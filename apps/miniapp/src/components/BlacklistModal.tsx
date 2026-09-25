import { useTranslation } from "react-i18next";
import ModalCard from "./ModalCard";
import { SUPPORT_EMAIL } from "@/lib/env";
import { useAuthStore } from "@/stores/auth";

/**
 * The screen a suspended account is held on.
 *
 * It used to ask the user to email us "your wallet address and which chain you
 * are using" while showing neither, and it covers the whole app, so there was
 * nowhere to go and look them up. Both are on the card now, and the button
 * opens a mail draft with them already in it — the one action available has to
 * be one tap, because this modal has no other exit by design.
 */
function BlacklistModal() {
  const { t } = useTranslation();
  const address = useAuthStore((s) => s.user?.address) ?? "";
  const platform = useAuthStore((s) => s.platform) ?? "";

  const mailto =
    `mailto:${SUPPORT_EMAIL}` +
    `?subject=${encodeURIComponent("Halo account suspended")}` +
    `&body=${encodeURIComponent(`Wallet: ${address}\nChain: ${platform}\n\n`)}`;

  return (
    <ModalCard
      icon={
        <div className="flex h-[60px] w-[60px] items-center justify-center rounded-[20px] bg-[#FFEBEE]">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-8 w-8 text-[#F04452]"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
            />
          </svg>
        </div>
      }
      title={t("Account Suspended")}
      description={
        <div className="space-y-3">
          <p>
            {t("This account has been suspended for violating our terms of service.")}
          </p>
          <p className="text-[12.5px] text-[#B0B8C1]">
            {t("If you believe this is a mistake, get in touch and we will look.")}
          </p>
          {address && (
            <div className="rounded-[12px] bg-[#F2F4F6] px-3 py-2.5 text-left">
              <p className="font-mono text-[11px] break-all text-[#4E5968]">{address}</p>
              <p className="font-mono text-[11px] text-[#B0B8C1]">{platform}</p>
            </div>
          )}
        </div>
      }
      actions={[
        {
          label: t("Contact support"),
          tone: "primary",
          onClick: () => {
            window.location.href = mailto;
          },
        },
      ]}
    />
  );
}

export default BlacklistModal;
