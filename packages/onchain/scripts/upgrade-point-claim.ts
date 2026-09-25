/**
 * Points an existing CeloPointClaimUpgradableV2 proxy at a fresh implementation.
 *
 *   NETWORK=celo pnpm --filter @halo/onchain upgrade
 *
 * The proxy address comes from `deployments/<network>.json`, or from
 * PROXY_ADDRESS when upgrading a proxy this checkout did not deploy. There is
 * no table of environment-to-address mappings in this file on purpose: a
 * hardcoded production address one keystroke away from `staging` is how the
 * wrong contract gets upgraded.
 *
 * Required environment:
 *
 *   NETWORK                 celo | worldchain | kaia | *-testnet
 *   <NETWORK>_RPC_URL       e.g. CELO_RPC_URL
 *   DEPLOYER_PRIVATE_KEY    must be the proxy's current owner
 *
 * Optional:
 *
 *   PROXY_ADDRESS           overrides the address in deployments/<network>.json
 *   ETHERSCAN_API_KEY       enables source verification
 */

import 'dotenv/config';

import type { Address } from 'viem';
import { isAddress, parseEther } from 'viem';

import { loadArtifact } from './lib/artifacts.js';
import { assertDeployerIsFunded, createClients, verifyContract } from './lib/clients.js';
import { readDeployment, writeDeployment } from './lib/deployments.js';
import { optionalEnv } from './lib/env.js';
import type { NetworkName } from './lib/networks.js';
import { resolveNetwork } from './lib/networks.js';

const CONTRACT_NAME = 'CeloPointClaimUpgradableV2';
const CONTRACT_PATH = `src/${CONTRACT_NAME}.sol:${CONTRACT_NAME}`;
const MIN_BALANCE = parseEther('0.05');

function resolveProxyAddress(network: NetworkName): Address {
  const override = optionalEnv('PROXY_ADDRESS');
  if (override) {
    if (!isAddress(override)) {
      throw new Error(`Invalid PROXY_ADDRESS: "${override}" is not a 0x address.`);
    }
    return override;
  }

  const record = readDeployment(network);
  if (!record) {
    throw new Error(
      `No deployment record for "${network}" and no PROXY_ADDRESS set. ` +
        'Set PROXY_ADDRESS to the proxy you mean to upgrade.',
    );
  }
  return record.proxy;
}

async function main(): Promise<void> {
  const network = resolveNetwork();
  const clients = createClients(network);
  const proxyAddress = resolveProxyAddress(network.name);

  console.log('');
  console.log(`Upgrading ${CONTRACT_NAME}`);
  console.log(`Network:   ${network.name} (chain ${network.chain.id})`);
  console.log(`Proxy:     ${proxyAddress}`);
  await assertDeployerIsFunded(clients, MIN_BALANCE);

  const artifact = loadArtifact(CONTRACT_NAME);

  // There must actually be a contract there. Upgrading an empty address
  // silently "succeeds" as a call to nothing.
  const deployedCode = await clients.publicClient.getCode({ address: proxyAddress });
  if (!deployedCode || deployedCode === '0x') {
    throw new Error(`No contract at ${proxyAddress} on ${network.name}.`);
  }

  // Only the owner can authorize a UUPS upgrade, so check before spending gas
  // on an implementation the proxy will refuse to adopt.
  const currentOwner = (await clients.publicClient.readContract({
    address: proxyAddress,
    abi: artifact.abi,
    functionName: 'owner',
  })) as Address;

  if (currentOwner.toLowerCase() !== clients.account.address.toLowerCase()) {
    throw new Error(
      `Upgrade blocked: proxy owner is ${currentOwner}, but DEPLOYER_PRIVATE_KEY is ${clients.account.address}.`,
    );
  }

  console.log('Deploying new implementation...');
  const implTxHash = await clients.walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: [],
  });
  const implReceipt = await clients.publicClient.waitForTransactionReceipt({
    hash: implTxHash,
  });
  const implementationAddress = implReceipt.contractAddress;
  if (!implementationAddress) {
    throw new Error(`Implementation deployment produced no address (tx ${implTxHash}).`);
  }
  console.log(`  implementation: ${implementationAddress}`);

  // Empty calldata: this upgrade runs no reinitializer. A version that adds
  // state needs `reinitializer(n)` here instead of "0x".
  console.log('Switching the proxy over...');
  const upgradeTxHash = await clients.walletClient.writeContract({
    address: proxyAddress,
    abi: artifact.abi,
    functionName: 'upgradeToAndCall',
    args: [implementationAddress, '0x'],
  });
  await clients.publicClient.waitForTransactionReceipt({ hash: upgradeTxHash });

  // Confirm the proxy survived: state it held before the upgrade must still
  // read back through the new implementation.
  const [ownerAfter, signerAfter] = await Promise.all([
    clients.publicClient.readContract({
      address: proxyAddress,
      abi: artifact.abi,
      functionName: 'owner',
    }) as Promise<Address>,
    clients.publicClient.readContract({
      address: proxyAddress,
      abi: artifact.abi,
      functionName: 'serverSigner',
    }) as Promise<Address>,
  ]);

  if (ownerAfter.toLowerCase() !== currentOwner.toLowerCase()) {
    throw new Error(
      `Owner changed across the upgrade: ${currentOwner} -> ${ownerAfter}. Storage layout is wrong.`,
    );
  }

  const existing = readDeployment(network.name);
  const recordPath = writeDeployment({
    network: network.name,
    chainId: network.chain.id,
    contract: CONTRACT_NAME,
    proxy: proxyAddress,
    implementation: implementationAddress,
    owner: ownerAfter,
    serverSigner: signerAfter,
    deployedAt: existing?.deployedAt ?? new Date().toISOString(),
    deployTxHash: existing?.deployTxHash ?? upgradeTxHash,
    upgrades: [
      ...(existing?.upgrades ?? []),
      {
        implementation: implementationAddress,
        txHash: upgradeTxHash,
        at: new Date().toISOString(),
      },
    ],
  });

  verifyContract({
    chainId: network.chain.id,
    address: implementationAddress,
    contractPath: CONTRACT_PATH,
  });

  console.log('');
  console.log('Upgrade complete.');
  console.log(`  proxy (unchanged):      ${proxyAddress}`);
  console.log(`  new implementation:     ${implementationAddress}`);
  console.log(`  owner / server signer:  ${ownerAfter} / ${signerAfter}`);
  console.log(`  record:                 ${recordPath}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
