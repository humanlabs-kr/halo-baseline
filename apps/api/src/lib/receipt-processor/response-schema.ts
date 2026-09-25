/**
 * JSON schema handed to the model for structured outputs.
 *
 * Written by hand rather than derived from the zod schema. `zodResponseFormat`
 * from the OpenAI SDK only produces a strict-mode-compatible schema for zod 4
 * schemas; against a classic zod 3 schema it falls back to a converter that
 * emits `nullable: true`, `format`, `minLength` and `minimum`, all of which
 * OpenAI rejects under `strict: true`. Keeping the wire schema explicit also
 * means the two constraints stay separate on purpose: this one describes what
 * the model may return, `ReceiptSchema` decides what we accept.
 *
 * Strict mode requires every property to be listed in `required` and
 * `additionalProperties: false`; nullability is expressed as a type union.
 */
import { LINE_ITEMS_JSON_SCHEMA } from './line-items-prompt';

export const RECEIPT_RESPONSE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    merchantName: {
      type: ['string', 'null'],
      description: 'Business that issued the receipt. Never a payment processor or a domain name.',
    },
    issuedAt: {
      type: 'string',
      description: 'Transaction timestamp printed on the receipt, as an ISO 8601 string.',
    },
    countryCode: {
      type: 'string',
      description: 'ISO 3166-1 alpha-2 country code, uppercase.',
    },
    currency: {
      type: 'string',
      description: 'ISO 4217 currency code, uppercase.',
    },
    totalAmount: {
      type: ['number', 'null'],
      description: 'Final amount paid, or null when no explicit total label is present.',
    },
    paymentMethod: {
      type: ['string', 'null'],
      description: 'Payment method exactly as printed, or null.',
    },
    isReceipt: {
      type: 'boolean',
      description:
        'False when the image is not a purchase receipt at all. Decided in STEP 0, before any field is read.',
    },
    qualityRate: {
      type: 'number',
      description: 'Integer 0-100. How reliably the three core fields could be read.',
    },
    lineItems: LINE_ITEMS_JSON_SCHEMA,
  },
  required: [
    'merchantName',
    'issuedAt',
    'countryCode',
    'currency',
    'totalAmount',
    'paymentMethod',
    'isReceipt',
    'qualityRate',
    'lineItems',
  ],
  additionalProperties: false,
} as const;
