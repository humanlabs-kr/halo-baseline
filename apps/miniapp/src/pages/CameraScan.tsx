import { useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { Drawer } from "vaul";
import { Turnstile, type TurnstileInstance } from "@marsidev/react-turnstile";
import { useCameraStream } from "@/hooks/useCameraStream";
import { ApiRequestError } from "@/lib/api/client";
import { receiptApi } from "@/lib/api/receipt";
import { useQueryClient } from "@tanstack/react-query";
import { receiptsQueryKey, useReceiptStat } from "@/lib/api/queries";
import toast from "react-hot-toast";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "@/stores/auth";
import BlacklistModal from "@/components/BlacklistModal";
import { CameraIcon, CheckIcon, CloseIcon, InfoIcon } from "@/components/ui/icons";
import { SCAN_LIMIT } from "@/lib/constants";
import { TURNSTILE_SITE_KEY } from "@/lib/env";
import { sendLightImpactHaptic } from "@/lib/haptic";

// One dot per scan allowed today.
const TOTAL_STEPS = SCAN_LIMIT.daily;

function CameraScan() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { videoRef, state, errorMessage, retry } = useCameraStream();
  const [isReviewing, setIsReviewing] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstileRef = useRef<TurnstileInstance>(null);

  const queryClient = useQueryClient();
  const location = useLocation();

  // Opened directly — deep link, or the Scan tab from a cold start — there is
  // nothing behind this screen, and `navigate(-1)` leaves the mini app.
  const closeScanner = () => {
    if (location.key === "default") navigate("/ledger", { replace: true });
    else navigate(-1);
  };

  const handleCapture = () => {
    if (state !== "ready" || isReviewing || !turnstileToken) return;
    if (!videoRef.current || videoRef.current.readyState < 2) return;

    if (isScanLimitReached) {
      toast.error(t("L-xl7MA3jN"));
      return;
    }

    sendLightImpactHaptic();
    setIsReviewing(true);

    void (async () => {
      if (videoRef.current) {
        videoRef.current.pause();
      }
      // Take a snapshot from the video and create a File object ("receipt.jpg")
      const canvas = document.createElement("canvas");
      const video = videoRef.current!;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      // Convert canvas to blob and create a File
      const getFile = () =>
        new Promise<File>((resolve, reject) => {
          canvas.toBlob((blob) => {
            if (blob) {
              resolve(new File([blob], "receipt.jpg", { type: "image/jpeg" }));
            } else {
              reject(new Error("Failed to capture image"));
            }
          }, "image/jpeg");
        });

      const file = await getFile();

      let uploaded;
      try {
        uploaded = await receiptApi.upload({ file, turnstileToken: turnstileToken! });
      } catch (error) {
        setIsReviewing(false);
        setTurnstileToken(null);
        turnstileRef.current?.reset();
        if (videoRef.current?.paused) {
          videoRef.current.play().catch(() => {});
        }
        // The upload failures worth naming (daily limit, blacklist, CAPTCHA)
        // already arrive as readable copy; anything else gets the generic line.
        toast.error(
          error instanceof ApiRequestError ? error.message : t("L-xl7MA3jN"),
        );
        return;
      }

      queryClient.invalidateQueries({ queryKey: receiptsQueryKey() });
      setIsReviewing(false);
      setTurnstileToken(null);
      turnstileRef.current?.reset();

      // Straight to the result rather than a modal saying it was queued. The
      // read takes a few seconds and what comes back is the reason to keep
      // scanning — sending the user away at exactly that moment was the old
      // flow's mistake, back when the only payload was points.
      navigate(`/scan/${uploaded.receiptId}`);
    })();
  };

  const isBlacklisted = useAuthStore((s) => s.isBlacklisted);

  const { data: receiptStat } = useReceiptStat();
  const dailyScanCount = receiptStat?.dailyScanCount ?? 0;
  const weeklyScanCount = receiptStat?.weeklyScanCount ?? 0;
  const isScanLimitReached =
    dailyScanCount >= SCAN_LIMIT.daily || weeklyScanCount >= SCAN_LIMIT.weekly;
  const steps = useMemo(
    () =>
      Array.from({ length: TOTAL_STEPS }, (_, index) => {
        const completedCount = Math.min(dailyScanCount, TOTAL_STEPS);
        return index < completedCount;
      }),
    [dailyScanCount],
  );

  return (
    // The one screen in the app that is not white. Black is not decoration
    // here, it is the absence of anything competing with the viewfinder.
    <div className="flex min-h-screen justify-center bg-black text-white">
      <div className="relative flex min-h-screen w-full flex-col px-4 pt-4 pb-12">
        <ScannerFrame videoRef={videoRef} state={state} />

        {/*
          Every control on this screen is white, and the subject is a receipt —
          white paper, filling the frame. Pointed at the one thing it exists to
          photograph, the header, the step dots and the shutter all disappeared
          completely. Scrims top and bottom, which is what the controls were
          always assuming was there.
        */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 z-[5] h-40 bg-gradient-to-b from-black/60 via-black/25 to-transparent"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 z-[5] h-48 bg-gradient-to-t from-black/70 via-black/30 to-transparent"
        />

        <div className="relative z-10 flex flex-1 flex-col">
          <Header onClose={closeScanner} />
          <StepIndicator steps={steps} />
        </div>

        {isReviewing && <ReviewOverlay />}

        <div className="fixed right-3 bottom-3 z-20 scale-75 origin-bottom-right opacity-80">
          <Turnstile
            ref={turnstileRef}
            siteKey={TURNSTILE_SITE_KEY}
            onSuccess={setTurnstileToken}
            onExpire={() => setTurnstileToken(null)}
            onError={() => setTurnstileToken(null)}
            options={{ theme: "dark", size: "compact" }}
          />
        </div>

        {/* A dead shutter with no words is the user's fault as far as they can
            tell. Five green ticks above it are not an explanation — they are
            the same information in a form that reads as progress. */}
        {isScanLimitReached && state === "ready" && (
          <p className="pointer-events-none absolute inset-x-6 bottom-[132px] z-20 break-keep rounded-[14px] bg-black/70 px-4 py-2.5 text-center text-[13px] font-medium text-white/90 backdrop-blur-sm">
            {t("Today's {{limit}} scans are done. More tomorrow.", { limit: SCAN_LIMIT.daily })}
          </p>
        )}

        <CaptureButton
          disabled={state !== "ready" || isReviewing || !turnstileToken || isScanLimitReached || isBlacklisted}
          onCapture={handleCapture}
        />

        <StatusText state={state} errorMessage={errorMessage} onRetry={retry} />
        {isBlacklisted && <BlacklistModal />}
      </div>
    </div>
  );
}

function Header({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <header className="flex items-center justify-between text-white">
      <button
        type="button"
        onClick={onClose}
        aria-label={t("Close")}
        className="pressed -ml-2 p-2"
      >
        <CloseIcon />
      </button>
      <div className="text-[16px] font-bold tracking-[-.03em]">{t("L-PQElQnFz")}</div>
      <InfoDrawer />
    </header>
  );
}

function StepIndicator({ steps }: { steps: boolean[] }) {
  const { t } = useTranslation();

  return (
    <div className="mt-4 flex justify-center gap-3">
      {steps.map((completed, index) => (
        <span
          key={`scan-step-${index}`}
          className={[
            "flex h-6 w-6 items-center justify-center rounded-full border border-dashed",
            completed
              ? "border-transparent bg-[#00A06A] text-white"
              : "border-white/40 text-white/70",
          ].join(" ")}
        >
          {completed && (
            <>
              <CheckIcon size={14} />
              <span className="sr-only">{t("Completed")}</span>
            </>
          )}
        </span>
      ))}
    </div>
  );
}

type ScannerFrameProps = {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  state: "idle" | "loading" | "ready" | "error";
};

function ScannerFrame({ videoRef, state }: ScannerFrameProps) {
  return (
    <div className="pointer-events-none absolute inset-0">
      <video
        ref={videoRef}
        className={[
          "h-full w-full object-cover",
          state === "ready" ? "opacity-100" : "opacity-0",
        ].join(" ")}
        playsInline
        muted
        autoPlay
      />

      <div className="absolute inset-0 flex items-center justify-center">
        <div className="relative h-[520px] w-[320px] max-w-[80vw]">
          <CornerImage className="left-0 top-0" />
          <CornerImage className="right-0 top-0 rotate-90" />
          <CornerImage className="left-0 bottom-0 -rotate-90" />
          <CornerImage className="right-0 bottom-0 rotate-180" />
        </div>
      </div>
    </div>
  );
}

function CornerImage({ className }: { className: string }) {
  return (
    <img
      src="/corner.png"
      alt=""
      className={[
        "pointer-events-none absolute h-14 w-14 opacity-80",
        // Same problem as the controls: white guides on white paper. The
        // shadow is what separates them from the receipt they frame.
        "drop-shadow-[0_1px_3px_rgba(0,0,0,0.65)]",
        className,
      ].join(" ")}
    />
  );
}

function CaptureButton({
  disabled,
  onCapture,
}: {
  disabled: boolean;
  onCapture: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="pointer-events-none fixed bottom-10 left-1/2 z-20 -translate-x-1/2">
      <button
        type="button"
        className="pointer-events-auto flex h-16 w-16 items-center justify-center rounded-full border-2 border-white bg-white/10 disabled:opacity-40"
        aria-label={t("Capture")}
        disabled={disabled}
        onClick={() => {
          onCapture();
        }}
      >
        {/* Both circles stay circles: a shutter is the one control on a
            camera that is round everywhere, and reshaping it would be the
            design system overruling a hardware convention. */}
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white text-[#191F28]">
          <CameraIcon />
        </div>
      </button>
    </div>
  );
}

function ReviewOverlay() {
  const { t } = useTranslation();
  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="flex flex-col items-center rounded-[20px] bg-linear-to-b from-white/15 to-white/5 px-6 py-5 text-center text-white shadow-2xl shadow-black/40">
        <div className="mb-3 h-10 w-10 animate-spin rounded-full border-2 border-white/30 border-t-white" />
        <p className="break-keep text-[15px] font-medium text-white/90">{t("L-kRmfOqQd")}</p>
        <p className="mt-1 break-keep text-[13px] font-medium text-white/70">{t("L-AoTtuFuI")}</p>
      </div>
    </div>
  );
}

function StatusText({
  state,
  errorMessage,
  onRetry,
}: {
  state: "idle" | "loading" | "ready" | "error";
  errorMessage: string;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  if (state === "ready") return null;
  const isLoading = state === "idle" || state === "loading";
  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
      <div className="rounded-[20px] bg-black/70 px-5 py-4 text-center text-[13px] font-medium text-white/90 shadow-2xl backdrop-blur-sm">
        {isLoading ? (
          <div className="mx-auto h-9 w-9 animate-spin rounded-full border-2 border-white/30 border-t-white" />
        ) : (
          <>
            <p>{t(errorMessage)}</p>
            {/* A label with a fill, not a bare word: the only thing that
                separated this from the error text above it was a hover
                background, and the phones this runs on have no hover. */}
            <button
              type="button"
              className="pointer-events-auto mt-3 rounded-[14px] bg-white/15 px-4 py-2 text-[14px] font-bold tracking-[-.03em] text-white transition active:bg-white/25"
              onClick={onRetry}
            >
              {t("L-Eu9O2jr8")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function InfoDrawer() {
  const { t } = useTranslation();
  return (
    <Drawer.Root>
      <Drawer.Trigger asChild>
        <button type="button" className="pressed -mr-2 p-2" aria-label={t("Info")}>
          <InfoIcon />
        </button>
      </Drawer.Trigger>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-30 bg-black/60" />
        <Drawer.Content className="fixed inset-x-0 bottom-0 z-40 flex justify-center">
          <div className="w-full rounded-t-[20px] bg-white p-6 text-start text-[#191F28] shadow-2xl">
            <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-[#E5E8EB]" />
            <h2 className="text-[20px] font-extrabold tracking-[-.035em]">{t("L-29EPh1FG")}</h2>
            <p className="mt-2 break-keep text-[14.5px] leading-[1.55] font-medium text-[#4E5968]">
              {t("L-RzS2XJr0")}
            </p>
            <p className="mt-4 break-keep pb-3 text-[14.5px] leading-[1.55] font-medium text-[#8B95A1]">
              {t("L-q2tCEQHX")}
            </p>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

export default CameraScan;
