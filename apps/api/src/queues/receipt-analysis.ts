import {
  and,
  createDb,
  eq,
  ne,
  receiptImages,
  receiptLineItems,
  receipts,
  type Database,
  type NewReceiptLineItem,
  type RejectionReason,
} from '@halo/database';
import KSUID from 'ksuid';
import { z } from 'zod';
import { BASE_POINT_PER_RECEIPT } from '../lib/constants';
import { R2 } from '../lib/r2';
import { gradeReceiptFields, numericCeiling, storableAmount } from '../lib/receipt-grade';
import { ReceiptProcessor } from '../lib/receipt-processor';
import {
  applyExclusions,
  readPrintedQuantity,
  toCategory,
  unitPrice,
} from '../lib/receipt-processor/categories';
import type { LineItem, Receipt } from '../lib/receipt-processor/zod';
import { tryCatch } from '../lib/try-catch';

/**
 * Analyses an uploaded receipt out of band.
 *
 * Off the request path because the vision call takes seconds: the upload
 * endpoint stores the image, enqueues here and returns. The queue is configured
 * with `max_batch_size: 1` — batching buys nothing when one model call
 * dominates the invocation, and one unreadable image would fail its batch.
 */

/** A rejected receipt is still worth a token amount, so scanning is never wasted. */
const REJECTED_RECEIPT_POINT = 5;

/** `receipt_line_items.raw_text` is unbounded, but a runaway line is a bug, not data. */
const MAX_RAW_TEXT = 200;

/** `receipt_line_items.quantity` is `numeric(12, 3)`. */
const MAX_QUANTITY = numericCeiling(12, 3);

/** `receipt_line_items.unit_price` is `numeric(15, 4)`. */
const MAX_UNIT_PRICE = numericCeiling(15, 4);

/**
 * Widest value `receipts.total_amount` holds — numeric(15, 2).
 *
 * Writing past it raises `numeric field overflow`, and because that happens in
 * the final transaction — after the model has already read the receipt — the
 * write fails, the message retries, and the retries buy nothing because the
 * amount is the same every time. Before receipts were settled on the last
 * attempt this left the row `pending` forever; a production receipt from
 * 2026-09-13 was stuck exactly that way.
 *
 * So the bound is enforced here rather than discovered by the database.
 */
const MAX_TOTAL_AMOUNT = numericCeiling(15, 2);

const RETRY_DELAY_SECONDS = 10;

/**
 * Total deliveries a message gets: `max_retries` in `wrangler.jsonc` **plus the
 * first delivery**.
 *
 * `message.attempts` is 1-based — the queue computes it as `failedAttempts + 1`
 * and keeps redelivering while `failedAttempts < maxRetries + 1`. So
 * `max_retries: 3` yields attempts 1, 2, 3 and 4. Treating 3 as the last one
 * would throw away a delivery that is still coming: a receipt caught in a
 * 40-second provider outage would be rejected at t=20s while the attempt that
 * would have succeeded, at t=30s, never runs.
 *
 * Cloudflare drops a message once its retries are spent, and nothing else
 * notices: the row keeps `status = 'pending'`, no error is written, and the
 * receipt sits in the user's history saying "analysing" until someone runs a
 * query. That is how 174k rows accumulated, so the final attempt settles the
 * receipt rather than letting the queue swallow it.
 */
const MAX_DELIVERY_ATTEMPTS = 4;

/**
 * Marks a receipt that was uploaded past the weekly point-earning limit. It is
 * still analysed and shown, it just cannot be claimed.
 */
const POINT_INELIGIBLE = -1;

const paramsSchema = z.object({
  receiptId: z.string(),
  /** ISO 3166-1 alpha-2, inferred from the uploader's IP. A hint for the model. */
  country: z.string(),
});

type Params = z.infer<typeof paramsSchema>;

export const ReceiptAnalysisQueue = {
  name: 'receipt-analysis',

  async send(queue: Queue, params: Params): Promise<void> {
    await queue.send(params, { contentType: 'json' });
  },

  async run(batch: MessageBatch, env: Env): Promise<void> {
    const db = createDb(env.HYPERDRIVE.connectionString);

    // `parse` is inside the async callback on purpose. Called in a plain
    // callback it throws synchronously, which makes `.map()` itself throw
    // before `allSettled` ever sees it — the handler rejects, the whole batch
    // is redelivered, and the per-message settling below never runs. An
    // unparseable message has to become a rejected promise like any other
    // failure.
    const results = await Promise.allSettled(
      batch.messages.map(async (message) => analyseReceipt(db, env, paramsSchema.parse(message.body))),
    );

    await Promise.all(
      results.map(async (result, index) => {
        const message = batch.messages[index];

        if (result.status !== 'rejected' || !message) {
          return;
        }

        console.error('Receipt analysis message failed:', result.reason);

        if (message.attempts < MAX_DELIVERY_ATTEMPTS) {
          message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
          return;
        }

        await settleUnanalysable(db, message.body, result.reason);
      }),
    );
  },
};

/**
 * Closes out a receipt whose analysis will not be attempted again.
 *
 * Deliberately scoped to rows still in `pending`: a receipt the user has since
 * claimed, or one a later delivery already settled, must not be rewritten by a
 * message that is only now giving up.
 */
async function settleUnanalysable(db: Database, body: unknown, reason: unknown): Promise<void> {
  const params = paramsSchema.safeParse(body);

  if (!params.success) {
    console.error('Cannot settle an analysis message that does not parse:', body);
    return;
  }

  const message = reason instanceof Error ? reason.message : String(reason);

  const settled = await tryCatch(
    db
      .update(receipts)
      .set({
        status: 'rejected',
        assignedPoint: 0,
        analysisCompletedAt: new Date(),
        analysisError: `Abandoned after ${MAX_DELIVERY_ATTEMPTS} delivery attempts: ${message}`,
      })
      .where(and(eq(receipts.id, params.data.receiptId), eq(receipts.status, 'pending'))),
  );

  if (settled.error) {
    console.error(`Failed to settle abandoned receipt ${params.data.receiptId}:`, settled.error);
  }
}

async function analyseReceipt(db: Database, env: Env, params: Params): Promise<void> {
  const receipt = await db.query.receipts.findFirst({
    where: eq(receipts.id, params.receiptId),
  });

  if (!receipt) {
    throw new Error(`Receipt not found: ${params.receiptId}`);
  }

  // A receipt can be delivered twice — the sweeper re-queues anything still
  // pending, and a message it was not aware of may arrive later. Analysing an
  // already-settled receipt is not a harmless repeat: it re-runs the model and
  // overwrites the verdict, which can knock a `claimable` receipt down to
  // `rejected` (the duplicate check below would match the row's own earlier
  // result) or reopen one the user has already claimed.
  if (receipt.status !== 'pending') {
    return;
  }

  const receiptImageRecords = await db.query.receiptImages.findMany({
    columns: { id: true },
    where: eq(receiptImages.receiptId, params.receiptId),
  });

  if (receiptImageRecords.length === 0) {
    throw new Error(`Receipt has no images: ${params.receiptId}`);
  }

  await db
    .update(receipts)
    .set({ analysisStartedAt: new Date() })
    .where(eq(receipts.id, params.receiptId));

  const images = await Promise.all(
    receiptImageRecords.map((image) => R2.downloadReceiptImage(env.RECEIPT_BUCKET, image.id)),
  );

  const analysis = await tryCatch(ReceiptProcessor.process(env.OPENROUTER_API_KEY, images, params.country));

  // A failed analysis is a rejected receipt, not a lost one: the reason is
  // stored so the user sees why and support can tell a model outage from a bad
  // photo.
  if (analysis.error) {
    console.error('Receipt analysis failed:', analysis.error);

    await db
      .update(receipts)
      .set({
        status: 'rejected',
        assignedPoint: 0,
        analysisCompletedAt: new Date(),
        analysisError: analysis.error.message,
      })
      .where(eq(receipts.id, params.receiptId));

    return;
  }

  const receiptData = analysis.data;
  const rejection = await gradeReceipt(db, params.receiptId, receipt.userAddress, receiptData);
  const status = rejection === null ? 'claimable' : 'rejected';

  const assignedPoint =
    rejection === null
      ? Math.floor((BASE_POINT_PER_RECEIPT * receiptData.qualityRate) / 100)
      : REJECTED_RECEIPT_POINT;

  await db.transaction(async (tx) => {
    const current = await tx.query.receipts.findFirst({
      where: eq(receipts.id, params.receiptId),
    });

    if (!current) {
      throw new Error(`Receipt disappeared mid-analysis: ${params.receiptId}`);
    }

    // Uploaded past the weekly limit: record the analysis, but settle it
    // immediately at zero rather than offering points that cannot be claimed.
    // Re-checked inside the transaction: the guard at the top of this function
    // ran before a model call that takes seconds, which is more than enough
    // time for a claim to land.
    if (current.status !== 'pending') {
      return;
    }

    const pointIneligible = current.assignedPoint === POINT_INELIGIBLE;

    await tx
      .update(receipts)
      .set({
        merchantName: receiptData.merchantName,
        issuedAt: receiptData.issuedAt,
        countryCode: receiptData.countryCode,
        currency: receiptData.currency,
        totalAmount: storableAmount(receiptData.totalAmount),
        paymentMethod: receiptData.paymentMethod,
        qualityRate: Math.max(0, Math.min(100, Math.floor(receiptData.qualityRate))),
        status: pointIneligible ? 'claimed' : status,
        rejectionReason: rejection,
        assignedPoint: pointIneligible ? 0 : assignedPoint,
        analysisCompletedAt: new Date(),
        analysisError: null,
      })
      .where(and(eq(receipts.id, params.receiptId), eq(receipts.status, 'pending')));

    // Deleted first so a redelivery cannot double the lines. The status guard
    // above already makes that unlikely, but a partial failure between the two
    // writes would otherwise leave a receipt with two copies of its basket.
    await tx.delete(receiptLineItems).where(eq(receiptLineItems.receiptId, params.receiptId));

    const lines = toLineItemRows(params.receiptId, receiptData.lineItems);

    if (lines.length > 0) {
      await tx.insert(receiptLineItems).values(lines);
    }
  });
}

/**
 * Turns the model's lines into rows, dropping the ones we are not allowed to price.
 *
 * Exported for the line backfill, which re-reads receipts the line reader
 * never saw. It has to write rows identical to these — a second copy of the
 * category, exclusion and quantity logic would make the corpus two corpora,
 * and the market median would be computed over both.
 *
 * `other` becomes a null category: the line still counts toward the user's
 * spend and is shown as unmatched, it simply cannot move a price series.
 * `unitPrice` is null whenever the quantity could not be converted to the
 * category's canonical unit — see `toCanonicalQuantity`, which returns null
 * rather than guessing.
 */
export function toLineItemRows(receiptId: string, lineItems: LineItem[]): NewReceiptLineItem[] {
  return lineItems.map((line, index) => {
    // Two steps, not one. `toCategory` narrows the model's label to the
    // basket; `applyExclusions` takes it back off when the printed text names
    // something the category cannot contain — bleach in the detergent slot, a
    // biscuit in the bread slot. The prompt asks for both and does not reliably
    // deliver the second.
    const labelled = toCategory(line.category);
    const category = labelled ? applyExclusions(labelled, line.rawText, line.unit) : null;

    // And a third: some numbers on a line describe the product rather than the
    // purchase. "食パン 6枚切" is one loaf sliced six ways, not six loaves.
    const printed =
      category === null
        ? { quantity: line.quantity, unit: line.unit }
        : readPrintedQuantity(category, line.rawText, line.quantity, line.unit);

    return {
      id: KSUID.randomSync().string,
      receiptId,
      // The model is told to number from 1 in printed order, but the array
      // order is the thing we actually rely on for display.
      lineNo: index + 1,
      rawText: line.rawText.slice(0, MAX_RAW_TEXT),
      category,
      quantity: storableDecimal(printed.quantity, MAX_QUANTITY, 3),
      unit: printed.unit,
      unitPrice: category
        ? storableDecimal(
            unitPrice(category, line.lineTotal, printed.quantity, printed.unit),
            MAX_UNIT_PRICE,
            4,
          )
        : null,
      lineTotal: storableDecimal(line.lineTotal, MAX_TOTAL_AMOUNT, 2),
      source: 'vision' as const,
    };
  });
}

/**
 * Renders a number for a `numeric` column, or null when it cannot be stored.
 *
 * Same reasoning as `storableAmount`: a value that overflows the column is "no
 * value", not an exception three seconds into a paid model call.
 */
function storableDecimal(value: number | null, max: number, scale: number): string | null {
  if (value === null || !Number.isFinite(value) || value <= 0 || value > max) {
    return null;
  }

  // Bounded *after* rounding, not before. `toFixed` rounds half away from
  // zero, so a value a hair under the ceiling — 999999999.9996 against
  // numeric(12,3) — passes the check above and then renders as
  // "1000000000.000", which the column rejects.
  const rendered = value.toFixed(scale);

  return Number(rendered) > max ? null : rendered;
}

/**
 * Decides whether an analysed receipt can earn points.
 *
 * The three fields that make a receipt a receipt — who, when, how much — must
 * all be present and plausible, and the same purchase must not already be in
 * the wallet's history.
 *
 * Returns the reason it failed, or `null` when it passed. It used to return
 * the status string, which collapsed five different situations into one word
 * and left the app to guess which of them had happened from the fields that
 * came back. It guessed wrong for the two that leave a perfectly good receipt
 * behind: too old, and photographed twice.
 */
export async function gradeReceipt(
  db: Database,
  receiptId: string,
  userAddress: string,
  receiptData: Receipt,
): Promise<RejectionReason | null> {
  const fieldVerdict = gradeReceiptFields(receiptData);
  if (fieldVerdict !== null) {
    return fieldVerdict;
  }

  // Nothing to match on without a timestamp, and `eq(column, null)` is never
  // true in SQL anyway — it would silently compare against nothing and call
  // every dateless receipt unique.
  if (receiptData.issuedAt === null) {
    return null;
  }

  // Same wallet, same purchase timestamp: the same receipt photographed twice.
  // Already-claimed rows are excluded so a legitimate re-scan of a settled
  // receipt does not block a genuinely new one.
  //
  // The row being graded is excluded as well. Without that, a second delivery
  // of the same message finds the verdict its own first delivery wrote and
  // calls the receipt a duplicate of itself.
  const duplicate = await db.query.receipts.findFirst({
    where: and(
      ne(receipts.id, receiptId),
      eq(receipts.userAddress, userAddress),
      eq(receipts.issuedAt, receiptData.issuedAt),
      ne(receipts.status, 'claimed'),
    ),
  });

  return duplicate ? 'duplicate' : null;
}
