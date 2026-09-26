/**
 * Build an epoch's index from the corpus, and say whether it may be published.
 *
 * This is the matched-model pipeline with a database in front of it, and the
 * pipeline itself lives in `lib/matched-index/epoch-index` because the
 * CCIP-Read gateway has to produce the *same* number. If the two drifted, an
 * ENS client would read a value that never matched what was settled and
 * HaloResolver's callback would start rejecting our own gateway.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. Write anything, or publish anything on
 * chain. A snapshot is a claim about what the rules say, and turning that into
 * a settlement involves posting a bond and starting a challenge window - a
 * decision, not a query. Keeping them apart means this endpoint can be run
 * repeatedly against a live corpus with no consequences at all.
 *
 * The response carries `eligible` and `reasons` rather than just refusing when
 * a floor is unmet, because the interesting answer during a hackathon is
 * usually "how far off is it", and a bare refusal cannot say.
 */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';

import { computeEpochIndex } from '../../lib/matched-index/epoch-index';
import { adminAuth } from '../../middleware/auth';
import type { AppEnv } from '../../types';
import { adminValidationHook, jsonData, jsonError } from './shared';

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

  const result = await computeEpochIndex({
    db,
    country,
    closesAt: closesAt ? new Date(closesAt) : new Date(),
    windowDays,
    limit,
  });

  // Leaves are the whole corpus for the window and can be tens of thousands of
  // rows, so they are opt-in rather than always paid for.
  const { leaves, ...rest } = result;
  return c.json({ data: { ...rest, ...(withLeaves ? { leaves } : {}) } }, 200);
});
