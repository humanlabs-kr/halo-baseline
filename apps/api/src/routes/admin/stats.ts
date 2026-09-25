/**
 * Cross-platform daily stats, plus the Celo onchain activity counter.
 *
 * SECURITY: these used to be reachable at `/admin/daily-stats/<uuid>` and
 * `/admin/celo-dashboard/onchain/<uuid>` with no authentication — an unguessable
 * path was the only thing protecting them. A URL is not a secret: it leaks
 * through browser history, referrer headers, proxy logs and screenshots, and it
 * cannot be rotated per person. The UUID is gone and `adminAuth` replaces it.
 *
 * The onchain endpoint keeps its `/admin/celo-dashboard/...` path but lives here
 * because it shares the RPC reader with `daily-stats`.
 */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  and,
  count,
  dailyPointClaims,
  eq,
  gte,
  lt,
  pointLogs,
  rafflePoolEntries,
  rafflePools,
  receipts,
  sql,
  users,
} from '@halo/database';
import { format, startOfDay } from 'date-fns';
import { createPublicClient, http, isAddress, parseAbiItem, type Address } from 'viem';
import { celo } from 'viem/chains';

import { adminAuth } from '../../middleware/auth';
import type { AppEnv } from '../../types';
import { adminValidationHook, jsonData, jsonError } from './shared';

/** Celo produces a block roughly every second, so a day is ~86,400 blocks. */
const BLOCKS_PER_DAY = 86_400n;
const RPC_TIMEOUT_MS = 10_000;

const PLATFORMS = ['world', 'celo', 'kaia'] as const;

const onchainDebugSchema = z.object({
  currentBlock: z.string(),
  fromBlock: z.string(),
  error: z.string().optional(),
});

const dailyStatsRoute = createRoute({
  method: 'get',
  path: '/admin/daily-stats',
  tags: ['Admin'],
  summary: "Today's stats for every platform",
  middleware: [adminAuth] as const,
  responses: {
    200: jsonData(
      'Daily stats',
      z.object({
        reportDate: z.string(),
        platforms: z.array(
          z.object({
            platform: z.string(),
            totalUsers: z.number(),
            newUsersToday: z.number(),
            totalReceipts: z.number(),
            receiptsToday: z.number(),
            pointsDistributedToday: z.number(),
            dailyClaimsToday: z.number(),
            raffleEntriesToday: z.number(),
            onchainTxToday: z.number().optional(),
            dailyOnchainBonusToday: z.number().optional(),
            celoContractAddress: z.string().optional(),
            celoContractLink: z.string().optional(),
            celoOnchainDebug: onchainDebugSchema.optional(),
          }),
        ),
        totals: z.object({
          totalUsers: z.number(),
          newUsersToday: z.number(),
          totalReceipts: z.number(),
          receiptsToday: z.number(),
          pointsDistributedToday: z.number(),
          dailyClaimsToday: z.number(),
          raffleEntriesToday: z.number(),
        }),
      }),
    ),
    401: jsonError('Authentication required'),
  },
});

const onchainStatsRoute = createRoute({
  method: 'get',
  path: '/admin/celo-dashboard/onchain',
  tags: ['Admin'],
  summary: 'Celo onchain claim/spend activity over the last day',
  middleware: [adminAuth] as const,
  responses: {
    200: jsonData(
      'Onchain stats',
      z.object({
        onchainTxToday: z.number(),
        onchainClaimsToday: z.number(),
        onchainSpendsToday: z.number(),
        dailyOnchainBonusToday: z.number(),
        celoContractAddress: z.string(),
        celoContractLink: z.string(),
        debug: onchainDebugSchema.optional(),
      }),
    ),
    401: jsonError('Authentication required'),
  },
});

type OnchainActivity = {
  claimCount: number;
  spendCount: number;
  totalCount: number;
  debug: { currentBlock: string; fromBlock: string; error?: string };
};

const POINTS_CLAIMED_EVENT = parseAbiItem(
  'event PointsClaimed(address indexed user, uint256 amount, uint256 newBalance, bytes32 indexed claimId)',
);
const POINTS_SPENT_EVENT = parseAbiItem(
  'event PointsSpent(address indexed user, uint256 amount, uint256 newBalance, bytes32 indexed spendId)',
);

/**
 * Count claim and spend events from the last day's blocks.
 *
 * `CELO_RPC_URL` may hold several comma-separated endpoints; they are tried in
 * order until one answers. Public RPCs rate-limit and go down, and the previous
 * version worked around that with a hardcoded fallback list — one entry of
 * which embedded a live Infura project key in the source. Endpoints are
 * configuration, so they live in the environment.
 */
async function readCeloOnchainActivity(rpcUrls: string[], contract: Address): Promise<OnchainActivity> {
  for (const rpcUrl of rpcUrls) {
    try {
      const client = createPublicClient({
        chain: celo,
        transport: http(rpcUrl, { timeout: RPC_TIMEOUT_MS, retryCount: 2 }),
      });

      const currentBlock = await client.getBlockNumber();
      const fromBlock = currentBlock - BLOCKS_PER_DAY;

      // Sequential, not parallel: two log queries at once is what trips the
      // rate limiter on the public endpoints.
      const claimLogs = await client.getLogs({
        address: contract,
        event: POINTS_CLAIMED_EVENT,
        fromBlock,
        toBlock: currentBlock,
      });
      const spendLogs = await client.getLogs({
        address: contract,
        event: POINTS_SPENT_EVENT,
        fromBlock,
        toBlock: currentBlock,
      });

      return {
        claimCount: claimLogs.length,
        spendCount: spendLogs.length,
        totalCount: claimLogs.length + spendLogs.length,
        debug: { currentBlock: currentBlock.toString(), fromBlock: fromBlock.toString() },
      };
    } catch (error) {
      console.error(`Celo RPC ${rpcUrl} failed:`, error instanceof Error ? error.message : error);
    }
  }

  // Onchain numbers are a nice-to-have on a dashboard: report zero with the
  // reason rather than failing the whole stats response.
  return {
    claimCount: 0,
    spendCount: 0,
    totalCount: 0,
    debug: { currentBlock: '0', fromBlock: '0', error: 'All Celo RPCs failed' },
  };
}

/** Parse the configured RPC list and contract, or explain why we cannot read. */
function celoOnchainConfig(env: AppEnv['Bindings']): { rpcUrls: string[]; contract: Address } | { error: string } {
  const rpcUrls = env.CELO_RPC_URL.split(',')
    .map((url) => url.trim())
    .filter(Boolean);
  if (rpcUrls.length === 0) return { error: 'CELO_RPC_URL is not configured' };

  const contract = env.POINT_CLAIM_CONTRACT_CELO;
  if (!isAddress(contract)) return { error: 'POINT_CLAIM_CONTRACT_CELO is not a valid address' };

  return { rpcUrls, contract };
}

const unavailable = (error: string): OnchainActivity => ({
  claimCount: 0,
  spendCount: 0,
  totalCount: 0,
  debug: { currentBlock: '0', fromBlock: '0', error },
});

export const adminStatsRoutes = new OpenAPIHono<AppEnv>({ defaultHook: adminValidationHook })
  .openapi(dailyStatsRoute, async (c) => {
    const db = c.get('db');
    const now = new Date();
    const todayStart = startOfDay(now);
    const reportDate = format(todayStart, 'yyyy-MM-dd');
    const config = celoOnchainConfig(c.env);

    const [platformStats, celoOnchain, celoDailyOnchainBonus] = await Promise.all([
      Promise.all(
        PLATFORMS.map(async (platform) => {
          const [
            totalUsers,
            newUsersToday,
            totalReceipts,
            receiptsToday,
            pointsDistributedToday,
            dailyClaimsToday,
            raffleEntriesToday,
          ] = await Promise.all([
            db
              .select({ count: count() })
              .from(users)
              .where(eq(users.platform, platform))
              .then((r) => r[0]?.count ?? 0),
            db
              .select({ count: count() })
              .from(users)
              .where(and(eq(users.platform, platform), gte(users.createdAt, todayStart), lt(users.createdAt, now)))
              .then((r) => r[0]?.count ?? 0),
            db
              .select({ count: count() })
              .from(receipts)
              .innerJoin(users, eq(receipts.userAddress, users.address))
              .where(eq(users.platform, platform))
              .then((r) => r[0]?.count ?? 0),
            db
              .select({ count: count() })
              .from(receipts)
              .innerJoin(users, eq(receipts.userAddress, users.address))
              .where(
                and(
                  eq(users.platform, platform),
                  gte(receipts.createdAt, todayStart),
                  lt(receipts.createdAt, now),
                ),
              )
              .then((r) => r[0]?.count ?? 0),
            db
              .select({ total: sql<number>`COALESCE(sum(${pointLogs.diff}), 0)` })
              .from(pointLogs)
              .innerJoin(users, eq(pointLogs.userAddress, users.address))
              .where(
                and(
                  eq(users.platform, platform),
                  gte(pointLogs.createdAt, todayStart),
                  lt(pointLogs.createdAt, now),
                  // Spends are negative; "distributed" means earnings only.
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
                  eq(users.platform, platform),
                  gte(dailyPointClaims.createdAt, todayStart),
                  lt(dailyPointClaims.createdAt, now),
                ),
              )
              .then((r) => r[0]?.count ?? 0),
            db
              .select({ total: sql<number>`COALESCE(sum(${rafflePoolEntries.entryCount}), 0)` })
              .from(rafflePoolEntries)
              .innerJoin(rafflePools, eq(rafflePoolEntries.rafflePoolId, rafflePools.id))
              .innerJoin(users, eq(rafflePoolEntries.userAddress, users.address))
              .where(and(eq(users.platform, platform), eq(rafflePools.utcDate, reportDate)))
              .then((r) => Number(r[0]?.total ?? 0)),
          ]);

          return {
            platform,
            totalUsers,
            newUsersToday,
            totalReceipts,
            receiptsToday,
            pointsDistributedToday,
            dailyClaimsToday,
            raffleEntriesToday,
          };
        }),
      ),
      'error' in config
        ? Promise.resolve(unavailable(config.error))
        : readCeloOnchainActivity(config.rpcUrls, config.contract),
      db
        .select({ count: count() })
        .from(pointLogs)
        .innerJoin(users, eq(pointLogs.userAddress, users.address))
        .where(
          and(
            eq(users.platform, 'celo'),
            eq(pointLogs.sourceType, 'daily-claim-onchain'),
            gte(pointLogs.createdAt, todayStart),
            lt(pointLogs.createdAt, now),
          ),
        )
        .then((r) => r[0]?.count ?? 0),
    ]);

    const contractAddress = 'error' in config ? undefined : config.contract;
    const platformsWithOnchain = platformStats.map((s) =>
      s.platform === 'celo'
        ? {
            ...s,
            onchainTxToday: celoOnchain.totalCount,
            dailyOnchainBonusToday: celoDailyOnchainBonus,
            celoContractAddress: contractAddress,
            celoContractLink: contractAddress
              ? `https://celoscan.io/address/${contractAddress}`
              : undefined,
            celoOnchainDebug: celoOnchain.debug,
          }
        : s,
    );

    const sumOf = (key: keyof (typeof platformStats)[number] & string): number =>
      platformStats.reduce((acc, s) => acc + (typeof s[key] === 'number' ? s[key] : 0), 0);

    return c.json(
      {
        data: {
          reportDate,
          platforms: platformsWithOnchain,
          totals: {
            totalUsers: sumOf('totalUsers'),
            newUsersToday: sumOf('newUsersToday'),
            totalReceipts: sumOf('totalReceipts'),
            receiptsToday: sumOf('receiptsToday'),
            pointsDistributedToday: sumOf('pointsDistributedToday'),
            dailyClaimsToday: sumOf('dailyClaimsToday'),
            raffleEntriesToday: sumOf('raffleEntriesToday'),
          },
        },
      },
      200,
    );
  })
  .openapi(onchainStatsRoute, async (c) => {
    const db = c.get('db');
    const now = new Date();
    const todayStart = startOfDay(now);
    const config = celoOnchainConfig(c.env);

    const [onchain, dailyOnchainBonusToday] = await Promise.all([
      'error' in config
        ? Promise.resolve(unavailable(config.error))
        : readCeloOnchainActivity(config.rpcUrls, config.contract),
      db
        .select({ count: count() })
        .from(pointLogs)
        .innerJoin(users, eq(pointLogs.userAddress, users.address))
        .where(
          and(
            eq(users.platform, 'celo'),
            eq(pointLogs.sourceType, 'daily-claim-onchain'),
            gte(pointLogs.createdAt, todayStart),
            lt(pointLogs.createdAt, now),
          ),
        )
        .then((r) => r[0]?.count ?? 0),
    ]);

    const contractAddress = 'error' in config ? '' : config.contract;

    return c.json(
      {
        data: {
          onchainTxToday: onchain.totalCount,
          onchainClaimsToday: onchain.claimCount,
          onchainSpendsToday: onchain.spendCount,
          dailyOnchainBonusToday,
          celoContractAddress: contractAddress,
          celoContractLink: contractAddress ? `https://celoscan.io/address/${contractAddress}` : '',
          debug: onchain.debug,
        },
      },
      200,
    );
  });
