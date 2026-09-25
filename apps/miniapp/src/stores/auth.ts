import { create } from 'zustand';
import { persist, subscribeWithSelector } from 'zustand/middleware';
import { statementFor, type Platform } from '@halo/contracts';
import { authApi, type SessionStatus } from '@/lib/api/auth';
import { AuthError, getAuthAdapter, submitSignIn } from '@/lib/auth/adapter';
import { detectPlatform } from '@/lib/platform';

/**
 * One session store for all three chains. World, MiniPay and Kaia used to have
 * their own near-identical copies of this; the only real difference was the
 * wallet handshake, which now lives behind `AuthAdapter`.
 */

export type AuthState = {
  platform: Platform | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  /**
   * Whether `checkSession` has answered yet.
   *
   * Distinct from `isAuthenticated`, which starts `false` and therefore cannot
   * tell "signed out" from "we have not looked". The router needs that
   * difference: acting on the first meaning while the second is true sends
   * every deep link to the signed-out wildcard, and the URL is gone before the
   * session arrives.
   *
   * Never persisted. A stale `true` from a previous boot would defeat the
   * whole point.
   */
  sessionChecked: boolean;
  isBlacklisted: boolean;
  user: SessionStatus | null;
  /** Last sign-in failure, already phrased for display. Cleared on retry. */
  error: string | null;
  hasSeenOnboarding: boolean;
};

export type AuthActions = {
  checkSession: () => Promise<void>;
  signIn: () => Promise<boolean>;
  signOut: () => Promise<void>;
  setHasSeenOnboarding: (hasSeenOnboarding: boolean) => void;
};

export type AuthStore = AuthState & AuthActions;

const initialState: AuthState = {
  platform: detectPlatform(),
  isLoading: false,
  isAuthenticated: false,
  sessionChecked: false,
  isBlacklisted: false,
  user: null,
  error: null,
  hasSeenOnboarding: false,
};

/** Module-level guard: a second tap must not open a second wallet prompt. */
let signInInFlight = false;

/**
 * How long sign-out will wait for the wallet to let go before carrying on.
 * Generous for a teardown, short enough that a dead relay socket cannot hold
 * the user on a spinner — the server session is revoked either way.
 */
const WALLET_DISCONNECT_TIMEOUT_MS = 5_000;

export const useAuthStore = create<AuthStore>()(
  subscribeWithSelector(
    persist(
      (set, get) => ({
        ...initialState,

        setHasSeenOnboarding: (hasSeenOnboarding) => set({ hasSeenOnboarding }),

        checkSession: async () => {
          let user: SessionStatus;
          try {
            user = await authApi.status();
          } catch {
            // Any failure here — expired cookie, offline, 404 on a wiped user —
            // means there is no session to act on. The reason is not actionable.
            set({ isAuthenticated: false, sessionChecked: true, isLoading: false, user: null });
            return;
          }

          set({
            isAuthenticated: true,
            sessionChecked: true,
            isLoading: false,
            user,
            isBlacklisted: user.isBlacklisted,
          });
        },

        signIn: async () => {
          const platform = get().platform;
          if (!platform) {
            set({ error: 'This host is not configured for any Halo chain.' });
            return false;
          }
          if (signInInFlight) return false;

          signInInFlight = true;
          set({ isLoading: true, error: null });

          try {
            const adapter = getAuthAdapter(platform);
            await adapter.init();

            const challenge = await authApi.nonce().catch(() => {
              throw new AuthError('rejected', 'Could not start sign-in. Please try again.');
            });

            // Built here rather than in each adapter so all three chains sign
            // the same shape. `statement` comes from `@halo/contracts` because
            // the API compares it against its own copy character for
            // character, and `domain` is what the API checks its allow-list
            // against — a message claiming any other host is refused.
            const result = await adapter.signIn({
              nonce: challenge.nonce,
              statement: statementFor(platform),
              domain: window.location.host,
              uri: window.location.origin,
            });

            await submitSignIn(platform, challenge, result);
            await get().checkSession();
            return true;
          } catch (error) {
            const message =
              error instanceof AuthError
                ? error.message
                : 'Something went wrong. Please try again.';
            set({ isAuthenticated: false, isLoading: false, error: message });
            return false;
          } finally {
            signInInFlight = false;
          }
        },

        signOut: async () => {
          set({ isLoading: true });

          // ── Wallet first, server second ────────────────────────────────────
          // Signing out has two halves: release the wallet session, then revoke
          // ours. The wallet goes first for two reasons.
          //
          // It is the half that actually fails. Revoking is one call to our own
          // API; the wallet teardown is an SDK talking to a wallet app over a
          // relay. And its failure is the one that matters: a wallet still
          // connected means the next sign-in is silent and the user is back in
          // the account they were trying to leave, which is the whole bug this
          // exists to fix. A cookie that outlives the screen merely expires.
          //
          // It also needs the app intact. Clearing the store below flips
          // `isAuthenticated` and sends `App.tsx` to the login screen — so a
          // teardown started after that point races a route change that can
          // abandon it mid-flight. Doing it first means sign-out finishes only
          // once both halves are genuinely done.
          const platform = get().platform;
          if (platform) {
            const disconnect = getAuthAdapter(platform).disconnect;
            if (disconnect) {
              // Never allowed to abort the sign-out. A rejection is swallowed
              // (the SDK may throw simply because nothing was connected), and
              // the race guards against the other failure mode — a relay call
              // that never settles, which would otherwise strand the user in
              // `isLoading` with no way out. Worst case the wallet is still
              // tearing down as we go; it stays a wallet problem either way.
              await Promise.race([
                disconnect().catch(() => {}),
                new Promise((resolve) => setTimeout(resolve, WALLET_DISCONNECT_TIMEOUT_MS)),
              ]);
            }
          }

          // A failed revoke still clears the client: the user asked to be signed
          // out, and leaving them "signed in" because the network blipped is worse
          // than a cookie that outlives the screen and expires on its own.
          await authApi.revoke().catch(() => {});
          set({
            isLoading: false,
            isAuthenticated: false,
            // Signed out *is* an answer — the router should show the login
            // screen, not hold on the fallback waiting for a check that has
            // already happened.
            sessionChecked: true,
            isBlacklisted: false,
            user: null,
            error: null,
          });
        },
      }),
      {
        name: 'halo.auth',
        // Only what survives a reload usefully. `isLoading` / `error` describe a
        // single attempt, and `platform` is re-detected from the host every boot.
        partialize: (state) => ({
          isAuthenticated: state.isAuthenticated,
          isBlacklisted: state.isBlacklisted,
          user: state.user,
          hasSeenOnboarding: state.hasSeenOnboarding,
        }),
      },
    ),
  ),
);
