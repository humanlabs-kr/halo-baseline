import { z } from 'zod';
import { EXTRACTION_LABELS, RAW_UNITS } from './categories';

/**
 * What we accept back from the vision model.
 *
 * Stricter than the JSON schema the model is given: structured outputs
 * guarantees the field set and their types, this guarantees the values are
 * usable. A receipt that fails here is rejected rather than half-stored.
 */
/**
 * One printed line off the receipt.
 *
 * Every field except `rawText` is allowed to be missing, because on a real
 * receipt they often are — a line with no printed pack size has no quantity,
 * and inventing one would put a fabricated unit price into a price series.
 */
export const LineItemSchema = z.object({
  lineNo: z.number().int().min(1).describe('1-based position in printed order'),
  rawText: z.string().min(1).describe('The line exactly as printed'),
  category: z.enum(EXTRACTION_LABELS).describe('Basket category, or `other`'),
  quantity: z.number().positive().nullable().describe('Printed quantity'),
  unit: z.enum(RAW_UNITS).nullable().describe('Printed unit'),
  lineTotal: z.number().nullable().describe('Amount printed for the line'),
});

export type LineItem = z.infer<typeof LineItemSchema>;

export const ReceiptSchema = z.object({
  merchantName: z.string().nullable().describe('Merchant name'),
  /**
   * Transaction timestamp, or null when nothing date-like could be read.
   *
   * Nullable because the strict version threw away the whole response. The
   * prompt tells the model to return a placeholder date only if one is
   * actually visible — which is precisely the non-receipt case — so a photo of
   * an app screen came back with an unparseable `issuedAt`, `z.coerce.date()`
   * rejected the object, and the analysis failed as an exception. The queue
   * treats that as an outage: no rejection reason, no participation reward.
   * The user saw "this one did not count" and lost five points for
   * photographing the wrong thing, which is the one case we now have a real
   * answer for.
   */
  issuedAt: z
    .preprocess((value) => {
      const parsed = new Date(value as string);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }, z.date().nullable())
    .describe('Transaction timestamp, null when unreadable'),
  countryCode: z.string().length(2).describe('ISO 3166-1 alpha-2 country code'),
  currency: z.string().length(3).describe('ISO 4217 currency code'),
  totalAmount: z.number().nullable().describe('Final amount paid'),
  paymentMethod: z.string().nullable().describe('Payment method as printed'),
  /**
   * Whether the image was a purchase receipt at all.
   *
   * Defaulted to `true` so a response missing the field cannot reject a
   * readable receipt: the failure we care about is telling someone their sharp
   * photo of a bank statement "came out too blurry", not the reverse. A
   * genuine non-receipt still scores zero and is rejected either way.
   */
  isReceipt: z.boolean().default(true).describe('False when the image is not a receipt'),
  qualityRate: z.number().min(0).max(100).describe('How readable the receipt was, 0-100'),

  /**
   * Defaulted rather than required: a receipt that scores and pays correctly
   * must not be rejected because the line-item half of the response was
   * malformed. Losing the lines costs observations; losing the receipt costs
   * the user their points.
   */
  lineItems: z.array(LineItemSchema).default([]).describe('Purchased lines, in printed order'),
});

export type Receipt = z.infer<typeof ReceiptSchema>;
