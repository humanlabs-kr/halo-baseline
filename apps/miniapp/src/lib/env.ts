/**
 * The single place that touches `import.meta.env`.
 *
 * Reading the env inline forces a cast at every call site and scatters the
 * names, so a typo only shows up as `undefined` at runtime. Everything is read
 * once here, normalised, and re-exported as plain typed values.
 */

const env = import.meta.env;

/** Base URL of the Halo API. */
export const API_URL = env.VITE_API_URL ?? '';

export const PROJECT_ENV = env.VITE_PROJECT_ENV ?? 'local';

/** `true` for the vite dev server and staging builds, `false` for production. */
export const IS_DEV = import.meta.env.MODE !== 'production';

export const TURNSTILE_SITE_KEY = env.VITE_TURNSTILE_SITE_KEY ?? '';

export const WORLD_APP_ID = env.VITE_WORLD_APP_ID ?? '';

export const KAIA_CLIENT_ID = env.VITE_KAIA_CLIENT_ID ?? '';
export const KAIA_LIFF_ID = env.VITE_KAIA_LIFF_ID ?? '';

export const CELO_RPC_URL = env.VITE_CELO_RPC_URL ?? '';
export const WORLDCHAIN_RPC_URL = env.VITE_WORLDCHAIN_RPC_URL ?? '';
export const KAIA_RPC_URL = env.VITE_KAIA_RPC_URL ?? '';

/**
 * Wallet addresses with internal QA affordances, lowercased for comparison.
 *
 * This used to be a literal array in the source: a list of privileged addresses
 * shipped in the client bundle for anyone to read (and to try to spoof). It is
 * configuration, not code — an unset variable simply means nobody is privileged.
 */
export const DEVELOPER_ADDRESSES: readonly string[] = (env.VITE_DEVELOPER_ADDRESSES ?? '')
  .split(',')
  .map((address) => address.trim().toLowerCase())
  .filter(Boolean);

/** Geo-IP lookup used to pick a country-specific cross-promo campaign. */
export const GEO_API_URL = env.VITE_GEO_API_URL ?? '';

/** Dynamic link the Halo Mini cross-promo sends users to. */
export const HALO_MINI_LINK = env.VITE_HALO_MINI_LINK ?? '';

export const SUPPORT_EMAIL = env.VITE_SUPPORT_EMAIL ?? 'support@example.com';

export function isDeveloperAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  return DEVELOPER_ADDRESSES.includes(address.toLowerCase());
}
