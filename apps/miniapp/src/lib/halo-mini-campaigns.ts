import type { Platform } from "@halo/contracts";
import { HALO_MINI_LINK } from "@/lib/env";

/**
 * Per-country cross-promo campaigns for Halo Mini.
 *
 * Banner and popup CTAs route through one dynamic link (`VITE_HALO_MINI_LINK`)
 * that handles iOS/Android store detection, deferred deep links and
 * attribution. The per-app UTM parameters appended below override the link's
 * own default tags, so installs can be credited to the chain the user came
 * from. With no link configured the cross-promo simply does not render.
 *
 * `EN` is a non-country fallback shown only in internal previews — it never
 * matches a real geo lookup, so users outside the target countries get the
 * "not available" page instead.
 */

export type HaloMiniCampaign = {
  enabled: boolean;
  flag: string;
  countryName: string;
  flagBadgeKey: string;
  utmCampaign: string;
  // Country-specific gift-card / voucher brand the bonus is redeemable for.
  // Injected into copy via the {{brand}} i18next interpolation token so a
  // single English source key works across all 4 countries.
  rewardBrand: string;
  isFallback?: boolean;
};

export const HALO_MINI_CAMPAIGNS: Record<string, HaloMiniCampaign> = {
  // Live in PH/VN/ID/TH/MY/SG/CL/MX/CO/BR/EC/PE/GT/JP/AR/ZA/KE/NG/GH/UG/KR/CI/CM/TZ/NL/IN/TW/CN/ES/PT/UY.
  // Flip enabled→false to disable a single country without removing the entry (preserves translations + utm_campaign codes).
  PH: {
    enabled: true,
    flag: "🇵🇭",
    countryName: "Philippines",
    flagBadgeKey: "SPECIAL FOR PHILIPPINES",
    utmCampaign: "ph_special",
    rewardBrand: "GrabGifts",
  },
  VN: {
    enabled: true,
    flag: "🇻🇳",
    countryName: "Vietnam",
    flagBadgeKey: "SPECIAL FOR VIETNAM",
    utmCampaign: "vn_special",
    rewardBrand: "GrabGifts",
  },
  ID: {
    enabled: true,
    flag: "🇮🇩",
    countryName: "Indonesia",
    flagBadgeKey: "SPECIAL FOR INDONESIA",
    utmCampaign: "id_special",
    rewardBrand: "GrabGifts",
  },
  TH: {
    enabled: true,
    flag: "🇹🇭",
    countryName: "Thailand",
    flagBadgeKey: "SPECIAL FOR THAILAND",
    utmCampaign: "th_special",
    rewardBrand: "Line Man",
  },
  MY: {
    enabled: true,
    flag: "🇲🇾",
    countryName: "Malaysia",
    flagBadgeKey: "SPECIAL FOR MALAYSIA",
    utmCampaign: "my_special",
    rewardBrand: "Foodpanda",
  },
  SG: {
    enabled: true,
    flag: "🇸🇬",
    countryName: "Singapore",
    flagBadgeKey: "SPECIAL FOR SINGAPORE",
    utmCampaign: "sg_special",
    rewardBrand: "GrabGifts",
  },
  CL: {
    enabled: true,
    flag: "🇨🇱",
    countryName: "Chile",
    flagBadgeKey: "SPECIAL FOR CHILE",
    utmCampaign: "cl_special",
    rewardBrand: "Rappi",
  },
  MX: {
    enabled: true,
    flag: "🇲🇽",
    countryName: "Mexico",
    flagBadgeKey: "SPECIAL FOR MEXICO",
    utmCampaign: "mx_special",
    rewardBrand: "Rappi",
  },
  CO: {
    enabled: true,
    flag: "🇨🇴",
    countryName: "Colombia",
    flagBadgeKey: "SPECIAL FOR COLOMBIA",
    utmCampaign: "co_special",
    rewardBrand: "PayPal",
  },
  BR: {
    enabled: true,
    flag: "🇧🇷",
    countryName: "Brazil",
    flagBadgeKey: "SPECIAL FOR BRAZIL",
    utmCampaign: "br_special",
    rewardBrand: "Shopee",
  },
  EC: {
    enabled: true,
    flag: "🇪🇨",
    countryName: "Ecuador",
    flagBadgeKey: "SPECIAL FOR ECUADOR",
    utmCampaign: "ec_special",
    rewardBrand: "PayPal",
  },
  PE: {
    enabled: true,
    flag: "🇵🇪",
    countryName: "Peru",
    flagBadgeKey: "SPECIAL FOR PERU",
    utmCampaign: "pe_special",
    rewardBrand: "Uber Rides",
  },
  GT: {
    enabled: true,
    flag: "🇬🇹",
    countryName: "Guatemala",
    flagBadgeKey: "SPECIAL FOR GUATEMALA",
    utmCampaign: "gt_special",
    rewardBrand: "Uber Eats",
  },
  JP: {
    enabled: true,
    flag: "🇯🇵",
    countryName: "Japan",
    flagBadgeKey: "SPECIAL FOR JAPAN",
    utmCampaign: "jp_special",
    rewardBrand: "Uber Eats",
  },
  AR: {
    enabled: true,
    flag: "🇦🇷",
    countryName: "Argentina",
    flagBadgeKey: "SPECIAL FOR ARGENTINA",
    utmCampaign: "ar_special",
    rewardBrand: "Frávega & PayPal",
  },
  ZA: {
    enabled: true,
    flag: "🇿🇦",
    countryName: "South Africa",
    flagBadgeKey: "SPECIAL FOR SOUTH AFRICA",
    utmCampaign: "za_special",
    rewardBrand: "Airtime, PayPal & Visa",
  },
  KE: {
    enabled: true,
    flag: "🇰🇪",
    countryName: "Kenya",
    flagBadgeKey: "SPECIAL FOR KENYA",
    utmCampaign: "ke_special",
    rewardBrand: "Airtime, PayPal & Visa",
  },
  NG: {
    enabled: true,
    flag: "🇳🇬",
    countryName: "Nigeria",
    flagBadgeKey: "SPECIAL FOR NIGERIA",
    utmCampaign: "ng_special",
    rewardBrand: "Airtime & Visa",
  },
  GH: {
    enabled: true,
    flag: "🇬🇭",
    countryName: "Ghana",
    flagBadgeKey: "SPECIAL FOR GHANA",
    utmCampaign: "gh_special",
    rewardBrand: "Airtime & Visa",
  },
  UG: {
    enabled: true,
    flag: "🇺🇬",
    countryName: "Uganda",
    flagBadgeKey: "SPECIAL FOR UGANDA",
    utmCampaign: "ug_special",
    rewardBrand: "Airtime",
  },
  KR: {
    enabled: true,
    flag: "🇰🇷",
    countryName: "South Korea",
    flagBadgeKey: "SPECIAL FOR KOREA",
    utmCampaign: "kr_special",
    rewardBrand: "Google Play & PayPal",
  },
  CI: {
    enabled: true,
    flag: "🇨🇮",
    countryName: "Côte d'Ivoire",
    flagBadgeKey: "SPECIAL FOR IVORY COAST",
    utmCampaign: "ci_special",
    rewardBrand: "Airtime & Visa",
  },
  CM: {
    enabled: true,
    flag: "🇨🇲",
    countryName: "Cameroon",
    flagBadgeKey: "SPECIAL FOR CAMEROON",
    utmCampaign: "cm_special",
    rewardBrand: "Airtime & Visa",
  },
  TZ: {
    enabled: true,
    flag: "🇹🇿",
    countryName: "Tanzania",
    flagBadgeKey: "SPECIAL FOR TANZANIA",
    utmCampaign: "tz_special",
    rewardBrand: "Airtime & Visa",
  },
  NL: {
    enabled: true,
    flag: "🇳🇱",
    countryName: "Netherlands",
    flagBadgeKey: "SPECIAL FOR NETHERLANDS",
    utmCampaign: "nl_special",
    rewardBrand: "PayPal & Visa",
  },
  IN: {
    enabled: true,
    flag: "🇮🇳",
    countryName: "India",
    flagBadgeKey: "SPECIAL FOR INDIA",
    utmCampaign: "in_special",
    rewardBrand: "Zomato",
  },
  TW: {
    enabled: true,
    flag: "🇹🇼",
    countryName: "Taiwan",
    flagBadgeKey: "SPECIAL FOR TAIWAN",
    utmCampaign: "tw_special",
    rewardBrand: "Uber Eats",
  },
  CN: {
    enabled: true,
    flag: "🇨🇳",
    countryName: "China",
    flagBadgeKey: "SPECIAL FOR CHINA",
    utmCampaign: "cn_special",
    rewardBrand: "Meituan",
  },
  ES: {
    enabled: true,
    flag: "🇪🇸",
    countryName: "Spain",
    flagBadgeKey: "SPECIAL FOR SPAIN",
    utmCampaign: "es_special",
    rewardBrand: "PayPal & Visa",
  },
  PT: {
    enabled: true,
    flag: "🇵🇹",
    countryName: "Portugal",
    flagBadgeKey: "SPECIAL FOR PORTUGAL",
    utmCampaign: "pt_special",
    rewardBrand: "PayPal & Visa",
  },
  UY: {
    enabled: true,
    flag: "🇺🇾",
    countryName: "Uruguay",
    flagBadgeKey: "SPECIAL FOR URUGUAY",
    utmCampaign: "uy_special",
    rewardBrand: "PayPal",
  },
  EN: {
    enabled: true,
    flag: "🌍",
    countryName: "Global",
    flagBadgeKey: "EXCLUSIVE OFFER",
    utmCampaign: "global_special",
    rewardBrand: "Gift Cards",
    isFallback: true,
  },
};

export type HaloMiniCampaignWithCode = HaloMiniCampaign & { code: string };

// Resolves a real country code (e.g. "PH") to an enabled, country-specific campaign.
// EN is excluded — it's a fallback variant, never a geo match.
export const getHaloMiniCampaign = (
  country: string | undefined
): HaloMiniCampaignWithCode | null => {
  if (!country) return null;
  const config = HALO_MINI_CAMPAIGNS[country];
  if (!config?.enabled || config.isFallback) return null;
  return { ...config, code: country };
};

// Resolves any campaign code (including EN) — used by the detail page when
// rendering an explicit ?geo= param including the EN fallback for admins.
export const getHaloMiniCampaignByCode = (
  code: string | undefined
): HaloMiniCampaignWithCode | null => {
  if (!code) return null;
  const config = HALO_MINI_CAMPAIGNS[code];
  if (!config?.enabled) return null;
  return { ...config, code };
};

// Default variant shown to devs (bypasses geo). Generic English / globe — keeps
// internal QA neutral instead of always landing on a country-specific variant.
const EN_FALLBACK: HaloMiniCampaign = {
  enabled: true,
  flag: "🌍",
  countryName: "Global",
  flagBadgeKey: "EXCLUSIVE OFFER",
  utmCampaign: "global_special",
  rewardBrand: "Gift Cards",
  isFallback: true,
};

export const ADMIN_FALLBACK_CAMPAIGN: HaloMiniCampaignWithCode = {
  ...EN_FALLBACK,
  code: "EN",
};

// Country campaigns shown on the "Offer Not Available" gate page.
export const getEnabledCountryCampaigns = (): HaloMiniCampaignWithCode[] =>
  Object.entries(HALO_MINI_CAMPAIGNS)
    .filter(([, c]) => c.enabled && !c.isFallback)
    .map(([code, c]) => ({ ...c, code }));

// Internal route to the Halo Celo detail page — banner/popup navigate
// here first, then the detail-page CTA jumps out to the dynamic link.
export const buildInternalHaloMiniLink = (
  campaign: HaloMiniCampaignWithCode,
  surface: "banner" | "popup"
): string => `/event/halo-mini?from=${surface}&geo=${campaign.code}`;

/**
 * Builds the outbound install link.
 *
 * The link itself is deployment configuration, not code: it points at a
 * partner's dynamic-link host and differs per environment, so it is read from
 * `VITE_HALO_MINI_LINK`. When it is unset the caller gets `null` and the
 * cross-promo surfaces hide themselves.
 *
 * `isInternalTest` suffixes the campaign tag so QA clicks stay out of the
 * real attribution numbers.
 */
export const buildHaloMiniInstallUrl = (
  campaign: HaloMiniCampaignWithCode,
  surface: "banner" | "popup" | "direct",
  isInternalTest: boolean,
  platform: Platform | null,
): string | null => {
  if (!HALO_MINI_LINK) return null;
  const utmCampaign = isInternalTest
    ? `${campaign.utmCampaign}_internal`
    : campaign.utmCampaign;
  // All values here are alphanumeric or underscore. If a future UTM value can
  // contain a reserved character, wrap that value — not the whole string — in
  // encodeURIComponent.
  const query = [
    `utm_source=halo_${platform ?? "unknown"}`,
    "utm_medium=cross_promo",
    `utm_campaign=${utmCampaign}`,
    `utm_content=${surface}`,
  ].join("&");
  return `${HALO_MINI_LINK}?${query}`;
};
