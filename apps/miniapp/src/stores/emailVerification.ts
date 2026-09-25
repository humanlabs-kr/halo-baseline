import { create } from "zustand";
import type { Platform } from "@halo/contracts";
import i18n from "@/lib/i18n";
import { ApiRequestError, hasApiErrorCode } from "@/lib/api/client";
import {
  haloEmailApi,
  type SendEmailCodeErrorCode,
  type VerifyEmailCodeErrorCode,
} from "@/lib/api/halo";

/**
 * Email verification state for the raffle flow.
 *
 * Prizes are announced and paid out by email, so an address has to be
 * verified before it can enter. Every chain uses the same endpoints; the
 * platform is passed through only because the server scopes verification per
 * chain.
 */

export type EmailVerificationState = {
  isVerified: boolean;
  verifiedEmail: string | null;
  isLoading: boolean;
  email: string;
  error: string | null;
  otpExpiresAt: Date | null;
  cooldownUntil: Date | null;
  attemptsRemaining: number | null;
};

export type EmailVerificationActions = {
  checkStatus: (platform: Platform) => Promise<void>;
  setEmail: (email: string) => void;
  sendCode: (platform: Platform, turnstileToken: string) => Promise<boolean>;
  verifyCode: (platform: Platform, code: string) => Promise<boolean>;
  clearError: () => void;
  reset: () => void;
};

export type EmailVerificationStore = EmailVerificationState &
  EmailVerificationActions;

const initialState: EmailVerificationState = {
  isVerified: false,
  verifiedEmail: null,
  isLoading: false,
  email: "",
  error: null,
  otpExpiresAt: null,
  cooldownUntil: null,
  attemptsRemaining: null,
};

/**
 * Copy for the codes the server documents, keyed exhaustively.
 *
 * Typing these as the full code union rather than `Record<string, string>` is
 * the point: when the server adds a code, this stops compiling instead of
 * quietly falling through to the raw server message.
 *
 * The strings double as i18n keys — natural-language keys, see `lib/i18n` — and
 * the screen runs `error` through `t()` before rendering it, so an untranslated
 * locale falls back to exactly this English.
 */
const SEND_CODE_ERRORS: Record<SendEmailCodeErrorCode, string> = {
  TURNSTILE_FAILED: "CAPTCHA verification failed. Please try again",
  DOMAIN_NOT_ALLOWED: "This email domain is not allowed",
  ALREADY_VERIFIED: "This wallet already has a verified email",
  EMAIL_ALREADY_USED: "This email is already used by another wallet",
  EMAIL_SEND_FAILED: "Could not send the email. Please try again",
  ADDRESS_BLACKLISTED: "Your account has been restricted",
  CHAIN_MISMATCH: "This wallet belongs to a different chain",
  RATE_LIMITED: "Too many requests. Please try again later",
  COOLDOWN_ACTIVE: "Please wait before requesting a new code",
};

const VERIFY_CODE_ERRORS: Record<VerifyEmailCodeErrorCode, string> = {
  NO_PENDING_VERIFICATION: "No code was requested. Please request a new one",
  OTP_EXPIRED: "Code expired. Please request a new one",
  MAX_ATTEMPTS_EXCEEDED: "Too many failed attempts. Please request a new code",
  INVALID_CODE: "That code is not right",
  EMAIL_ALREADY_USED: "This email is already used by another wallet",
};

/** Number of code attempts the server allows before a new code is required. */
const MAX_OTP_ATTEMPTS = 5;

/**
 * Picks display copy for a failed request.
 *
 * Matches on `error.code` only. Matching on `error.message` would read a
 * string the server writes for humans — it gets reworded and the branch dies
 * silently — so an unrecognised code falls back to showing that message rather
 * than trying to parse it.
 */
function errorMessage(
  copy: Partial<Record<string, string>>,
  error: unknown,
): string {
  if (!(error instanceof ApiRequestError)) {
    return "Something went wrong. Please try again";
  }
  return (error.code === null ? undefined : copy[error.code]) ?? error.message;
}

export const useEmailVerificationStore = create<EmailVerificationStore>()(
  (set, get) => ({
    ...initialState,

    checkStatus: async (platform) => {
      set({ isLoading: true });

      try {
        const status = await haloEmailApi.status(platform);
        set({
          isLoading: false,
          isVerified: status.verified,
          verifiedEmail: status.email,
        });
      } catch {
        // Nothing actionable: an unreadable status just leaves the screen in
        // its "not verified yet" state, which is the safe default.
        set({ isLoading: false });
      }
    },

    setEmail: (email) => set({ email, error: null }),

    sendCode: async (platform, turnstileToken) => {
      const { email } = get();
      if (!email) {
        set({ error: "Please enter your email" });
        return false;
      }

      set({ isLoading: true, error: null });

      try {
        const sent = await haloEmailApi.sendCode(platform, {
          email,
          turnstileToken,
        });
        set({
          isLoading: false,
          otpExpiresAt: new Date(sent.expiresAt),
          cooldownUntil: new Date(sent.cooldownUntil),
          attemptsRemaining: MAX_OTP_ATTEMPTS,
        });
        return true;
      } catch (error) {
        // The wait is sent as a `Retry-After` header, not a body field — it is
        // the only structured number available, so use it rather than reading
        // the seconds back out of the message.
        const message =
          hasApiErrorCode(error, "COOLDOWN_ACTIVE") &&
          error instanceof ApiRequestError
            ? i18n.t("Please wait {{seconds}} seconds", {
                seconds: error.retryAfter ?? 60,
              })
            : errorMessage(SEND_CODE_ERRORS, error);

        set({ isLoading: false, error: message });
        return false;
      }
    },

    verifyCode: async (platform, code) => {
      if (code.length !== 6) {
        set({ error: "Please enter the 6-digit code" });
        return false;
      }

      set({ isLoading: true, error: null });

      try {
        const verified = await haloEmailApi.verifyCode(platform, code);
        set({
          isLoading: false,
          isVerified: true,
          verifiedEmail: verified.email,
        });
        return true;
      } catch (error) {
        if (hasApiErrorCode(error, "INVALID_CODE")) {
          // The server counts attempts but does not report the remainder as a
          // field — only inside the message. Counting down locally keeps the
          // hint without parsing prose that is free to change.
          const remaining = Math.max(0, (get().attemptsRemaining ?? MAX_OTP_ATTEMPTS) - 1);
          set({
            isLoading: false,
            attemptsRemaining: remaining,
            error: i18n.t("Invalid code. {{remaining}} attempts remaining", {
              remaining,
            }),
          });
          return false;
        }

        set({
          isLoading: false,
          error: errorMessage(VERIFY_CODE_ERRORS, error),
        });
        return false;
      }
    },

    clearError: () => set({ error: null }),

    reset: () => set(initialState),
  }),
);
