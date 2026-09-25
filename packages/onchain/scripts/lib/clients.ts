/**
 * viem clients and contract verification for the deploy scripts.
 *
 * Plain EOA deployment over a configurable JSON-RPC endpoint — no bundler, no
 * paymaster, no provider-specific SDK. That keeps the deploy path identical on
 * every chain the app targets, including ones without account-abstraction
 * infrastructure.
 */

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Account, Chain, PublicClient, WalletClient } from 'viem';
import { createPublicClient, createWalletClient, formatEther, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { optionalEnv, requirePrivateKeyEnv } from './env.js';
import type { ResolvedNetwork } from './networks.js';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface DeployClients {
  account: Account;
  publicClient: PublicClient;
  walletClient: WalletClient<ReturnType<typeof http>, Chain, Account>;
  network: ResolvedNetwork;
}

export function createClients(network: ResolvedNetwork): DeployClients {
  const account = privateKeyToAccount(
    requirePrivateKeyEnv('DEPLOYER_PRIVATE_KEY', 'the EOA that sends the deploy transactions'),
  );

  const transport = http(network.rpcUrl);

  const publicClient = createPublicClient({
    chain: network.chain,
    transport,
  }) as PublicClient;

  const walletClient = createWalletClient({
    account,
    chain: network.chain,
    transport,
  });

  return { account, publicClient, walletClient, network };
}

/**
 * Refuses to start a deployment the deployer cannot pay for.
 *
 * Running out of gas halfway through leaves an orphaned implementation and an
 * uninitialized proxy, which is far more annoying to untangle than stopping
 * up front.
 */
export async function assertDeployerIsFunded(
  clients: DeployClients,
  minimumWei: bigint,
): Promise<void> {
  const balance = await clients.publicClient.getBalance({
    address: clients.account.address,
  });
  const symbol = clients.network.chain.nativeCurrency.symbol;

  console.log(`Deployer:  ${clients.account.address}`);
  console.log(`Balance:   ${formatEther(balance)} ${symbol}`);

  if (balance < minimumWei) {
    throw new Error(
      `Deployer ${clients.account.address} holds ${formatEther(balance)} ${symbol}, ` +
        `below the ${formatEther(minimumWei)} ${symbol} floor. Fund it before deploying.`,
    );
  }
}

/**
 * Verifies source on the block explorer, if an API key is configured.
 *
 * The key is passed through the environment rather than argv: anything on a
 * command line shows up in `ps` and in the shell history of whoever is
 * watching, and the previous version of this script also printed the full
 * command — API key included — to stdout.
 */
export function verifyContract(options: {
  chainId: number;
  address: string;
  /** `src/CeloPointClaimUpgradableV2.sol:CeloPointClaimUpgradableV2` */
  contractPath: string;
  constructorArgs?: string;
}): void {
  const apiKey = optionalEnv('ETHERSCAN_API_KEY');
  if (!apiKey) {
    console.log(
      'ETHERSCAN_API_KEY is not set — skipping source verification. ' +
        `Verify later with: forge verify-contract --chain ${options.chainId} ${options.address} ${options.contractPath}`,
    );
    return;
  }

  const args = [
    'verify-contract',
    '--chain',
    String(options.chainId),
    '--watch',
    options.address,
    options.contractPath,
  ];
  if (options.constructorArgs) {
    args.push('--constructor-args', options.constructorArgs);
  }

  console.log(`Verifying ${options.contractPath} at ${options.address}...`);
  try {
    execFileSync('forge', args, {
      stdio: 'inherit',
      cwd: PACKAGE_ROOT,
      env: { ...process.env, ETHERSCAN_API_KEY: apiKey },
    });
  } catch {
    // A failed verification does not invalidate the deployment, and the
    // addresses have already been written to disk by this point.
    console.warn('Source verification failed. The contract itself is deployed and usable.');
  }
}
