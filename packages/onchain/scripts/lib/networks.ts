/**
 * The chains this contract is deployed to, and where each one's RPC URL comes
 * from.
 *
 * No RPC endpoint is hardcoded: every network names an environment variable,
 * so switching providers (or pointing at a local fork) is a config change, not
 * a code change. The mainnet variables are the same ones the API and miniapp
 * already use, listed in the repository root `.env.example`.
 */

import type { Chain } from 'viem';
import {
  celo,
  celoAlfajores,
  foundry,
  kaia,
  kairos,
  worldchain,
  worldchainSepolia,
} from 'viem/chains';

import { requireEnv } from './env.js';

export interface NetworkConfig {
  /** viem chain definition — carries the chain id the signer commits to. */
  readonly chain: Chain;
  /** Environment variable holding this network's RPC URL. */
  readonly rpcUrlEnvVar: string;
  /** Block explorer verification is only wired up where the repo has an API key. */
  readonly testnet: boolean;
}

export const NETWORKS = {
  celo: { chain: celo, rpcUrlEnvVar: 'CELO_RPC_URL', testnet: false },
  worldchain: { chain: worldchain, rpcUrlEnvVar: 'WORLDCHAIN_RPC_URL', testnet: false },
  kaia: { chain: kaia, rpcUrlEnvVar: 'KAIA_RPC_URL', testnet: false },

  // Testnets. Their RPC variables are not part of the deployed configuration —
  // put them in `packages/onchain/.env` when you need them.
  'celo-alfajores': {
    chain: celoAlfajores,
    rpcUrlEnvVar: 'CELO_ALFAJORES_RPC_URL',
    testnet: true,
  },
  'worldchain-sepolia': {
    chain: worldchainSepolia,
    rpcUrlEnvVar: 'WORLDCHAIN_SEPOLIA_RPC_URL',
    testnet: true,
  },
  'kaia-kairos': { chain: kairos, rpcUrlEnvVar: 'KAIA_KAIROS_RPC_URL', testnet: true },

  // Local `anvil`. Deploying against it is the cheapest way to check that a
  // change to these scripts still produces a working proxy.
  anvil: { chain: foundry, rpcUrlEnvVar: 'ANVIL_RPC_URL', testnet: true },
} as const satisfies Record<string, NetworkConfig>;

export type NetworkName = keyof typeof NETWORKS;

export const NETWORK_NAMES = Object.keys(NETWORKS) as NetworkName[];

function isNetworkName(value: string): value is NetworkName {
  return Object.hasOwn(NETWORKS, value);
}

export interface ResolvedNetwork {
  readonly name: NetworkName;
  readonly chain: Chain;
  readonly rpcUrl: string;
}

/**
 * Resolves the `NETWORK` variable into a chain plus its RPC URL.
 *
 * Deliberately has no default: "deployed to the wrong chain because NETWORK
 * was unset" is not a mistake worth making cheap.
 */
export function resolveNetwork(): ResolvedNetwork {
  const name = requireEnv('NETWORK', `one of: ${NETWORK_NAMES.join(', ')}`);

  if (!isNetworkName(name)) {
    throw new Error(
      `Unknown NETWORK "${name}". Expected one of: ${NETWORK_NAMES.join(', ')}.`,
    );
  }

  const config = NETWORKS[name];
  const rpcUrl = requireEnv(
    config.rpcUrlEnvVar,
    `JSON-RPC endpoint for ${name} (chain ${config.chain.id})`,
  );

  return { name, chain: config.chain, rpcUrl };
}
