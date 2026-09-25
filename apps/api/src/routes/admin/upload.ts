/**
 * Put an image through the real upload path, without a browser.
 *
 * A normal upload needs two things this cannot have: a Turnstile token, which
 * is a challenge solved by a human in a browser and correctly refuses to be
 * scripted, and a wallet signature, because `impersonate` is disabled outside
 * staging. So there is no way to get a receipt into production except by hand,
 * one at a time, on a phone.
 *
 * That matters when a country has no corpus. Japan holds seven line items in
 * total, which is below every floor in the app, so a Japanese user opens the
 * market board and sees nothing — the exact empty screen this product was
 * rebuilt to stop showing. Filling it by hand is thirty receipts photographed
 * on a phone.
 *
 * Everything after the two gates is the real path, deliberately: the same
 * image normalisation, the same R2 object, the same rows, the same queue
 * message, the same vision prompt, the same categoriser. A shortcut here
 * would make this a test of code that nothing else runs.
 *
 * WHAT THIS MEANS FOR THE INDEX. Receipts written here are indistinguishable
 * from real ones — the queue writes `source = 'vision'` and no column records
 * how they arrived. If the images are invented, the prices are invented, and
 * they will be pooled into the median that real users in that country are
 * compared against. `MIN_MARKET_OBSERVATIONS` counts distinct receipts and not
 * distinct people, so one address uploading thirty of them is enough to
 * publish a country's price on its own.
 *
 * Use addresses you can find again. `DELETE /admin/test/upload/{address}`
 * below takes them all back out, so this is reversible by anyone holding the
 * admin token rather than by anyone holding a database connection.
 */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { eq, inArray, receiptImages, receiptLineItems, receipts, users } from '@halo/database';
import KSUID from 'ksuid';

import { adminAuth } from '../../middleware/auth';
import { R2 } from '../../lib/r2';
import { ReceiptAnalysisQueue } from '../../queues/receipt-analysis';
import { ReceiptProcessor } from '../../lib/receipt-processor';
import type { AppEnv } from '../../types';
import { adminValidationHook, jsonData, jsonError } from './shared';

const uploadRoute = createRoute({
  method: 'post',
  path: '/admin/test/upload',
  tags: ['Admin'],
  summary: 'Upload a receipt image as a given wallet, through the real analysis queue',
  middleware: [adminAuth] as const,
  request: {
    body: {
      required: true,
      content: {
        'multipart/form-data': {
          schema: z.object({
            file: z.instanceof(File),
            address: z
              .string()
              .regex(/^0x[0-9a-fA-F]{40}$/, 'address must be a 0x-prefixed wallet address'),
            /**
             * The country hint the prompt receives — on a real upload this is
             * the request IP's country. It is a hint and not ground truth:
             * the model is told to prefer what is printed on the paper.
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
    200: jsonData('Queued', z.object({ receiptId: z.string(), address: z.string() })),
    400: jsonError('Bad request'),
    401: jsonError('Unauthorized'),
  },
});

export const adminUploadRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: adminValidationHook,
}).openapi(uploadRoute, async (c) => {
  const db = c.get('db');
  const { file, address, country } = c.req.valid('form');
  const userAddress = address.toLowerCase() as `0x${string}`;

  // A receipt needs an owner: `receipts.user_address` is a foreign key onto
  // `users`, and on the real path the row already exists because signing in
  // upserts it. Without this every insert here fails the constraint.
  await db
    .insert(users)
    .values({
      address: userAddress,
      username: `admin-upload-${userAddress.slice(2, 8)}`,
      checksumAddress: address as `0x${string}`,
    })
    .onConflictDoNothing();

  // Image before rows, as the client path does. An orphaned R2 object costs
  // storage; an orphaned row costs a receipt that says "analysing" forever.
  const receiptImageId = crypto.randomUUID();
  const normalised = ReceiptProcessor.normalizeImage(new Uint8Array(await file.arrayBuffer()));
  await R2.saveReceiptImage(c.env.RECEIPT_BUCKET, normalised, receiptImageId);

  const receiptId = await db.transaction(async (tx) => {
    const id = KSUID.randomSync().string;
    await tx.insert(receipts).values({ id, userAddress });
    await tx.insert(receiptImages).values([{ id: receiptImageId, receiptId: id, numOrder: 0 }]);
    return id;
  });

  // `await`, not `waitUntil`: a send that fails inside `waitUntil` is
  // invisible, and the receipt would sit `pending` for good.
  await ReceiptAnalysisQueue.send(c.env.RECEIPT_ANALYSIS_QUEUE, {
    receiptId,
    country: (country ?? '').toUpperCase(),
  });

  return c.json({ data: { receiptId, address: userAddress } }, 200);
});

const removeRoute = createRoute({
  method: 'delete',
  path: '/admin/test/upload/{address}',
  tags: ['Admin'],
  summary: 'Remove every receipt belonging to an address, and its line items',
  middleware: [adminAuth] as const,
  request: {
    params: z.object({
      address: z
        .string()
        .regex(/^0x[0-9a-fA-F]{40}$/, 'address must be a 0x-prefixed wallet address'),
    }),
  },
  responses: {
    200: jsonData('Removed', z.object({ receipts: z.number(), lines: z.number() })),
    400: jsonError('Bad request'),
    401: jsonError('Unauthorized'),
  },
});

/**
 * The other half of the route above.
 *
 * Writing fabricated receipts into a live index is a thing to be able to undo
 * without a database connection, and until this existed the undo was a SQL
 * snippet in a comment — which is to say, it did not exist.
 *
 * Deliberately not restricted to receipts this route created: nothing records
 * how a receipt arrived, so there is no such filter to write. It removes
 * everything the address owns, which is why the address has to be one kept
 * for the purpose.
 *
 * The user row stays. It carries no receipts now, and deleting it would take
 * any points ever granted to it with it.
 */
export const adminUploadRemoveRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: adminValidationHook,
}).openapi(removeRoute, async (c) => {
  const db = c.get('db');
  const userAddress = c.req.valid('param').address.toLowerCase() as `0x${string}`;

  const mine = await db
    .select({ id: receipts.id })
    .from(receipts)
    .where(eq(receipts.userAddress, userAddress));

  if (mine.length === 0) return c.json({ data: { receipts: 0, lines: 0 } }, 200);

  const ids = mine.map((row) => row.id);
  const lines = await db
    .delete(receiptLineItems)
    .where(inArray(receiptLineItems.receiptId, ids))
    .returning({ id: receiptLineItems.id });

  await db.delete(receipts).where(eq(receipts.userAddress, userAddress));

  return c.json({ data: { receipts: ids.length, lines: lines.length } }, 200);
});
