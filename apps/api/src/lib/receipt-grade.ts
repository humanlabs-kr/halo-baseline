import { MAX_RECEIPT_AGE_DAYS, RECEIPT_QUALITY_THRESHOLD } from '@halo/contracts';
import type { RejectionReason } from '@halo/contracts';
import type { Receipt } from './receipt-processor/zod';

/**
 * Everything the verdict can decide from the model's answer alone.
 *
 * Split from the queue's `gradeReceipt`, which adds the one check that needs
 * the database — the same purchase photographed twice. Two callers now: the
 * queue, which acts on the answer, and the admin reparse probe, which only
 * reports it. They have to agree, and the way to guarantee that is for there
 * to be one copy.
 *
 * The order is not arbitrary. Each answer is shown to a user as a thing to do
 * differently, so the first true one has to be the one that actually explains
 * the photo in their hand.
 */
export function gradeReceiptFields(receiptData: Receipt, now = new Date()): RejectionReason | null {
  // Asked before quality, because the two are different failures with
  // different remedies. A photo of a bank statement is not a bad photo, and
  // "the photo came out too blurry" tells that person to steady their hands
  // over an image that was never going to count however sharp it was.
  if (notAReceipt(receiptData)) {
    return 'not-a-receipt';
  }

  if (receiptData.qualityRate < RECEIPT_QUALITY_THRESHOLD) {
    return 'unreadable';
  }

  if (!receiptData.merchantName) {
    return 'no-merchant';
  }

  // Same test as the write path: a receipt whose total cannot be stored has no
  // total as far as the rest of the system is concerned, and a receipt with no
  // total is not claimable.
  if (storableAmount(receiptData.totalAmount) === null) {
    return 'no-total';
  }

  // Asked after `not-a-receipt`, so a photo of a home screen is never told to
  // get the date in the shot. This branch is for a real receipt whose date
  // could not be read — a crease, a thermal print that has faded, the top of
  // the slip cut off.
  if (receiptData.issuedAt === null) {
    return 'no-date';
  }

  if (receiptData.issuedAt < new Date(now.getTime() - MAX_RECEIPT_AGE_DAYS * 24 * 60 * 60 * 1000)) {
    return 'too-old';
  }

  return null;
}

/**
 * Whether the model said this was never a receipt.
 *
 * Two signals, because one of them is new. `isReceipt` is the STEP 0 verdict
 * asked for directly, and it is the one to trust — but it only works if the
 * deployed model actually fills it in.
 *
 * So the older signal is kept alongside it. The prompt has always told the
 * model to answer a non-receipt with `qualityRate = 0` and the literal
 * merchant name `UNKNOWN`, and that pair is already unambiguous: a real
 * receipt scored zero still has whatever name could be read, or none.
 *
 * If `isReceipt` turns out to be ignored the fix still lands. If the model
 * omits the field entirely it parses as `true`, which is the behaviour before
 * this change rather than a new way to reject someone's shopping.
 */
function notAReceipt(receiptData: Receipt): boolean {
  return (
    !receiptData.isReceipt ||
    (receiptData.qualityRate === 0 && receiptData.merchantName === 'UNKNOWN')
  );
}

/**
 * Largest value a `numeric(precision, scale)` column can hold.
 *
 * Derived rather than written out. The constant was retyped by hand once
 * while moving this function and came out as `numeric(12,2)` against a
 * `numeric(15,2)` column, which would have started rejecting real receipts a
 * thousand times smaller than the ones that actually overflow.
 */
export function numericCeiling(precision: number, scale: number): number {
  return 10 ** (precision - scale) - 10 ** -scale;
}

/** `receipts.total_amount` is `numeric(15, 2)`. */
const MAX_TOTAL_AMOUNT = numericCeiling(15, 2);

/**
 * Renders an amount for `receipts.total_amount`, or null if it cannot be stored.
 *
 * NaN, infinities and anything wider than the column are all "no amount"
 * rather than an error. The alternative is an exception three seconds into a
 * paid model call, on data that will not change when the message is
 * redelivered.
 */
export function storableAmount(amount: number | null): string | null {
  if (amount === null || !Number.isFinite(amount) || Math.abs(amount) > MAX_TOTAL_AMOUNT) {
    return null;
  }

  return amount.toFixed(2);
}
