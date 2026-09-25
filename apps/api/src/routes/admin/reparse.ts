/**
 * Re-read receipts we already have, with the prompt as it stands today.
 *
 * Extraction quality is the product. The prompt decides what a line item is,
 * what a pack size means, and whether a photo counts at all — and every one of
 * those was changed on the evidence of a handful of receipts somebody happened
 * to be looking at. That is not enough evidence, and the receipts that would
 * have shown the problem are already in the bucket.
 *
 * So this runs the live prompt against stored images and hands back what it
 * got, beside what is on file. Nothing is written: the point is to find out
 * whether a prompt change is an improvement *before* it decides anybody's
 * points, and a probe that mutates cannot be run on production data.
 *
 * It is also the only way to check a claim about the model from outside the
 * Worker. There is no model key on a laptop, and the upload path sits behind a
 * Turnstile that correctly refuses to be scripted — so "the model fills in
 * this new field" was, until now, not a testable statement.
 */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { and, eq, exists, inArray, isNotNull, QueryBuilder, receiptImages, receiptLineItems, receipts, sql } from '@halo/database';

import { adminAuth } from '../../middleware/auth';
import { R2 } from '../../lib/r2';
import { gradeReceiptFields } from '../../lib/receipt-grade';
import { applyExclusions, toCategory } from '../../lib/receipt-processor/categories';
import { ReceiptProcessor } from '../../lib/receipt-processor';
import { RECEIPT_STATUSES } from '@halo/contracts';
import type { AppEnv } from '../../types';
import { adminValidationHook, jsonData, jsonError } from './shared';

/**
 * Ceiling on one call. Each receipt is a model round trip of roughly three
 * seconds, and they are run a few at a time — twenty is about a minute, which
 * is the most that should happen behind a single request.
 */
const MAX_SAMPLE = 20;

/** Model calls in flight at once. Enough to be quick, few enough to be polite. */
const CONCURRENCY = 4;

const lineSchema = z.object({
  rawText: z.string(),
  category: z.string().nullable(),
  quantity: z.string().nullable(),
  unit: z.string().nullable(),
  unitPrice: z.string().nullable(),
  lineTotal: z.string().nullable(),
});

const resultSchema = z.object({
  receiptId: z.string(),
  imageCount: z.number(),
  ms: z.number().openapi({ description: 'Wall time of the model call' }),
  /** Null when the model call itself failed. */
  error: z.string().nullable(),
  stored: z.object({
    merchantName: z.string().nullable(),
    issuedAt: z.string().nullable(),
    countryCode: z.string().nullable(),
    currency: z.string().nullable(),
    totalAmount: z.string().nullable(),
    qualityRate: z.number().nullable(),
    status: z.string(),
    rejectionReason: z.string().nullable(),
    lines: z.array(lineSchema),
  }),
  parsed: z
    .object({
      merchantName: z.string().nullable(),
      issuedAt: z.string().nullable(),
      countryCode: z.string(),
      currency: z.string(),
      totalAmount: z.number().nullable(),
      isReceipt: z.boolean(),
      qualityRate: z.number(),
      lines: z.array(
        z.object({
          lineNo: z.number(),
          rawText: z.string(),
          /** What the model answered. */
          category: z.string(),
          /**
           * What would actually be stored, after the exclusions.
           * `other` where the printed text rules the model's label out — this
           * is the column the price index is built from, so it is the one
           * worth measuring.
           */
          stored: z.string(),
          quantity: z.number().nullable(),
          unit: z.string().nullable(),
          lineTotal: z.number().nullable(),
        }),
      ),
    })
    .nullable(),
  /**
   * What today's rules would decide, had this receipt arrived now. The
   * duplicate check is left out — it depends on the rest of the wallet's
   * history and would report every receipt in the bucket as a copy of itself.
   */
  verdict: z.string().nullable().openapi({ description: 'Rejection reason, or null for accepted' }),
  /** Fields where the fresh read disagrees with what is on file. */
  changed: z.array(z.string()),
});

const reparseRoute = createRoute({
  method: 'post',
  path: '/admin/test/reparse',
  tags: ['Admin'],
  summary: 'Re-run the current vision prompt over receipts already in the bucket',
  description:
    'Read-only. Nothing is written to the database, no points move and no status changes.',
  middleware: [adminAuth] as const,
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            receiptIds: z
              .array(z.string())
              .max(MAX_SAMPLE)
              .optional()
              .openapi({ description: 'Specific receipts. Takes precedence over sampling.' }),
            sample: z
              .number()
              .int()
              .min(1)
              .max(MAX_SAMPLE)
              .optional()
              .openapi({ description: 'How many to draw at random instead.' }),
            country: z
              .string()
              .length(2)
              .optional()
              .openapi({ description: 'Restrict the draw to one country.' }),
            status: z.enum(RECEIPT_STATUSES).optional(),
            withLines: z
              .boolean()
              .optional()
              .openapi({ description: 'Only receipts that already have line items.' }),
            ignoreAge: z.boolean().optional().openapi({
              description:
                'Judge as if the receipt were bought today. Stored receipts are mostly older than a week, so without this every verdict is `too-old` and the extraction failures underneath it are invisible.',
            }),
          }),
        },
      },
    },
  },
  responses: {
    200: jsonData(
      'One entry per receipt',
      z.object({ count: z.number(), results: z.array(resultSchema) }),
    ),
    400: jsonError('Invalid body'),
    401: jsonError('Authentication required'),
  },
});

export const adminReparseRoutes = new OpenAPIHono<AppEnv>({ defaultHook: adminValidationHook });
const app = adminReparseRoutes;

app.openapi(reparseRoute, async (c) => {
  const db = c.get('db');
  const { receiptIds, sample = 5, country, status, withLines, ignoreAge } = c.req.valid('json');

  // The age rule answers a question nobody is asking here. Every receipt in
  // the bucket was bought before today, so left alone it returns `too-old` for
  // almost all of them and hides the reason that would have mattered — no
  // merchant, no total, not a receipt at all. Judging against the receipt's
  // own date puts the extraction back in view.
  const asOf = (issuedAt: Date | null) =>
    ignoreAge && usable(issuedAt) ? new Date(issuedAt.getTime() + 1000) : new Date();

  const chosen = receiptIds?.length
    ? await db.select(STORED_COLUMNS).from(receipts).where(inArray(receipts.id, receiptIds))
    : await db
        .select(STORED_COLUMNS)
        // A plain select, not `db.query.receipts.findMany`. The relational API
        // aliases the table it selects from, so the correlated subquery below
        // cannot see it and Postgres answers `invalid reference to FROM-clause
        // entry for table "receipts"`.
        .from(receipts)
        .where(
          and(
            isNotNull(receipts.countryCode),
            country ? eq(receipts.countryCode, country.toUpperCase()) : undefined,
            status ? eq(receipts.status, status) : undefined,
            // `EXISTS` rather than a join: a receipt with six lines must come
            // back once, not six times. Built with the query builder rather
            // than written as a raw `sql` template — the raw version renders
            // both column references unqualified and Postgres answers
            // `column receipts.receipt_id does not exist`.
            withLines
              ? exists(
                  new QueryBuilder()
                    .select({ one: sql`1` })
                    .from(receiptLineItems)
                    .where(eq(receiptLineItems.receiptId, receipts.id)),
                )
              : undefined,
          ),
        )
        // A sequential scan, and deliberately. This runs a handful of times a
        // week by one person, and every cheaper sampling trick — a random id
        // cursor, TABLESAMPLE — biases the draw toward whatever the physical
        // order happens to be, which for a time-ordered key means recent
        // receipts. The whole point is to see the old and strange ones.
        .orderBy(sql`random()`)
        .limit(Math.min(sample, MAX_SAMPLE));

  if (chosen.length === 0) {
    return c.json({ data: { count: 0, results: [] } }, 200);
  }

  const ids = chosen.map((receipt) => receipt.id);

  const [images, lines] = await Promise.all([
    db.query.receiptImages.findMany({
      where: inArray(receiptImages.receiptId, ids),
      columns: { id: true, receiptId: true, numOrder: true },
      orderBy: [receiptImages.numOrder],
    }),
    db.query.receiptLineItems.findMany({
      where: inArray(receiptLineItems.receiptId, ids),
      columns: {
        receiptId: true,
        rawText: true,
        category: true,
        quantity: true,
        unit: true,
        unitPrice: true,
        lineTotal: true,
      },
      orderBy: [receiptLineItems.lineNo],
    }),
  ]);

  const imagesByReceipt = groupBy(images, (image) => image.receiptId);
  const linesByReceipt = groupBy(lines, (line) => line.receiptId);

  const results = await mapWithConcurrency(chosen, CONCURRENCY, async (receipt) => {
    const stored = {
      merchantName: receipt.merchantName,
      issuedAt: usable(receipt.issuedAt) ? receipt.issuedAt.toISOString() : null,
      countryCode: receipt.countryCode,
      currency: receipt.currency,
      totalAmount: receipt.totalAmount,
      qualityRate: receipt.qualityRate,
      status: receipt.status,
      rejectionReason: receipt.rejectionReason,
      lines: (linesByReceipt.get(receipt.id) ?? []).map((line) => ({
        rawText: line.rawText,
        category: line.category,
        quantity: line.quantity,
        unit: line.unit,
        unitPrice: line.unitPrice,
        lineTotal: line.lineTotal,
      })),
    };

    const receiptImageRows = imagesByReceipt.get(receipt.id) ?? [];
    const base = { receiptId: receipt.id, imageCount: receiptImageRows.length, stored };

    if (receiptImageRows.length === 0) {
      return { ...base, ms: 0, error: 'No stored image', parsed: null, verdict: null, changed: [] };
    }

    const started = Date.now();

    try {
      const bytes = await Promise.all(
        receiptImageRows.map((image) => R2.downloadReceiptImage(c.env.RECEIPT_BUCKET, image.id)),
      );

      // The same country hint the original run got, so a difference in the
      // answer is a difference in the prompt rather than in the input.
      const parsed = await ReceiptProcessor.process(
        c.env.OPENROUTER_API_KEY,
        bytes,
        receipt.countryCode ?? 'NG',
      );

      return {
        ...base,
        ms: Date.now() - started,
        error: null,
        parsed: {
          merchantName: parsed.merchantName,
          issuedAt: parsed.issuedAt?.toISOString() ?? null,
          countryCode: parsed.countryCode,
          currency: parsed.currency,
          totalAmount: parsed.totalAmount,
          isReceipt: parsed.isReceipt,
          qualityRate: parsed.qualityRate,
          lines: parsed.lineItems.map((line) => {
            const labelled = toCategory(line.category);

            return {
              lineNo: line.lineNo,
              rawText: line.rawText,
              category: line.category,
              // The same two steps the queue takes before writing a row, so
              // the probe reports what would be stored rather than what the
              // model said. Reporting the model's answer made the exclusion
              // guard invisible to the only measurement of it.
              stored:
                (labelled ? applyExclusions(labelled, line.rawText, line.unit) : null) ?? 'other',
              quantity: line.quantity,
              unit: line.unit,
              lineTotal: line.lineTotal,
            };
          }),
        },
        verdict: gradeReceiptFields(parsed, asOf(parsed.issuedAt)),
        changed: differences(stored, parsed),
      };
    } catch (error) {
      return {
        ...base,
        ms: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
        parsed: null,
        verdict: null,
        changed: [],
      };
    }
  });

  return c.json({ data: { count: results.length, results } }, 200);
});

const STORED_COLUMNS = {
  id: receipts.id,
  merchantName: receipts.merchantName,
  issuedAt: receipts.issuedAt,
  countryCode: receipts.countryCode,
  currency: receipts.currency,
  totalAmount: receipts.totalAmount,
  qualityRate: receipts.qualityRate,
  status: receipts.status,
  rejectionReason: receipts.rejectionReason,
};

/**
 * Which fields the fresh read disagrees about.
 *
 * Only the ones a change would actually cost somebody: the merchant, the
 * total, the country and the number of lines priced. Quality is excluded — it
 * moves by a point or two on every run and would mark every receipt as
 * changed, which is the same as marking none.
 */
function differences(
  stored: { merchantName: string | null; totalAmount: string | null; countryCode: string | null; lines: unknown[] },
  parsed: { merchantName: string | null; totalAmount: number | null; countryCode: string; lineItems: unknown[] },
): string[] {
  const changed: string[] = [];

  if ((stored.merchantName ?? '') !== (parsed.merchantName ?? '')) changed.push('merchantName');
  if (Number(stored.totalAmount ?? NaN) !== (parsed.totalAmount ?? NaN)) changed.push('totalAmount');
  if ((stored.countryCode ?? '') !== parsed.countryCode) changed.push('countryCode');
  if (stored.lines.length !== parsed.lineItems.length) changed.push('lineCount');

  return changed;
}

/**
 * Whether a stored timestamp can be turned back into a string.
 *
 * `timestamptz` holds years JavaScript's `Date` cannot represent, and the
 * driver hands those back as an Invalid Date rather than throwing. Calling
 * `.toISOString()` on one raises `RangeError: Invalid time value` — which took
 * out a whole sampling batch, because one Nigerian receipt in it carries a
 * year the model must have misread off the paper.
 *
 * The receipt is still worth probing; only its stored date is unreadable.
 */
function usable(value: Date | null): value is Date {
  return value !== null && !Number.isNaN(value.getTime());
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const grouped = new Map<K, T[]>();
  for (const item of items) {
    const bucket = grouped.get(key(item));
    if (bucket) bucket.push(item);
    else grouped.set(key(item), [item]);
  }
  return grouped;
}

/**
 * `Promise.all` over twenty model calls opens twenty sockets at once and is
 * the kind of thing that gets an API key rate-limited. A fixed number of
 * workers pulling from a shared cursor keeps the order of the results while
 * bounding what is in flight.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await run(items[index]!);
    }
  });

  await Promise.all(workers);
  return results;
}

