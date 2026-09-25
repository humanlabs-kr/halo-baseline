import { createConfig, http, type Config } from 'wagmi';
import { celo, kaia, worldchain } from 'wagmi/chains';
import { injected } from 'wagmi/connectors';
import { CELO_RPC_URL, KAIA_RPC_URL, WORLDCHAIN_RPC_URL } from './env';
import { detectPlatform, type Platform } from './platform';

/**
 * One wagmi config for the whole app, built for the detected platform.
 *
 * Each platform reaches its wallet differently:
 * - `celo`  — MiniPay injects an EIP-1193 provider, so the injected connector works.
 * - `world` — wallet access goes through `MiniKit`, never through a wagmi
 *             connector; the config exists only so hooks have a chain/transport.
 * - `kaia`  — the LINE DappPortal SDK owns the wallet session, same as World.
 *
 * Cached at module scope: wagmi keeps connection state inside the config object,
 * so building a second one silently forks that state.
 */

/** The chain each platform transacts on. */
export const PLATFORM_CHAIN = {
  world: worldchain,
  celo,
  kaia,
} as const satisfies Record<Platform, { id: number }>;

let cached: Config | null = null;

function build(platform: Platform): Config {
  // An empty string means "no override" — let viem use the chain's public RPC.
  switch (platform) {
    case 'world':
      return createConfig({
        chains: [worldchain],
        connectors: [],
        transports: { [worldchain.id]: http(WORLDCHAIN_RPC_URL || undefined) },
      });
    case 'kaia':
      return createConfig({
        chains: [kaia],
        connectors: [],
        transports: { [kaia.id]: http(KAIA_RPC_URL || undefined) },
      });
    case 'celo':
      return createConfig({
        chains: [celo],
        connectors: [injected()],
        transports: { [celo.id]: http(CELO_RPC_URL || undefined) },
      });
  }
}

export function getWagmiConfig(): Config {
  // No platform (unknown host) still needs a config so the provider can mount
  // and the app can render its signed-out state instead of crashing.
  cached ??= build(detectPlatform() ?? 'celo');
  return cached;
}
