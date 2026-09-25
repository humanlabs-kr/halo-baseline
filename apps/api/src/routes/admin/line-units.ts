/**
 * What units the corpus actually carries, per category and per country.
 *
 * The conversion table in `categories.ts` is the only place a printed quantity
 * becomes a comparable one, and every entry in it is a claim about how a
 * country writes receipts — "a sachet is a pack", "a piece is a loaf". Those
 * claims were written from memory and from a handful of receipts somebody
 * happened to be looking at, and each wrong one does not fail: it puts a price
 * that is off by a factor of five into the median everyone is measured
 * against.
 *
 * This counts the evidence. Read-only, aggregate only — no raw text, no
 * amounts, nothing about a person — so it is safe to point at production,
 * which is the only place the evidence exists.
 */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { sql } from '@halo/database';
import { marketBoard } from '../../lib/market';
import { ts } from '../../lib/sql-time';

import { adminAuth } from '../../middleware/auth';
import {
  CANONICAL_UNIT,
  ITEM_CATEGORIES,
  toCanonicalQuantity,
  type ItemCategory,
  type RawUnit,
} from '../../lib/receipt-processor/categories';
import type { AppEnv } from '../../types';
import { adminValidationHook, jsonData, jsonError } from './shared';

const rowSchema = z.object({
  /** `other` where the line was read but placed in no basket category. */
  category: z.string(),
  /** The unit the category is priced in, for reading the counts against. */
  canonical: z.string(),
  country: z.string().nullable(),
  /** The unit as the model read it off the paper. */
  unit: z.string().nullable(),
  lines: z.number(),
  /** Of those, how many came out with a unit price. */
  priced: z.number(),
  /**
   * Priced lines whose printed unit no longer converts to the category's.
   *
   * `unit_price` is computed once, at read time, and stored. So a conversion
   * we have since decided was a guess — "a piece of noodles is a pack" — is
   * still sitting in the column, still feeding the published median, on every
   * line that was read before the rule changed. This counts them, so the size
   * of that is a number rather than a worry.
   */
  stale: z.number(),
});

const lineUnitsRoute = createRoute({
  method: 'get',
  path: '/admin/test/line-units',
  tags: ['Admin'],
  summary: 'How many lines carry each raw unit, per category and country',
  middleware: [adminAuth] as const,
  request: {
    query: z.object({
      /** Restrict to one category. Omitted, every category is counted. */
      category: z.enum(ITEM_CATEGORIES).optional(),
      /** Restrict to one country, uppercase ISO 3166-1 alpha-2. */
      country: z
        .string()
        .regex(/^[A-Za-z]{2}$/, 'country must be an ISO 3166-1 alpha-2 code')
        .optional(),
      /**
       * Only receipts uploaded in the last N hours.
       *
       * On `receipts.created_at`, the upload time — not the date printed on
       * the paper. The question this answers is whether what users are
       * sending *now* is better than what is in the archive, and the archive
       * is full of receipts bought recently and uploaded long ago.
       */
      sinceHours: z.coerce.number().int().min(1).max(24 * 90).optional(),
      /** Only lines the model read, not seeded ones. Defaults to true. */
      visionOnly: z
        .enum(['true', 'false'])
        .optional()
        .transform((value) => value !== 'false'),
    }),
  },
  responses: {
    200: jsonData('Unit counts', z.object({ rows: z.array(rowSchema) })),
    401: jsonError('Unauthorized'),
  },
});

export const adminLineUnitRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: adminValidationHook,
}).openapi(lineUnitsRoute, async (c) => {
  const db = c.get('db');
  const { category, country, visionOnly, sinceHours } = c.req.valid('query');
  const where = country?.toUpperCase();

  // Uncategorised lines are counted. They were filtered out, which made this
  // blind to exactly the case it is most needed for: a backfill that reads
  // twelve lines off Nigerian receipts and places none of them in the basket
  // looked, through a filter on a non-null category, identical to a backfill
  // that wrote nothing at all. I read that as "the write failed" and went
  // looking for a bug in the write.
  const rows = await db.execute<{
    category: string | null;
    country_code: string | null;
    unit: string | null;
    lines: number;
    priced: number;
  }>(sql`
    SELECT li.category, r.country_code, li.unit,
           COUNT(*)::int AS lines,
           COUNT(li.unit_price)::int AS priced
    FROM receipto.receipt_line_items li
    JOIN receipto.receipts r ON r.id = li.receipt_id
    WHERE TRUE
      ${visionOnly ? sql`AND li.source = 'vision'` : sql``}
      ${category === undefined ? sql`` : sql`AND li.category = ${category}`}
      ${where === undefined ? sql`` : sql`AND r.country_code = ${where}`}
      ${
        sinceHours === undefined
          ? sql``
          : sql`AND r.created_at >= ${ts(new Date(Date.now() - sinceHours * 3_600_000))}`
      }
    GROUP BY li.category, r.country_code, li.unit
    ORDER BY li.category, COUNT(*) DESC
  `);

  return c.json(
    {
      data: {
        rows: rows.map((row) => {
          const convertible =
            row.unit !== null &&
            toCanonicalQuantity(row.category as ItemCategory, 1, row.unit as RawUnit) !== null;

          return {
            category: row.category ?? 'other',
            canonical: CANONICAL_UNIT[row.category as keyof typeof CANONICAL_UNIT] ?? '?',
            country: row.country_code,
            unit: row.unit,
            lines: row.lines,
            priced: row.priced,
            // Priced under a rule we no longer apply. Nothing is rewritten
            // here — this only says how many there are.
            stale: convertible ? 0 : row.priced,
          };
        }),
      },
    },
    200,
  );
});

const marketRoute = createRoute({
  method: 'get',
  path: '/admin/test/market',
  tags: ['Admin'],
  summary: "A country's published prices, without needing a session in it",
  middleware: [adminAuth] as const,
  request: {
    query: z.object({
      country: z.string().regex(/^[A-Za-z]{2}$/, 'country must be an ISO 3166-1 alpha-2 code'),
    }),
  },
  responses: {
    200: jsonData(
      'Market board',
      z.object({
        country: z.string(),
        currency: z.string().nullable(),
        receipts: z.number(),
        items: z.array(
          z.object({
            category: z.string(),
            unit: z.string(),
            unitPrice: z.number().nullable(),
            observations: z.number(),
            needed: z.number(),
            change: z.number().nullable(),
          }),
        ),
      }),
    ),
    401: jsonError('Unauthorized'),
  },
});

/**
 * What a country's market board actually says.
 *
 * `/v1/ledger/market` is behind `userAuth`, and outside staging there is no
 * way to mint a session — so after filling a country's corpus the only way to
 * find out whether the prices published was to sign in on a phone in that
 * country. This runs the same `marketBoard` the screen runs.
 *
 * Read-only, and the numbers are the ones already shown to every user in that
 * country, so it discloses nothing a signed-in account could not see.
 */
export const adminMarketRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: adminValidationHook,
}).openapi(marketRoute, async (c) => {
  const country = c.req.valid('query').country.toUpperCase();
  const board = await marketBoard(c.get('db'), country);

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
});
