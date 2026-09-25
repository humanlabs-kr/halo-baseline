import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18nInstance } from 'i18next';
import { REFERENCE_LANG, SUPPORTED_LANGS, type LangCode } from '@/lib/i18n';

/**
 * Every date and number the app renders, in the language the app is rendering.
 *
 * Halo used to format every locale as American English: `dayjs.locale("en")`
 * at three module tops, `toLocaleString("en-US")` in two more, and bare
 * `toLocaleString()` — which follows the *device*, not the language the user
 * picked in our own drawer — everywhere else. A Korean screen said
 * "September 18, 2026" and "2 hours ago"; an Indonesian one could group
 * thousands as "15,000" while every other number on the page said "15.000".
 *
 * This module is the only place allowed to decide how a date or a number
 * looks. Components ask for `useFormatters()` and get formatters already bound
 * to the active language, so no screen has to reason about `i18n.language`.
 *
 * ## Why `Intl` and not dayjs locales
 *
 * dayjs formats in English until you `import('dayjs/locale/<name>')`, so the
 * alternative was one lazy chunk per language behind a hand-written name map —
 * dayjs locale names are lowercase and diverge from BCP-47 in ways that are
 * easy to get quietly wrong (`es-419`→`es-mx`, `tl`→`tl-ph`, `zh-CN`→`zh-cn`).
 *
 * `Intl` accepts all of our tags as written, costs no bytes and no extra
 * requests, and was measured — not assumed — to have real data for every
 * shipped locale for numbers, dates and relative time. dayjs stays in the app
 * for UTC date arithmetic, which `Intl` does not do; it no longer formats
 * anything for display.
 */

export type DateInput = Date | string | number;

/**
 * Extension subtags appended to every locale handed to `Intl`.
 *
 * **`nu-latn` — digits stay Latin.** CLDR gives some locales a non-Latin
 * default numbering system (Hindi can render 15000 in Devanagari as १५,०००).
 * Halo prints point balances, USDT amounts and entry counts directly against
 * Latin-script units ("15,000 Pt", "$12.50 USDT") and users reconcile those
 * figures with MiniPay, World App and block explorers, none of which localise
 * digits. A balance that reads differently depending on UI language is a
 * support ticket, not a courtesy — so the numerals are forced, through the
 * documented `-u-nu-latn` extension rather than by rewriting output strings.
 * It is a no-op for locales already on Latin digits, and free.
 *
 * **`ca-gregory` — years stay Gregorian.** `th` defaults to the Buddhist era
 * (2569 for 2026). The dates on these screens are raffle round identifiers,
 * receipt dates and on-chain payout dates: the year has to match the API, the
 * block explorer and what other users are saying. Localising the *language* of
 * a date is the fix; changing its era is a product decision nobody made.
 *
 * Both are single-constant reversals if the product says otherwise.
 */
const INTL_EXTENSIONS = '-u-ca-gregory-nu-latn';

/**
 * Locales whose `Intl` data is missing for one formatter, mapped to the
 * closest locale that has it.
 *
 * Empty today: every shipped locale has genuine `Intl.RelativeTimeFormat`
 * data. The map and its use below are kept because this is exactly the kind of
 * gap that reappears when a locale is added — CLDR's relative-time coverage is
 * thinner than its number/date coverage. Do not add an entry on a hunch; print
 * the output first, because a miss drops to root and returns the English words
 * "yesterday" and "last year", which looks deliberate.
 */
const RELATIVE_TIME_FALLBACK: Partial<Record<LangCode, string>> = {};

const SUPPORTED = new Set<string>(SUPPORTED_LANGS);

type LanguageState = Pick<I18nInstance, 'language' | 'languages' | 'resolvedLanguage'>;

/**
 * Which shipped locale the formatters should follow.
 *
 * i18next has already done the hard part: `languages` is the ordered
 * resolution chain it built from `fallbackLng`, so a device reporting "de"
 * reaches us as `["de", "de-DE", "en"]` and we take the first entry we
 * actually ship. Reading `language` on its own would hand `Intl` a tag the
 * user is not reading — and "de" and "de-DE" can group thousands differently.
 */
export function resolveLangCode(i18n: LanguageState): LangCode {
  const chain = [i18n.resolvedLanguage, ...(i18n.languages ?? []), i18n.language];
  for (const candidate of chain) {
    if (candidate && SUPPORTED.has(candidate)) return candidate as LangCode;
  }
  return REFERENCE_LANG;
}

// `Intl` constructors are the expensive part of formatting; the formatted call
// itself is cheap. These lists re-render on every poll tick, so the objects are
// built once per locale and kept.
const numberFormats = new Map<string, Intl.NumberFormat>();
const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();
const relativeTimeFormats = new Map<string, Intl.RelativeTimeFormat>();

function numberFormatter(lang: LangCode, options?: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = options ? `${lang} ${JSON.stringify(options)}` : lang;
  let formatter = numberFormats.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(lang + INTL_EXTENSIONS, options);
    numberFormats.set(key, formatter);
  }
  return formatter;
}

/**
 * Whether a formatted range is written the way this locale writes one date.
 *
 * Compares the marks — the punctuation a date carries, plus the month name
 * where it is a word rather than a number. Nineteen of the twenty-one
 * languages here pass; Japanese and Chinese do not, and that is the whole
 * reason this exists.
 */
function rangeKeptTheFormat(formatter: Intl.DateTimeFormat, at: Date, range: string): boolean {
  return formatter.formatToParts(at).every((part) => {
    if (part.type === 'literal') {
      const mark = part.value.trim();
      return mark === '' || range.includes(mark);
    }
    // A numeric month tells us nothing: "9" is in `09/01` too.
    return part.type !== 'month' || /^\d+$/.test(part.value) || range.includes(part.value);
  });
}

/** `{}` inside the current year, `{ year: 'numeric' }` outside it. */
function thisYear(at: Date): { year?: 'numeric' } {
  return at.getUTCFullYear() === new Date().getUTCFullYear() ? {} : { year: 'numeric' };
}

function dateTimeFormatter(lang: LangCode, options: Intl.DateTimeFormatOptions, tag: string) {
  const key = `${lang} ${tag}`;
  let formatter = dateTimeFormats.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(lang + INTL_EXTENSIONS, options);
    dateTimeFormats.set(key, formatter);
  }
  return formatter;
}

function relativeTimeFormatter(lang: LangCode): Intl.RelativeTimeFormat {
  let formatter = relativeTimeFormats.get(lang);
  if (!formatter) {
    const base = RELATIVE_TIME_FALLBACK[lang] ?? lang;
    formatter = new Intl.RelativeTimeFormat(base + INTL_EXTENSIONS, { numeric: 'auto' });
    relativeTimeFormats.set(lang, formatter);
  }
  return formatter;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `new Date("2026-09-18")` is UTC midnight, and rendering that in a timezone
 * behind Greenwich produces "September 17". dayjs read the same string as
 * *local* midnight, and raffle rounds are named by exactly these strings — a
 * round must not change its name depending on where it is read — so the local
 * reading is preserved. Timestamps with a time part are unambiguous and go
 * straight to `Date`.
 */
function toDate(value: DateInput): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  const parts = DATE_ONLY.exec(value);
  if (parts) {
    return new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
  }
  return new Date(value);
}

const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 60 * MINUTE_SECONDS;
const DAY_SECONDS = 24 * HOUR_SECONDS;
const MONTH_SECONDS = 30.436875 * DAY_SECONDS; // mean Gregorian month
const YEAR_SECONDS = 365.2425 * DAY_SECONDS;

/**
 * `Intl.RelativeTimeFormat` translates a value and a unit but does not pick
 * them, so the bucketing dayjs's `fromNow()` used to do lives here. Signs are
 * kept: a draw twelve hours out still reads "in 12 hours", not "12 hours ago".
 */
function relativeUnit(seconds: number): [Intl.RelativeTimeFormatUnit, number] {
  const magnitude = Math.abs(seconds);
  if (magnitude < MINUTE_SECONDS) return ['second', Math.round(seconds)];
  if (magnitude < HOUR_SECONDS) return ['minute', Math.round(seconds / MINUTE_SECONDS)];
  if (magnitude < DAY_SECONDS) return ['hour', Math.round(seconds / HOUR_SECONDS)];
  if (magnitude < MONTH_SECONDS) return ['day', Math.round(seconds / DAY_SECONDS)];
  if (magnitude < YEAR_SECONDS) return ['month', Math.round(seconds / MONTH_SECONDS)];
  return ['year', Math.round(seconds / YEAR_SECONDS)];
}

/** USDC and USDT both carry six decimals on chain; nothing we show needs more. */
const TOKEN_AMOUNT_OPTIONS: Intl.NumberFormatOptions = { maximumFractionDigits: 6 };

export interface Formatters {
  /** The locale these formatters are bound to. Useful as a React key. */
  readonly lang: LangCode;
  /** Quantities: point balances, entry counts, page totals. */
  number(value: number, options?: Intl.NumberFormatOptions): string;
  /**
   * A large number said roughly, the way the locale says it.
   *
   * `1,171,808` is a fact nobody reads; `117만` is a size. Korean writes big
   * numbers in 만 and the screens that print the corpus count are making a
   * point about scale, not quoting a figure anyone will check.
   *
   * Only for counts. Money is never rounded away.
   */
  compact(value: number): string;
  /**
   * A token or prize amount. Grouped and with a locale decimal separator, but
   * never rounded: `Intl`'s default of three fraction digits would silently
   * turn 0.123456 USDC into "0.123", so the ceiling is the six decimals USDC
   * and USDT actually carry. These figures are reconciled against wallets and
   * block explorers — the digits have to survive.
   */
  amount(value: number): string;
  /** A calendar day: "Sep 18, 2026", "2026년 9월 18일", "18 sept 2026". */
  date(value: DateInput): string;
  /**
   * A span of days inside one month: "9월 1~21일", "September 1 – 21".
   *
   * Built by `formatRange` rather than by joining two formatted dates,
   * because the joining order is not the same in every language. The ledger
   * header used to print `1–21 9월` in Korean — the month tacked on the end
   * of an English shape — which is the kind of mistake that makes a screen
   * feel translated rather than written.
   */
  dayRange(from: DateInput, to: DateInput): string;
  /**
   * A day, in the reader's own zone, without the year they are living in.
   *
   * `date` keeps the year because it labels things that can be old. This is
   * for a list of days a user is scrolling through now — "9월 10일" — and it
   * puts the year back the moment the day is outside the current one.
   */
  day(value: DateInput): string;
  /** A day and a clock time, in the locale's own hour cycle. */
  dateTime(value: DateInput): string;
  /** Just the clock time: "14:22", "2:22 PM". Used where the day is the heading. */
  time(value: DateInput): string;
  /**
   * A date printed on a receipt.
   *
   * Formatted in UTC, deliberately. The timestamp on a receipt is a wall clock
   * reading from wherever the shop is — "2026-09-20 16:30" — and it is stored
   * as if that reading were UTC, because nothing on the paper says which zone
   * it was. Rendering it in the *reader's* zone then shifts it: a Seoul
   * receipt printed at 16:30 on the 20th displayed as the 21st, and anything
   * bought after 15:00 local moved a day. The server buckets months in UTC for
   * the same reason, so this keeps the screen agreeing with the ledger.
   *
   * `createdAt` is a real instant — when our server received the scan — and
   * belongs in `date`, not here.
   */
  receiptDate(value: DateInput): string;
  /**
   * The day a receipt was issued, as a heading: "9월 21일", "September 21".
   *
   * The year is dropped inside the current year and kept outside it. A list
   * headed "2026년 9월 21일" spends its widest line telling a reader the year
   * they are living in; a receipt from 2025 in the same list needs to say so.
   */
  receiptDay(value: DateInput): string;
  /** The day and clock time printed on a receipt: "9월 21일 오후 11:22". */
  receiptStamp(value: DateInput): string;
  /** Just the clock time printed on a receipt, read as a wall clock. */
  receiptTime(value: DateInput): string;
  /** Distance from now: "2 hours ago", "2시간 전", "in 12 hours". */
  relative(value: DateInput, now?: DateInput): string;
}

export function createFormatters(lang: LangCode): Formatters {
  return {
    lang,
    number: (value, options) => numberFormatter(lang, options).format(value),
    compact: (value) => numberFormatter(lang, { notation: 'compact' }).format(value),
    amount: (value) => numberFormatter(lang, TOKEN_AMOUNT_OPTIONS).format(value),
    dayRange: (from, to) => {
      const formatter = dateTimeFormatter(lang, { month: 'long', day: 'numeric' }, 'dayRange');
      const start = toDate(from);
      const end = toDate(to);

      // `formatRange` is missing on some of the older Android WebViews this
      // ships into. Two formatted dates joined is worse than the real thing
      // and better than a thrown TypeError on the home screen.
      if (typeof formatter.formatRange !== 'function') {
        return `${formatter.format(start)} – ${formatter.format(end)}`;
      }

      const range = formatter.formatRange(start, end);

      // ICU answers a *range* in Japanese and Chinese with a numeric pattern
      // whatever skeleton it was asked for, so `9月1日` and `9月20日` sat on the
      // same screen as `09/01～09/21` — three date formats in one column. The
      // tell is the punctuation: a Japanese date carries 月 and 日, and that
      // range carries neither. Where the marks a single date is written with
      // are missing from the range, it is rebuilt from two single dates —
      // keeping ICU's own separator, which is `～` in Japanese and `至` in
      // Taiwan and is the only part of its answer worth having.
      if (rangeKeptTheFormat(formatter, start, range)) return range;

      const separator = formatter
        .formatRangeToParts(start, end)
        .filter((part) => part.source === 'shared' && part.type === 'literal')
        .map((part) => part.value)
        .join('');

      return `${formatter.format(start)}${separator || ' – '}${formatter.format(end)}`;
    },
    date: (value) =>
      dateTimeFormatter(
        lang,
        { year: 'numeric', month: 'short', day: 'numeric' },
        'date',
      ).format(toDate(value)),
    day: (value) => {
      const at = toDate(value);
      const year = at.getFullYear() === new Date().getFullYear() ? {} : ({ year: 'numeric' } as const);
      return dateTimeFormatter(
        lang,
        { ...year, month: 'long', day: 'numeric' },
        `day${'year' in year ? 'Y' : ''}`,
      ).format(at);
    },
    dateTime: (value) =>
      dateTimeFormatter(
        lang,
        {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        },
        'dateTime',
      ).format(toDate(value)),
    time: (value) =>
      dateTimeFormatter(lang, { hour: '2-digit', minute: '2-digit' }, 'time').format(toDate(value)),
    receiptDate: (value) =>
      dateTimeFormatter(
        lang,
        { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' },
        'receiptDate',
      ).format(toDate(value)),
    // The tag carries the year variant. `dateTimeFormatter` caches on
    // `lang + tag` alone, so two shapes sharing one tag would mean whichever
    // receipt rendered first decided whether every later one showed a year.
    receiptDay: (value) => {
      const at = toDate(value);
      const year = thisYear(at);
      return dateTimeFormatter(
        lang,
        { ...year, month: 'long', day: 'numeric', timeZone: 'UTC' },
        `receiptDay${year.year ?? ''}`,
      ).format(at);
    },
    receiptStamp: (value) => {
      const at = toDate(value);
      const year = thisYear(at);
      return dateTimeFormatter(
        lang,
        {
          ...year,
          month: 'long',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          timeZone: 'UTC',
        },
        `receiptStamp${year.year ?? ''}`,
      ).format(at);
    },
    receiptTime: (value) =>
      dateTimeFormatter(
        lang,
        { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' },
        'receiptTime',
      ).format(toDate(value)),
    relative: (value, now) => {
      const seconds = (toDate(value).getTime() - (now ? toDate(now) : new Date()).getTime()) / 1000;
      const [unit, amount] = relativeUnit(seconds);
      return relativeTimeFormatter(lang).format(amount, unit);
    },
  };
}

/**
 * Formatters bound to the language currently on screen.
 *
 * `useTranslation()` is doing real work here even where the caller never uses
 * `t`: it is what subscribes the component to i18next's `languageChanged`.
 * Without it a card that only renders a date would keep the English string it
 * built at mount while every label around it switched to Korean. The `useMemo`
 * is keyed on the resolved language for the same reason — memoising on `[]`
 * would freeze the formatters at their first locale.
 */
export function useFormatters(): Formatters {
  const { i18n } = useTranslation();
  const lang = resolveLangCode(i18n);
  return useMemo(() => createFormatters(lang), [lang]);
}
