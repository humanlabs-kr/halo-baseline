/**
 * Read the basket off receipts the line reader never saw.
 *
 * The archive is not empty, it is unread. Nine hundred and seventy-eight
 * thousand receipts are in the bucket, processed before line extraction
 * existed, so every one of them has a total and no items. Put five of them
 * back in front of the model today and three come back with a basket — the
 * images are fine, nobody has ever looked at them.
 *
 * That is the whole reason the price index is empty: 291 line items across a
 * million receipts, and 193 of those were written by a demo seeder.
 *
 * WHAT THIS IS ALLOWED TO TOUCH. Line items, and nothing else. Not points,
 * not status, not the total, not the merchant, not the date. A receipt that
 * was claimed stays claimed for the same points; a receipt that was rejected
 * stays rejected with the same reason. The standing rule against retroactive
 * analysis is about not moving numbers a user was already told — this moves
 * none of them. What a user sees afterwards is a basket on a month that
 * previously said nothing, which is information appearing rather than
 * changing.
 *
 * Only receipts with no lines at all are eligible, so a second run skips
 * whatever the first one wrote and the whole thing is safe to repeat.
 */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  and,
  eq,
  exists,
  inArray,
  isNotNull,
  notExists,
  QueryBuilder,
  receiptImages,
  receiptLineItems,
  receipts,
  sql,
} from '@halo/database';

import { adminAuth } from '../../middleware/auth';
import { R2 } from '../../lib/r2';
import { ReceiptProcessor } from '../../lib/receipt-processor';
import { toLineItemRows } from '../../queues/receipt-analysis';
import type { AppEnv } from '../../types';
import { adminValidationHook, jsonData, jsonError } from './shared';

/**
 * Receipts per call. Each is a model round trip of roughly thirteen seconds,
 * run a few at a time — twenty is about a minute, which is as long as a
 * single request should take.
 */
const MAX_BATCH = 20;

/** Model calls in flight at once. Enough to be quick, few enough to be polite. */
const CONCURRENCY = 4;

const resultSchema = z.object({
  receiptId: z.string(),
  country: z.string().nullable(),
  /**
   * Lines the model produced. Not the same as what was stored — see `skipped`.
   *
   * It used to be reported as `written`, which made the endpoint claim twelve
   * lines on a run that stored none.
   */
  read: z.number(),
  /** Rows actually inserted. This is the number that changed the database. */
  written: z.number(),
  /** Of those, how many carry a unit price and can reach the index. */
  priced: z.number(),
  /** Why nothing was stored, when the model did read something. */
  skipped: z.string().nullable(),
  ms: z.number(),
  error: z.string().nullable(),
});

const backfillRoute = createRoute({
  method: 'post',
  path: '/admin/test/backfill-lines',
  tags: ['Admin'],
  summary: 'Write line items for receipts that have none. Touches nothing else.',
  middleware: [adminAuth] as const,
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            /** Uppercase ISO 3166-1 alpha-2. Omitted, every country is in scope. */
            country: z
              .string()
              .regex(/^[A-Za-z]{2}$/, 'country must be an ISO 3166-1 alpha-2 code')
              .optional(),
            /** How many to attempt. Capped at twenty per call. */
            sample: z.number().int().min(1).max(MAX_BATCH).default(10),
            /**
             * Settled receipts only, by default.
             *
             * The market reads `claimable` and `claimed`; a rejected receipt's
             * lines would sit in a ledger and reach no index. Reading them is
             * model time spent on rows nothing queries.
             */
            includeRejected: z.boolean().default(false),
          }),
        },
      },
    },
  },
  responses: {
    200: jsonData(
      'What was written',
      z.object({
        attempted: z.number(),
        read: z.number(),
        written: z.number(),
        priced: z.number(),
        results: z.array(resultSchema),
      }),
    ),
    401: jsonError('Unauthorized'),
  },
});

export const adminBackfillRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: adminValidationHook,
}).openapi(backfillRoute, async (c) => {
  const db = c.get('db');
  const { country, sample, includeRejected } = c.req.valid('json');

  const chosen = await db
    // A plain select, not `db.query.receipts.findMany`. The relational API
    // aliases the table it selects from, so the correlated subqueries below
    // cannot see it and Postgres answers `invalid reference to FROM-clause
    // entry for table "receipts"`.
    .select({ id: receipts.id, countryCode: receipts.countryCode })
    .from(receipts)
    .where(
      and(
        isNotNull(receipts.countryCode),
        country ? eq(receipts.countryCode, country.toUpperCase()) : undefined,
        includeRejected
          ? undefined
          : inArray(receipts.status, ['claimable', 'claimed'] as const),
        // Nothing to read without an image.
        exists(
          new QueryBuilder()
            .select({ one: sql`1` })
            .from(receiptImages)
            .where(eq(receiptImages.receiptId, receipts.id)),
        ),
        // The point of the whole route: only the ones nobody has read.
        // Re-running therefore skips whatever the last run wrote.
        notExists(
          new QueryBuilder()
            .select({ one: sql`1` })
            .from(receiptLineItems)
            .where(eq(receiptLineItems.receiptId, receipts.id)),
        ),
      ),
    )
    // Newest first: a price series needs recent months more than old ones,
    // and the market window is 180 days.
    .orderBy(sql`${receipts.issuedAt} DESC NULLS LAST`)
    .limit(sample);

  const images = chosen.length
    ? await db
        .select({ receiptId: receiptImages.receiptId, id: receiptImages.id })
        .from(receiptImages)
        .where(
          inArray(
            receiptImages.receiptId,
            chosen.map((row) => row.id),
          ),
        )
    : [];

  const byReceipt = new Map<string, string[]>();
  for (const image of images) {
    byReceipt.set(image.receiptId, [...(byReceipt.get(image.receiptId) ?? []), image.id]);
  }

  async function read(receipt: (typeof chosen)[number]) {
    const started = Date.now();
    const imageIds = byReceipt.get(receipt.id) ?? [];

    if (imageIds.length === 0) {
      return {
        receiptId: receipt.id,
        country: receipt.countryCode,
        read: 0,
        written: 0,
        priced: 0,
        skipped: null,
        ms: 0,
        error: 'No stored image',
      };
    }

    try {
      const bytes = await Promise.all(
        imageIds.map((id) => R2.downloadReceiptImage(c.env.RECEIPT_BUCKET, id)),
      );

      // The receipt's own country as the hint, which is what the original run
      // derived from it — so a difference in the answer is the prompt having
      // improved, not the input having changed.
      const parsed = await ReceiptProcessor.process(
        c.env.OPENROUTER_API_KEY,
        bytes,
        receipt.countryCode ?? '',
      );

      const rows = toLineItemRows(receipt.id, parsed.lineItems);
      let stored = 0;
      let skipped: string | null = null;

      if (rows.length > 0) {
        // Guarded on emptiness again inside the write. Two backfills racing
        // the same receipt would otherwise each insert a full basket, and the
        // median would be computed over a doubled one.
        await db.transaction(async (tx) => {
          const already = await tx
            .select({ id: receiptLineItems.id })
            .from(receiptLineItems)
            .where(eq(receiptLineItems.receiptId, receipt.id))
            .limit(1);

          if (already.length > 0) {
            // Which also means the selection handed back a receipt it was
            // supposed to filter out, so say so rather than passing silently.
            skipped = 'already had lines';
            return;
          }

          await tx.insert(receiptLineItems).values(rows);
          stored = rows.length;
        });
      }

      return {
        receiptId: receipt.id,
        country: receipt.countryCode,
        read: rows.length,
        written: stored,
        priced: stored === 0 ? 0 : rows.filter((row) => row.unitPrice !== null).length,
        skipped,
        ms: Date.now() - started,
        error: null,
      };
    } catch (error) {
      return {
        receiptId: receipt.id,
        country: receipt.countryCode,
        read: 0,
        written: 0,
        priced: 0,
        skipped: null,
        ms: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const results: z.infer<typeof resultSchema>[] = [];
  for (let i = 0; i < chosen.length; i += CONCURRENCY) {
    results.push(...(await Promise.all(chosen.slice(i, i + CONCURRENCY).map(read))));
  }

  return c.json(
    {
      data: {
        attempted: chosen.length,
        read: results.reduce((sum, row) => sum + row.read, 0),
        written: results.reduce((sum, row) => sum + row.written, 0),
        priced: results.reduce((sum, row) => sum + row.priced, 0),
        results,
      },
    },
    200,
  );
});
