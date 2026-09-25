import { useState, useEffect, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Trans, useTranslation } from "react-i18next";
import { Turnstile, type TurnstileInstance } from "@marsidev/react-turnstile";
import { TopBar } from "@/components/ledger/TopBar";
import { Button } from "@/components/ui/Button";
import { CheckIcon } from "@/components/ui/icons";
import { TURNSTILE_SITE_KEY } from "@/lib/env";
import { useAuthStore } from "@/stores/auth";
import { useEmailVerificationStore } from "@/stores/emailVerification";

type Step = "email" | "otp" | "success";

function VerifyEmail() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const returnTo = searchParams.get("returnTo") || "/rewards";
  const platform = useAuthStore((s) => s.platform);

  const {
    email,
    error,
    isLoading,
    otpExpiresAt,
    cooldownUntil,
    isVerified,
    verifiedEmail,
    setEmail,
    checkStatus,
    sendCode,
    verifyCode,
    clearError,
  } = useEmailVerificationStore();

  const [step, setStep] = useState<Step>("email");
  const [otp, setOtp] = useState<string[]>(["", "", "", "", "", ""]);
  const [timeLeft, setTimeLeft] = useState<number>(0);
  const [cooldownLeft, setCooldownLeft] = useState<number>(0);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstileRef = useRef<TurnstileInstance | null>(null);

  // Arriving already verified means there is nothing to do here. Verifying
  // during this visit also flips `isVerified`, so the guard below keeps the
  // success screen on-screen instead of redirecting out from under the user.
  const justVerifiedRef = useRef(false);
  useEffect(() => {
    if (isVerified && !justVerifiedRef.current) {
      navigate(returnTo, { replace: true });
    }
  }, [isVerified, navigate, returnTo]);

  useEffect(() => {
    if (platform) void checkStatus(platform);
  }, [checkStatus, platform]);

  // Timer for OTP expiry
  useEffect(() => {
    if (!otpExpiresAt) return;

    const updateTimer = () => {
      const now = Date.now();
      const diff = Math.max(
        0,
        Math.floor((otpExpiresAt.getTime() - now) / 1000),
      );
      setTimeLeft(diff);
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [otpExpiresAt]);

  // Timer for cooldown
  useEffect(() => {
    if (!cooldownUntil) return;

    const updateCooldown = () => {
      const now = Date.now();
      const diff = Math.max(
        0,
        Math.floor((cooldownUntil.getTime() - now) / 1000),
      );
      setCooldownLeft(diff);
    };

    updateCooldown();
    const interval = setInterval(updateCooldown, 1000);
    return () => clearInterval(interval);
  }, [cooldownUntil]);

  const handleOtpChange = (index: number, value: string) => {
    if (!/^\d*$/.test(value)) return;

    const newOtp = [...otp];
    newOtp[index] = value.slice(-1);
    setOtp(newOtp);

    // Auto-focus next input
    if (value && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }

    // Auto-verify when complete
    const fullCode = newOtp.join("");
    if (fullCode.length === 6) {
      handleVerifyCode(fullCode);
    }
  };

  const handleOtpKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === "Backspace" && !otp[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handleOtpPaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const pastedData = e.clipboardData.getData("text").slice(0, 6);
    if (!/^\d+$/.test(pastedData)) return;

    const newOtp = [...otp];
    for (let i = 0; i < pastedData.length; i++) {
      newOtp[i] = pastedData[i] ?? "";
    }
    setOtp(newOtp);

    // Auto-verify if complete
    if (pastedData.length === 6) {
      handleVerifyCode(pastedData);
    }
  };

  const handleSendCode = async () => {
    if (!turnstileToken || !platform) return;
    const success = await sendCode(platform, turnstileToken);
    if (success) {
      setTurnstileToken(null);
      setStep("otp");
    } else {
      turnstileRef.current?.reset();
      setTurnstileToken(null);
    }
  };

  const handleVerifyCode = async (code: string) => {
    if (!platform) return;
    const success = await verifyCode(platform, code);
    if (success) {
      justVerifiedRef.current = true;
      setStep("success");
    }
  };

  const handleResendCode = async () => {
    if (cooldownLeft > 0) return;
    setOtp(["", "", "", "", "", ""]);
    // Go back to email step to get fresh turnstile token
    setStep("email");
  };

  const handleBack = () => {
    if (step === "otp") {
      setStep("email");
      setOtp(["", "", "", "", "", ""]);
      clearError();
    } else {
      navigate(-1);
    }
  };

  const handleSuccessContinue = () => {
    navigate(returnTo, { replace: true });
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  return (
    <div className="flex min-h-full flex-col bg-white pb-4 text-[#191F28]">
      <TopBar
        title={
          step === "email"
            ? t("Verify Email")
            : step === "otp"
              ? t("Enter Code")
              : t("Verified!")
        }
        back
        onBack={handleBack}
      />
      <p className="break-keep px-5 pt-1 text-[15px] font-medium leading-[1.55] text-[#8B95A1]">
        {step === "email" && t("Required to enter raffles")}
        {step === "otp" && t("Code sent to {{email}}", { email })}
        {step === "success" && t("Your email has been verified")}
      </p>

      <div className="flex-1 px-5 pt-7">
        {step === "email" && (
          <div className="space-y-5">
            <div>
              <label className="mb-2 block text-[13px] font-medium tracking-[-.02em] text-[#8B95A1]">
                {t("Email Address")}
              </label>
              <input
                type="email"
                inputMode="email"
                value={email}
                onChange={(e) => setEmail(e.target.value.toLowerCase())}
                placeholder={t("your@email.com")}
                className="w-full rounded-[14px] bg-[#F2F4F6] px-4 py-[15px] text-[16px] font-medium text-[#191F28] placeholder:text-[#B0B8C1] outline-none focus:ring-2 focus:ring-[#191F28]/10"
                autoComplete="email"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>

            {error && (
              <p className="break-keep text-[13px] font-medium text-[#F04452]">{t(error)}</p>
            )}

            <div className="flex justify-center">
              <Turnstile
                ref={turnstileRef}
                siteKey={TURNSTILE_SITE_KEY}
                onSuccess={setTurnstileToken}
                onExpire={() => setTurnstileToken(null)}
                onError={() => setTurnstileToken(null)}
                options={{ theme: "light" }}
              />
            </div>

            <Button
              onClick={handleSendCode}
              disabled={isLoading || !email || !turnstileToken}
            >
              {isLoading ? t("Sending...") : t("Send Verification Code")}
            </Button>

            <p className="break-keep text-center text-[13px] font-medium text-[#8B95A1]">
              {t("Once verified, this email cannot be changed.")}
            </p>
          </div>
        )}

        {step === "otp" && (
          <div className="space-y-5">
            {/* A six-column grid rather than six fixed-width boxes: at the
                previous 48px each they overran the 320px screens this mini
                app still ships to, and the last digit fell off the edge. */}
            <div className="grid grid-cols-6 gap-2">
              {otp.map((digit, index) => (
                <input
                  key={index}
                  ref={(el) => {
                    inputRefs.current[index] = el;
                  }}
                  type="text"
                  inputMode="numeric"
                  value={digit}
                  onChange={(e) => handleOtpChange(index, e.target.value)}
                  onKeyDown={(e) => handleOtpKeyDown(index, e)}
                  onPaste={handleOtpPaste}
                  maxLength={1}
                  className="h-[58px] w-full rounded-[14px] bg-[#F2F4F6] text-center text-[22px] font-bold tabular-nums text-[#191F28] outline-none focus:ring-2 focus:ring-[#191F28]/10"
                  disabled={isLoading}
                />
              ))}
            </div>

            {timeLeft > 0 && (
              <p className="text-center text-[13px] font-medium text-[#8B95A1]">
                <Trans
                  i18nKey="Code expires in <strong>{{time}}</strong>"
                  values={{ time: formatTime(timeLeft) }}
                  components={{
                    strong: (
                      <span className="font-bold tabular-nums text-[#191F28]" />
                    ),
                  }}
                />
              </p>
            )}

            {timeLeft === 0 && otpExpiresAt && (
              <p className="break-keep text-center text-[13px] font-medium text-[#F04452]">
                {t("Code expired. Please request a new one.")}
              </p>
            )}

            {error && (
              <p className="break-keep text-center text-[13px] font-medium text-[#F04452]">
                {t(error)}
              </p>
            )}

            <div className="flex items-center justify-center gap-4">
              <button
                type="button"
                onClick={handleResendCode}
                disabled={cooldownLeft > 0 || isLoading}
                className={`text-[14px] font-medium tracking-[-.02em] ${
                  cooldownLeft > 0 || isLoading
                    ? "text-[#B0B8C1]"
                    : "text-[#4E5968] underline"
                }`}
              >
                {cooldownLeft > 0
                  ? t("Resend in {{seconds}}s", { seconds: cooldownLeft })
                  : t("Resend Code")}
              </button>
              <span className="text-[#E5E8EB]">|</span>
              <button
                type="button"
                onClick={() => {
                  setStep("email");
                  setOtp(["", "", "", "", "", ""]);
                  clearError();
                }}
                disabled={isLoading}
                className="text-[14px] font-medium tracking-[-.02em] text-[#4E5968] underline"
              >
                {t("Change Email")}
              </button>
            </div>

            {isLoading && (
              <p className="text-center text-[13px] font-medium text-[#8B95A1]">
                {t("Verifying...")}
              </p>
            )}
          </div>
        )}

        {step === "success" && (
          <div className="space-y-6 text-center">
            {/* The same green, and the same tint, a saved-money row uses. The
                app has one green and success is not a second one. */}
            <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-[20px] bg-[#E7F8F1] text-[#00A06A]">
              <CheckIcon size={36} />
            </div>

            <div>
              <p className="text-[19px] font-bold tracking-[-.03em]">
                {t("Email Verified")}
              </p>
              <p className="mt-1 text-[14px] font-medium text-[#8B95A1]">
                {verifiedEmail}
              </p>
            </div>

            <Button onClick={handleSuccessContinue}>
              {t("Continue to Raffle")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export default VerifyEmail;
