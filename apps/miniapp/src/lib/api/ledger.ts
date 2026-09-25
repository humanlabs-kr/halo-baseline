import { apiFetch, type ApiRequestInit } from './client';

/**
 * Ledger endpoints — `apps/api/src/routes/client/ledger.ts`.
 *
 * Three nullable fields here are load-bearing, and collapsing any of them to a
 * zero would make the screen lie:
 *
 * - `previous` is null when the wallet has no receipts in the comparison span.
 * - `itemised` is null for a window that predates line reading. An empty basket
 *   reads as "you bought nothing"; null means "we were not reading yet", and
 *   the screen draws nothing at all.
 * - `unitPriceChange` is null on first sight. "No change" and "nothing to
 *   compare with" are different answers.
 */
function call<T>(path: string, init?: ApiRequestInit): Promise<T> {
  return apiFetch<T>(`/v1${path}`, init);
}

export type SpendGroup = 'groceries' | 'household';

/**
 * How far back the item chart looks.
 *
 * Three fixed spans rather than a date range: the screen offers three buttons
 * and a ledger is read in months, not in days.
 */
export type ChartSpan = '6m' | '1y' | 'all';

export interface Money {
  amount: number;
  currency: string;
}

/** One line of shopping, priced against the country's median. */
export interface ComparedLine {
  /** As printed on the paper. */
  rawText: string;
  category: string;
  unit: string;
  unitPrice: number;
  /** Market minus yours: positive is money saved on this line. */
  gap: number;
}

export interface MonthSummary {
  month: string;
  /** Days of this month covered. The previous window carries its own. */
  throughDay: number;
  spent: Money;
  previous: { month: string; spent: Money; difference: number; throughDay: number } | null;
  receiptCount: number;
  /**
   * The best and worst buy of the month against everyone else's prices.
   *
   * Null when nothing in the month could be compared — no line cleared the
   * three bars, or the country's corpus is still too thin to publish a price.
   * `worst` is null on its own when only one line could be compared: the same
   * line cannot be both.
   */
  comparison: {
    best: ComparedLine | null;
    worst: ComparedLine | null;
    matched: number;
    unmatched: number;
  } | null;
  itemised: {
    groups: {
      group: SpendGroup;
      label: string;
      amount: number;
      /** Category slugs, dearest first. Named on the client, in its language. */
      categories: string[];
      /** How many of them cost more per unit than last month, and how many
       *  less. A category with nothing to compare against is in neither. */
      dearer: number;
      cheaper: number;
    }[];
    /** Lines we read but could not place in the basket. Shown, never hidden. */
    unmatched: number;
  } | null;
}

export interface LedgerItem {
  category: string;
  label: string;
  /** The unit the price is quoted in — kg, l, loaf, crate, pack, piece. */
  unit: string;
  /** Null where no line in the category had a size we could read. */
  unitPrice: number | null;
  unitPriceChange: number | null;
  buys: number;
  spent: number;
}

export interface GroupDetail {
  month: string;
  throughDay: number;
  spent: Money;
  previousSpent: number | null;
  items: LedgerItem[];
  unmatched: { amount: number; lines: number };
}

export interface ItemDetail {
  category: string;
  label: string;
  unit: string;
  currency: string;
  yours: {
    unitPrice: number;
    buys: number;
    /** The month the price is a median of — not necessarily the current one. */
    month: string;
    lastBought: string | null;
  } | null;
  /**
   * Null until the corpus holds enough observations for the user's country.
   * A "what others pay" drawn from three receipts is noise, and the reader
   * cannot tell the difference — so it is withheld rather than softened.
   */
  /**
   * Three states, not two. `null` is "nobody here has bought this";
   * `unitPrice: null` with a `needed` count is "not enough receipts yet, and
   * here is how many more"; a number is a published price.
   */
  market: {
    unitPrice: number | null;
    observations: number;
    needed: number;
    country: string;
  } | null;
  history: { month: string; unitPrice: number; marketUnitPrice: number | null }[];
  purchases: {
    receiptId: string;
    merchantName: string | null;
    issuedAt: string;
    rawText: string;
    unitPrice: number;
    lineTotal: number | null;
  }[];
}

export const ledgerApi = {
  month(month?: string): Promise<MonthSummary> {
    return call(`/ledger/month${month ? `?month=${encodeURIComponent(month)}` : ''}`);
  },

  group(group: SpendGroup, month?: string): Promise<GroupDetail> {
    return call(`/ledger/group/${group}${month ? `?month=${encodeURIComponent(month)}` : ''}`);
  },

  item(category: string, span: ChartSpan = '6m'): Promise<ItemDetail> {
    return call(`/ledger/item/${encodeURIComponent(category)}?span=${span}`);
  },

  /**
   * The country's prices, for a reader who has scanned nothing.
   *
   * Takes no month: this is what things cost now, not what they cost in the
   * month the ledger happens to be showing.
   */
  market(country?: string): Promise<MarketBoard> {
    return call(`/ledger/market${country ? `?country=${encodeURIComponent(country)}` : ''}`);
  },
};

export interface MarketItem {
  category: string;
  unit: string;
  /** Null while the category is under the observation floor. */
  unitPrice: number | null;
  observations: number;
  /** Distinct receipts still needed before a price can be published. */
  needed: number;
  /** Fraction, not percent: 0.021 is 2.1% dearer than the 30 days before. */
  change: number | null;
}

export interface MarketBoard {
  country: string | null;
  currency: string | null;
  /** Receipts read in this country, all time. Not the sum of `observations`. */
  receipts: number;
  items: MarketItem[];
}
