import { apiFetch, type ApiRequestInit } from './client';

/**
 * Session endpoints — `apps/api/src/routes/client/auth.ts`.
 *
 * Sign-in always runs as nonce → wallet signs a SIWE message → complete. All
 * three chains now prove the same thing the same way: the server-issued nonce
 * has to appear inside a message the wallet signed, and the signature has to
 * check out against the address being claimed. What differs is only *how* a
 * given wallet's signature is checked — recovered for an EOA, asked of the
 * wallet contract for a Safe — and that lives entirely on the server.
 *
 * The completion paths stay per-chain because installed clients post to them.
 *
 * Nothing here returns a token. The server sets an http-only cookie pair the
 * client never reads, which is why `credentials: 'include'` in `client.ts` is
 * load-bearing rather than incidental.
 */

/** Module-private: every client route is mounted under `/v1`. */
function call<T>(path: string, init?: ApiRequestInit): Promise<T> {
  return apiFetch<T>(`/v1${path}`, init);
}

export interface AuthChallenge {
  nonce: string;
  hmac: string;
}

/** The SIWE result a wallet hands back, as the server expects it. */
export interface SiweAuthPayload {
  status: 'success';
  message: string;
  signature: string;
  address: string;
  version: number;
}

export interface SiweCompleteRequest {
  nonce: string;
  hmac: string;
  payload: SiweAuthPayload;
}

/**
 * MiniPay's body is flat rather than nested, because the endpoint predates the
 * shared shape and installed clients post to it. `message` and `signature` are
 * required: the version of this call that omitted them issued a session for
 * whatever address it was handed.
 */
export interface CeloConnectRequest {
  nonce: string;
  hmac: string;
  address: string;
  message: string;
  signature: string;
}

/** Every endpoint that mutates the session answers with this and a `Set-Cookie`. */
export interface SessionMutated {
  success: true;
}

export interface SessionStatus {
  address: string;
  username: string;
  verificationLevel: 'none' | 'orb' | 'device';
  profilePictureUrl: string | null;
  /**
   * Whether the wallet proved ownership by signing. True for every session
   * minted since sign-in was unified — there is no longer a way to get one
   * without a signature — but older tokens are still in circulation with it
   * unset.
   */
  verified: boolean;
  isBlacklisted: boolean;
}

export const authApi = {
  nonce(): Promise<AuthChallenge> {
    return call('/auth/session/miniapp/nonce');
  },

  completeWorld(request: SiweCompleteRequest): Promise<SessionMutated> {
    return call('/auth/session/world-miniapp/complete', { method: 'POST', body: request });
  },

  connectCelo(request: CeloConnectRequest): Promise<SessionMutated> {
    return call('/auth/session/celo-miniapp/connect', { method: 'POST', body: request });
  },

  completeKaia(request: SiweCompleteRequest): Promise<SessionMutated> {
    return call('/auth/session/kaia-miniapp/complete', { method: 'POST', body: request });
  },

  status(): Promise<SessionStatus> {
    return call('/auth/session/status');
  },

  revoke(): Promise<SessionMutated> {
    return call('/auth/session/revoke', { method: 'POST' });
  },
};
