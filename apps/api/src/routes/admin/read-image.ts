/**
 * Run the live prompt over an image that is not in the database yet.
 *
 * `reparse` re-reads receipts we already hold, which answers "did the prompt
 * get better" but cannot answer "will it cope with a kind of receipt we have
 * never seen". Japan is that case: the corpus holds seven Japanese line items
 * in total, and the category hints in the prompt name Korean, Indonesian,
 * Yoruba, Swahili, Spanish and French — and exactly one Japanese word. Nobody
 * knows what the model does with 「お米 コシヒカリ 5kg」 because nobody has
 * ever put one in front of it.
 *
 * Nothing is written. No receipt row, no line items, no R2 object, no points.
 * The answer comes back as JSON and goes nowhere else, so this can be pointed
 * at production — where the prompt that matters actually runs — without any
 * of it reaching a user's ledger or a published median.
 *
 * It also reports what the *rest* of the pipeline would then do with each
 * line: the category after exclusions, the canonical quantity, and the unit
 * price. A line the model reads perfectly and the conversion table then
 * refuses is a different problem from one the model misreads, and telling
 * them apart from the outside was not previously possible.
 */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';

import { adminAuth } from '../../middleware/auth';
import { gradeReceiptFields } from '../../lib/receipt-grade';
import {
  applyExclusions,
  readPrintedQuantity,
  toCanonicalQuantity,
  toCategory,
  unitPrice,
  CANONICAL_UNIT,
  type ItemCategory,
  type RawUnit,
} from '../../lib/receipt-processor/categories';
import { ReceiptProcessor } from '../../lib/receipt-processor';
import type { AppEnv } from '../../types';
import { adminValidationHook, jsonData, jsonError } from './shared';

const lineSchema = z.object({
  rawText: z.string(),
  /** What the model answered, before our own exclusion rules run. */
  modelCategory: z.string().nullable(),
  /** What it becomes after them — `other` where a rule demoted it. */
  category: z.string().nullable(),
  quantity: z.number().nullable(),
  unit: z.string().nullable(),
  lineTotal: z.number().nullable(),
  /** The unit the category is indexed in, for reading the next two against. */
  canonicalUnit: z.string().nullable(),
  /** Null where the printed unit does not convert to the canonical one. */
  canonicalQuantity: z.number().nullable(),
  /** Null means this line cannot enter a price series, and why is above. */
  unitPrice: z.number().nullable(),
});

const readImageRoute = createRoute({
  method: 'post',
  path: '/admin/test/read-image',
  tags: ['Admin'],
  summary: 'Read an image with the live prompt and report what would happen to it (writes nothing)',
  middleware: [adminAuth] as const,
  request: {
    body: {
      required: true,
      content: {
        'multipart/form-data': {
          schema: z.object({
            file: z.instanceof(File),
            /**
             * The country hint the prompt receives. On a real upload this is
             * the request IP's country, so it is a hint and not ground truth —
             * pass the one a real uploader would send, not the one you want.
             */
            country: z
              .string()
              .regex(/^[A-Za-z]{2}$/, 'country must be an ISO 3166-1 alpha-2 code')
              .optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: jsonData(
      'What the model read',
      z.object({
        ms: z.number(),
        isReceipt: z.boolean(),
        qualityRate: z.number(),
        merchantName: z.string().nullable(),
        issuedAt: z.string().nullable(),
        countryCode: z.string(),
        currency: z.string().nullable(),
        totalAmount: z.number().nullable(),
        /** What the queue would do with it: accept, or reject and why. */
        verdict: z.string(),
        lines: z.array(lineSchema),
      }),
    ),
    400: jsonError('Bad request'),
    401: jsonError('Unauthorized'),
  },
});

export const adminReadImageRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: adminValidationHook,
}).openapi(readImageRoute, async (c) => {
  const { file, country } = c.req.valid('form');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const started = Date.now();

  const parsed = await ReceiptProcessor.process(
    c.env.OPENROUTER_API_KEY,
    [bytes],
    (country ?? 'JP').toUpperCase(),
  );

  // The whole parsed object: the grader reads more of it than the five fields
  // a summary would carry, and passing a subset would be a second opinion
  // about what "accepted" means rather than the queue's own.
  const grade = gradeReceiptFields(parsed);

  return c.json(
    {
      data: {
        ms: Date.now() - started,
        isReceipt: parsed.isReceipt,
        qualityRate: parsed.qualityRate,
        merchantName: parsed.merchantName,
        issuedAt: parsed.issuedAt?.toISOString() ?? null,
        countryCode: parsed.countryCode,
        currency: parsed.currency,
        totalAmount: parsed.totalAmount,
        verdict: grade ?? 'accepted',
        lines: parsed.lineItems.map((line) => {
          const answered = toCategory(line.category);
          const category = answered
            ? applyExclusions(answered, line.rawText, line.unit)
            : null;
          // What the queue would store, not what the model answered — the
          // two differ wherever a printed number describes the product.
          const printed =
            category === null
              ? { quantity: line.quantity, unit: line.unit as RawUnit | null }
              : readPrintedQuantity(
                  category as ItemCategory,
                  line.rawText,
                  line.quantity,
                  line.unit as RawUnit,
                );

          return {
            rawText: line.rawText,
            modelCategory: answered,
            category,
            quantity: printed.quantity,
            unit: printed.unit,
            lineTotal: line.lineTotal,
            canonicalUnit: category === null ? null : CANONICAL_UNIT[category as ItemCategory],
            canonicalQuantity:
              category === null
                ? null
                : toCanonicalQuantity(category as ItemCategory, printed.quantity, printed.unit),
            unitPrice:
              category === null
                ? null
                : unitPrice(category as ItemCategory, line.lineTotal, printed.quantity, printed.unit),
          };
        }),
      },
    },
    200,
  );
});
