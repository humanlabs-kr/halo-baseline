/**
 * Manual point grants: to a specific list of addresses, or to every user.
 *
 * Both routes move real balances, so both are behind `adminAuth`.
 */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { and, eq, gte, pointLogs, sql, users } from '@halo/database';
import KSUID from 'ksuid';

import { adminAuth } from '../../middleware/auth';
import { PointService } from '../../lib/point';
import type { AppEnv } from '../../types';
import { adminValidationHook, jsonData, jsonError } from './shared';

/** Postgres caps bind parameters per statement, so inserts go in chunks. */
const BATCH_SIZE = 100;
/** How many chunks run at once. Each chunk is its own transaction. */
const PARALLEL_BATCHES = 10;
/** A user who already got an airdrop this recently is skipped. */
const AIRDROP_COOLDOWN_MS = 12 * 60 * 60 * 1000;

const insertManualPointRoute = createRoute({
  method: 'post',
  path: '/admin/insert-manual-point',
  tags: ['Admin'],
  summary: 'Grant points to a specific list of addresses',
  middleware: [adminAuth] as const,
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            addresses: z.array(z.string()),
            point: z.number(),
          }),
        },
      },
    },
  },
  responses: {
    200: jsonData('Points granted', z.object({ success: z.boolean() })),
    400: jsonError('Invalid body'),
    401: jsonError('Authentication required'),
  },
});

const insertPointToAllRoute = createRoute({
  method: 'post',
  path: '/admin/insert-point-to-all',
  tags: ['Admin'],
  summary: 'Airdrop points to every user who has not received one recently',
  middleware: [adminAuth] as const,
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            point: z.number(),
          }),
        },
      },
    },
  },
  responses: {
    200: jsonData(
      'Airdrop result',
      z.object({
        success: z.boolean(),
        userCount: z.number(),
        skippedCount: z.number(),
      }),
    ),
    400: jsonError('Invalid body'),
    401: jsonError('Authentication required'),
  },
});

export const adminPointsRoutes = new OpenAPIHono<AppEnv>({ defaultHook: adminValidationHook })
  .openapi(insertManualPointRoute, async (c) => {
    const { addresses, point } = c.req.valid('json');
    const db = c.get('db');

    // One transaction for the whole list: a half-applied manual grant is worse
    // than a failed one, because there is no record of where it stopped.
    await db.transaction(async (tx) => {
      for (const address of addresses) {
        await PointService.insertPointLog(tx, {
          userAddress: address,
          diff: point,
          sourceType: 'manual',
        });
      }
    });

    return c.json({ data: { success: true } }, 200);
  })
  .openapi(insertPointToAllRoute, async (c) => {
    const { point } = c.req.valid('json');
    const db = c.get('db');

    const allUsers = await db.select({ address: users.address }).from(users);

    // Anyone airdropped within the cooldown is skipped, so re-running the
    // endpoint after a partial failure does not double-pay.
    const cooldownStart = new Date(Date.now() - AIRDROP_COOLDOWN_MS);
    const recentAirdrops = await db
      .selectDistinct({ userAddress: pointLogs.userAddress })
      .from(pointLogs)
      .where(and(eq(pointLogs.sourceType, 'airdrop'), gte(pointLogs.createdAt, cooldownStart)));

    const alreadyAirdropped = new Set(recentAirdrops.map((r) => r.userAddress));
    const addressesToProcess = allUsers.map((u) => u.address).filter((addr) => !alreadyAirdropped.has(addr));
    const skippedCount = allUsers.length - addressesToProcess.length;

    if (addressesToProcess.length === 0) {
      return c.json({ data: { success: true, userCount: 0, skippedCount } }, 200);
    }

    const batches: (typeof addressesToProcess)[] = [];
    for (let i = 0; i < addressesToProcess.length; i += BATCH_SIZE) {
      batches.push(addressesToProcess.slice(i, i + BATCH_SIZE));
    }

    for (let i = 0; i < batches.length; i += PARALLEL_BATCHES) {
      const parallelBatches = batches.slice(i, i + PARALLEL_BATCHES);

      await Promise.all(
        parallelBatches.map(async (batch) => {
          // Read the latest balance and insert inside the same transaction:
          // reading outside it would race with a concurrent point claim and
          // write a stale `after_balance`.
          await db.transaction(async (tx) => {
            const rows = await tx.execute<{
              user_address: string;
              after_balance: number;
              accumulated_balance: number;
            }>(sql`
              SELECT DISTINCT ON (address)
                address as user_address,
                after_balance,
                accumulated_balance
              FROM ${pointLogs}
              WHERE address = ANY(ARRAY[${sql.join(
                batch.map((a) => sql`${a}`),
                sql`, `,
              )}])
              ORDER BY address, created_at DESC
            `);

            const balanceByAddress = new Map<string, { afterBalance: number; accumulatedBalance: number }>();
            for (const row of rows) {
              balanceByAddress.set(row.user_address, {
                afterBalance: Number(row.after_balance),
                accumulatedBalance: Number(row.accumulated_balance),
              });
            }

            await tx.insert(pointLogs).values(
              batch.map((address) => {
                const balance = balanceByAddress.get(address) ?? { afterBalance: 0, accumulatedBalance: 0 };
                return {
                  id: KSUID.randomSync().string,
                  userAddress: address,
                  diff: point,
                  afterBalance: balance.afterBalance + point,
                  // Accumulated balance tracks earnings only, so a negative
                  // airdrop (a correction) must not reduce it.
                  accumulatedBalance:
                    point > 0 ? balance.accumulatedBalance + point : balance.accumulatedBalance,
                  sourceType: 'airdrop' as const,
                  sourceId: null,
                  metadata: {},
                };
              }),
            );
          });
        }),
      );
    }

    return c.json({ data: { success: true, userCount: addressesToProcess.length, skippedCount } }, 200);
  });
