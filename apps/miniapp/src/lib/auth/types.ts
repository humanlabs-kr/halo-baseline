import type { Platform } from '@halo/contracts';
import type { AuthChallenge } from '@/lib/api/auth';

/** Server-issued challenge: `nonce` plus the HMAC that proves the server minted it. */
export type { AuthChallenge };

/**
 * Everything an adapter needs to build the message its wallet will sign.
 *
 * Assembled once in `stores/auth.ts` so all three platforms sign the same
 * shape. `statement` in particular comes from `@halo/contracts` rather than
 * from the adapter: the API compares it against its own copy character for
 * character, so a per-platform string invented here would be rejected.
 */
export interface SignInArgs {
  /** The server-issued nonce. It has to end up inside the signed message. */
  nonce: string;
  statement: string;
  /** `window.location.host` — checked against the API's allow-list. */
  domain: string;
  /** `window.location.origin`. */
  uri: string;
}

/**
 * What the wallet handshake produced. Nothing here is trusted by the server:
 * `address` is a claim that `signature` over `message` has to back up.
 */
export interface SignInResult {
  address: string;
  /** The exact EIP-4361 text that was signed, byte for byte. */
  message: string;
  signature: string;
  /**
   * World App's wallet-auth payload version, which picks the verification path
   * on the server: 1 recovers the signer and asks the Safe `isOwner`, 2 asks
   * the Safe `isValidSignature` directly. The other two platforms report 1;
   * their verifiers ignore it.
   */
  version: number;
}

/**
 * What one platform has to be able to do for Halo to sign a user in.
 *
 * The three chains differ only in how the wallet handshake happens, so that is
 * all an adapter owns. Building the message, posting it, session state, error
 * surfacing and navigation are identical everywhere and live outside.
 */
export interface AuthAdapter {
  readonly platform: Platform;

  /**
   * One-time SDK bootstrap (MiniKit install, LIFF + DappPortal init, ...).
   * Safe to call repeatedly — implementations de-duplicate internally.
   * Resolves when `signIn` may be attempted; rejects if the SDK cannot start.
   */
  init(): Promise<void>;

  /**
   * Whether the host wallet environment is actually present. Only meaningful
   * after `init()`. A `false` here means the user opened the app outside its
   * wallet app (a plain mobile browser, say), not that anything failed.
   */
  isAvailable(): boolean;

  /**
   * Run the wallet handshake. Throws `AuthError` on failure; returns the signed
   * message on success. Adapters do no networking of their own — exchanging the
   * result for a session cookie is `submitSignIn`'s job.
   */
  signIn(args: SignInArgs): Promise<SignInResult>;

  /**
   * Tear down the *wallet* session — the SDK-side connection that survives our
   * own sign-out and makes the next `signIn` silent.
   *
   * Optional on purpose: only Kaia has one. World App *is* the wallet, and
   * MiniPay's injected provider exposes nothing that revokes an authorisation,
   * so for those two the honest implementation is no implementation. A stub
   * that resolved would read like the wallet had been released when it had
   * not. Each adapter that declines documents why at its own definition.
   *
   * Nothing here is allowed to block sign-out: the caller in `stores/auth.ts`
   * treats a rejection as "wallet could not be released" and revokes the server
   * session regardless. Implementations should still be defensive — in
   * particular they must not bootstrap an SDK just to disconnect it, because
   * opening a wallet session on the way out is worse than leaving one open.
   */
  disconnect?: () => Promise<void>;
}

export type AuthErrorKind =
  /** User closed or declined the wallet prompt — not worth an error toast. */
  | 'cancelled'
  /** Wallet app / SDK missing or refusing to start. */
  | 'unavailable'
  /** The wallet signed, but the server rejected the result. */
  | 'rejected'
  | 'unknown';

export class AuthError extends Error {
  readonly kind: AuthErrorKind;

  constructor(kind: AuthErrorKind, message: string) {
    super(message);
    this.name = 'AuthError';
    this.kind = kind;
  }
}
