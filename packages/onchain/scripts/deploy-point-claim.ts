/**
 * Deploys CeloPointClaimUpgradableV2 behind an ERC1967 proxy.
 *
 *   NETWORK=celo pnpm --filter @halo/onchain deploy
 *
 * Two transactions: the implementation, then the proxy whose constructor
 * delegatecalls `initialize(owner, serverSigner)`. Initializing inside the
 * proxy constructor rather than in a follow-up transaction closes the window
 * where an uninitialized proxy could be claimed by someone else.
 *
 * Required environment (every one of these throws if unset — nothing here
 * falls back to a default):
 *
 *   NETWORK                 celo | worldchain | kaia | *-testnet (see lib/networks.ts)
 *   <NETWORK>_RPC_URL       e.g. CELO_RPC_URL
 *   DEPLOYER_PRIVATE_KEY    EOA that sends the transactions
 *   OWNER_ADDRESS           owner of the proxy: rotates the signer, authorizes upgrades
 *   SERVER_SIGNER_ADDRESS   key whose signatures mint points
 *                           (or SERVER_SIGNER_PRIVATE_KEY, from which it is derived)
 *
 * Optional:
 *
 *   ETHERSCAN_API_KEY       enables source verification
 *   MIN_DEPLOYER_BALANCE_WEI  override the pre-flight balance floor
 */

import 'dotenv/config';

import type { Address } from 'viem';
import { encodeAbiParameters, encodeFunctionData, isAddress, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { loadArtifact } from './lib/artifacts.js';
import { assertDeployerIsFunded, createClients, verifyContract } from './lib/clients.js';
import { writeDeployment } from './lib/deployments.js';
import { optionalEnv, requireAddressEnv, requirePrivateKeyEnv } from './lib/env.js';
import { resolveNetwork } from './lib/networks.js';

const CONTRACT_NAME = 'CeloPointClaimUpgradableV2';
const CONTRACT_PATH = `src/${CONTRACT_NAME}.sol:${CONTRACT_NAME}`;

// The proxy is OpenZeppelin's ERC1967Proxy, used unmodified — this is what is
// already live on mainnet. `src/Proxy.sol` is a bare import of it whose only
// job is to pull it into the compilation unit so `forge build` emits its
// artifact. Foundry keys artifacts by the file a contract is *declared* in, so
// that artifact lands under `out/ERC1967Proxy.sol/`, not `out/Proxy.sol/`.
const PROXY_CONTRACT_NAME = 'ERC1967Proxy';
const PROXY_CONTRACT_PATH =
  'node_modules/@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy';
const DEFAULT_MIN_BALANCE = parseEther('0.05');

/**
 * The address whose signatures the contract will trust.
 *
 * Accepts the address directly, so a deploy never needs the signing key on
 * the deploying machine. Deriving it from `SERVER_SIGNER_PRIVATE_KEY` stays
 * available because that is the variable the API already holds.
 */
function resolveServerSigner(): Address {
  const explicit = optionalEnv('SERVER_SIGNER_ADDRESS');
  if (explicit) {
    if (!isAddress(explicit)) {
      throw new Error(`Invalid SERVER_SIGNER_ADDRESS: "${explicit}" is not a 0x address.`);
    }
    return explicit;
  }

  if (optionalEnv('SERVER_SIGNER_PRIVATE_KEY')) {
    const derived = privateKeyToAccount(
      requirePrivateKeyEnv('SERVER_SIGNER_PRIVATE_KEY', 'the backend signing key'),
    ).address;
    console.log('SERVER_SIGNER_ADDRESS not set — derived it from SERVER_SIGNER_PRIVATE_KEY.');
    return derived;
  }

  throw new Error(
    'Set SERVER_SIGNER_ADDRESS (preferred) or SERVER_SIGNER_PRIVATE_KEY. ' +
      'This is the key the deployed contract will trust to authorize point claims; ' +
      'there is no safe default for it.',
  );
}

function resolveMinimumBalance(): bigint {
  const override = optionalEnv('MIN_DEPLOYER_BALANCE_WEI');
  if (!override) return DEFAULT_MIN_BALANCE;
  return BigInt(override);
}

async function main(): Promise<void> {
  const network = resolveNetwork();
  const clients = createClients(network);

  const owner = requireAddressEnv(
    'OWNER_ADDRESS',
    'owner of the proxy — it can rotate the server signer and authorize upgrades',
  );
  const serverSigner = resolveServerSigner();

  console.log('');
  console.log(`Deploying ${CONTRACT_NAME}`);
  console.log(`Network:   ${network.name} (chain ${network.chain.id})`);
  await assertDeployerIsFunded(clients, resolveMinimumBalance());
  console.log(`Owner:     ${owner}`);
  console.log(`Signer:    ${serverSigner}`);
  console.log('');

  // 1. Implementation. No constructor arguments — an upgradeable contract's
  //    state lives in the proxy, and its own constructor only locks itself.
  const implementation = loadArtifact(CONTRACT_NAME);
  console.log('Deploying implementation...');
  const implTxHash = await clients.walletClient.deployContract({
    abi: implementation.abi,
    bytecode: implementation.bytecode,
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

  // 2. Proxy. Its constructor runs `initialize` through a delegatecall, so the
  //    proxy is owned and configured in the same transaction that creates it.
  const initData = encodeFunctionData({
    abi: implementation.abi,
    functionName: 'initialize',
    args: [owner, serverSigner],
  });

  const proxyArtifact = loadArtifact(PROXY_CONTRACT_NAME);
  console.log('Deploying proxy...');
  const proxyTxHash = await clients.walletClient.deployContract({
    abi: proxyArtifact.abi,
    bytecode: proxyArtifact.bytecode,
    args: [implementationAddress, initData],
  });
  const proxyReceipt = await clients.publicClient.waitForTransactionReceipt({
    hash: proxyTxHash,
  });
  const proxyAddress = proxyReceipt.contractAddress;
  if (!proxyAddress) {
    throw new Error(`Proxy deployment produced no address (tx ${proxyTxHash}).`);
  }
  console.log(`  proxy:          ${proxyAddress}`);

  // 3. Read the state back through the proxy. A proxy that deployed but did
  //    not initialize looks fine until the first claim fails.
  const [onchainOwner, onchainSigner] = await Promise.all([
    clients.publicClient.readContract({
      address: proxyAddress,
      abi: implementation.abi,
      functionName: 'owner',
    }) as Promise<Address>,
    clients.publicClient.readContract({
      address: proxyAddress,
      abi: implementation.abi,
      functionName: 'serverSigner',
    }) as Promise<Address>,
  ]);

  if (onchainOwner.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(
      `Proxy reports owner ${onchainOwner} but ${owner} was requested — initialization did not take.`,
    );
  }
  if (onchainSigner.toLowerCase() !== serverSigner.toLowerCase()) {
    throw new Error(
      `Proxy reports serverSigner ${onchainSigner} but ${serverSigner} was requested.`,
    );
  }

  const recordPath = writeDeployment({
    network: network.name,
    chainId: network.chain.id,
    contract: CONTRACT_NAME,
    proxy: proxyAddress,
    implementation: implementationAddress,
    owner,
    serverSigner,
    deployedAt: new Date().toISOString(),
    deployTxHash: proxyTxHash,
    upgrades: [],
  });

  verifyContract({
    chainId: network.chain.id,
    address: implementationAddress,
    contractPath: CONTRACT_PATH,
  });

  // The proxy is verified too: explorers detect ERC1967 by storage slot, but
  // verified proxy source is what makes the "Read as Proxy" tab work.
  verifyContract({
    chainId: network.chain.id,
    address: proxyAddress,
    contractPath: PROXY_CONTRACT_PATH,
    constructorArgs: encodeAbiParameters(
      [{ type: 'address' }, { type: 'bytes' }],
      [implementationAddress, initData],
    ),
  });

  console.log('');
  console.log('Deployed and initialized.');
  console.log(`  proxy (use this address):  ${proxyAddress}`);
  console.log(`  implementation:            ${implementationAddress}`);
  console.log(`  record:                    ${recordPath}`);
  console.log('');
  console.log('Point the app at it by setting, for this environment:');
  console.log(`  POINT_CLAIM_CONTRACT_${network.name.toUpperCase().replace(/-/g, '_')}=${proxyAddress}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
