import { z } from 'zod';

/**
 * Wallet platforms Halo runs inside. The mini app is built once and picks one
 * of these at runtime from its hostname — see `apps/miniapp/src/lib/platform.ts`.
 */
export const PLATFORMS = ['world', 'celo', 'kaia'] as const;

export const platformSchema = z.enum(PLATFORMS);
export type Platform = z.infer<typeof platformSchema>;

export const PLATFORM_CHAIN_ID = {
  world: 480,
  celo: 42220,
  kaia: 8217,
} as const satisfies Record<Platform, number>;

export const PLATFORM_LABEL = {
  world: 'World App',
  celo: 'MiniPay',
  kaia: 'Kaia',
} as const satisfies Record<Platform, string>;

/**
 * First hostname label → platform.
 *
 * This is a lookup rather than `label === platform` because the deployed
 * hostnames predate the platform names. World shipped first and took the bare
 * `miniapp.` subdomain; the later chains were added beside it with a prefix.
 * Those hostnames are baked into installed mini apps and cannot be renamed, so
 * the mapping lives here instead.
 *
 * The plain `world.` / `celo.` / `kaia.` forms are accepted too, for local
 * development and for any future deployment that does not inherit the history.
 */
const HOSTNAME_PREFIX_TO_PLATFORM: Record<string, Platform> = {
  miniapp: 'world',
  'world-miniapp': 'world',
  world: 'world',
  'celo-miniapp': 'celo',
  celo: 'celo',
  'kaia-miniapp': 'kaia',
  kaia: 'kaia',
};

/**
 * Resolves the platform from a hostname, e.g. `celo-miniapp.halo.example.com`
 * yields `celo`.
 *
 * Returns null rather than guessing. A mini app that silently assumes a
 * platform when served from an unexpected host authenticates against the wrong
 * chain and fails in ways nobody traces back to DNS.
 */
export function platformFromHostname(hostname: string): Platform | null {
  const label = hostname.split('.')[0]?.toLowerCase();
  if (!label) return null;
  return HOSTNAME_PREFIX_TO_PLATFORM[label] ?? null;
}

/** Every hostname prefix that resolves to a platform. Used by tests and docs. */
export const KNOWN_HOSTNAME_PREFIXES = Object.keys(HOSTNAME_PREFIX_TO_PLATFORM);
