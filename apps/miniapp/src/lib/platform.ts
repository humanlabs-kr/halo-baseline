import { PLATFORMS, platformFromHostname, type Platform } from '@halo/contracts';
import { IS_DEV } from './env';

/**
 * Which chain this build is currently serving. Halo ships ONE app; the host it
 * is served from decides whether it talks to World App, MiniPay or Kaia.
 * This module is the only place that decision is made — everything else takes
 * `Platform` as an input.
 */

const OVERRIDE_KEY = 'halo.dev.platform';

/**
 * Local development runs on `localhost`, which carries no platform label, so a
 * default is needed to get a usable app. Staging and production deliberately
 * get NO default: if a build is served from an unexpected host we want
 * `detectPlatform()` to return null and the UI to say so. A fallback there
 * would make a misrouted deployment look healthy while it signs users into the
 * wrong chain — the kind of bug that is invisible until funds move.
 */
const DEV_DEFAULT_PLATFORM: Platform = 'celo';

function isPlatform(value: string | null): value is Platform {
  return value !== null && (PLATFORMS as readonly string[]).includes(value);
}

/** Dev-only manual switch, so one localhost can exercise all three platforms. */
export function getPlatformOverride(): Platform | null {
  if (!IS_DEV || typeof window === 'undefined') return null;
  try {
    const stored = localStorage.getItem(OVERRIDE_KEY);
    return isPlatform(stored) ? stored : null;
  } catch {
    // Private-mode browsers throw on localStorage access.
    return null;
  }
}

export function setPlatformOverride(platform: Platform | null): void {
  try {
    if (platform) localStorage.setItem(OVERRIDE_KEY, platform);
    else localStorage.removeItem(OVERRIDE_KEY);
  } catch {
    // Nothing to do — the override is a convenience, not a requirement.
  }
}

let cached: Platform | null | undefined;

/**
 * Resolution order: dev override → hostname → `?platform=` → dev default.
 * The result is cached because the answer cannot change without a reload.
 */
export function detectPlatform(): Platform | null {
  if (cached !== undefined) return cached;
  if (typeof window === 'undefined') {
    cached = null;
    return cached;
  }

  const override = getPlatformOverride();
  if (override) {
    cached = override;
    return cached;
  }

  cached = platformFromHostname(window.location.hostname);

  if (!cached) {
    const param = new URLSearchParams(window.location.search).get('platform');
    if (isPlatform(param)) cached = param;
  }

  if (!cached && IS_DEV) cached = DEV_DEFAULT_PLATFORM;

  return cached;
}

/** For the rare caller that cannot render anything useful without a platform. */
export function requirePlatform(): Platform {
  const platform = detectPlatform();
  if (!platform) {
    throw new Error(
      `Unknown Halo platform for host "${window.location.hostname}". ` +
        `Expected one of: ${PLATFORMS.join(', ')}.`,
    );
  }
  return platform;
}

export type { Platform };
