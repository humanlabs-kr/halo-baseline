/**
 * Celo 7x7 retention grid: for each of the last seven signup cohorts, how many
 * of those users were active on each of their first seven days.
 *
 * SECURITY: like the rest of the dashboard this used to be reachable at
 * `/admin/celo-dashboard/retention/<uuid>` with no authentication. The UUID is
 * gone and `adminAuth` replaces it.
 *
 * Kept apart from `celo-dashboard.ts` because the cohort walk is the one query
 * here that is O(cohorts x days) and worth reading on its own.
 */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { and, eq, gte, lt, pointLogs, receipts, sql, users } from '@halo/database';
import { format, startOfDay, subDays } from 'date-fns';

import { adminAuth } from '../../middleware/auth';
import type { AppEnv } from '../../types';
import { adminValidationHook, jsonData, jsonError } from './shared';

/** This dashboard is Celo-only; the other chains have their own reporting. */
const PLATFORM = 'celo' as const;
const RETENTION_DAYS = 7;

const retentionRowSchema = z.object({
  cohortDate: z.string(),
  cohortSize: z.number(),
  retention: z.array(z.number()),
});

const retentionRoute = createRoute({
  method: 'get',
  path: '/admin/celo-dashboard/retention',
  tags: ['Admin'],
  summary: '7x7 retention grid by signup cohort',
  middleware: [adminAuth] as const,
  responses: {
    200: jsonData(
      'Retention grid',
      z.object({
        cohortDates: z.array(z.string()),
        receiptRetention: z.array(retentionRowSchema),
        pointsRetention: z.array(retentionRowSchema),
      }),
    ),
    401: jsonError('Authentication required'),
  },
});

export const adminCeloRetentionRoutes = new OpenAPIHono<AppEnv>({ defaultHook: adminValidationHook })
  .openapi(retentionRoute, async (c) => {
    const db = c.get('db');
    const todayStart = startOfDay(new Date());

    // Cohorts are the last 7 completed signup days, oldest first.
    const cohortDates: string[] = [];
    for (let i = RETENTION_DAYS; i >= 1; i--) {
      cohortDates.push(format(subDays(todayStart, i), 'yyyy-MM-dd'));
    }

    const emptyRow = Array<number>(RETENTION_DAYS).fill(0);
    const receiptRetention: Array<{ cohortDate: string; cohortSize: number; retention: number[] }> = [];
    const pointsRetention: Array<{ cohortDate: string; cohortSize: number; retention: number[] }> = [];

    for (const cohortDate of cohortDates) {
      const cohortStart = new Date(`${cohortDate}T00:00:00Z`);
      const cohortEnd = new Date(new Date(cohortStart).setUTCDate(cohortStart.getUTCDate() + 1));

      const cohortUsers = await db
        .select({ address: users.address })
        .from(users)
        .where(
          and(
            eq(users.platform, PLATFORM),
            gte(users.createdAt, cohortStart),
            lt(users.createdAt, cohortEnd),
          ),
        );

      if (cohortUsers.length === 0) {
        receiptRetention.push({ cohortDate, cohortSize: 0, retention: [...emptyRow] });
        pointsRetention.push({ cohortDate, cohortSize: 0, retention: [...emptyRow] });
        continue;
      }

      const cohortAddresses = sql.join(
        cohortUsers.map((u) => sql`${u.address}`),
        sql`, `,
      );
      const receiptDays: number[] = [];
      const pointDays: number[] = [];

      for (let dayOffset = 0; dayOffset < RETENTION_DAYS; dayOffset++) {
        const dayStart = new Date(new Date(cohortStart).setUTCDate(cohortStart.getUTCDate() + dayOffset));
        const dayEnd = new Date(new Date(dayStart).setUTCDate(dayStart.getUTCDate() + 1));

        // Days that have not happened yet read as 0 rather than a partial count.
        if (dayStart >= todayStart) {
          receiptDays.push(0);
          pointDays.push(0);
          continue;
        }

        const [receiptActive, pointActive] = await Promise.all([
          db
            .select({ count: sql<number>`count(distinct ${receipts.userAddress})` })
            .from(receipts)
            .where(
              and(
                sql`${receipts.userAddress} IN (${cohortAddresses})`,
                gte(receipts.createdAt, dayStart),
                lt(receipts.createdAt, dayEnd),
              ),
            )
            .then((r) => Number(r[0]?.count ?? 0)),
          db
            .select({ count: sql<number>`count(distinct ${pointLogs.userAddress})` })
            .from(pointLogs)
            .where(
              and(
                sql`${pointLogs.userAddress} IN (${cohortAddresses})`,
                gte(pointLogs.createdAt, dayStart),
                lt(pointLogs.createdAt, dayEnd),
                sql`${pointLogs.diff} > 0`,
              ),
            )
            .then((r) => Number(r[0]?.count ?? 0)),
        ]);

        receiptDays.push(receiptActive);
        pointDays.push(pointActive);
      }

      receiptRetention.push({ cohortDate, cohortSize: cohortUsers.length, retention: receiptDays });
      pointsRetention.push({ cohortDate, cohortSize: cohortUsers.length, retention: pointDays });
    }

    return c.json({ data: { cohortDates, receiptRetention, pointsRetention } }, 200);
  });
