import { z } from 'zod';

/**
 * Receipt lifecycle.
 *
 * - `pending`          uploaded, sitting in the analysis queue
 * - `rejected`         below the quality threshold, or missing one of the three
 *                      required fields (timestamp, total, merchant)
 * - `claimable`        passed analysis; the user can claim points
 * - `claimed`          the user completed the onchain claim
 * - `rejected-claimed` consolation reward claimed for a rejected receipt
 */
export const RECEIPT_STATUSES = ['pending', 'rejected', 'claimable', 'claimed', 'rejected-claimed'] as const;

export const receiptStatusSchema = z.enum(RECEIPT_STATUSES);
export type ReceiptStatus = z.infer<typeof receiptStatusSchema>;

/**
 * Why a receipt was rejected.
 *
 * `status` says a scan did not count; it does not say what to do differently,
 * and these are five different pieces of advice. Inferring it from the fields
 * that came back reads fine for a blurry photo and tells someone holding a
 * sharp, complete, two-week-old receipt to photograph it again — the one
 * action that cannot possibly help them.
 *
 * Mirrored by `REJECTION_REASONS` in `@halo/database`, which the mini app does
 * not and should not depend on.
 */
export const REJECTION_REASONS = [
  'not-a-receipt',
  'unreadable',
  'no-merchant',
  'no-total',
  'no-date',
  'too-old',
  'duplicate',
] as const;

export const rejectionReasonSchema = z.enum(REJECTION_REASONS);
export type RejectionReason = z.infer<typeof rejectionReasonSchema>;

/**
 * Points a perfect receipt is worth.
 *
 * The award scales with the analysis quality rate, so this is a ceiling
 * rather than a flat rate — a receipt scored 80 pays 20.
 *
 * Here rather than in the API because the mini app has to print it, and
 * printing it from a second copy is how the rewards screen came to advertise
 * "+30" for something that has never paid more than 25. A number a user can
 * check against their own balance has to have one source.
 */
export const BASE_POINT_PER_RECEIPT = 25;

/**
 * What the daily check-in pays, as a range.
 *
 * It is drawn at random inside these bounds, so there is no single number to
 * print — and the rewards screen was printing "+10", which is not a number it
 * has ever paid. Same failure as the "+30" that put `BASE_POINT_PER_RECEIPT`
 * in this file: a figure the user can check against their own balance, kept in
 * a second place.
 */
export const DAILY_CHECK_IN_POINTS = { min: 5, max: 8 } as const;

/** The extra on-chain mint Celo offers after the check-in. Richer by design. */
export const DAILY_ONCHAIN_BONUS_POINTS = { min: 12, max: 20 } as const;

/** Analysis scores below this are rejected. */
export const RECEIPT_QUALITY_THRESHOLD = 30;

/** Purchases older than this are not paid for. */
export const MAX_RECEIPT_AGE_DAYS = 7;

/** Receipts issued longer ago than this are not accepted. */
export const RECEIPT_MAX_AGE_DAYS = 7;

export const receiptSchema = z.object({
  id: z.string(),
  status: receiptStatusSchema,
  assignedPoint: z.number().int(),
  merchantName: z.string().nullable(),
  issuedAt: z.string().nullable(),
  countryCode: z.string().nullable(),
  currency: z.string().nullable(),
  totalAmount: z.string().nullable(),
  qualityRate: z.number().int().nullable(),
  createdAt: z.string(),
});

export type Receipt = z.infer<typeof receiptSchema>;
