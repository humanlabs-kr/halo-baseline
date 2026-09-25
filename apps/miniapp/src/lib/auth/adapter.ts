import type { Platform } from '@halo/contracts';
import { authApi, type AuthChallenge } from '@/lib/api/auth';
import { celoAdapter } from './celo';
import { kaiaAdapter } from './kaia';
import { worldAdapter } from './world';
import { AuthError, type AuthAdapter, type SignInResult } from './types';

/** The one place platform choice turns into platform behaviour. */
export function getAuthAdapter(platform: Platform): AuthAdapter {
  switch (platform) {
    case 'world':
      return worldAdapter;
    case 'celo':
      return celoAdapter;
    case 'kaia':
      return kaiaAdapter;
  }
}

/**
 * Exchanges a signed message for a session cookie.
 *
 * Each chain keeps its own path because installed clients post to them, but
 * they all now carry the same three things — the nonce we were issued, the
 * message that nonce appears in, and the signature over it. The server runs
 * one verifier over all three.
 *
 * Nothing is returned: the session lives in an http-only cookie pair the client
 * never reads, which is why `credentials: 'include'` in `api/client.ts` is
 * load-bearing rather than incidental.
 */
export async function submitSignIn(
  platform: Platform,
  challenge: AuthChallenge,
  result: SignInResult,
): Promise<void> {
  const { nonce, hmac } = challenge;

  const request = (): Promise<unknown> => {
    switch (platform) {
      case 'world':
        return authApi.completeWorld({
          nonce,
          hmac,
          payload: {
            status: 'success',
            message: result.message,
            signature: result.signature,
            address: result.address,
            version: result.version,
          },
        });
      case 'kaia':
        return authApi.completeKaia({
          nonce,
          hmac,
          payload: {
            status: 'success',
            message: result.message,
            signature: result.signature,
            address: result.address,
            version: result.version,
          },
        });
      case 'celo':
        return authApi.connectCelo({
          nonce,
          hmac,
          address: result.address,
          message: result.message,
          signature: result.signature,
        });
    }
  };

  await request().catch(() => {
    throw new AuthError('rejected', 'Sign-in could not be completed. Please try again.');
  });
}

export { AuthError } from './types';
export type {
  AuthAdapter,
  AuthChallenge,
  AuthErrorKind,
  SignInArgs,
  SignInResult,
} from './types';
