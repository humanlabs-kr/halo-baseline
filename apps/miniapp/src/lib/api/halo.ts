import type { Platform } from '@halo/contracts';
import { apiFetch, type ApiRequestInit } from './client';

/**
 * Email verification — `apps/api/src/routes/client/halo.ts`.
 *
 * Raffle prizes are announced and paid out by email, so an address has to
 * verify a mailbox before it can enter. Verification is scoped per chain: the
 * same wallet address on two chains verifies twice, which is why every call
 * takes the chain explicitly rather than inferring it from the session.
 */

/** Module-private: every client route is mounted under `/v1`. */
function call<T>(path: string, init?: ApiRequestInit): Promise<T> {
  return apiFetch<T>(`/v1${path}`, init);
}

/** Email verification is available on every chain, so this is just `Platform`. */
export type HaloEmailChain = Platform;

export interface EmailStatus {
  verified: boolean;
  email: string | null;
}

export interface SendEmailCodeRequest {
  email: string;
  turnstileToken: string;
}

export interface EmailCodeSent {
  success: true;
  expiresAt: string;
  /** No new code may be requested before this instant. */
  cooldownUntil: string;
}

export interface EmailVerified {
  verified: true;
  email: string;
}

/**
 * Codes `POST /halo/email/send-code` answers with.
 *
 * Listed as a union so a screen mapping codes to copy gets a type error when
 * the server adds one, instead of silently falling through to a generic
 * message. `COOLDOWN_ACTIVE` and `RATE_LIMITED` also set `Retry-After`, which
 * `ApiRequestError.retryAfter` carries.
 */
export type SendEmailCodeErrorCode =
  | 'TURNSTILE_FAILED'
  | 'DOMAIN_NOT_ALLOWED'
  | 'ALREADY_VERIFIED'
  | 'EMAIL_ALREADY_USED'
  | 'EMAIL_SEND_FAILED'
  | 'ADDRESS_BLACKLISTED'
  | 'CHAIN_MISMATCH'
  | 'RATE_LIMITED'
  | 'COOLDOWN_ACTIVE';

export type VerifyEmailCodeErrorCode =
  | 'NO_PENDING_VERIFICATION'
  | 'OTP_EXPIRED'
  | 'MAX_ATTEMPTS_EXCEEDED'
  | 'INVALID_CODE'
  | 'EMAIL_ALREADY_USED';

export const haloEmailApi = {
  status(chain: HaloEmailChain): Promise<EmailStatus> {
    return call('/halo/email/status', { query: { chain } });
  },

  sendCode(chain: HaloEmailChain, request: SendEmailCodeRequest): Promise<EmailCodeSent> {
    return call('/halo/email/send-code', { method: 'POST', query: { chain }, body: request });
  },

  verifyCode(chain: HaloEmailChain, code: string): Promise<EmailVerified> {
    return call('/halo/email/verify-code', { method: 'POST', query: { chain }, body: { code } });
  },
};
