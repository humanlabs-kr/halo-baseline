import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { isDeveloperAddress } from "@/lib/env";
import { useAuthStore } from "@/stores/auth";
import {
  ADMIN_FALLBACK_CAMPAIGN,
  buildHaloMiniInstallUrl,
  getEnabledCountryCampaigns,
  getHaloMiniCampaignByCode,
  type HaloMiniCampaignWithCode,
} from "@/lib/halo-mini-campaigns";

const ALLOWED_SURFACES = ["banner", "popup", "direct"] as const;
type Surface = (typeof ALLOWED_SURFACES)[number];

// Inline icons — one page does not justify pulling in an icon library.
const ChevronLeft = ({ className }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
  </svg>
);
const ChevronRight = ({ className }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
  </svg>
);
const Gift = ({ className }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M12 8v13m0-13V6a2 2 0 112 2h-2zm0 0V5.5A2.5 2.5 0 109.5 8H12zm-7 4h14M5 12a2 2 0 110-4h14a2 2 0 110 4M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7"
    />
  </svg>
);
const Coins = ({ className }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <circle cx="9" cy="9" r="6" strokeWidth={2} />
    <circle cx="15" cy="15" r="6" strokeWidth={2} />
  </svg>
);
const BadgeCheck = ({ className }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
    />
  </svg>
);
const Gamepad = ({ className }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
    />
    <rect x={3} y={5} width={18} height={14} rx={3} strokeWidth={2} />
  </svg>
);
const Trophy = ({ className }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M5 3v4a4 4 0 008 0V3M19 3v4a4 4 0 01-4 4M5 3h14M9 21h6m-3 0v-4m-4-1h8a2 2 0 002-2v-3H6v3a2 2 0 002 2z"
    />
  </svg>
);
const Phone = ({ className }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <rect x={6} y={3} width={12} height={18} rx={2} strokeWidth={2} />
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 18h2" />
  </svg>
);
const Star = ({ className }: { className?: string }) => (
  <svg className={className} fill="currentColor" viewBox="0 0 24 24">
    <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
  </svg>
);

function EventHaloMini() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const address = useAuthStore((s) => s.user?.address);
  const platform = useAuthStore((s) => s.platform);

  // Always send the user back to the top of the page on mount.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  const fromParam = searchParams.get("from") ?? "";
  const surface: Surface = (ALLOWED_SURFACES as readonly string[]).includes(fromParam)
    ? (fromParam as Surface)
    : "direct";

  const isInternalTest = isDeveloperAddress(address);

  // Resolve the variant:
  //  - If ?geo= is a valid enabled campaign (PH/VN/ID/TH/EN), use that
  //  - Else if dev → fall back to EN (lets devs preview without a geo param)
  //  - Else → null → render the "not available" gate
  const geoParam = searchParams.get("geo");
  const validParamCampaign = getHaloMiniCampaignByCode(geoParam ?? undefined);
  const campaign: HaloMiniCampaignWithCode | null =
    validParamCampaign ?? (isInternalTest ? ADMIN_FALLBACK_CAMPAIGN : null);

  if (!campaign) {
    return <NotAvailableGate />;
  }

  const installUrl = buildHaloMiniInstallUrl(campaign, surface, isInternalTest, platform);
  // No dynamic link configured for this deployment: there is nothing to
  // install, so show the same page a user in an unsupported country gets.
  if (!installUrl) {
    return <NotAvailableGate />;
  }

  return (
    <div className="w-full h-full flex flex-col overflow-y-auto scrollbar-hide bg-[#0a0d0c]">
      <button
        onClick={() => navigate(-1)}
        className="fixed top-4 left-4 z-50 p-2.5 bg-black/60 backdrop-blur-md rounded-full border border-white/10"
        aria-label={t("Back")}
      >
        <ChevronLeft className="w-5 h-5 text-white" />
      </button>

      {/* Hero */}
      <div className="relative px-6 pt-16 pb-10">
        <div className="absolute inset-0 bg-gradient-to-b from-emerald-500/15 via-emerald-500/5 to-transparent" />
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[400px] h-[300px] bg-emerald-500/20 rounded-full blur-[100px]" />

        <div className="relative flex flex-col items-center text-center">
          <div className="flex items-center gap-2 px-3 py-1.5 bg-emerald-500/10 rounded-full border border-emerald-500/20 mb-5">
            <span className="text-lg leading-none">{campaign.flag}</span>
            <span className="text-xs font-bold tracking-wider text-emerald-400">
              {t(campaign.flagBadgeKey)}
            </span>
          </div>

          <h1 className="text-3xl font-bold text-white leading-tight">
            {t("Get 10,000 Halo Mini Points")}
          </h1>
          <h2 className="text-3xl font-bold leading-tight text-emerald-400">
            {t("+ {{brand}} Rewards", { brand: campaign.rewardBrand })}
          </h2>

          <p className="mt-4 text-white/50 text-sm max-w-[280px]">
            {t("Play mini games, earn rewards redeemable via {{brand}}.", {
              brand: campaign.rewardBrand,
            })}
          </p>

          {/* Hero artwork */}
          <div className="mt-8 relative">
            <div className="absolute inset-0 bg-emerald-500/20 blur-2xl rounded-3xl" />
            <div className="relative w-64 h-64 rounded-3xl border border-white/10 shadow-xl overflow-hidden bg-gradient-to-br from-emerald-500/10 to-teal-600/10">
              <img
                src="/halo-mini-hero.webp"
                alt="Halo Mini"
                className="w-full h-full object-cover"
              />
            </div>
            <div className="absolute -top-2 -right-2 w-12 h-12 rounded-full bg-zinc-900 border-2 border-emerald-500/40 flex items-center justify-center text-3xl shadow-lg">
              {campaign.flag}
            </div>
            <div className="absolute -bottom-2 left-1/2 -translate-x-1/2 px-3 py-1 bg-emerald-500 rounded-full text-xs font-bold text-white">
              {t("FREE")}
            </div>
          </div>
        </div>
      </div>

      <div className="px-5 pb-10">
        {/* Bonus highlight */}
        <div className="p-4 rounded-xl bg-gradient-to-r from-emerald-500/15 to-emerald-600/10 border border-emerald-500/30">
          <div className="flex items-center gap-2 mb-2">
            <Gift className="w-5 h-5 text-emerald-400" />
            <p className="font-semibold text-white">
              {t("Halo Exclusive Bonus")}
            </p>
          </div>
          <p className="text-emerald-400 font-bold text-lg">
            {t("10,000 Halo Mini Points + {{brand}} Rewards", {
              brand: campaign.rewardBrand,
            })}
          </p>
          <p className="text-white/40 text-xs mt-2">
            {t("Download via this page to claim your exclusive bonus.")}
          </p>
        </div>

        {/* Primary CTA */}
        <a
          href={installUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 w-full flex items-center justify-center gap-2 py-4 rounded-xl font-bold text-lg bg-emerald-500 hover:bg-emerald-400 transition-colors text-black shadow-lg shadow-emerald-500/20"
        >
          {t("Download Halo Mini")}
          <ChevronRight className="w-5 h-5" />
        </a>
        <p className="text-center text-white/40 text-xs mt-2">
          {t("Free to install on iOS & Android")}
        </p>

        {/* Features */}
        <div className="mt-10">
          <p className="text-white/40 text-xs uppercase tracking-wider mb-4">
            {t("Why You'll Love Halo Mini")}
          </p>
          <div className="space-y-4">
            <FeatureRow
              icon={<Gamepad className="w-5 h-5 text-emerald-400" />}
              title={t("Quick Mini Games")}
              desc={t("Tap, scratch, and spin — every round under 60 seconds.")}
            />
            <FeatureRow
              icon={<Coins className="w-5 h-5 text-emerald-400" />}
              title={t("Real Rewards")}
              desc={t(
                "Redeem coins for digital gift cards or mobile load — sent direct to your number."
              )}
            />
            <FeatureRow
              icon={<Trophy className="w-5 h-5 text-emerald-400" />}
              title={t("Compete & Climb")}
              desc={t("Invite friends, climb the leaderboard, earn Legendary Boxes.")}
            />
            <FeatureRow
              icon={<Phone className="w-5 h-5 text-emerald-400" />}
              title={t("Lightweight")}
              desc={t("Smooth even on older phones. One-handed controls, play anywhere.")}
            />
          </div>
        </div>

        {/* Reward breakdown */}
        <div className="mt-10 p-5 rounded-xl bg-gradient-to-b from-white/[0.06] to-white/[0.02] border border-white/10">
          <div className="flex items-center gap-2 mb-4">
            <Star className="w-5 h-5 text-emerald-400" />
            <p className="text-white font-semibold">{t("Your Bonus")}</p>
          </div>

          <div className="grid grid-cols-2 gap-4 mb-4">
            <div className="relative p-3 rounded-lg bg-black/30 overflow-hidden">
              <img
                src="/halo-mini-coin.webp"
                alt=""
                className="absolute -right-2 -bottom-2 w-16 h-16 opacity-90 drop-shadow-[0_0_8px_rgba(251,191,36,0.4)]"
              />
              <div className="relative">
                <p className="text-white/50 text-xs mb-1">{t("Points")}</p>
                <p className="text-emerald-400 text-2xl font-bold">10,000</p>
                <p className="text-white/50 text-xs font-medium">
                  {t("Halo Mini Points")}
                </p>
              </div>
            </div>
            <div className="p-3 rounded-lg bg-black/30">
              <p className="text-white/50 text-xs mb-1">{t("Rewards")}</p>
              <p className="text-emerald-400 text-2xl font-bold">★</p>
              <p className="text-white/50 text-xs font-medium">
                {t("{{brand}} Exclusive", { brand: campaign.rewardBrand })}
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Coins className="w-4 h-4 text-emerald-400/70" />
              <span className="text-white/70 text-sm">
                {t("Use points for gift cards & mobile load")}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <BadgeCheck className="w-4 h-4 text-emerald-400/70" />
              <span className="text-white/70 text-sm">
                {t("Redeem points for {{brand}} vouchers", {
                  brand: campaign.rewardBrand,
                })}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Gift className="w-4 h-4 text-emerald-400/70" />
              <span className="text-white/70 text-sm">
                {t("Bonus credited after first launch")}
              </span>
            </div>
          </div>
        </div>

        {/* How to claim */}
        <div className="mt-10">
          <p className="text-white/40 text-xs uppercase tracking-wider mb-4">
            {t("How to Claim Your Bonus")}
          </p>
          <div className="relative">
            <div className="absolute left-[15px] top-8 bottom-8 w-[2px] bg-emerald-500/20" />
            <div className="space-y-6">
              <Step
                n={1}
                step={t("Tap Download Halo Mini")}
                desc={t("Use the link on this page so we can attribute your install.")}
              />
              <Step
                n={2}
                step={t("Install & open the app")}
                desc={t("Free download on iOS & Android.")}
              />
              <Step
                n={3}
                step={t("Sign up with your phone")}
                desc={t("Create your Halo Mini account to start playing.")}
              />
              <Step
                n={4}
                step={t("Claim your 10K Points + Rewards")}
                desc={t("Bonus appears in your account after first launch.")}
              />
            </div>
          </div>
        </div>

        {/* Final CTA */}
        <div className="mt-10 p-6 rounded-2xl bg-gradient-to-b from-emerald-500/15 to-emerald-500/5 border border-emerald-500/30">
          <div className="w-16 h-16 rounded-2xl overflow-hidden mx-auto mb-4 ring-2 ring-emerald-500/30 shadow-lg shadow-emerald-500/20">
            <img src="/halo-mini.webp" alt="Halo Mini" className="w-full h-full object-cover" />
          </div>
          <p className="text-white font-bold text-xl text-center">
            {t("Ready to play & earn?")}
          </p>
          <p className="text-white/50 text-sm text-center mt-2">
            {t("Play Halo Mini, earn mobile load and gift cards")}
          </p>
          <a
            href={installUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-5 w-full flex items-center justify-center gap-2 py-4 rounded-xl font-bold text-lg text-center bg-emerald-500 hover:bg-emerald-400 transition-colors text-black shadow-lg shadow-emerald-500/20"
          >
            {t("Download Halo Mini")}
            <ChevronRight className="w-5 h-5" />
          </a>
          <p className="text-center text-white/30 text-xs mt-3">
            {t("Free to play — no purchase required")}
          </p>
        </div>

        <p className="mt-6 text-center text-white/30 text-[10px] px-4">
          {t(
            "* Bonus is for Halo users in supported countries who install Halo Mini via this page. Bonus credited after first app launch."
          )}
        </p>
      </div>
    </div>
  );
}

function FeatureRow({
  icon,
  title,
  desc,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
}) {
  return (
    <div className="p-4 rounded-xl bg-white/[0.03] border border-white/10">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-lg bg-emerald-500/20 flex items-center justify-center flex-shrink-0">
          {icon}
        </div>
        <div>
          <p className="text-white font-medium">{title}</p>
          <p className="text-white/50 text-sm mt-1">{desc}</p>
        </div>
      </div>
    </div>
  );
}

function Step({ n, step, desc }: { n: number; step: string; desc: string }) {
  return (
    <div className="flex items-start gap-4 relative">
      <div className="w-8 h-8 rounded-full bg-emerald-500 text-black text-sm font-bold flex items-center justify-center flex-shrink-0 relative z-10">
        {n}
      </div>
      <div className="pt-1">
        <p className="text-white font-medium">{step}</p>
        <p className="text-white/50 text-sm mt-0.5">{desc}</p>
      </div>
    </div>
  );
}

// Shown when a user lands on /event/halo-mini without a valid geo param
// and isn't a dev. Mirrors jw_clicker's gate page.
function NotAvailableGate() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const enabled = getEnabledCountryCampaigns();

  return (
    <div className="w-full min-h-screen flex flex-col bg-[#0a0d0c]">
      <button
        onClick={() => navigate(-1)}
        className="fixed top-4 left-4 z-50 p-2.5 bg-black/60 backdrop-blur-md rounded-full border border-white/10"
        aria-label={t("Back")}
      >
        <ChevronLeft className="w-5 h-5 text-white" />
      </button>

      <div className="flex-1 flex flex-col items-center justify-center px-6 text-center min-h-screen relative">
        <div className="absolute top-1/3 left-1/2 -translate-x-1/2 w-[300px] h-[200px] bg-emerald-500/10 rounded-full blur-[80px]" />

        <div className="relative w-16 h-16 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center mb-6">
          <span className="text-3xl">🌏</span>
        </div>

        <h1 className="relative text-2xl font-bold text-white mb-3 leading-tight">
          {enabled.length > 0
            ? t("Offer Not Available in Your Region")
            : t("Coming Soon")}
        </h1>

        <p className="relative text-white/60 text-sm mb-6 max-w-[280px]">
          {enabled.length > 0
            ? t("This offer is currently available in:")
            : t(
                "Halo Mini is rolling out soon — check back later for exclusive bonuses."
              )}
        </p>

        {enabled.length > 0 && (
          <div className="relative flex flex-col gap-2 mb-8">
            {enabled.map((c) => (
              <div
                key={c.code}
                className="flex items-center gap-3 px-4 py-2 bg-white/5 rounded-full border border-white/10"
              >
                <span className="text-xl leading-none">{c.flag}</span>
                <span className="text-white text-sm">{c.countryName}</span>
              </div>
            ))}
          </div>
        )}

        <button
          onClick={() => navigate("/ledger")}
          className="relative px-8 py-3 bg-emerald-500 text-black font-bold rounded-xl hover:bg-emerald-400 transition-colors"
        >
          {t("Back to Home")}
        </button>
      </div>
    </div>
  );
}

export default EventHaloMini;
