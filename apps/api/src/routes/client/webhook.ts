import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { dataSchema, errorSchema } from '@halo/contracts';
import { eq, rafflePools } from '@halo/database';
import { computeHmac, timingSafeEqual } from '../../lib/hmac';
import type { AppEnv } from '../../types';

const app = new OpenAPIHono<AppEnv>({
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: {
            code: 'BAD_REQUEST' as const,
            message: result.error.issues[0]?.message ?? 'Invalid request',
          },
        },
        400,
      );
    }
  },
});

// ── POST /webhook/raffle-received ───────────────────────────────────────────

const raffleReceivedRoute = createRoute({
  method: 'post',
  path: '/webhook/raffle-received',
  tags: ['Webhook'],
  summary: 'Raffle received webhook',
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            data: z.object({
              base58Id: z.string(),
              withdrawId: z.string(),
              userAddress: z.string(),
              amount: z.string(),
              tokenAddress: z.string(),
              tokenSymbol: z.string(),
              tokenDecimals: z.number(),
              receivedAt: z.string(),
              transactionHash: z.string().optional(),
            }),
            signature: z.string(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Payout recorded',
      content: {
        'application/json': { schema: dataSchema(z.object({ success: z.literal(true) })) },
      },
    },
    401: {
      description: 'INVALID_SIGNATURE',
      content: { 'application/json': { schema: errorSchema } },
    },
    404: {
      description: 'RAFFLE_POOL_NOT_FOUND',
      content: { 'application/json': { schema: errorSchema } },
    },
  },
});

app.openapi(raffleReceivedRoute, async (c) => {
  const body = c.req.valid('json');
  const db = c.get('db');

  // The signature covers only the `data` object, so the envelope is rebuilt exactly as the
  // sender serialised it — including the wrapping key — before hashing.
  const payloadString = JSON.stringify({ data: body.data });
  const computedSignature = await computeHmac(payloadString, c.env.JWT_SECRET);

  // Compared in constant time: a byte-by-byte `!==` leaks the signature prefix through
  // response timing, and this endpoint is callable by anyone.
  if (!timingSafeEqual(computedSignature, body.signature)) {
    return c.json(
      { error: { code: 'INVALID_SIGNATURE' as const, message: 'Invalid signature' } },
      401,
    );
  }

  const rafflePool = await db.query.rafflePools.findFirst({
    where: eq(rafflePools.dropLinkBase58Id, body.data.base58Id),
  });

  if (!rafflePool) {
    return c.json(
      { error: { code: 'RAFFLE_POOL_NOT_FOUND' as const, message: 'Raffle not found' } },
      404,
    );
  }

  await db
    .update(rafflePools)
    .set({ claimedAt: new Date(body.data.receivedAt) })
    .where(eq(rafflePools.id, rafflePool.id));

  return c.json({ data: { success: true as const } }, 200);
});

export const clientWebhookRoutes = app;
