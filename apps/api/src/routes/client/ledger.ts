import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { dataSchema, errorSchema } from '@halo/contracts';
import { sql, type Database } from '@halo/database';
import {
  CANONICAL_UNIT,
  CATEGORY_GROUP,
  CATEGORY_LABEL,
  ITEM_CATEGORIES,
  type ItemCategory,
} from '../../lib/receipt-processor/categories';
import { marketBoard, marketUnitPrices, userCountry } from '../../lib/market';
import { ts } from '../../lib/sql-time';
import { userAuth } from '../../middleware/auth';
import type { AppEnv } from '../../types';

/**
 * The ledger: what a user spent, on what, and how the price moved.
 *
 * Two rules run through every query here.
 *
 * **Spend comes from receipts, prices come from lines.** `receipts.total_amount`
 * exists on every receipt ever scanned, so monthly spend and month-over-month
 * comparison work across the whole archive. Line items only exist from the
 * deploy that started reading them, so anything per-item is necessarily thinner
 * and newer.
 *
 * **A month-to-date is only comparable with the same month-to-date.** On the 5th
 * of the month a full previous month is not a comparison, it is a different
 * question. Every comparison here is clipped to the same day span.
 */

/**
 * Statuses whose receipts count as spend. `pending` has not been read yet.
 *
 * Built as an explicit `ARRAY[...]` of bound values rather than passed as a JS
 * array. On the simple query protocol — which Hyperdrive forces, see
 * `lib/sql-time` — an array parameter is written out as its text form, and
 * Postgres answers `op ANY/ALL (array) requires array on right side`.
 */
/*
 * `rejected-claimed` is deliberately absent. It means the receipt was rejected
 * — unreadable, too old, or the same purchase photographed twice — and the
 * user then collected the five-point consolation. The total is still in the
 * column, so counting it made claiming those points retroactively change how
 * much the user had spent: photograph one ₦45,000 receipt twice, tap claim,
 * and the month goes to ₦90,000 without a second purchase existing.
 *
 * The screen calls those receipts "Not counted". This is where that has to be
 * true.
 */
const SETTLED_STATUSES = ['claimable', 'claimed'] as const;

const SETTLED = sql`ARRAY[${sql.join(
  SETTLED_STATUSES.map((status) => sql`${status}`),
  sql`, `,
)}]`;

const categorySchema = z.enum(ITEM_CATEGORIES);

const monthQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/, 'month must be YYYY-MM')
    .optional(),
});

/**
 * Resolves a month into the window to read and the window to compare against,
 * both clipped to the same number of days.
 */
export function monthWindow(month: string | undefined, now: Date) {
  const key = month ?? `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const [year, monthNumber] = key.split('-').map(Number) as [number, number];

  const start = new Date(Date.UTC(year, monthNumber - 1, 1));
  const monthEnd = new Date(Date.UTC(year, monthNumber, 1));
  const isCurrent = now >= start && now < monthEnd;

  // A month in progress is only ever compared with the same span of the month
  // before it. Comparing five days against thirty is the easiest way to make a
  // ledger lie without anyone noticing.
  const end = isCurrent ? new Date(Date.UTC(year, monthNumber - 1, now.getUTCDate() + 1)) : monthEnd;
  const throughDay = Math.round((end.getTime() - start.getTime()) / 86_400_000);

  const previousStart = new Date(Date.UTC(year, monthNumber - 2, 1));

  // Clipped to the previous month's own end as well as to the day span. March
  // has 31 days and February has 28, so "the same 31 days of last month" ran
  // to 4 March — counting three days of the month being reported into the
  // month it is being compared against, on both bars at once, under a label
  // that read "1–31 Feb".
  const previousMonthEnd = new Date(Date.UTC(year, monthNumber - 1, 1));
  const previousSpan = new Date(Date.UTC(year, monthNumber - 2, 1 + throughDay));
  const previousEnd = previousSpan < previousMonthEnd ? previousSpan : previousMonthEnd;

  return {
    key,
    start,
    end,
    throughDay,
    previousKey: `${previousStart.getUTCFullYear()}-${String(previousStart.getUTCMonth() + 1).padStart(2, '0')}`,
    previousStart,
    previousEnd,
    /**
     * Days the previous window actually covers. Equal to `throughDay` unless
     * the shorter month ran out first, and the label has to say which.
     */
    previousThroughDay: Math.round((previousEnd.getTime() - previousStart.getTime()) / 86_400_000),
  };
}

/**
 * The currency this wallet keeps its ledger in.
 *
 * Whichever one most of its receipts are printed in. Everything downstream is
 * filtered to it, because the alternative is what this used to do: `SUM` every
 * receipt regardless and stamp the commonest currency on the answer. Three
 * ₦10,000 receipts and one $50 receipt came out as "₦30,050" — a number that
 * is not the spend in either currency, presented as if it were.
 *
 * One currency is the right answer rather than a limitation: a ledger's whole
 * job is a column that adds up, and two currencies do not add.
 */
async function walletCurrency(db: Database, address: string): Promise<string | null> {
  const rows = await db.execute<{ currency: string | null }>(sql`
    SELECT MODE() WITHIN GROUP (ORDER BY currency) AS currency
    FROM receipto.receipts
    WHERE user_address = ${address}
      AND status = ANY(${SETTLED})
      AND currency IS NOT NULL
  `);

  return rows[0]?.currency ?? null;
}

/**
 * Spend and receipt count for one wallet over one window, in one currency.
 *
 * `elsewhere` is the receipts inside the window that are printed in some other
 * currency and therefore not in `total`. They are counted rather than dropped
 * silently — money the user spent, missing from their ledger with no
 * explanation, is the worst of the available failures.
 */
async function readSpend(db: Database, address: string, currency: string | null, from: Date, to: Date) {
  const rows = await db.execute<{
    total: string | null;
    receipts: number;
    elsewhere: number;
  }>(sql`
    SELECT SUM(total_amount) FILTER (WHERE currency IS NOT DISTINCT FROM ${currency})::text AS total,
           COUNT(*) FILTER (WHERE currency IS NOT DISTINCT FROM ${currency})::int           AS receipts,
           COUNT(*) FILTER (WHERE currency IS DISTINCT FROM ${currency})::int               AS elsewhere
    FROM receipto.receipts
    WHERE user_address = ${address}
      AND status = ANY(${SETTLED})
      AND total_amount IS NOT NULL
      AND issued_at >= ${ts(from)} AND issued_at < ${ts(to)}
  `);

  const row = rows[0];
  return {
    total: Number(row?.total ?? 0),
    receipts: row?.receipts ?? 0,
    elsewhere: row?.elsewhere ?? 0,
  };
}

/**
 * Spend and median unit price per category for one wallet over one window.
 *
 * Every classified line counts towards `spent`, including the ones we could
 * not price. Restricting the whole query to priced lines made this screen's
 * total smaller than the row the user tapped to reach it — a receipt line
 * with no printed pack size has no unit price, and its money was disappearing
 * from the group total without appearing in "things we could not read" either,
 * which only holds lines with no category at all.
 *
 * So the median is filtered instead of the rows, and comes back null for a
 * category where nothing could be priced.
 */
async function readUserPrices(
  db: Database,
  address: string,
  currency: string | null,
  from: Date,
  to: Date,
) {
  return db.execute<{ category: string; median: string | null; buys: number; spent: string | null }>(sql`
    SELECT li.category,
           (percentile_cont(0.5) WITHIN GROUP (ORDER BY li.unit_price)
              FILTER (WHERE li.unit_price IS NOT NULL))::text AS median,
           COUNT(*)::int                                      AS buys,
           SUM(li.line_total)::text                           AS spent
    FROM receipto.receipt_line_items li
    JOIN receipto.receipts r ON r.id = li.receipt_id
    WHERE r.user_address = ${address}
      -- Same status filter as readSpend. Line items are written for rejected
      -- receipts too, so without it "what you bought" could total more than
      -- "you spent", and the breakdown bars drew past 100%.
      AND r.status = ANY(${SETTLED})
      -- And the same currency filter, or a median mixes ₦1,200 a kilo with
      -- ₩4,500 a kilo and reports the midpoint as a price.
      AND r.currency IS NOT DISTINCT FROM ${currency}
      AND li.category IS NOT NULL
      AND r.issued_at >= ${ts(from)} AND r.issued_at < ${ts(to)}
    GROUP BY li.category
  `);
}

const moneySchema = z.object({ amount: z.number(), currency: z.string() });

type ComparedLine = z.infer<typeof comparedLineSchema>;

/** One line of shopping, priced against the country's median. */
const comparedLineSchema = z.object({
  /** As printed on the paper. The shopper recognises their own receipt. */
  rawText: z.string(),
  category: z.string(),
  unit: z.string(),
  /** What one unit cost them. */
  unitPrice: z.number(),
  /** Market minus theirs: positive is money saved on this line. */
  gap: z.number(),
});

const monthSummarySchema = z.object({
  month: z.string(),
  /** Days covered, so the client can label the comparison honestly. */
  throughDay: z.number(),
  spent: moneySchema,
  previous: z
    .object({
      month: z.string(),
      spent: moneySchema,
      difference: z.number(),
      /** Days the comparison window covers. Shorter than `throughDay` when
       *  the previous month ran out of days first. */
      throughDay: z.number(),
    })
    .nullable(),
  receiptCount: z.number(),
  /** Null until some receipt in the window was read for line items. */
  /**
   * The best and the worst buy of the month, against everyone else's prices.
   *
   * One line each, not a summary: a month that nets to nothing is not a month
   * where nothing happened — it is usually one thing well bought and one badly,
   * and those two are what a shopper can act on next time. Null when nothing
   * in the month could be compared at all.
   */
  comparison: z
    .object({
      best: comparedLineSchema.nullable(),
      worst: comparedLineSchema.nullable(),
      /** Lines placed against a market price, and lines that could not be. */
      matched: z.number(),
      unmatched: z.number(),
    })
    .nullable(),
  itemised: z
    .object({
      groups: z.array(
        z.object({
          group: z.string(),
          label: z.string(),
          amount: z.number(),
          /**
           * The categories in this group, dearest first.
           *
           * Slugs rather than names: the screen already knows how to say
           * "rice" in the reader's language and the server does not.
           */
          categories: z.array(z.string()),
          /** How many of them cost more per unit this month than last. */
          dearer: z.number(),
          /** And how many cost less. Categories with nothing to compare
           *  against count as neither. */
          cheaper: z.number(),
        }),
      ),
      /** Lines read but not placed in the basket. Never hidden. */
      unmatched: z.number(),
    })
    .nullable(),
});

const itemRowSchema = z.object({
  category: categorySchema,
  label: z.string(),
  unit: z.string(),
  /** Null where every line in the category was missing a printed pack size. */
  unitPrice: z.number().nullable(),
  /** Change against the same span last month, in money per unit. Null on first sight. */
  unitPriceChange: z.number().nullable(),
  buys: z.number(),
  spent: z.number(),
});

const categoryDetailSchema = z.object({
  month: z.string(),
  throughDay: z.number(),
  spent: moneySchema,
  previousSpent: z.number().nullable(),
  items: z.array(itemRowSchema),
  unmatched: z.object({ amount: z.number(), lines: z.number() }),
});

const itemDetailSchema = z.object({
  category: categorySchema,
  label: z.string(),
  unit: z.string(),
  currency: z.string(),
  yours: z
    .object({
      unitPrice: z.number(),
      /** Every purchase, not just the ones in `purchases` below. */
      buys: z.number(),
      /** The month `unitPrice` is the median of — not necessarily this one. */
      month: z.string(),
      lastBought: z.string().nullable(),
    })
    .nullable(),
  /**
   * What other shoppers in this country pay.
   *
   * `unitPrice` is null while the corpus is too thin to publish one, and
   * `needed` says how many more receipts it would take. Null for the whole
   * object only when nobody here has ever bought this — which is a third
   * thing again, and the screen says so.
   */
  market: z
    .object({
      unitPrice: z.number().nullable(),
      observations: z.number(),
      needed: z.number(),
      country: z.string(),
    })
    .nullable(),
  /**
   * Your price each month, beside what everyone else was paying that month.
   *
   * Both series, because the claim the screen makes is about the gap between
   * them and a gap needs two lines. `marketUnitPrice` is null in a month whose
   * corpus was under the floor — the chart simply has no reference point there
   * rather than borrowing a neighbouring month's.
   */
  history: z.array(
    z.object({
      month: z.string(),
      unitPrice: z.number(),
      marketUnitPrice: z.number().nullable(),
    }),
  ),
  purchases: z.array(
    z.object({
      receiptId: z.string(),
      merchantName: z.string().nullable(),
      issuedAt: z.string(),
      rawText: z.string(),
      unitPrice: z.number(),
      lineTotal: z.number().nullable(),
    }),
  ),
});

/**
 * Which country's prices to read.
 *
 * Optional, and the fallback is the caller's own country rather than a default
 * one. The screen this feeds is the first thing a new user sees, so it runs
 * before there is anything to derive a country from — the client knows where
 * the phone is and we do not, which is why it may say so here.
 */
const marketQuerySchema = z.object({
  country: z
    .string()
    .regex(/^[A-Za-z]{2}$/, 'country must be an ISO 3166-1 alpha-2 code')
    .optional(),
});

const marketSchema = z.object({
  /** Null when none was given and none could be derived. The list is empty then. */
  country: z.string().nullable(),
  currency: z.string().nullable(),
  /** Receipts read in this country, all time — not the sum of `observations`. */
  receipts: z.number(),
  items: z.array(
    z.object({
      category: categorySchema,
      unit: z.string(),
      /** Null while the category is under the observation floor. */
      unitPrice: z.number().nullable(),
      observations: z.number(),
      /** Distinct receipts still needed before a price can be published. Zero once it is. */
      needed: z.number(),
      /** Fraction, not percent: 0.021 is 2.1% dearer than the 30 days before. */
      change: z.number().nullable(),
    }),
  ),
});

const json = <T extends z.ZodTypeAny>(description: string, schema: T) => ({
  description,
  content: { 'application/json': { schema: dataSchema(schema) } },
});

const unauthorized = {
  description: 'Unauthorized',
  content: { 'application/json': { schema: errorSchema } },
};

const monthRoute = createRoute({
  method: 'get',
  path: '/ledger/month',
  tags: ['Ledger'],
  summary: 'Spend for a month, against the same span of the month before',
  security: [{ Bearer: [] }],
  middleware: [userAuth] as const,
  request: { query: monthQuerySchema },
  responses: { 200: json('Month summary', monthSummarySchema), 401: unauthorized },
});

const categoryRoute = createRoute({
  method: 'get',
  path: '/ledger/group/{group}',
  tags: ['Ledger'],
  summary: 'What a spend group cost, item by item',
  security: [{ Bearer: [] }],
  middleware: [userAuth] as const,
  request: {
    params: z.object({ group: z.enum(['groceries', 'household']) }),
    query: monthQuerySchema,
  },
  responses: { 200: json('Group detail', categoryDetailSchema), 401: unauthorized },
});

const marketRoute = createRoute({
  method: 'get',
  path: '/ledger/market',
  tags: ['Ledger'],
  summary: 'What the basket costs in a country, for a reader who has scanned nothing',
  security: [{ Bearer: [] }],
  middleware: [userAuth] as const,
  request: { query: marketQuerySchema },
  responses: { 200: json('Market prices', marketSchema), 401: unauthorized },
});

/**
 * How far back the chart looks.
 *
 * Three spans rather than a free number of months: the screen offers three
 * buttons, and a span the buttons cannot produce is a span nobody has looked
 * at. `all` is capped below — every month on the chart costs one market query,
 * and a four-year wallet would open thirty of them on a Hyperdrive pool.
 */
const itemQuerySchema = z.object({
  span: z.enum(['6m', '1y', 'all']).optional(),
});

/** Months kept when the reader asks for everything. */
const MAX_HISTORY_MONTHS = 24;

const itemRoute = createRoute({
  method: 'get',
  path: '/ledger/item/{category}',
  tags: ['Ledger'],
  summary: 'One basket item: your price, the market price, and every time you bought it',
  security: [{ Bearer: [] }],
  middleware: [userAuth] as const,
  request: { params: z.object({ category: categorySchema }), query: itemQuerySchema },
  responses: { 200: json('Item detail', itemDetailSchema), 401: unauthorized },
});

export const clientLedgerRoutes = new OpenAPIHono<AppEnv>()
  .openapi(monthRoute, async (c) => {
    const db = c.get('db');
    const address = c.get('address')!;
    const window = monthWindow(c.req.valid('query').month, new Date());
    const currency = await walletCurrency(db, address);

    const [current, previous, lineRows, pricesNow, pricesBefore, pricedLines, country] =
      await Promise.all([
      readSpend(db, address, currency, window.start, window.end),
      readSpend(db, address, currency, window.previousStart, window.previousEnd),
      db.execute<{ category: string | null; amount: string | null }>(sql`
        SELECT li.category, SUM(li.line_total)::text AS amount
        FROM receipto.receipt_line_items li
        JOIN receipto.receipts r ON r.id = li.receipt_id
        WHERE r.user_address = ${address}
          AND r.status = ANY(${SETTLED})
          AND r.currency IS NOT DISTINCT FROM ${currency}
          AND li.line_total IS NOT NULL
          AND r.issued_at >= ${ts(window.start)} AND r.issued_at < ${ts(window.end)}
        GROUP BY li.category
      `),
      // The same two reads the group drill-down does. A group row that says
      // only "₩43,504" is a number without a subject — the mock-up names what
      // is in it and how many of those went up, and both are one query each.
      readUserPrices(db, address, currency, window.start, window.end),
      readUserPrices(db, address, currency, window.previousStart, window.previousEnd),
      // Every priced line of the month, so the best and worst buy can be named
      // rather than summarised. `unit_price` is already per canonical unit, so
      // the gap is a straight subtraction against the country's median.
      db.execute<{ raw_text: string; category: string; unit_price: string }>(sql`
        SELECT li.raw_text, li.category, li.unit_price::text
        FROM receipto.receipt_line_items li
        JOIN receipto.receipts r ON r.id = li.receipt_id
        WHERE r.user_address = ${address}
          AND r.status = ANY(${SETTLED})
          AND r.currency IS NOT DISTINCT FROM ${currency}
          AND li.category IS NOT NULL
          AND li.unit_price IS NOT NULL
          AND r.issued_at >= ${ts(window.start)} AND r.issued_at < ${ts(window.end)}
      `),
      userCountry(db, address),
    ]);

    const groups = new Map<string, number>();
    let unmatched = 0;

    for (const row of lineRows) {
      const amount = Number(row.amount ?? 0);
      if (row.category === null) {
        unmatched += amount;
        continue;
      }
      const group = CATEGORY_GROUP[row.category as ItemCategory];
      groups.set(group, (groups.get(group) ?? 0) + amount);
    }

    const previousPrice = new Map(
      pricesBefore
        .filter((row) => row.median !== null)
        .map((row) => [row.category, Number(row.median)] as const),
    );

    const breakdown = new Map<string, { categories: string[]; dearer: number; cheaper: number }>();

    for (const row of [...pricesNow].sort((a, b) => Number(b.spent ?? 0) - Number(a.spent ?? 0))) {
      const category = row.category as ItemCategory;
      const group = CATEGORY_GROUP[category];
      if (group === undefined) continue;

      const entry = breakdown.get(group) ?? { categories: [], dearer: 0, cheaper: 0 };
      entry.categories.push(category);

      // Null on either side is "nothing to compare", which is neither up nor
      // down. Counting it as flat would let a month of first-ever purchases
      // report every item as unchanged.
      const before = previousPrice.get(category);
      const nowPrice = row.median === null ? null : Number(row.median);
      if (before !== undefined && nowPrice !== null) {
        if (nowPrice > before) entry.dearer += 1;
        else if (nowPrice < before) entry.cheaper += 1;
      }

      breakdown.set(group, entry);
    }



    // The best and worst line of the month, by how far each sat from what
    // everyone else paid. Priced through `marketUnitPrices` because that is
    // the only place the vision filter, the settled statuses and the
    // observation floor are enforced together.
    const seen = [...new Set(pricedLines.map((row) => row.category))] as ItemCategory[];
    const reference =
      country === null || seen.length === 0
        ? new Map()
        : await marketUnitPrices(db, seen, country, address);

    let best: ComparedLine | null = null;
    let worst: ComparedLine | null = null;
    let matched = 0;

    for (const row of pricedLines) {
      const category = row.category as ItemCategory;
      const price = reference.get(category)?.unitPrice;
      if (price == null) continue;

      const unitPrice = Number(row.unit_price);
      const line: ComparedLine = {
        rawText: row.raw_text,
        category,
        unit: CANONICAL_UNIT[category],
        unitPrice,
        gap: price - unitPrice,
      };

      matched += 1;
      if (best === null || line.gap > best.gap) best = line;
      if (worst === null || line.gap < worst.gap) worst = line;
    }

    // A single line cannot be both the best and the worst buy of the month.
    // Showing it twice reads as a bug, and the one it is really making is the
    // claim that we compared more than one thing.
    if (matched < 2) worst = null;

    return c.json(
      {
        data: {
          month: window.key,
          throughDay: window.throughDay,
          spent: { amount: current.total, currency: currency ?? 'USD' },
          previous:
            previous.receipts > 0
              ? {
                  month: window.previousKey,
                  spent: { amount: previous.total, currency: currency ?? 'USD' },
                  difference: current.total - previous.total,
                  throughDay: window.previousThroughDay,
                }
              : null,
          receiptCount: current.receipts,
          comparison:
            matched === 0
              ? null
              : { best, worst, matched, unmatched: pricedLines.length - matched },
          // Null rather than an empty breakdown. A month scanned before line
          // reading started has no basket, and an empty one would read as "you
          // bought nothing" instead of "we were not reading yet".
          itemised:
            lineRows.length > 0
              ? {
                  groups: [...groups].map(([group, amount]) => ({
                    group,
                    label: group === 'household' ? 'Household' : 'Groceries',
                    amount,
                    categories: breakdown.get(group)?.categories ?? [],
                    dearer: breakdown.get(group)?.dearer ?? 0,
                    cheaper: breakdown.get(group)?.cheaper ?? 0,
                  })),
                  unmatched,
                }
              : null,
        },
      },
      200,
    );
  })

  .openapi(categoryRoute, async (c) => {
    const db = c.get('db');
    const address = c.get('address')!;
    const { group } = c.req.valid('param');
    const window = monthWindow(c.req.valid('query').month, new Date());
    const currency = await walletCurrency(db, address);

    const inGroup = ITEM_CATEGORIES.filter((category) => CATEGORY_GROUP[category] === group);

    const [now, before, unmatchedRows] = await Promise.all([
      readUserPrices(db, address, currency, window.start, window.end),
      readUserPrices(db, address, currency, window.previousStart, window.previousEnd),
      db.execute<{ amount: string | null; lines: number }>(sql`
        SELECT SUM(li.line_total)::text AS amount, COUNT(*)::int AS lines
        FROM receipto.receipt_line_items li
        JOIN receipto.receipts r ON r.id = li.receipt_id
        WHERE r.user_address = ${address}
          AND r.status = ANY(${SETTLED})
          AND r.currency IS NOT DISTINCT FROM ${currency}
          AND li.category IS NULL
          AND r.issued_at >= ${ts(window.start)} AND r.issued_at < ${ts(window.end)}
      `),
    ]);

    const previousPrice = new Map(
      before
        .filter((row) => row.median !== null)
        .map((row) => [row.category, Number(row.median)] as const),
    );

    const items = now
      .filter((row) => inGroup.includes(row.category as ItemCategory))
      .map((row) => {
        const category = row.category as ItemCategory;
        const unitPrice = row.median === null ? null : Number(row.median);
        const previous = previousPrice.get(category);

        return {
          category,
          label: CATEGORY_LABEL[category],
          unit: CANONICAL_UNIT[category],
          unitPrice,
          // Null on first sight rather than zero: "no change" and "we have
          // nothing to compare with" are different answers, and only one of
          // them should be shown as a flat arrow. Null again when this month
          // has no price of its own to compare.
          unitPriceChange:
            previous === undefined || unitPrice === null ? null : unitPrice - previous,
          buys: row.buys,
          spent: Number(row.spent ?? 0),
        };
      })
      .sort((a, b) => b.spent - a.spent);

    const groupSpent = items.reduce((total, item) => total + item.spent, 0);

    // Last month's figure for *this group*, not for everything. Summing the
    // unfiltered result told someone looking at ₦12,000 of household spend
    // that last month it was ₦55,000, because groceries were in the number.
    const previousGroupSpent = before
      .filter((row) => inGroup.includes(row.category as ItemCategory))
      .reduce((total, row) => total + Number(row.spent ?? 0), 0);

    const unmatchedRow = unmatchedRows[0];

    return c.json(
      {
        data: {
          month: window.key,
          throughDay: window.throughDay,
          spent: { amount: groupSpent, currency: currency ?? 'USD' },
          previousSpent: previousGroupSpent > 0 ? previousGroupSpent : null,
          items,
          // Only on the first group. Uncategorised lines belong to no group,
          // so returning them from both printed the same ₦30,000 twice — and
          // on the smaller group it sat above rows that summed to less than
          // it did.
          unmatched:
            group === 'groceries'
              ? { amount: Number(unmatchedRow?.amount ?? 0), lines: unmatchedRow?.lines ?? 0 }
              : { amount: 0, lines: 0 },
        },
      },
      200,
    );
  })

  .openapi(marketRoute, async (c) => {
    const db = c.get('db');
    const address = c.get('address')!;
    const requested = c.req.valid('query').country;

    // Uppercased before it reaches SQL. The analyzer writes `country_code` in
    // uppercase and Postgres `=` is case-sensitive, so `?country=ng` would come
    // back as a complete, empty, entirely believable board for Nigeria.
    const country =
      requested === undefined ? await userCountry(db, address) : requested.toUpperCase();

    // Nothing given and nothing derivable: a signed-in user who has never
    // scanned anything and whose client did not say where it is. An empty list
    // under an explicit `country: null` lets the screen say which of the two
    // blank states it is in — "we have no prices for here" and "we do not know
    // where here is" need different words and only one of them is our fault.
    if (country === null) {
      return c.json({ data: { country: null, currency: null, receipts: 0, items: [] } }, 200);
    }

    const board = await marketBoard(db, country);

    return c.json(
      {
        data: {
          country,
          currency: board.currency,
          receipts: board.receipts,
          items: board.items,
        },
      },
      200,
    );
  })

  .openapi(itemRoute, async (c) => {
    const db = c.get('db');
    const address = c.get('address')!;
    const { category } = c.req.valid('param');
    const span = c.req.valid('query').span ?? '6m';
    // `all` still has a floor: the oldest receipt in the corpus predates the
    // line reader, so "everything" would otherwise stretch the chart across
    // months that can never have a point on them.
    const since =
      span === 'all'
        ? new Date(Date.UTC(1970, 0, 1))
        : new Date(Date.now() - (span === '1y' ? 365 : 180) * 86_400_000);

    const [purchases, history, country, totals] = await Promise.all([
      db.execute<{
        receipt_id: string;
        merchant_name: string | null;
        issued_at: string;
        raw_text: string;
        unit_price: string;
        line_total: string | null;
        currency: string | null;
      }>(sql`
        SELECT li.receipt_id, r.merchant_name, r.issued_at, li.raw_text,
               li.unit_price::text, li.line_total::text, r.currency
        FROM receipto.receipt_line_items li
        JOIN receipto.receipts r ON r.id = li.receipt_id
        WHERE r.user_address = ${address}
          AND r.status = ANY(${SETTLED})
          AND li.category = ${category}
          AND li.unit_price IS NOT NULL
        ORDER BY r.issued_at DESC
        LIMIT 30
      `),
      db.execute<{ month: string; median: string }>(sql`
        SELECT to_char(date_trunc('month', r.issued_at), 'YYYY-MM') AS month,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY li.unit_price)::text AS median
        FROM receipto.receipt_line_items li
        JOIN receipto.receipts r ON r.id = li.receipt_id
        WHERE r.user_address = ${address}
          AND r.status = ANY(${SETTLED})
          AND li.category = ${category}
          AND li.unit_price IS NOT NULL
          AND r.issued_at >= ${ts(since)}
        GROUP BY 1
        ORDER BY 1
      `).then((rows) => rows.slice(-MAX_HISTORY_MONTHS)),
      userCountry(db, address),
      db.execute<{ buys: number; last_bought: string | null }>(sql`
        SELECT COUNT(*)::int AS buys, MAX(r.issued_at)::text AS last_bought
        FROM receipto.receipt_line_items li
        JOIN receipto.receipts r ON r.id = li.receipt_id
        WHERE r.user_address = ${address}
          AND r.status = ANY(${SETTLED})
          AND li.category = ${category}
          AND li.unit_price IS NOT NULL
      `),
    ]);

    // The last month with a purchase, not "now". A user who last bought rice
    // in April was being shown "Rice costs you ₦840 a kilo" in September and
    // stamped BELOW AVERAGE for it, by comparing an April median against
    // today's market. The date travels with the figure so the screen can say
    // when it is from instead of implying it is current.
    const yours = history.at(-1);
    const lastBought = totals[0]?.last_bought ?? null;
    // Other people's prices go through `marketUnitPrices`, which is the only
    // place `source = 'vision'` and the observation floor are enforced.
    const marketRow = (await marketUnitPrices(db, [category], country ?? '', address)).get(category) ?? null;

    // The same median the headline uses, run once per month on screen. Six
    // small queries on a detail view nobody polls, rather than one clever one
    // — the alternative is a fourth place that has to remember the vision
    // filter, the settled statuses and the observation floor.
    const marketByMonth = new Map<string, number | null>(
      await Promise.all(
        history.map(async (row) => {
          const [year, index] = row.month.split('-').map(Number) as [number, number];
          const start = new Date(Date.UTC(year, index - 1, 1));
          const end = new Date(Date.UTC(year, index, 1));
          const prices = await marketUnitPrices(db, [category], country ?? '', address, {
            since: start,
            until: end,
          });

          return [row.month, prices.get(category)?.unitPrice ?? null] as const;
        }),
      ),
    );

    return c.json(
      {
        data: {
          category,
          label: CATEGORY_LABEL[category],
          unit: CANONICAL_UNIT[category],
          currency: purchases[0]?.currency ?? 'USD',
          yours: yours
            ? {
                unitPrice: Number(yours.median),
                buys: totals[0]?.buys ?? purchases.length,
                month: yours.month,
                lastBought: lastBought === null ? null : new Date(lastBought).toISOString(),
              }
            : null,
          market: marketRow,
          history: history.map((row) => ({
            month: row.month,
            unitPrice: Number(row.median),
            marketUnitPrice: marketByMonth.get(row.month) ?? null,
          })),
          purchases: purchases.map((row) => ({
            receiptId: row.receipt_id,
            merchantName: row.merchant_name,
            issuedAt: new Date(row.issued_at).toISOString(),
            rawText: row.raw_text,
            unitPrice: Number(row.unit_price),
            lineTotal: row.line_total === null ? null : Number(row.line_total),
          })),
        },
      },
      200,
    );
  });
