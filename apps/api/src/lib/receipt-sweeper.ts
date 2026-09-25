import { and, eq, gte, inArray, isNull, lt, or, receipts, type Database } from '@halo/database';
import { ReceiptAnalysisQueue } from '../queues';

/**
 * Closes the gap between "a receipt was uploaded" and "a receipt was analysed".
 *
 * Every step between those two points can fail without anyone noticing: the
 * queue send can be rejected, the message can expire in a backlog, the consumer
 * can exhaust its retries. In each case the row keeps `status = 'pending'` and
 * no further work is ever scheduled for it, so the receipt shows "analysing" in
 * the user's history permanently.
 *
 * Production reached 174,534 such rows — 114k of them from a single day when
 * uploads spiked to 188k and the queue could not drain them. Nothing in the
 * system would ever have retried one of them. This sweeper is that missing
 * half: re-queue what is merely late, settle what is past saving.
 */

/**
 * A receipt still pending after this long did not reach the consumer. Analysis
 * itself averages four seconds, so half an hour is not a slow run — it is a
 * message that was never delivered.
 */
const STALE_AFTER_MINUTES = 30;

/**
 * Past this there is nothing worth re-queueing: `MAX_RECEIPT_AGE_DAYS` in the
 * consumer rejects any receipt issued more than a week ago, so re-analysis
 * would spend a model call to reach the same verdict.
 */
const ABANDON_AFTER_DAYS = 7;

/** Rows settled per run. Chunked so one pass cannot hold a long write lock. */
const ABANDON_BATCH = 500;

/** Messages re-queued per run, kept under the consumer's concurrency ceiling. */
const REQUEUE_BATCH = 200;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export const ReceiptSweeper = {
  async run(db: Database, env: Env): Promise<void> {
    const now = Date.now();
    const abandonBefore = new Date(now - ABANDON_AFTER_DAYS * DAY_MS);
    const staleBefore = new Date(now - STALE_AFTER_MINUTES * MINUTE_MS);

    // Settle first. Re-queueing first would hand the queue rows that the very
    // next statement is about to abandon.
    const abandoned = await abandonExpired(db, abandonBefore);
    const requeued = await requeueStalled(db, env, staleBefore, abandonBefore);

    if (abandoned > 0 || requeued > 0) {
      console.log(`Receipt sweeper: settled ${abandoned}, re-queued ${requeued}`);
    }
  },
};

/**
 * Marks receipts that are too old to analyse as rejected, with no points.
 *
 * `assignedPoint` is zeroed rather than given the consolation award: these
 * receipts were never scored, so there is no judgement to reward, and paying
 * out on rows the system lost would turn an outage into an airdrop.
 */
async function abandonExpired(db: Database, abandonBefore: Date): Promise<number> {
  const expired = await db
    .select({ id: receipts.id })
    .from(receipts)
    .where(and(eq(receipts.status, 'pending'), lt(receipts.createdAt, abandonBefore)))
    .orderBy(receipts.createdAt)
    .limit(ABANDON_BATCH);

  if (expired.length === 0) {
    return 0;
  }

  await db
    .update(receipts)
    .set({
      status: 'rejected',
      assignedPoint: 0,
      analysisCompletedAt: new Date(),
      analysisError: `Never analysed within ${ABANDON_AFTER_DAYS} days of upload`,
    })
    .where(
      and(
        inArray(
          receipts.id,
          expired.map((receipt) => receipt.id),
        ),
        // Re-checked because the select above is not part of this statement:
        // a receipt settled between the two must not be rewritten.
        eq(receipts.status, 'pending'),
      ),
    );

  return expired.length;
}

/**
 * Puts late receipts back on the queue.
 *
 * The country hint is dropped — it came from the uploader's IP header and was
 * never stored. An empty hint is the same value the upload path already sends
 * when Cloudflare omits `CF-IPCountry`, and the prompt treats it as a hint
 * rather than ground truth, so a re-queued receipt is scored the same way as
 * one uploaded from an unknown country.
 *
 * A receipt whose image is missing from R2 is re-queued too, and that is
 * intended: the consumer throws, spends its retries and settles the row, which
 * is the only path that gets those receipts out of `pending` at all.
 *
 * Every row sent is stamped with `analysisStartedAt`, and rows stamped within
 * the staleness window are skipped. Without that stamp this function is a
 * backlog amplifier rather than a repair: the selection is ordered and
 * deterministic, so each pass would pick the *same* oldest rows, pile another
 * message on receipts that already have one queued, and never reach the rest.
 * A twelve-hour backlog would mean thousands of duplicate — and billable —
 * vision calls against a couple of hundred receipts.
 */
async function requeueStalled(
  db: Database,
  env: Env,
  staleBefore: Date,
  abandonBefore: Date,
): Promise<number> {
  const stalled = await db
    .select({ id: receipts.id })
    .from(receipts)
    .where(
      and(
        eq(receipts.status, 'pending'),
        lt(receipts.createdAt, staleBefore),
        gte(receipts.createdAt, abandonBefore),
        // `analysisStartedAt` reads as "when this receipt was last handed to
        // the analyser" — the consumer sets it when it picks a message up, and
        // this function sets it when it re-queues one. Either way, a value
        // newer than the staleness window means an attempt is still in flight.
        or(isNull(receipts.analysisStartedAt), lt(receipts.analysisStartedAt, staleBefore)),
      ),
    )
    .orderBy(receipts.createdAt)
    .limit(REQUEUE_BATCH);

  if (stalled.length === 0) {
    return 0;
  }

  const results = await Promise.allSettled(
    stalled.map((receipt) =>
      ReceiptAnalysisQueue.send(env.RECEIPT_ANALYSIS_QUEUE, { receiptId: receipt.id, country: '' }),
    ),
  );

  const delivered = stalled
    .filter((_, index) => results[index]?.status === 'fulfilled')
    .map((receipt) => receipt.id);

  const failures = results.filter((result) => result.status === 'rejected');

  if (failures.length > 0) {
    console.error(`Receipt sweeper: ${failures.length} re-queue sends failed`, failures[0]?.reason);
  }

  // Only what actually reached the queue is stamped. A send that failed has to
  // stay eligible for the next pass.
  if (delivered.length > 0) {
    await db
      .update(receipts)
      .set({ analysisStartedAt: new Date() })
      .where(and(inArray(receipts.id, delivered), eq(receipts.status, 'pending')));
  }

  return delivered.length;
}
