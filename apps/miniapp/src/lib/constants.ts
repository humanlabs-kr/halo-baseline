import type { Platform } from '@halo/contracts';

/** Scan quota shown in the progress card and enforced by the API. */
export const SCAN_LIMIT = {
  daily: 5,
  weekly: 35,
} as const;

/**
 * Stablecoin each chain pays raffle rewards in. Only a display label — the
 * amounts come from the API already denominated in this currency.
 */
export const REWARD_CURRENCY: Record<Platform, string> = {
  world: 'USDC',
  celo: 'USDT',
  kaia: 'USDT',
};

/**
 * Chain assumed by copy that has to render before the host has identified one.
 * The onboarding deck is reachable signed out, so it may paint before (or
 * without) a platform; `getWagmiConfig()` makes the same assumption for the
 * same reason — an unknown host cannot sign anyone in, but the shell still has
 * to draw something rather than crash.
 */
export const FALLBACK_PLATFORM: Platform = 'celo';

/**
 * Onboarding's third slide names the reward currency, so its copy is per-chain:
 * World pays USDC, the Halo chains pay USDT. Two key pairs, picked here rather
 * than branched on at the call site.
 */
export const ONBOARDING_REWARD_COPY: Record<Platform, { titleKey: string; subtitleKey: string }> = {
  // "Swap points for USDC rewards" / "… claim the USDC rewards …"
  world: { titleKey: 'L-ew1FGlX2', subtitleKey: 'L-uqoEmpy6' },
  // "Swap Points for USDT Rewards" / "… claim the USDT rewards …"
  celo: { titleKey: 'L-ooS1yAuv', subtitleKey: 'L-7QsZgPLu' },
  kaia: { titleKey: 'L-ooS1yAuv', subtitleKey: 'L-7QsZgPLu' },
};

/**
 * Per-chain feature switches.
 *
 * Halo ships one bundle for three products that are not the same product. The
 * differences are small but they are everywhere, and scattered
 * `if (platform === 'kaia')` checks are how a feature ends up enabled on two
 * chains and forgotten on the third. Every such difference is declared here, so
 * adding a chain is one row and auditing one is one column.
 */
export interface PlatformFeatures {
  /**
   * Halo Mini cross-promo: home banner, dwell popup and `/event/halo-mini`.
   * Off for Kaia — the LINE build never carried the cross-promo and the Kaia
   * store listing is not cleared for it.
   */
  crossPromo: boolean;
  /** LINE friend invite card. Only the LINE webview has a friend graph. */
  lineInvite: boolean;
  /**
   * Confirm before a hardware/gesture back leaves the app. The LINE webview
   * pops the mini app off the stack on back, so leaving is unrecoverable;
   * World App and MiniPay keep their own chrome and need no warning.
   */
  confirmOnBack: boolean;
  /**
   * Require a verified email before entering a raffle. The Halo raffle
   * endpoints answer `EMAIL_NOT_VERIFIED`; World's Drop-Protocol raffle does
   * not, and gating it client-side would refuse an entry the server allows.
   */
  raffleNeedsVerifiedEmail: boolean;
  /**
   * Whether a payout ledger exists to link to.
   *
   * Only the chains we settle ourselves keep one. On World the winner claims
   * the prize directly, so the screen has nothing to show and always will —
   * and the rewards tab was offering a row that led to a permanent "No
   * payouts yet".
   */
  prizePayouts: boolean;
}

export const PLATFORM_FEATURES: Record<Platform, PlatformFeatures> = {
  world: {
    crossPromo: true,
    lineInvite: false,
    confirmOnBack: false,
    raffleNeedsVerifiedEmail: false,
    prizePayouts: false,
  },
  celo: {
    crossPromo: true,
    lineInvite: false,
    confirmOnBack: false,
    raffleNeedsVerifiedEmail: true,
    prizePayouts: true,
  },
  kaia: {
    crossPromo: false,
    lineInvite: true,
    confirmOnBack: true,
    raffleNeedsVerifiedEmail: true,
    prizePayouts: true,
  },
};

/** Every feature off — what an unidentified host gets. */
const NO_FEATURES: PlatformFeatures = {
  crossPromo: false,
  lineInvite: false,
  confirmOnBack: false,
  raffleNeedsVerifiedEmail: false,
  prizePayouts: false,
};

export function platformFeatures(platform: Platform | null): PlatformFeatures {
  return platform ? PLATFORM_FEATURES[platform] : NO_FEATURES;
}

/**
 * GA4 property per chain. Each product reports into its own stream — they have
 * separate funnels, separate stores and separate owners, and merging them would
 * make every retention number meaningless.
 *
 * The three apps used to be three HTML files, one hardcoded tag each. They are
 * one file now, so the tag is chosen at runtime from the host (`main.tsx`).
 */
export const GA_MEASUREMENT_ID: Record<Platform, string> = {
  world: 'G-0YV6E7CC1Q',
  celo: 'G-J0T1CXJ7DG',
  kaia: 'G-CQTCYZDTH6',
};

/** Block explorer used to link a payout transaction, per chain. */
export const EXPLORER_TX_URL: Record<Platform, string> = {
  world: 'https://worldscan.org/tx/',
  celo: 'https://celoscan.io/tx/',
  kaia: 'https://kaiascan.io/tx/',
};


/** LIFF entry point shared when a Kaia user invites a LINE friend. */
export const LINE_INVITE_URL = 'https://liff.line.me/2008843741-ys04RAGi';
