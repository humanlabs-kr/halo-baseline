import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/Button";
import { CloseIcon, GiftIcon } from "@/components/ui/icons";
import { buildInternalHaloMiniLink } from "@/lib/halo-mini-campaigns";
import { useHaloMiniCampaign } from "@/hooks/useHaloMiniCampaign";

const POPUP_STORAGE_KEY = "halo.crossPromo.lastShown";
/**
 * Key the pre-merge builds wrote. The rename kept the same origin, so every
 * user who had already dismissed the popup still has the old timestamp and
 * none has the new one — without this read they would all be shown it again
 * on the first load after release.
 */
const LEGACY_POPUP_STORAGE_KEY = "halo_mini_popup_last_shown";
const POPUP_COOLDOWN_HOURS = 24;
const FIRST_VISIT_DELAY_MS = 10_000;
const RETURNING_VISIT_DELAY_MS = 15_000;

export function HaloMiniPopup() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const campaign = useHaloMiniCampaign();
  const [isVisible, setIsVisible] = useState(false);

  // Show the popup after a short dwell, at most once a day.
  useEffect(() => {
    if (!campaign) return;

    const lastShown =
      localStorage.getItem(POPUP_STORAGE_KEY) ??
      localStorage.getItem(LEGACY_POPUP_STORAGE_KEY);
    const lastShownTime = lastShown ? Number.parseInt(lastShown, 10) : Number.NaN;
    const isFirstVisit = Number.isNaN(lastShownTime);

    if (!isFirstVisit) {
      const hoursSince = (Date.now() - lastShownTime) / (1000 * 60 * 60);
      if (hoursSince < POPUP_COOLDOWN_HOURS) return;
    }

    const timeoutId = setTimeout(
      () => setIsVisible(true),
      isFirstVisit ? FIRST_VISIT_DELAY_MS : RETURNING_VISIT_DELAY_MS,
    );
    return () => clearTimeout(timeoutId);
  }, [campaign]);

  // Every write goes through here so the legacy entry is cleared exactly where
  // the current one is written — the migration then needs no separate pass.
  const markShown = () => {
    localStorage.setItem(POPUP_STORAGE_KEY, Date.now().toString());
    localStorage.removeItem(LEGACY_POPUP_STORAGE_KEY);
  };

  const handleClose = () => {
    setIsVisible(false);
    markShown();
  };

  const handleCTA = () => {
    if (!campaign) return;
    markShown();
    setIsVisible(false);
    navigate(buildInternalHaloMiniLink(campaign, "popup"));
  };

  if (!isVisible || !campaign) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-[#191F28]/60 px-5">
      <div className="animate-rise relative w-full max-w-sm rounded-[20px] bg-white px-5 pt-6 pb-5 text-[#191F28] shadow-[0_8px_40px_rgba(25,31,40,.22)]">
        <button
          type="button"
          onClick={handleClose}
          className="pressed absolute top-3 right-3 p-2 text-[#B0B8C1]"
          aria-label={t('Close')}
        >
          <CloseIcon />
        </button>

        {/* The country this offer is for, said once. It was an uppercase
            letter-spaced pill — "SPECIAL FOR PHILIPPINES" — which is the one
            typographic register this app does not have. */}
        <p className="flex items-center justify-center gap-1.5 text-[12.5px] font-bold tracking-[-.02em] text-[#8B95A1]">
          <span className="text-[15px] leading-none">{campaign.flag}</span>
          {t('Only in {{country}}', { country: campaign.countryName })}
        </p>

        <div className="mt-3.5 flex justify-center">
          <img src="/halo-mini-coin.webp" alt="" className="h-[68px] w-[68px]" />
        </div>

        <h3 className="mt-3.5 break-keep text-center text-[20px] font-extrabold tracking-[-.035em]">
          {t('Get 10,000 Halo Mini Points')}
        </h3>
        <p className="mt-2 break-keep text-center text-[14.5px] leading-[1.55] font-medium text-[#8B95A1]">
          {t('Plus {{brand}} rewards — exclusive for Halo users in your country', {
            brand: campaign.rewardBrand,
          })}
        </p>

        <div className="mt-5 space-y-2">
          <Benefit
            icon={<img src="/halo-mini-coin.webp" alt="" className="h-5 w-5" />}
            text={t('10,000 free Halo Mini points')}
          />
          <Benefit icon={<GiftIcon />} tone="warm" text={t('Exclusive {{brand}} rewards', { brand: campaign.rewardBrand })} />
        </div>

        <div className="mt-6 space-y-2.5">
          <Button onClick={handleCTA}>{t('Claim Now')}</Button>
          <Button variant="ghost" onClick={handleClose}>
            {t('Maybe later')}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** One line of what the other app is offering. */
function Benefit({
  icon,
  text,
  tone = 'neutral',
}: {
  icon: ReactNode;
  text: string;
  tone?: 'neutral' | 'warm';
}) {
  return (
    <div className="flex items-center gap-3 rounded-[14px] bg-[#F2F4F6] px-3.5 py-3">
      <span
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] ${
          tone === 'warm' ? 'bg-[#FFF1E6] text-[#E8833A]' : 'bg-white text-[#4E5968]'
        }`}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1 break-keep text-[14px] font-semibold tracking-[-.02em]">
        {text}
      </span>
    </div>
  );
}
