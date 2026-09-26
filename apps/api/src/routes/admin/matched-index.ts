/**
 * Build an epoch's index from the corpus, and say whether it may be published.
 *
 * This is the whole matched-model pipeline with a database in front of it:
 * pull two windows of line items, cap per person, match products across the
 * two, drop what the integrity rules drop, aggregate, and hand back the
 * number together with the leaf set that produced it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. Write anything, or publish anything on
 * chain. A snapshot is a claim about what the rules say, and turning that into
 * a settlement involves posting a bond and starting a challenge window — a
 * decision, not a query. Keeping them apart means this endpoint can be run
 * repeatedly against a live corpus with no consequences at all.
 *
 * The response carries `eligible` and `reasons` rather than just refusing when
 * a floor is unmet, because the interesting answer during a hackathon is
 * usually "how far off is it", and a bare refusal cannot say.
 */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { receiptLineItems, receipts, sql } from '@halo/database';

import { itemKeyOf } from '../../lib/matched-index/identity';
import {
  applyIntegrity,
  capPerPerson,
  checkEligibility,
  costToMoveOnePercent,
} from '../../lib/matched-index/integrity';
import { computeIndex } from '../../lib/matched-index/aggregate';
import { collapseToPeriodPrices, priceRelatives, type Observation } from '../../lib/matched-index/relatives';
import { buildSnapshot, CURRENT_RULES, rulesHash, seriesId } from '../../lib/matched-index/snapshot';
import { ts } from '../../lib/sql-time';
import { adminAuth } from '../../middleware/auth';
import type { AppEnv } from '../../types';
import { adminValidationHook, jsonData, jsonError } from './shared';

/** Rows the index reads. Joined because the outlet lives on the receipt. */
type Row = {
  receipt_id: string;
  user_address: string;
  merchant_name: string | null;
  raw_text: string;
  unit_price: string | null;
  line_total: string | null;
  currency: string | null;
  observed_at: string;
};

const leafSchema = z.object({
  outlet: z.string(),
  item: z.string(),
  priceMinor: z.number(),
  expenditureMinor: z.number(),
  currency: z.string(),
  observedAt: z.number(),
});

const buildRoute = createRoute({
  method: 'post',
  path: '/admin/index/epoch',
  tags: ['Admin'],
  summary: 'Compute a matched-model index for one country and period. Writes nothing.',
  middleware: [adminAuth] as const,
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            country: z.string().regex(/^[A-Za-z]{2}$/),
            /** End of the current period. Defaults to now. */
            closesAt: z.string().datetime().optional(),
            /** Length of each of the two windows, in days. */
            windowDays: z.number().int().min(1).max(365).default(30),
            /** Cap on rows pulled per window, so a sweep cannot run away. */
            limit: z.number().int().min(100).max(50_000).default(20_000),
            /** Include the full leaf set. Large; off by default. */
            withLeaves: z.boolean().default(false),
          }),
        },
      },
    },
  },
  responses: {
    200: jsonData(
      'The index, and whether it may be published',
      z.object({
        country: z.string(),
        currency: z.string().nullable(),
        seriesId: z.string(),
        rulesHash: z.string(),
        rules: z.record(z.union([z.string(), z.number()])),
        window: z.object({ previousFrom: z.string(), splitAt: z.string(), currentTo: z.string() }),
        observations: z.object({ raw: z.number(), afterPersonCap: z.number() }),
        relatives: z.object({ matched: z.number(), afterIntegrity: z.number() }),
        index: z.object({
          changeBps: z.number().nullable(),
          level: z.number().nullable(),
          pairs: z.number(),
          outlets: z.number(),
        }),
        eligible: z.boolean(),
        reasons: z.array(z.string()),
        people: z.number(),
        costToMoveOnePercent: z.number(),
        root: z.string(),
        leaves: z.array(leafSchema).optional(),
      }),
    ),
    401: jsonError('Unauthorized'),
  },
});

export const adminMatchedIndexRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: adminValidationHook,
}).openapi(buildRoute, async (c) => {
  const db = c.get('db');
  const { country, closesAt, windowDays, limit, withLeaves } = c.req.valid('json');

  const to = closesAt ? new Date(closesAt) : new Date();
  const splitAt = new Date(to.getTime() - windowDays * 86_400_000);
  const from = new Date(splitAt.getTime() - windowDays * 86_400_000);

  /**
   * The window is cut on `created_at`, not on the printed date.
   *
   * This is the rule committed in `rulesHash`, and it is a real concession —
   * the printed date is the one that says when a price was paid. But the
   * archive holds receipts bought recently and uploaded long afterwards, and
   * nothing tells those apart, so cutting on the printed date lets anyone move
   * a closed period by uploading old paper into it. A window that cannot be
   * edited after it closes is worth more here than one that is slightly better
   * dated.
   */
  const pull = async (start: Date, end: Date): Promise<Row[]> => {
    const result = await db.execute(sql`
      SELECT li.receipt_id,
             r.user_address,
             r.merchant_name,
             li.raw_text,
             li.unit_price,
             li.line_total,
             r.currency,
             li.created_at AS observed_at
      FROM ${receiptLineItems} li
      JOIN ${receipts} r ON r.id = li.receipt_id
      WHERE r.country_code = ${country.toUpperCase()}
        AND r.status IN ('claimable', 'claimed')
        AND li.created_at >= ${ts(start)}
        AND li.created_at <  ${ts(end)}
        AND li.raw_text <> ''
        AND r.merchant_name IS NOT NULL
      ORDER BY li.created_at DESC
      LIMIT ${limit}
    `);
    return result as unknown as Row[];
  };

  const [previousRows, currentRows] = await Promise.all([pull(from, splitAt), pull(splitAt, to)]);

  /**
   * A stable pseudonym per person, salted per series.
   *
   * Salting with the series means the same wallet is a different pseudonym in
   * a different country's leaf set, so publishing two of them does not let
   * anyone stitch a cross-country shopping history together.
   */
  const series = seriesId(country, '');
  const personOf = (address: string) => `${series.slice(2, 10)}:${address.slice(2, 14)}`;

  const toObservations = (rows: Row[]): Observation[] => {
    const out: Observation[] = [];
    for (const row of rows) {
      const key = itemKeyOf(row.merchant_name, row.raw_text);
      if (!key) continue;
      // Prefer the unit price, because it is already normalised for pack size.
      // Fall back to the line total so an item the converter could not handle
      // is still matched against itself over time.
      const price = Number(row.unit_price ?? row.line_total);
      if (!Number.isFinite(price) || price <= 0) continue;
      out.push({
        key,
        person: personOf(row.user_address),
        price,
        expenditure: Number(row.line_total ?? 0) || price,
        at: new Date(row.observed_at),
      });
    }
    return out;
  };

  const rawPrevious = toObservations(previousRows);
  const rawCurrent = toObservations(currentRows);

  const cappedPrevious = capPerPerson(rawPrevious);
  const cappedCurrent = capPerPerson(rawCurrent);

  const matched = priceRelatives(
    collapseToPeriodPrices(cappedPrevious),
    collapseToPeriodPrices(cappedCurrent),
  );
  const clean = applyIntegrity(matched);

  const distinctPeople = new Set([...cappedPrevious, ...cappedCurrent].map((o) => o.person)).size;
  const eligibility = checkEligibility(clean, distinctPeople);
  const currency = currentRows[0]?.currency ?? previousRows[0]?.currency ?? null;
  const snapshot = buildSnapshot([...cappedPrevious, ...cappedCurrent], currency ?? 'XXX');

  const index = clean.length > 0 ? computeIndex(clean) : null;

  return c.json(
    {
      data: {
        country: country.toUpperCase(),
        currency,
        seriesId: series,
        rulesHash: rulesHash(),
        rules: CURRENT_RULES as unknown as Record<string, string | number>,
        window: {
          previousFrom: from.toISOString(),
          splitAt: splitAt.toISOString(),
          currentTo: to.toISOString(),
        },
        observations: {
          raw: rawPrevious.length + rawCurrent.length,
          afterPersonCap: cappedPrevious.length + cappedCurrent.length,
        },
        relatives: { matched: matched.length, afterIntegrity: clean.length },
        index: {
          changeBps: index && Number.isFinite(index.changeBps) ? index.changeBps : null,
          level: index && Number.isFinite(index.level) ? index.level : null,
          pairs: clean.length,
          outlets: eligibility.outlets,
        },
        eligible: eligibility.eligible,
        reasons: eligibility.reasons,
        people: distinctPeople,
        costToMoveOnePercent: costToMoveOnePercent(clean),
        root: snapshot.root,
        ...(withLeaves ? { leaves: snapshot.leaves } : {}),
      },
    },
    200,
  );
});
