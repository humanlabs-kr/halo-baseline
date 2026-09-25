import { useTranslation } from 'react-i18next';
import { unitName } from '@/lib/basket';
import { useFormatters, type Formatters } from '@/lib/format';
import type { LangCode } from '@/lib/i18n';

/**
 * Money, in the currency the receipts were printed in.
 *
 * Tabular figures throughout: a ledger is a column of numbers, and proportional
 * digits make the column ragged enough that two amounts stop being comparable
 * at a glance, which is the only thing the column is for.
 */
export function Amount({
  value,
  currency,
  className = '',
}: {
  value: number;
  currency: string;
  className?: string;
}) {
  const fmt = useFormatters();

  return (
    <span className={`tabular-nums tracking-[-.02em] ${className}`}>
      {formatMoney(value, currency, fmt)}
    </span>
  );
}

/**
 * Currencies that are written after the number in their own language.
 *
 * `Intl` cannot do this: asked for KRW in Korean it answers `₩62,900`, and
 * every Korean app on the phone writes `62,900원`. The symbol is not wrong,
 * it is foreign — it is what a price looks like to someone reading *about*
 * Korea rather than someone shopping in it.
 *
 * Keyed on the pair, not on the currency alone. `₩` is the clearer form for a
 * reader who does not read Korean, so a Japanese user looking at a Korean
 * receipt still gets the symbol. Only the languages whose convention is known
 * are listed; a guess here would be worse than the symbol.
 */
const SUFFIX: Partial<Record<LangCode, Partial<Record<string, string>>>> = {
  ko: { KRW: '원' },
  ja: { JPY: '円' },
  'zh-CN': { CNY: '元' },
  'zh-TW': { TWD: '元' },
};

/**
 * Money as this reader writes it.
 *
 * Exported because two components print amounts and they must not disagree:
 * one of them printing `₩62,900` beside the other's `62,900원` is the kind of
 * difference that reads as a bug in the numbers rather than in the styling.
 */
export function formatMoney(value: number, currency: string, fmt: Formatters): string {
  const rounded = fmt.number(Math.round(value));
  const suffix = SUFFIX[fmt.lang]?.[currency];

  return suffix ? `${rounded}${suffix}` : `${symbolFor(currency)}${rounded}`;
}

/**
 * A price change, said in money rather than percent.
 *
 * Percent is the natural unit for an index and the wrong one for a shopper:
 * "8.2%" needs a multiplication before it means anything, "₦64 more a kg" does
 * not. Percent still appears beside this as a secondary chip.
 */
export function UnitChange({
  change,
  unit,
  currency,
  priced = true,
}: {
  change: number | null;
  unit: string;
  currency: string;
  /** False when nothing in the category could be priced this month. */
  priced?: boolean;
}) {
  const { t } = useTranslation();
  const money = useMoneyText();

  // Three different absences, and they used to be one. `null` meant "first
  // sighting" *and* "no price this month", so a category whose lines had no
  // readable pack size was announced as newly bought every month forever.
  if (!priced) return <span className="text-[#8B95A1]">{t('No price we could read')}</span>;
  if (change === null) return <span className="text-[#8B95A1]">{t('first time')}</span>;
  if (Math.round(change) === 0) return <span className="text-[#8B95A1]">{t('same as last month')}</span>;

  const dearer = change > 0;
  const values = { amount: money(Math.abs(change), currency), unit: unitName(unit, t) };

  return (
    <span className={dearer ? 'text-[#F04452]' : 'text-[#00A06A]'}>
      {dearer
        ? t('{{amount}} more a {{unit}}', values)
        : t('{{amount}} less a {{unit}}', values)}
    </span>
  );
}

/**
 * Money as a plain string, for the places it sits inside a sentence.
 *
 * `<Amount>` is a component and cannot be interpolated into a `Trans` value,
 * and the alternative — cutting the sentence around it — ships English word
 * order to twenty locales. Only the number comes through here; words like
 * "less" belong in the translated sentence, not glued on in English.
 */
export function useMoneyText() {
  const fmt = useFormatters();

  return (value: number, currency: string) => formatMoney(value, currency, fmt);
}

/**
 * Country names for the market line.
 *
 * `Intl.DisplayNames` would cover every code and localise itself, but it is
 * missing on some of the older Android WebViews this ships into, where it
 * throws rather than degrading. The map covers the markets we actually have
 * receipts from and the code is the fallback — wrong-looking, never misleading.
 */
/**
 * The country, in the language on screen.
 *
 * `Intl.DisplayNames` is the right tool and is missing on some of the older
 * Android WebViews this ships into, where it throws rather than degrading. So
 * it is tried, and the English table is the fallback — which is what the
 * sentence used to say in every locale: "Korea 사람들보다" in an otherwise
 * Korean line.
 */
export function countryName(code: string, lang?: string): string {
  const upper = code.toUpperCase();

  if (lang) {
    try {
      // The short form. Sentences on these screens are about people — "한국
      // 사람들보다", "than most people in the UK" — and the long form puts
      // "대한민국" and "United Kingdom" in the middle of them, which reads
      // like a customs form. Only the handful of countries with a formal long
      // name differ; "나이지리아" and "Nigeria" are the same either way.
      const named = new Intl.DisplayNames([lang], { type: 'region', style: 'short' }).of(upper);
      if (named && named !== upper) return named;
    } catch {
      // Older WebView. Fall through to the table.
    }
  }

  return COUNTRIES[upper] ?? code;
}

const COUNTRIES: Record<string, string> = {
  NG: 'Nigeria',
  KE: 'Kenya',
  GH: 'Ghana',
  ZA: 'South Africa',
  TZ: 'Tanzania',
  UG: 'Uganda',
  ID: 'Indonesia',
  MY: 'Malaysia',
  TH: 'Thailand',
  VN: 'Vietnam',
  PH: 'the Philippines',
  IN: 'India',
  BR: 'Brazil',
  AR: 'Argentina',
  MX: 'Mexico',
  CO: 'Colombia',
  PE: 'Peru',
  US: 'the US',
  GB: 'the UK',
  JP: 'Japan',
  KR: 'Korea',
};

const SYMBOLS: Record<string, string> = {
  NGN: '₦',
  KES: 'KSh',
  GHS: 'GH₵',
  IDR: 'Rp',
  USD: '$',
  EUR: '€',
  JPY: '¥',
  KRW: '₩',
  BRL: 'R$',
  ARS: '$',
  ZAR: 'R',
};

/** Falls back to the ISO code, which is wrong-looking but never misleading. */
function symbolFor(currency: string): string {
  return SYMBOLS[currency] ?? `${currency} `;
}
