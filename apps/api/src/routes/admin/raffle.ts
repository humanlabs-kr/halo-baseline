/**
 * Raffle payout administration.
 *
 * Halo raffle prizes are paid by hand from a treasury wallet, so the API's job
 * is to say who is owed what and to record the transaction hash afterwards.
 * `winners` deliberately separates blacklisted addresses instead of hiding
 * them, so an operator sees what was withheld and why.
 */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  and,
  blacklistedAddresses,
  eq,
  gte,
  haloRafflePools,
  isNotNull,
  isNull,
  lte,
} from '@halo/database';

import { adminAuth } from '../../middleware/auth';
import type { AppEnv } from '../../types';
import { adminValidationHook, jsonData, jsonError } from './shared';

const chainSchema = z.enum(['celo', 'kaia']).default('celo');
const utcDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const txHashSchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/);

const winnersRoute = createRoute({
  method: 'get',
  path: '/admin/raffle-payout/winners',
  tags: ['Admin'],
  summary: 'Raffle winners due a payout, with blacklisted ones separated out',
  middleware: [adminAuth] as const,
  request: {
    query: z.object({
      date: utcDateSchema.describe('UTC date (YYYY-MM-DD)'),
      dateTo: utcDateSchema.optional().describe('End of an inclusive date range'),
      chain: chainSchema,
      includeAlreadyPaid: z.enum(['true', 'false']).default('false'),
    }),
  },
  responses: {
    200: jsonData(
      'Winner list with payout status',
      z.object({
        winners: z.array(
          z.object({
            poolId: z.string().uuid(),
            utcDate: z.string(),
            amountInUSDT: z.number(),
            winnerAddress: z.string(),
            isPaid: z.boolean(),
            manualPayoutTxHash: z.string().nullable(),
            manualPayoutAt: z.string().nullable(),
          }),
        ),
        blacklisted: z.array(
          z.object({
            poolId: z.string().uuid(),
            utcDate: z.string(),
            amountInUSDT: z.number(),
            winnerAddress: z.string(),
            blacklistReason: z.string().nullable(),
          }),
        ),
        summary: z.object({
          totalWinners: z.number(),
          filteredWinners: z.number(),
          blacklistedCount: z.number(),
          unpaidCount: z.number(),
          unpaidTotal: z.number(),
          paidCount: z.number(),
          paidTotal: z.number(),
        }),
      }),
    ),
    400: jsonError('Invalid query'),
    401: jsonError('Authentication required'),
  },
});

const recordRoute = createRoute({
  method: 'post',
  path: '/admin/raffle-payout/record',
  tags: ['Admin'],
  summary: 'Record the payout transaction hash for raffle winners',
  middleware: [adminAuth] as const,
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z
            .object({
              // Either individual pool/hash pairs...
              payouts: z
                .array(z.object({ poolId: z.string().uuid(), txHash: txHashSchema }))
                .optional(),
              // ...or one hash covering every unpaid pool on a date.
              bulk: z
                .object({ date: utcDateSchema, chain: chainSchema, txHash: txHashSchema })
                .optional(),
            })
            .refine((data) => data.payouts ?? data.bulk, {
              message: 'Either payouts or bulk must be provided',
            }),
        },
      },
    },
  },
  responses: {
    200: jsonData(
      'Payout recorded',
      z.object({
        success: z.boolean(),
        recorded: z.number(),
        alreadyPaid: z.number(),
        details: z.array(
          z.object({
            poolId: z.string(),
            status: z.enum(['recorded', 'already_paid', 'not_found', 'no_winner']),
          }),
        ),
      }),
    ),
    400: jsonError('Invalid body'),
    401: jsonError('Authentication required'),
  },
});

type PayoutDetail = {
  poolId: string;
  status: 'recorded' | 'already_paid' | 'not_found' | 'no_winner';
};

export const adminRaffleRoutes = new OpenAPIHono<AppEnv>({ defaultHook: adminValidationHook })
  .openapi(winnersRoute, async (c) => {
    const { date, dateTo, chain, includeAlreadyPaid } = c.req.valid('query');
    const db = c.get('db');

    const dateCondition = dateTo
      ? and(gte(haloRafflePools.utcDate, date), lte(haloRafflePools.utcDate, dateTo))
      : eq(haloRafflePools.utcDate, date);

    const conditions = [
      eq(haloRafflePools.chain, chain),
      dateCondition,
      isNotNull(haloRafflePools.winnerAddress),
    ];
    // Default to unpaid pools only, so a re-run of the payout script does not
    // re-send money that already went out.
    if (includeAlreadyPaid !== 'true') {
      conditions.push(isNull(haloRafflePools.manualPayoutTxHash));
    }

    const pools = await db.query.haloRafflePools.findMany({ where: and(...conditions) });

    // One query for the whole blacklist: per-winner lookups would be dozens of
    // round trips for a list that is a few hundred rows at most.
    const blacklistRows = await db.select().from(blacklistedAddresses);
    const blacklistReasons = new Map<string, string | null>(
      blacklistRows.map((row) => [row.address.toLowerCase(), row.reason]),
    );

    const winners: Array<{
      poolId: string;
      utcDate: string;
      amountInUSDT: number;
      winnerAddress: string;
      isPaid: boolean;
      manualPayoutTxHash: string | null;
      manualPayoutAt: string | null;
    }> = [];
    const blacklisted: Array<{
      poolId: string;
      utcDate: string;
      amountInUSDT: number;
      winnerAddress: string;
      blacklistReason: string | null;
    }> = [];

    for (const pool of pools) {
      // `isNotNull` filtered these out in SQL; the check narrows the type too.
      if (!pool.winnerAddress) continue;

      const address = pool.winnerAddress.toLowerCase();

      if (blacklistReasons.has(address)) {
        blacklisted.push({
          poolId: pool.id,
          utcDate: pool.utcDate,
          amountInUSDT: pool.amountInUSDT,
          winnerAddress: pool.winnerAddress,
          blacklistReason: blacklistReasons.get(address) ?? null,
        });
        continue;
      }

      winners.push({
        poolId: pool.id,
        utcDate: pool.utcDate,
        amountInUSDT: pool.amountInUSDT,
        winnerAddress: pool.winnerAddress,
        isPaid: pool.manualPayoutTxHash !== null,
        manualPayoutTxHash: pool.manualPayoutTxHash,
        manualPayoutAt: pool.manualPayoutAt?.toISOString() ?? null,
      });
    }

    const unpaid = winners.filter((w) => !w.isPaid);
    const paid = winners.filter((w) => w.isPaid);

    return c.json(
      {
        data: {
          winners,
          blacklisted,
          summary: {
            totalWinners: pools.length,
            filteredWinners: winners.length,
            blacklistedCount: blacklisted.length,
            unpaidCount: unpaid.length,
            unpaidTotal: unpaid.reduce((sum, w) => sum + w.amountInUSDT, 0),
            paidCount: paid.length,
            paidTotal: paid.reduce((sum, w) => sum + w.amountInUSDT, 0),
          },
        },
      },
      200,
    );
  })
  .openapi(recordRoute, async (c) => {
    const body = c.req.valid('json');
    const db = c.get('db');
    const now = new Date();

    const details: PayoutDetail[] = [];
    let recorded = 0;
    let alreadyPaid = 0;

    if (body.payouts && body.payouts.length > 0) {
      for (const { poolId, txHash } of body.payouts) {
        const pool = await db.query.haloRafflePools.findFirst({
          where: eq(haloRafflePools.id, poolId),
        });

        if (!pool) {
          details.push({ poolId, status: 'not_found' });
          continue;
        }
        if (!pool.winnerAddress) {
          details.push({ poolId, status: 'no_winner' });
          continue;
        }
        // Never overwrite a recorded hash: the first one is the payment that
        // actually happened, and losing it loses the audit trail.
        if (pool.manualPayoutTxHash) {
          details.push({ poolId, status: 'already_paid' });
          alreadyPaid++;
          continue;
        }

        await db
          .update(haloRafflePools)
          .set({ manualPayoutTxHash: txHash, manualPayoutAt: now })
          .where(eq(haloRafflePools.id, poolId));

        details.push({ poolId, status: 'recorded' });
        recorded++;
      }
    }

    if (body.bulk) {
      const { date, chain, txHash } = body.bulk;

      const unpaidPools = await db.query.haloRafflePools.findMany({
        where: and(
          eq(haloRafflePools.chain, chain),
          eq(haloRafflePools.utcDate, date),
          isNotNull(haloRafflePools.winnerAddress),
          isNull(haloRafflePools.manualPayoutTxHash),
        ),
      });

      for (const pool of unpaidPools) {
        await db
          .update(haloRafflePools)
          .set({ manualPayoutTxHash: txHash, manualPayoutAt: now })
          .where(eq(haloRafflePools.id, pool.id));

        details.push({ poolId: pool.id, status: 'recorded' });
        recorded++;
      }
    }

    return c.json({ data: { success: true, recorded, alreadyPaid, details } }, 200);
  });
