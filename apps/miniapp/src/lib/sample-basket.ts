import { countryName } from '@/components/ledger/Amount';
import { categoryName, unitEach } from '@/lib/basket';
import type { TFunction } from 'i18next';
import type { LangCode } from '@/lib/i18n';

/**
 * The shopping shown on the entry screens, in the reader's own money.
 *
 * The deck this replaces printed `₦840 a kilo` to everyone, including the
 * Korean users who had just told us what language they read. Nothing about
 * that basket was true for them, and it is the first screen of the product.
 *
 * Three rules this file follows, all of them learnt the hard way:
 *
 * 1. **No real shop names.** The old mock-ups used E-Mart and a named market.
 *    Putting another company's trading name on a fabricated receipt inside our
 *    own product shot is not ours to do, so the shop is a translated common
 *    noun.
 * 2. **No invented precision.** These are illustrative prices, and they are
 *    round numbers at a plausible scale for the currency. They are never
 *    presented as a market figure — the real one comes from the API and
 *    arrives after a scan.
 * 3. **Currency follows the reader, not the wallet.** Onboarding runs before
 *    we have seen a single receipt, so there is no country on file. The
 *    language the person is reading is the only evidence we have.
 */
export interface SampleLine {
  /** Translated product description, as it would be printed. */
  name: string;
  /** Which of the twelve the ledger filed it under. Printed beside the unit
   *  price, because "what did it cost a kilo" is only half the answer — the
   *  other half is that the app knew this line was rice. */
  category: string | null;
  /** Line total. */
  total: number;
  /** Price per canonical unit, already divided out. Null when there is none. */
  unitPrice: number | null;
  /**
   * Which unit the price is per. A key, not a label: Korean puts the unit
   * before the money ("kg당 ₩3,800") and English after it ("₩3,800 a kilo"),
   * so the two have to be translated as one sentence rather than joined.
   */
  unit: 'kilo' | 'litre' | 'crate' | 'loaf' | null;
  /** Where this line sits against everyone else's. Null when nothing to compare. */
  standing: 'cheaper' | 'dearer' | 'same' | null;
  /** Distance from the median, in currency. Zero when `standing` is `same`. */
  delta: number;
}

export interface SampleBasket {
  currency: string;
  /** The reader's country, in the reader's language. Null when unknown. */
  country: string | null;
  shop: string;
  lines: SampleLine[];
  total: number;
  /** What the basket came in under the median by, across the priced lines. */
  saved: number;
}

/**
 * Region each shipped language is read in, for the purpose of picking money.
 *
 * A guess, and only ever used to choose an illustration. `es-419` is Latin
 * America as a whole and has no single currency; Mexico is the largest market
 * in it. `en` defaults to Nigeria rather than the United States because that
 * is where the receipts in this app actually come from.
 */
const LANG_REGION: Record<LangCode, string> = {
  en: 'NG',
  'en-GB': 'GB',
  ko: 'KR',
  ja: 'JP',
  'zh-CN': 'CN',
  'zh-TW': 'TW',
  'de-DE': 'DE',
  'nl-NL': 'NL',
  'fr-FR': 'FR',
  'es-ES': 'ES',
  'es-419': 'MX',
  'pt-BR': 'BR',
  'pt-PT': 'PT',
  pl: 'PL',
  id: 'ID',
  'ms-MY': 'MY',
  tl: 'PH',
  th: 'TH',
  vi: 'VN',
  hi: 'IN',
  sw: 'KE',
};

const REGION_CURRENCY: Record<string, string> = {
  NG: 'NGN', GB: 'GBP', KR: 'KRW', JP: 'JPY', CN: 'CNY', TW: 'TWD',
  DE: 'EUR', NL: 'EUR', FR: 'EUR', ES: 'EUR', PT: 'EUR',
  MX: 'MXN', BR: 'BRL', PL: 'PLN', ID: 'IDR', MY: 'MYR',
  PH: 'PHP', TH: 'THB', VN: 'VND', IN: 'INR', KE: 'KES',
};

/**
 * Four prices per currency, at the scale a shopper there would recognise.
 *
 * Written out rather than derived, because deriving them does not work. The
 * first attempt scaled one basket by a per-currency factor, which assumes
 * groceries keep the same ratios everywhere — and they do not. A litre of
 * cooking oil is about four and a half times a kilo of rice in Lagos and
 * about one and a third in Seoul, so the Korean screen advertised cooking oil
 * at ₩17,500 a litre and a crate of eggs at ₩20,500.
 *
 * Order: rice per kilo, oil per litre, eggs per crate, bread per loaf.
 */
const PRICES: Record<string, [number, number, number, number, number, number]> = {
  NGN: [840, 3900, 4500, 1300, 1600, 100],
  KRW: [3800, 5200, 7900, 3000, 2400, 100],
  JPY: [420, 480, 280, 180, 230, 5],
  CNY: [9, 22, 18, 9, 7, 0.2],
  TWD: [45, 130, 85, 40, 35, 1],
  GBP: [2, 3, 3, 1, 1, 0.2],
  EUR: [2, 4, 4, 2, 2, 0.1],
  MXN: [34, 40, 55, 40, 28, 1],
  BRL: [8, 9, 20, 8, 5, 0.1],
  PLN: [7, 12, 14, 6, 4, 0.5],
  IDR: [14000, 20000, 28000, 18000, 16000, 200],
  MYR: [5, 9, 14, 4, 3, 0.2],
  PHP: [62, 95, 110, 70, 65, 2],
  THB: [42, 60, 145, 45, 25, 2],
  VND: [26000, 45000, 38000, 25000, 22000, 2000],
  INR: [58, 150, 75, 45, 45, 5],
  KES: [180, 350, 480, 70, 150, 5],
};

/** Currencies written without a fraction. Used to round the derived figures. */
const WHOLE_UNIT = new Set(['KRW', 'JPY', 'IDR', 'VND', 'NGN', 'KES', 'CLP', 'PYG']);

function round(value: number, currency: string): number {
  if (!WHOLE_UNIT.has(currency)) return Math.round(value * 10) / 10;
  const step = value >= 10000 ? 500 : value >= 1000 ? 100 : value >= 100 ? 10 : 1;
  return Math.round(value / step) * step;
}

/** Smallest sum worth printing as a difference in this currency. */
function nudge(value: number, currency: string): number {
  const rounded = round(value, currency);
  if (rounded > 0) return rounded;
  return WHOLE_UNIT.has(currency) ? 1 : 0.1;
}

export function sampleBasket(lang: LangCode, t: TFunction): SampleBasket {
  const region = LANG_REGION[lang] ?? 'NG';
  const currency = REGION_CURRENCY[region] ?? 'NGN';
  const [rice, oil, eggs, bread, sugar, bag] = PRICES[currency] ?? PRICES.NGN!;

  const lines: SampleLine[] = [
    {
      name: t('Rice, 5 kg'),
      category: categoryName('rice', t),
      total: round(rice * 5, currency),
      unitPrice: rice,
      unit: 'kilo',
      standing: 'cheaper',
      delta: nudge(rice * 0.03, currency),
    },
    {
      name: t('Cooking oil, 1 L'),
      category: categoryName('cooking_oil', t),
      total: oil,
      unitPrice: oil,
      unit: 'litre',
      standing: 'dearer',
      delta: nudge(oil * 0.07, currency),
    },
    {
      name: t('Eggs, one crate'),
      category: categoryName('eggs', t),
      total: eggs,
      unitPrice: eggs,
      unit: 'crate',
      standing: 'cheaper',
      delta: nudge(eggs * 0.1, currency),
    },
    {
      name: t('Bread, one loaf'),
      category: categoryName('bread', t),
      total: bread,
      unitPrice: bread,
      unit: 'loaf',
      standing: 'same',
      delta: 0,
    },
    {
      name: t('Sugar, 1 kg'),
      category: categoryName('sugar', t),
      total: sugar,
      unitPrice: sugar,
      unit: 'kilo',
      standing: 'cheaper',
      delta: nudge(sugar * 0.04, currency),
    },
    // No unit and no comparison, on purpose. Most of a real receipt is lines
    // like this one, and a slip where every line has a verdict is a promise
    // the app does not keep.
    {
      name: t('Carrier bag'),
      category: null,
      total: bag,
      unitPrice: null,
      unit: null,
      standing: null,
      delta: 0,
    },
  ];

  const saved = lines.reduce(
    (sum, line) =>
      sum + (line.standing === 'cheaper' ? line.delta : line.standing === 'dearer' ? -line.delta : 0),
    0,
  );

  return {
    currency,
    country: countryName(region, lang),
    shop: t('Corner shop'),
    lines,
    total: lines.reduce((sum, line) => sum + line.total, 0),
    saved: round(saved, currency),
  };
}

/**
 * "₩3,800 a kilo", as one translated sentence.
 *
 * Four literal keys rather than one built from the unit name, for the same
 * reason the standing sentence is whole: Korean puts the unit first and the
 * money second. A computed key would also be invisible to the locale checker,
 * which is how a missing translation reaches a shop window.
 */
export function unitPriceText(
  unit: NonNullable<SampleLine['unit']>,
  amount: string,
  t: TFunction,
): string {
  // The shelf form — "1kg 3,800원" — the same one the rest of the app uses.
  // This had its own four keys saying "kg당 3,800원", and "한 판당" for a
  // crate, which is not a phrase.
  return `${unitEach(UNIT_SLUG[unit], t)} ${amount}`;
}

/** The sample basket names its units in English; the app keys them by slug. */
const UNIT_SLUG: Record<NonNullable<SampleLine['unit']>, string> = {
  kilo: 'kg',
  litre: 'l',
  crate: 'crate',
  loaf: 'loaf',
};
