/// <reference types="vite/client" />

/**
 * Every `VITE_*` the app reads is declared here, and `src/lib/env.ts` is the only
 * module allowed to read `import.meta.env`. Anything else imports the typed values
 * from there, so a renamed or missing variable breaks the build in one place
 * instead of silently becoming `undefined` deep inside a component.
 */
interface ImportMetaEnv {
  /** Base URL of the Halo API (`apps/api`), e.g. `http://localhost:8001`. */
  readonly VITE_API_URL: string;
  readonly VITE_PROJECT_ENV: 'local' | 'staging' | 'production';

  /** Cloudflare Turnstile site key (public half of the pair). */
  readonly VITE_TURNSTILE_SITE_KEY?: string;

  /** World App mini app id, required to boot MiniKit on the `world` platform. */
  readonly VITE_WORLD_APP_ID?: string;

  /** LINE DappPortal client id + LIFF id, required on the `kaia` platform. */
  readonly VITE_KAIA_CLIENT_ID?: string;
  readonly VITE_KAIA_LIFF_ID?: string;

  /** Per-chain RPC endpoints. Falls back to the chain's public RPC when unset. */
  readonly VITE_CELO_RPC_URL?: string;
  readonly VITE_WORLDCHAIN_RPC_URL?: string;
  readonly VITE_KAIA_RPC_URL?: string;

  /**
   * Comma-separated wallet addresses that get internal QA affordances
   * (campaign previews that bypass geo lookup, the on-device debug console).
   * Empty in a normal deployment.
   */
  readonly VITE_DEVELOPER_ADDRESSES?: string;

  /** Endpoint returning `{ "country": "KR" }` for the caller's IP. */
  readonly VITE_GEO_API_URL?: string;

  /**
   * Dynamic link for the Halo Mini cross-promo (store detection + deferred
   * deep link). Unset hides the cross-promo banner and popup entirely.
   */
  readonly VITE_HALO_MINI_LINK?: string;

  /** Address shown to users whose account was suspended. */
  readonly VITE_SUPPORT_EMAIL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
