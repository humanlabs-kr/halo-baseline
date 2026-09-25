import { sql, type Database } from '@halo/database';
import {
  CANONICAL_UNIT,
  ITEM_CATEGORIES,
  toCanonicalQuantity,
  type ItemCategory,
  type RawUnit,
} from './receipt-processor/categories';
import { ts } from './sql-time';

/**
 * What other people pay.
 *
 * Every figure in the app that comes from someone else's receipt is read
 * through this module, because two filters have to hold on all of them and
 * neither one announces itself when it is missing.
 *
 * `source = 'vision'` keeps seeded rows out. Seeds exist so a demo has
 * something to draw and they are indistinguishable from real lines once
 * they are in the table — a market price computed over them is a made-up
 * number presented as an observation.
 *
 * `MIN_MARKET_OBSERVATIONS` keeps thin categories out. A median over four
 * receipts is noise in the costume of a statistic, and the person reading
 * "others pay ₦840" cannot tell how many receipts are behind it.
 *
 * `status` keeps rejections out. Line items are written whatever the verdict,
 * so without it an unreadable scan and a receipt photographed three times both
 * set the price everyone else is measured against — and the duplicate is worse
 * than the blurry one, because it is three identical copies of a real price
 * rather than one wrong reading.
 */
const SETTLED = ['claimable', 'claimed'] as const;
export const MIN_MARKET_OBSERVATIONS = 20;

/** Prices older than this stop describing the current market. */
export const MARKET_WINDOW_DAYS = 180;

/**
 * The span each side of a price change is measured over.
 *
 * Deliberately shorter than `MARKET_WINDOW_DAYS`. A headline price wants every
 * receipt it can get, because the number it publishes is a level. A change is
 * only interesting while it is recent, and over 180 days it is also mostly
 * self-cancelling — the same purchases sit on both sides of the comparison.
 */
export const MARKET_CHANGE_WINDOW_DAYS = 30;

/**
 * The slice of purchase dates one median is computed over.
 *
 * This is a value rather than a `now` argument because a change needs two
 * windows and they must not overlap. With only `now` to work from the older
 * window can only be expressed by winding `now` back, which moves the newer
 * window's end as well: "the last 30 days against the 30 before" turns into
 * "the last 30 days against the last 60", the two sets share most of their
 * receipts, and every category reports a change of nearly zero — a wrong
 * number that looks like a calm market.
 */
export interface MarketWindow {
  /** Oldest `issued_at` that counts, inclusive. */
  since: Date;
  /**
   * Exclusive end, or null for "everything from `since` onward".
   *
   * Null on the window that runs up to today, which is how this query has
   * always behaved. Adding an upper bound there would quietly move prices that
   * are already on screens, to fix a failure nobody has seen. A window that
   * ends in the past must have one, or it swallows the window it is being
   * compared against.
   */
  until: Date | null;
}

/** A window `days` long, ending `endedDaysAgo` days before `now`. */
export function marketWindow(days: number, now = new Date(), endedDaysAgo = 0): MarketWindow {
  const end = new Date(now.getTime() - endedDaysAgo * 86_400_000);

  return {
    since: new Date(end.getTime() - days * 86_400_000),
    until: endedDaysAgo === 0 ? null : end,
  };
}

export interface MarketPrice {
  /**
   * Median price in the category's canonical unit, or `null` while the corpus
   * is too thin to publish one.
   *
   * Withholding the number is right; withholding the fact that we are close
   * was not. Every screen simply drew nothing, so a user in a country we have
   * barely started reading saw an app that had no opinion about their
   * shopping and no reason given — which reads as "this does not work", not
   * as "not yet".
   */
  unitPrice: number | null;
  /**
   * Distinct receipts behind the median, not lines.
   *
   * One shopper with twenty rice lines is not twenty observations, and the
   * screen renders this as "From N receipts" — which was a false statement
   * about a real number, the worst kind.
   */
  observations: number;
  /** How many more distinct receipts this category needs. Zero once published. */
  needed: number;
  country: string;
}

/**
 * Median unit price per category among receipts from one country.
 *
 * A category below the threshold comes back with `unitPrice: null` and a
 * `needed` count rather than being dropped. The price is still withheld — that
 * part was never in question — but the distance to having one is a fact the
 * screens need, and dropping the row meant they could not tell "no data" from
 * "no such category".
 */
export async function marketUnitPrices(
  db: Database,
  categories: readonly ItemCategory[],
  country: string,
  /**
   * Whoever is being shown the figure. Their own receipts are excluded from
   * it: the sentence on screen is "shoppers paid X" and "you paid less than
   * most people", and a median that includes the reader is neither. A user
   * who buys a category often could otherwise be compared mostly against
   * themselves and told they are exactly average.
   */
  exclude: string | null = null,
  /**
   * Which purchase dates count. Defaults to the window every existing caller
   * was already getting; the market board passes narrower ones so that the
   * same median, the same filters and the same floor produce both sides of a
   * price change. A second query would have been a second set of rules to keep
   * in step, and they do not stay in step.
   */
  window: MarketWindow = marketWindow(MARKET_WINDOW_DAYS),
): Promise<Map<ItemCategory, MarketPrice>> {
  if (categories.length === 0 || country === '') return new Map();

  // Two medians, not one. The inner one collapses each receipt to a single
  // price per category; the outer one is the median across receipts.
  //
  // A flat median over line rows was weighted by how much people shop. One
  // receipt listing rice five times contributed five values while counting as
  // one observation, and a household that buys rice weekly outweighed twelve
  // households that buy it once — so "한국 사람들은 보통 3,838원에 사요" was a
  // median over purchases dressed up as a median over people. The floor has
  // always counted distinct receipts; now the figure it gates is measured at
  // the same grain, and `observations` is that count by construction rather
  // than by a second aggregate that could drift from it.
  const rows = await db.execute<{
    category: ItemCategory;
    median: string | null;
    observations: number;
  }>(sql`
    SELECT category,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY receipt_price)::text AS median,
           COUNT(*)::int AS observations
    FROM (
      SELECT li.category, li.receipt_id,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY li.unit_price) AS receipt_price
      FROM receipto.receipt_line_items li
      JOIN receipto.receipts r ON r.id = li.receipt_id
      WHERE li.category = ANY(ARRAY[${sql.join(
        categories.map((category) => sql`${category}`),
        sql`, `,
      )}])
        AND li.unit_price IS NOT NULL
        AND li.source = 'vision'
        AND r.status = ANY(ARRAY[${sql.join(
          SETTLED.map((status) => sql`${status}`),
          sql`, `,
        )}])
        AND r.country_code = ${country}
        AND r.issued_at >= ${ts(window.since)}
        ${window.until === null ? sql`` : sql`AND r.issued_at < ${ts(window.until)}`}
        ${exclude === null ? sql`` : sql`AND r.user_address <> ${exclude}`}
      GROUP BY li.category, li.receipt_id
    ) per_receipt
    GROUP BY category
  `);

  const prices = new Map<ItemCategory, MarketPrice>();

  for (const row of rows) {
    const enough = row.median !== null && row.observations >= MIN_MARKET_OBSERVATIONS;
    prices.set(row.category, {
      unitPrice: enough ? Number(row.median) : null,
      observations: row.observations,
      needed: Math.max(0, MIN_MARKET_OBSERVATIONS - row.observations),
      country,
    });
  }

  return prices;
}

/** The country this user shops in: whichever one their last readable receipt came from. */
export async function userCountry(db: Database, address: string): Promise<string | null> {
  const rows = await db.execute<{ country_code: string }>(sql`
    SELECT country_code FROM receipto.receipts
    WHERE user_address = ${address} AND country_code IS NOT NULL
    ORDER BY issued_at DESC NULLS LAST
    LIMIT 1
  `);

  return rows[0]?.country_code ?? null;
}

/** How big a country's corpus is, and what money it is counted in. */
export interface CountryMarket {
  /**
   * The currency this country's receipts are printed in — the commonest one,
   * not the only one. A border town's receipts are not all in one currency and
   * a country that redenominated has two in the archive, so this is a label
   * for the prices below it rather than a fact about the country.
   */
  currency: string | null;
  /**
   * Settled receipts read here, all time.
   *
   * All time on purpose, while every price above it is windowed. The screen
   * prints this as "read from N receipts in Nigeria", which is a statement
   * about how much of the country we have seen, not about what is currently
   * priceable — so it must not shrink when a quiet month rolls the 180-day
   * window forward.
   *
   * It is therefore not the sum of the `observations` below and cannot be
   * reconciled with them: a receipt counts here even if nothing on it was
   * classified, and counts once however many basket items it held.
   */
  receipts: number;
}

/**
 * The size and currency of one country's corpus, in one round trip.
 *
 * Both figures come off the same filtered scan of `receipts` because they are
 * the same filtered scan — running them separately is two Hyperdrive round
 * trips for one condition, and the two can disagree if a receipt settles
 * between them.
 */
export async function countryMarket(db: Database, country: string): Promise<CountryMarket> {
  if (country === '') return { currency: null, receipts: 0 };

  const rows = await db.execute<{ currency: string | null; receipts: number }>(sql`
    SELECT MODE() WITHIN GROUP (ORDER BY currency) FILTER (WHERE currency IS NOT NULL) AS currency,
           COUNT(*)::int                                                               AS receipts
    FROM receipto.receipts
    WHERE country_code = ${country}
      -- Same two statuses as the median above. 'pending' has not been read at
      -- all and 'rejected' could not be, so counting either would tell a user
      -- we have 40,000 receipts from their country behind prices that came
      -- from 300.
      AND status = ANY(ARRAY[${sql.join(
        SETTLED.map((status) => sql`${status}`),
        sql`, `,
      )}])
  `);

  return { currency: rows[0]?.currency ?? null, receipts: rows[0]?.receipts ?? 0 };
}

/**
 * Change between two windows, as a fraction: 0.021 is 2.1% dearer.
 *
 * Null unless both sides published a price, which means both cleared
 * `MIN_MARKET_OBSERVATIONS` on their own. Deriving a change from windows that
 * are individually too thin to show would be a number we refuse to print, next
 * to an arrow drawn from it.
 *
 * A fraction rather than a percentage so the client decides the precision, and
 * rounded because the subtraction of two medians produces sixteen digits of
 * float noise that survive into JSON and make two identical answers compare
 * unequal.
 */
export function priceChange(
  recent: MarketPrice | undefined,
  prior: MarketPrice | undefined,
): number | null {
  if (recent?.unitPrice == null || prior?.unitPrice == null) return null;
  // A median of zero is a reading error, not a free bag of rice, and dividing
  // by it yields Infinity — which JSON.stringify writes as `null` anyway, two
  // steps later and for the wrong reason.
  if (prior.unitPrice <= 0) return null;

  return Math.round(((recent.unitPrice - prior.unitPrice) / prior.unitPrice) * 10_000) / 10_000;
}

/** One row of the market board. */
export interface MarketBoardItem {
  category: ItemCategory;
  /** The unit `unitPrice` is per. Always `CANONICAL_UNIT[category]`. */
  unit: RawUnit;
  unitPrice: number | null;
  observations: number;
  needed: number;
  /** Against the previous `MARKET_CHANGE_WINDOW_DAYS`. Null when either side is thin. */
  change: number | null;
}

export interface MarketBoard extends CountryMarket {
  items: MarketBoardItem[];
}

/**
 * What groceries cost in one country, for someone who has scanned nothing.
 *
 * Three medians rather than one query with `FILTER` clauses: the rules that
 * make a median publishable — vision-only, settled-only, twenty distinct
 * receipts — live in `marketUnitPrices` and nowhere else, and a hand-written
 * three-window aggregate would be a fourth copy of them that drifts the first
 * time one changes. They are issued together, so it is one round trip's worth
 * of latency and not three.
 *
 * Nobody is excluded from these medians, unlike everywhere else in this module.
 * The other screens say "you paid less than most people" and have to take the
 * reader out of "most people"; this one says "rice costs ₦840 a kilo here" and
 * has no "you" in it. Excluding the reader anyway would make the published
 * price of a country differ per viewer, with nothing on the page to explain why
 * two people looking at the same screen see different numbers.
 */
export async function marketBoard(
  db: Database,
  country: string,
  now = new Date(),
): Promise<MarketBoard> {
  const [totals, published, recent, prior] = await Promise.all([
    countryMarket(db, country),
    marketUnitPrices(db, ITEM_CATEGORIES, country, null, marketWindow(MARKET_WINDOW_DAYS, now)),
    marketUnitPrices(
      db,
      ITEM_CATEGORIES,
      country,
      null,
      marketWindow(MARKET_CHANGE_WINDOW_DAYS, now),
    ),
    marketUnitPrices(
      db,
      ITEM_CATEGORIES,
      country,
      null,
      // Ends exactly where the recent window starts: adjacent, never
      // overlapping. A shared day would put the same receipts on both sides of
      // the comparison and damp every change towards zero.
      marketWindow(MARKET_CHANGE_WINDOW_DAYS, now, MARKET_CHANGE_WINDOW_DAYS),
    ),
  ]);

  const items = ITEM_CATEGORIES.map((category) => {
    // A category nobody here has bought yet still gets a row. The board is the
    // basket, and a missing row reads as "we do not track eggs" rather than
    // "no eggs seen in this country yet" — which is the whole thing this
    // screen exists to say out loud.
    const price = published.get(category);

    return {
      category,
      unit: CANONICAL_UNIT[category],
      unitPrice: price?.unitPrice ?? null,
      observations: price?.observations ?? 0,
      needed: price?.needed ?? MIN_MARKET_OBSERVATIONS,
      change: priceChange(recent.get(category), prior.get(category)),
    };
  }).sort((a, b) => {
    // Priced rows first, then the best-evidenced of what is left, so the page
    // opens on what we can actually tell them. Sort is stable, so ties keep
    // `ITEM_CATEGORIES` order and the list does not reshuffle between two
    // requests that found the same data.
    const bothPriced = Number(b.unitPrice !== null) - Number(a.unitPrice !== null);
    return bothPriced !== 0 ? bothPriced : b.observations - a.observations;
  });

  return { ...totals, items };
}

/** One line as this module needs to see it. */
export interface ComparableLine {
  category: ItemCategory | null;
  quantity: number | null;
  unit: RawUnit | null;
  unitPrice: number | null;
}

export interface MarketComparison {
  /** Positive when they paid less than the going rate. */
  amount: number;
  lines: number;
}

/**
 * What the basket would have cost at everyone else's median price.
 *
 * Only lines that clear three separate bars count: we classified it, we could
 * derive a size for it, and its category has enough observations behind it.
 * Everything else is left out of the total rather than counted at zero —
 * a line we could not price is not a line where the user broke even.
 *
 * Returns `null` when no line qualified, which is a different statement from
 * a difference of zero and reads as a different screen.
 */
export function compareWithMarket(
  lines: readonly ComparableLine[],
  market: ReadonlyMap<ItemCategory, MarketPrice>,
): MarketComparison | null {
  let amount = 0;
  let compared = 0;

  for (const line of lines) {
    if (line.category === null || line.unitPrice === null) continue;

    const reference = market.get(line.category);
    if (reference?.unitPrice == null) continue;

    const canonical = toCanonicalQuantity(line.category, line.quantity, line.unit);
    if (canonical === null) continue;

    amount += (reference.unitPrice - line.unitPrice) * canonical;
    compared += 1;
  }

  return compared === 0 ? null : { amount, lines: compared };
}
