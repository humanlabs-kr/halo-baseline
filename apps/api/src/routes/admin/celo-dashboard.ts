/**
 * Celo growth dashboard: overview, funnel, day-by-day numbers and retention.
 *
 * SECURITY: every endpoint here used to sit at
 * `/admin/celo-dashboard/<name>/<uuid>` with no authentication — the unguessable
 * path was the whole protection. URLs leak (history, referrers, proxy logs) and
 * cannot be revoked, so the UUID is gone and `adminAuth` replaces it.
 *
 * Split out of `stats.ts` to keep both files readable, and the retention grid
 * lives in `celo-retention.ts` for the same reason. The paths are unchanged
 * apart from dropping the UUID segment.
 */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  and,
  count,
  dailyPointClaims,
  eq,
  gte,
  haloRafflePoolEntries,
  haloRafflePools,
  lt,
  pointLogs,
  receipts,
  sql,
  users,
  type Database,
} from '@halo/database';
import { format, startOfDay, subDays } from 'date-fns';

import { adminAuth } from '../../middleware/auth';
import type { AppEnv } from '../../types';
import { adminValidationHook, jsonData, jsonError } from './shared';

/** This dashboard is Celo-only; the other chains have their own reporting. */
const PLATFORM = 'celo' as const;
const HISTORY_DAYS = 10;

type DayStats = {
  date: string;
  newUsers: number;
  receipts: number;
  pointsDistributed: number;
  dailyClaims: number;
  raffleEntries: number;
};

const dayStatsSchema = z.object({
  date: z.string(),
  newUsers: z.number(),
  receipts: z.number(),
  pointsDistributed: z.number(),
  dailyClaims: z.number(),
  raffleEntries: z.number(),
});

/** Counts for one day window. `end` is exclusive. */
async function getDayStats(db: Database, start: Date, end: Date, dateStr: string): Promise<DayStats> {
  const [newUsers, receiptCount, pointsDistributed, dailyClaims, raffleEntries] = await Promise.all([
    db
      .select({ count: count() })
      .from(users)
      .where(and(eq(users.platform, PLATFORM), gte(users.createdAt, start), lt(users.createdAt, end)))
      .then((r) => r[0]?.count ?? 0),
    db
      .select({ count: count() })
      .from(receipts)
      .innerJoin(users, eq(receipts.userAddress, users.address))
      .where(and(eq(users.platform, PLATFORM), gte(receipts.createdAt, start), lt(receipts.createdAt, end)))
      .then((r) => r[0]?.count ?? 0),
    db
      .select({ total: sql<number>`COALESCE(sum(${pointLogs.diff}), 0)` })
      .from(pointLogs)
      .innerJoin(users, eq(pointLogs.userAddress, users.address))
      .where(
        and(
          eq(users.platform, PLATFORM),
          gte(pointLogs.createdAt, start),
          lt(pointLogs.createdAt, end),
          sql`${pointLogs.diff} > 0`,
        ),
      )
      .then((r) => Number(r[0]?.total ?? 0)),
    db
      .select({ count: count() })
      .from(dailyPointClaims)
      .innerJoin(users, eq(dailyPointClaims.userAddress, users.address))
      .where(
        and(
          eq(users.platform, PLATFORM),
          gte(dailyPointClaims.createdAt, start),
          lt(dailyPointClaims.createdAt, end),
        ),
      )
      .then((r) => r[0]?.count ?? 0),
    // Celo raffle entries live in the Halo raffle tables, keyed by UTC date.
    db
      .select({ total: sql<number>`COALESCE(sum(${haloRafflePoolEntries.entryCount}), 0)` })
      .from(haloRafflePoolEntries)
      .innerJoin(haloRafflePools, eq(haloRafflePoolEntries.rafflePoolId, haloRafflePools.id))
      .innerJoin(users, eq(haloRafflePoolEntries.userAddress, users.address))
      .where(
        and(
          eq(users.platform, PLATFORM),
          eq(haloRafflePools.chain, PLATFORM),
          eq(haloRafflePools.utcDate, dateStr),
        ),
      )
      .then((r) => Number(r[0]?.total ?? 0)),
  ]);

  return {
    date: dateStr,
    newUsers,
    receipts: receiptCount,
    pointsDistributed,
    dailyClaims,
    raffleEntries,
  };
}

const overviewRoute = createRoute({
  method: 'get',
  path: '/admin/celo-dashboard/overview',
  tags: ['Admin'],
  summary: 'Celo totals',
  middleware: [adminAuth] as const,
  responses: {
    200: jsonData(
      'Overview',
      z.object({ reportDate: z.string(), totalUsers: z.number(), totalReceipts: z.number() }),
    ),
    401: jsonError('Authentication required'),
  },
});

const funnelRoute = createRoute({
  method: 'get',
  path: '/admin/celo-dashboard/funnel',
  tags: ['Admin'],
  summary: 'Celo activation funnel',
  middleware: [adminAuth] as const,
  responses: {
    200: jsonData(
      'Funnel',
      z.object({
        totalUsers: z.number(),
        usersWithReceipts: z.number(),
        usersWithReceiptPoints: z.number(),
        usersWithDailyClaimOffchain: z.number(),
        usersWithDailyClaimOnchain: z.number(),
        usersWithRaffleEntries: z.number(),
      }),
    ),
    401: jsonError('Authentication required'),
  },
});

const todayRoute = createRoute({
  method: 'get',
  path: '/admin/celo-dashboard/today',
  tags: ['Admin'],
  summary: "Today's Celo numbers, with a points breakdown",
  middleware: [adminAuth] as const,
  responses: {
    200: jsonData(
      'Today',
      dayStatsSchema.extend({
        pointsFromReceipts: z.number(),
        pointsFromDailyClaim: z.number(),
        pointsFromDailyClaimOnchain: z.number(),
      }),
    ),
    401: jsonError('Authentication required'),
  },
});

const yesterdayRoute = createRoute({
  method: 'get',
  path: '/admin/celo-dashboard/yesterday',
  tags: ['Admin'],
  summary: "Yesterday's Celo numbers",
  middleware: [adminAuth] as const,
  responses: {
    200: jsonData('Yesterday', dayStatsSchema),
    401: jsonError('Authentication required'),
  },
});

const historyRoute = createRoute({
  method: 'get',
  path: '/admin/celo-dashboard/history',
  tags: ['Admin'],
  summary: 'Last 10 days of Celo numbers',
  middleware: [adminAuth] as const,
  responses: {
    200: jsonData('History', z.array(dayStatsSchema)),
    401: jsonError('Authentication required'),
  },
});

/** Count Celo users for which `activity` (a correlated EXISTS body) holds. */
function countUsersWhere(db: Database, activity: ReturnType<typeof sql>) {
  return db
    .select({ count: count() })
    .from(users)
    .where(and(eq(users.platform, PLATFORM), activity))
    .then((r) => r[0]?.count ?? 0);
}

/** Sum of positive point movements of one source type, for a time window. */
function sumPoints(db: Database, sourceType: 'receipt-upload' | 'daily-claim' | 'daily-claim-onchain', start: Date, end: Date) {
  return db
    .select({ total: sql<number>`COALESCE(sum(${pointLogs.diff}), 0)` })
    .from(pointLogs)
    .innerJoin(users, eq(pointLogs.userAddress, users.address))
    .where(
      and(
        eq(users.platform, PLATFORM),
        eq(pointLogs.sourceType, sourceType),
        gte(pointLogs.createdAt, start),
        lt(pointLogs.createdAt, end),
        sql`${pointLogs.diff} > 0`,
      ),
    )
    .then((r) => Number(r[0]?.total ?? 0));
}

export const adminCeloDashboardRoutes = new OpenAPIHono<AppEnv>({ defaultHook: adminValidationHook })
  .openapi(overviewRoute, async (c) => {
    const db = c.get('db');
    const reportDate = format(startOfDay(new Date()), 'yyyy-MM-dd');

    const [totalUsers, totalReceipts] = await Promise.all([
      db
        .select({ count: count() })
        .from(users)
        .where(eq(users.platform, PLATFORM))
        .then((r) => r[0]?.count ?? 0),
      db
        .select({ count: count() })
        .from(receipts)
        .innerJoin(users, eq(receipts.userAddress, users.address))
        .where(eq(users.platform, PLATFORM))
        .then((r) => r[0]?.count ?? 0),
    ]);

    return c.json({ data: { reportDate, totalUsers, totalReceipts } }, 200);
  })
  .openapi(funnelRoute, async (c) => {
    const db = c.get('db');

    // Each step counts distinct users via an EXISTS semi-join over the
    // platform-indexed users table. Joining the full activity table and
    // counting DISTINCT instead spilled gigabytes of temp files.
    const [
      totalUsers,
      usersWithReceipts,
      usersWithReceiptPoints,
      usersWithDailyClaimOffchain,
      usersWithDailyClaimOnchain,
      usersWithRaffleEntries,
    ] = await Promise.all([
      db
        .select({ count: count() })
        .from(users)
        .where(eq(users.platform, PLATFORM))
        .then((r) => r[0]?.count ?? 0),
      countUsersWhere(
        db,
        sql`exists (select 1 from ${receipts} where ${receipts.userAddress} = ${users.address})`,
      ),
      countUsersWhere(
        db,
        sql`exists (select 1 from ${pointLogs} where ${pointLogs.userAddress} = ${users.address} and ${pointLogs.sourceType} = ${'receipt-upload'} and ${pointLogs.diff} > 0)`,
      ),
      countUsersWhere(
        db,
        sql`exists (select 1 from ${pointLogs} where ${pointLogs.userAddress} = ${users.address} and ${pointLogs.sourceType} = ${'daily-claim'} and ${pointLogs.diff} > 0)`,
      ),
      countUsersWhere(
        db,
        sql`exists (select 1 from ${pointLogs} where ${pointLogs.userAddress} = ${users.address} and ${pointLogs.sourceType} = ${'daily-claim-onchain'} and ${pointLogs.diff} > 0)`,
      ),
      db
        .select({ count: sql<number>`count(distinct ${haloRafflePoolEntries.userAddress})` })
        .from(haloRafflePoolEntries)
        .innerJoin(haloRafflePools, eq(haloRafflePoolEntries.rafflePoolId, haloRafflePools.id))
        .innerJoin(users, eq(haloRafflePoolEntries.userAddress, users.address))
        .where(and(eq(users.platform, PLATFORM), eq(haloRafflePools.chain, PLATFORM)))
        .then((r) => Number(r[0]?.count ?? 0)),
    ]);

    return c.json(
      {
        data: {
          totalUsers,
          usersWithReceipts,
          usersWithReceiptPoints,
          usersWithDailyClaimOffchain,
          usersWithDailyClaimOnchain,
          usersWithRaffleEntries,
        },
      },
      200,
    );
  })
  .openapi(todayRoute, async (c) => {
    const db = c.get('db');
    const now = new Date();
    const todayStart = startOfDay(now);
    const dateStr = format(todayStart, 'yyyy-MM-dd');

    const [stats, pointsFromReceipts, pointsFromDailyClaim, pointsFromDailyClaimOnchain] =
      await Promise.all([
        getDayStats(db, todayStart, now, dateStr),
        sumPoints(db, 'receipt-upload', todayStart, now),
        sumPoints(db, 'daily-claim', todayStart, now),
        sumPoints(db, 'daily-claim-onchain', todayStart, now),
      ]);

    return c.json(
      {
        data: { ...stats, pointsFromReceipts, pointsFromDailyClaim, pointsFromDailyClaimOnchain },
      },
      200,
    );
  })
  .openapi(yesterdayRoute, async (c) => {
    const db = c.get('db');
    const todayStart = startOfDay(new Date());
    const yesterdayStart = subDays(todayStart, 1);

    const stats = await getDayStats(
      db,
      yesterdayStart,
      todayStart,
      format(yesterdayStart, 'yyyy-MM-dd'),
    );

    return c.json({ data: stats }, 200);
  })
  .openapi(historyRoute, async (c) => {
    const db = c.get('db');
    const now = new Date();
    const todayStart = startOfDay(now);

    const days: DayStats[] = [];
    for (let i = HISTORY_DAYS - 1; i >= 0; i--) {
      const dayStart = subDays(todayStart, i);
      // Today is still running, so its window ends now rather than at midnight.
      const dayEnd = i === 0 ? now : subDays(todayStart, i - 1);
      days.push(await getDayStats(db, dayStart, dayEnd, format(dayStart, 'yyyy-MM-dd')));
    }

    return c.json({ data: days }, 200);
  });
