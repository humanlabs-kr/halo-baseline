import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { dataSchema, errorSchema, POINT_CLAIM_EIP712_DOMAIN_NAME } from '@halo/contracts';
import {
  and,
  count,
  desc,
  eq,
  haloEmailVerifications,
  haloRafflePoolEntries,
  haloRafflePools,
  inArray,
  isNotNull,
  isNull,
  rafflePoolEntries,
  rafflePools,
  sql,
  sum,
  users,
} from '@halo/database';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { celo } from 'viem/chains';
import { PointService } from '../../lib/point';
import { userAuth } from '../../middleware/auth';
import type { AppEnv } from '../../types';

/** How long an onchain spend signature stays redeemable. */
const SPEND_SIGNATURE_TTL_SECONDS = 60 * 30;

/** Sentinel in `max_entries_per_user` meaning "no per-user cap". */
const UNLIMITED_ENTRIES = -1;

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

const chainSchema = z.enum(['celo', 'kaia']);

const winnerSchema = z.object({ address: z.string(), username: z.string() });

function utcToday(): string {
  return new Date().toISOString().split('T')[0]!;
}

// ── GET /raffle/list ────────────────────────────────────────────────────────

const listRafflePoolsRoute = createRoute({
  method: 'get',
  path: '/raffle/list',
  tags: ['Raffle'],
  summary: 'List raffle pools',
  middleware: [userAuth] as const,
  responses: {
    200: {
      description: 'Success',
      content: {
        'application/json': {
          schema: dataSchema(
            z.object({
              list: z.array(
                z.object({
                  id: z.string(),
                  amountInUSDC: z.number(),
                  pointPerEntry: z.number(),
                  maxEntriesPerUser: z.number().describe('-1 for unlimited'),
                  totalEntryCount: z.number(),
                  userEntryCount: z.number(),
                  isClosed: z.boolean(),
                }),
              ),
            }),
          ),
        },
      },
    },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: errorSchema } } },
  },
});

app.openapi(listRafflePoolsRoute, async (c) => {
  const userAddress = c.get('address')!;
  const db = c.get('db');
  const today = utcToday();

  const rafflePoolRecords = await db.query.rafflePools.findMany({
    columns: {
      id: true,
      amountInUSDC: true,
      pointPerEntry: true,
      maxEntriesPerUser: true,
      totalEntryCount: true,
      winnerAddress: true,
    },
    where: eq(rafflePools.utcDate, today),
    // Equal prize amounts are broken by entry price so the cheapest pool shows first.
    orderBy: [desc(rafflePools.amountInUSDC), rafflePools.pointPerEntry],
  });

  const userEntries = await db.query.rafflePoolEntries.findMany({
    columns: { rafflePoolId: true, entryCount: true },
    where: and(
      inArray(
        rafflePoolEntries.rafflePoolId,
        rafflePoolRecords.map((rafflePool) => rafflePool.id),
      ),
      eq(rafflePoolEntries.userAddress, userAddress),
    ),
  });

  const userEntriesMap = userEntries.reduce<Record<string, number>>((acc, entry) => {
    acc[entry.rafflePoolId] = (acc[entry.rafflePoolId] ?? 0) + entry.entryCount;
    return acc;
  }, {});

  return c.json(
    {
      data: {
        list: rafflePoolRecords.map((rafflePool) => {
          const userEntryCount = userEntriesMap[rafflePool.id] ?? 0;

          return {
            id: rafflePool.id,
            amountInUSDC: rafflePool.amountInUSDC,
            pointPerEntry: rafflePool.pointPerEntry,
            maxEntriesPerUser: rafflePool.maxEntriesPerUser,
            totalEntryCount: rafflePool.totalEntryCount,
            userEntryCount,
            isClosed:
              rafflePool.winnerAddress !== null ||
              (rafflePool.maxEntriesPerUser !== UNLIMITED_ENTRIES &&
                userEntryCount >= rafflePool.maxEntriesPerUser),
          };
        }),
      },
    },
    200,
  );
});

// ── GET /raffle/history ─────────────────────────────────────────────────────

const raffleHistoryRoute = createRoute({
  method: 'get',
  path: '/raffle/history',
  tags: ['Raffle'],
  summary: 'Raffle history',
  middleware: [userAuth] as const,
  request: { query: z.object({ date: z.string() }) },
  responses: {
    200: {
      description: 'Success',
      content: {
        'application/json': {
          schema: dataSchema(
            z.object({
              totalEntryCount: z.number(),
              myRewards: z.array(
                z.object({
                  amountInUSDC: z.number(),
                  claimedAt: z.string().nullable(),
                  dropLink: z.string(),
                }),
              ),
              pools: z.array(
                z.object({
                  amountInUSDC: z.number(),
                  winner: winnerSchema.nullable(),
                }),
              ),
            }),
          ),
        },
      },
    },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: errorSchema } } },
  },
});

app.openapi(raffleHistoryRoute, async (c) => {
  const { date } = c.req.valid('query');
  const userAddress = c.get('address')!;
  const db = c.get('db');

  const rafflePoolRecords = await db.query.rafflePools.findMany({
    columns: { id: true, amountInUSDC: true, dropLink: true, claimedAt: true },
    with: { winner: { columns: { address: true, username: true } } },
    where: eq(rafflePools.utcDate, date),
    orderBy: [desc(rafflePools.amountInUSDC)],
  });

  const sumEntriesCount = await db
    .select({ count: sum(rafflePoolEntries.entryCount) })
    .from(rafflePoolEntries)
    .where(
      inArray(
        rafflePoolEntries.rafflePoolId,
        rafflePoolRecords.map((rafflePool) => rafflePool.id),
      ),
    )
    .then((result: { count: string | null }[]) => Number(result[0]?.count ?? 0));

  return c.json(
    {
      data: {
        totalEntryCount: sumEntriesCount,
        myRewards: rafflePoolRecords
          .filter((rafflePool) => rafflePool.winner?.address === userAddress)
          .map((rafflePool) => ({
            amountInUSDC: rafflePool.amountInUSDC,
            claimedAt: rafflePool.claimedAt?.toISOString() ?? null,
            dropLink: rafflePool.dropLink ?? '',
          })),
        pools: rafflePoolRecords.map((rafflePool) => ({
          amountInUSDC: rafflePool.amountInUSDC,
          winner: rafflePool.winner ?? null,
        })),
      },
    },
    200,
  );
});

// ── POST /raffle/apply ──────────────────────────────────────────────────────

const applyRaffleRoute = createRoute({
  method: 'post',
  path: '/raffle/apply',
  tags: ['Raffle'],
  summary: 'Apply for a raffle',
  middleware: [userAuth] as const,
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({ rafflePoolId: z.string(), entryCount: z.number() }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Success',
      content: {
        'application/json': { schema: dataSchema(z.object({ success: z.literal(true) })) },
      },
    },
    400: {
      description: 'RAFFLE_POOL_NOT_FOUND / MAX_ENTRIES_PER_USER_REACHED / INSUFFICIENT_POINT',
      content: { 'application/json': { schema: errorSchema } },
    },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: errorSchema } } },
    500: {
      description: 'INTERNAL_ERROR',
      content: { 'application/json': { schema: errorSchema } },
    },
  },
});

app.openapi(applyRaffleRoute, async (c) => {
  const { rafflePoolId, entryCount } = c.req.valid('json');
  const userAddress = c.get('address')!;
  const db = c.get('db');
  const today = utcToday();

  const { afterBalance: currentPoint } = await PointService.getUserPoint(db, userAddress);

  try {
    await db.transaction(async (tx) => {
      const rafflePool = await tx.query.rafflePools.findFirst({
        where: and(
          eq(rafflePools.id, rafflePoolId),
          isNull(rafflePools.winnerAddress),
          eq(rafflePools.utcDate, today),
        ),
      });

      if (!rafflePool) {
        throw new Error('RAFFLE_POOL_NOT_FOUND');
      }

      if (rafflePool.maxEntriesPerUser !== UNLIMITED_ENTRIES) {
        const existingEntryCount = await tx
          .select({ entryCount: sum(rafflePoolEntries.entryCount) })
          .from(rafflePoolEntries)
          .where(
            and(
              eq(rafflePoolEntries.rafflePoolId, rafflePoolId),
              eq(rafflePoolEntries.userAddress, userAddress),
            ),
          )
          .then((result: { entryCount: string | null }[]) => Number(result[0]?.entryCount ?? 0));

        if (existingEntryCount + entryCount > rafflePool.maxEntriesPerUser) {
          throw new Error('MAX_ENTRIES_PER_USER_REACHED');
        }
      }

      if (currentPoint < entryCount * rafflePool.pointPerEntry) {
        throw new Error('INSUFFICIENT_POINT');
      }

      const rafflePoolEntry = await tx
        .insert(rafflePoolEntries)
        .values({
          rafflePoolId,
          userAddress,
          entryCount,
          pointSpent: entryCount * rafflePool.pointPerEntry,
        })
        .returning({ id: rafflePoolEntries.id })
        .then((result: { id: string }[]) => result[0]!);

      await PointService.insertPointLog(tx, {
        userAddress,
        diff: -entryCount * rafflePool.pointPerEntry,
        sourceType: 'raffle',
        sourceId: rafflePoolEntry.id,
      });

      // Done last on purpose: concurrent entries into a popular pool serialise on this row's
      // lock, so holding it only from here to commit keeps the contended window as short as
      // possible.
      await tx
        .update(rafflePools)
        .set({ totalEntryCount: sql`${rafflePools.totalEntryCount} + ${entryCount}` })
        .where(eq(rafflePools.id, rafflePoolId));
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : '';

    switch (code) {
      case 'RAFFLE_POOL_NOT_FOUND':
        return c.json(
          { error: { code: 'RAFFLE_POOL_NOT_FOUND' as const, message: 'Raffle pool not found' } },
          400,
        );
      case 'MAX_ENTRIES_PER_USER_REACHED':
        return c.json(
          {
            error: {
              code: 'MAX_ENTRIES_PER_USER_REACHED' as const,
              message: 'Max entries per user reached',
            },
          },
          400,
        );
      case 'INSUFFICIENT_POINT':
        return c.json(
          { error: { code: 'INSUFFICIENT_POINT' as const, message: 'Insufficient point' } },
          400,
        );
      default:
        console.error('[raffle/apply] transaction error:', error);
        return c.json(
          { error: { code: 'INTERNAL_ERROR' as const, message: 'Internal server error' } },
          500,
        );
    }
  }

  return c.json({ data: { success: true as const } }, 200);
});

// ── GET /halo/raffle/list ───────────────────────────────────────────────────

const listHaloRafflePoolsRoute = createRoute({
  method: 'get',
  path: '/halo/raffle/list',
  tags: ['Halo Raffle'],
  summary: 'List Halo raffle pools for today',
  middleware: [userAuth] as const,
  request: {
    query: z.object({ chain: chainSchema.describe('Chain to list raffle pools for') }),
  },
  responses: {
    200: {
      description: 'Success',
      content: {
        'application/json': {
          schema: dataSchema(
            z.object({
              list: z.array(
                z.object({
                  id: z.string(),
                  amountInUSDT: z.number(),
                  pointPerEntry: z.number(),
                  maxEntriesPerUser: z.number().describe('-1 for unlimited'),
                  totalEntryCount: z.number(),
                  userEntryCount: z.number(),
                  isClosed: z.boolean(),
                }),
              ),
            }),
          ),
        },
      },
    },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: errorSchema } } },
  },
});

app.openapi(listHaloRafflePoolsRoute, async (c) => {
  const { chain } = c.req.valid('query');
  const userAddress = c.get('address')!;
  const db = c.get('db');
  const today = utcToday();

  const rafflePoolRecords = await db.query.haloRafflePools.findMany({
    columns: {
      id: true,
      amountInUSDT: true,
      pointPerEntry: true,
      maxEntriesPerUser: true,
      totalEntryCount: true,
      winnerAddress: true,
    },
    where: and(eq(haloRafflePools.chain, chain), eq(haloRafflePools.utcDate, today)),
    orderBy: [desc(haloRafflePools.amountInUSDT), haloRafflePools.pointPerEntry],
  });

  if (rafflePoolRecords.length === 0) {
    return c.json({ data: { list: [] } }, 200);
  }

  const userEntries = await db.query.haloRafflePoolEntries.findMany({
    columns: { rafflePoolId: true, entryCount: true },
    where: and(
      inArray(
        haloRafflePoolEntries.rafflePoolId,
        rafflePoolRecords.map((rafflePool) => rafflePool.id),
      ),
      eq(haloRafflePoolEntries.userAddress, userAddress),
    ),
  });

  const userEntriesMap = userEntries.reduce<Record<string, number>>((acc, entry) => {
    acc[entry.rafflePoolId] = (acc[entry.rafflePoolId] ?? 0) + entry.entryCount;
    return acc;
  }, {});

  return c.json(
    {
      data: {
        list: rafflePoolRecords.map((rafflePool) => {
          const userEntryCount = userEntriesMap[rafflePool.id] ?? 0;

          return {
            id: rafflePool.id,
            amountInUSDT: rafflePool.amountInUSDT,
            pointPerEntry: rafflePool.pointPerEntry,
            maxEntriesPerUser: rafflePool.maxEntriesPerUser,
            totalEntryCount: rafflePool.totalEntryCount,
            userEntryCount,
            isClosed:
              rafflePool.winnerAddress !== null ||
              (rafflePool.maxEntriesPerUser !== UNLIMITED_ENTRIES &&
                userEntryCount >= rafflePool.maxEntriesPerUser),
          };
        }),
      },
    },
    200,
  );
});

// ── POST /halo/raffle/apply ─────────────────────────────────────────────────

const applyHaloRaffleRoute = createRoute({
  method: 'post',
  path: '/halo/raffle/apply',
  tags: ['Halo Raffle'],
  summary: 'Apply for a Halo raffle',
  middleware: [userAuth] as const,
  request: {
    query: z.object({ chain: chainSchema.describe('Chain for raffle entry') }),
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({ rafflePoolId: z.string(), entryCount: z.number() }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Success',
      content: {
        'application/json': {
          schema: dataSchema(
            z.object({
              success: z.literal(true),
              // Celo entries are also spent onchain; other chains get no signature.
              spendSignature: z
                .object({
                  amount: z.number(),
                  spendIdBytes32: z.string(),
                  deadline: z.number(),
                  signature: z.string(),
                  contractAddress: z.string(),
                  chainId: z.number(),
                })
                .optional(),
            }),
          ),
        },
      },
    },
    400: {
      description: 'RAFFLE_POOL_NOT_FOUND / MAX_ENTRIES_PER_USER_REACHED / INSUFFICIENT_POINT',
      content: { 'application/json': { schema: errorSchema } },
    },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: errorSchema } } },
    403: {
      description: 'CHAIN_MISMATCH / EMAIL_NOT_VERIFIED',
      content: { 'application/json': { schema: errorSchema } },
    },
    500: {
      description: 'INTERNAL_ERROR',
      content: { 'application/json': { schema: errorSchema } },
    },
  },
});

app.openapi(applyHaloRaffleRoute, async (c) => {
  const { chain } = c.req.valid('query');
  const { rafflePoolId, entryCount } = c.req.valid('json');
  const userAddress = c.get('address')!;
  const db = c.get('db');
  const today = utcToday();

  // A wallet belongs to exactly one chain; entering another chain's pool would let one
  // balance be spent twice.
  const user = await db.query.users.findFirst({ where: eq(users.address, userAddress) });

  if (!user || user.platform !== chain) {
    return c.json({ error: { code: 'CHAIN_MISMATCH' as const, message: 'Chain mismatch' } }, 403);
  }

  // Celo prizes are paid out by hand against a verified email, so the email gate is here
  // rather than at payout time when the entry is already irreversible.
  if (chain === 'celo') {
    const emailVerified = await db.query.haloEmailVerifications.findFirst({
      where: and(
        eq(haloEmailVerifications.userAddress, userAddress),
        eq(haloEmailVerifications.chain, 'celo'),
        eq(haloEmailVerifications.isVerified, true),
      ),
    });

    if (!emailVerified) {
      return c.json(
        {
          error: {
            code: 'EMAIL_NOT_VERIFIED' as const,
            message: 'Please verify your email before entering the raffle',
          },
        },
        403,
      );
    }
  }

  const { afterBalance: currentPoint } = await PointService.getUserPoint(db, userAddress);

  let entryResult: { rafflePoolEntryId: string; pointRequired: number };

  try {
    entryResult = await db.transaction(async (tx) => {
      const rafflePool = await tx.query.haloRafflePools.findFirst({
        where: and(
          eq(haloRafflePools.id, rafflePoolId),
          eq(haloRafflePools.chain, chain),
          isNull(haloRafflePools.winnerAddress),
          eq(haloRafflePools.utcDate, today),
        ),
      });

      if (!rafflePool) {
        throw new Error('RAFFLE_POOL_NOT_FOUND');
      }

      const existingEntryCount = await tx
        .select({ entryCount: sum(haloRafflePoolEntries.entryCount) })
        .from(haloRafflePoolEntries)
        .where(
          and(
            eq(haloRafflePoolEntries.rafflePoolId, rafflePoolId),
            eq(haloRafflePoolEntries.userAddress, userAddress),
          ),
        )
        .then((result: { entryCount: string | null }[]) => Number(result[0]?.entryCount ?? 0));

      if (
        rafflePool.maxEntriesPerUser !== UNLIMITED_ENTRIES &&
        existingEntryCount + entryCount > rafflePool.maxEntriesPerUser
      ) {
        throw new Error('MAX_ENTRIES_PER_USER_REACHED');
      }

      const pointRequired = entryCount * rafflePool.pointPerEntry;

      if (currentPoint < pointRequired) {
        throw new Error('INSUFFICIENT_POINT');
      }

      const rafflePoolEntry = await tx
        .insert(haloRafflePoolEntries)
        .values({ rafflePoolId, userAddress, entryCount, pointSpent: pointRequired })
        .returning({ id: haloRafflePoolEntries.id })
        .then((result: { id: string }[]) => result[0]!);

      await PointService.insertPointLog(tx, {
        userAddress,
        diff: -pointRequired,
        sourceType: 'raffle',
        sourceId: rafflePoolEntry.id,
      });

      // Done last on purpose — see the note on /raffle/apply: this row is the contention
      // point, so its lock is held for as little of the transaction as possible.
      await tx
        .update(haloRafflePools)
        .set({ totalEntryCount: sql`${haloRafflePools.totalEntryCount} + ${entryCount}` })
        .where(eq(haloRafflePools.id, rafflePoolId));

      return { rafflePoolEntryId: rafflePoolEntry.id, pointRequired };
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : '';

    switch (code) {
      case 'RAFFLE_POOL_NOT_FOUND':
        return c.json(
          {
            error: {
              code: 'RAFFLE_POOL_NOT_FOUND' as const,
              message: 'Raffle pool not found or already closed',
            },
          },
          400,
        );
      case 'MAX_ENTRIES_PER_USER_REACHED':
        return c.json(
          {
            error: {
              code: 'MAX_ENTRIES_PER_USER_REACHED' as const,
              message: 'Maximum entries per user reached',
            },
          },
          400,
        );
      case 'INSUFFICIENT_POINT':
        return c.json(
          { error: { code: 'INSUFFICIENT_POINT' as const, message: 'Insufficient points' } },
          400,
        );
      default:
        console.error('[halo/raffle/apply] transaction error:', error);
        return c.json(
          { error: { code: 'INTERNAL_ERROR' as const, message: 'Internal server error' } },
          500,
        );
    }
  }

  if (chain !== 'celo') {
    return c.json({ data: { success: true as const } }, 200);
  }

  const account = privateKeyToAccount(c.env.SERVER_SIGNER_PRIVATE_KEY as `0x${string}`);
  const contractAddress = c.env.POINT_CLAIM_CONTRACT_CELO as string;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + SPEND_SIGNATURE_TTL_SECONDS);
  const spendIdBytes32 = keccak256(toHex(entryResult.rafflePoolEntryId));

  const signature = await account.signTypedData({
    domain: {
      name: POINT_CLAIM_EIP712_DOMAIN_NAME,
      version: '1',
      chainId: celo.id,
      verifyingContract: contractAddress as `0x${string}`,
    },
    types: {
      Spend: [
        { name: 'user', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'spendId', type: 'bytes32' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'Spend',
    message: {
      user: userAddress,
      amount: BigInt(entryResult.pointRequired),
      spendId: spendIdBytes32,
      deadline,
    },
  });

  return c.json(
    {
      data: {
        success: true as const,
        spendSignature: {
          amount: entryResult.pointRequired,
          spendIdBytes32,
          deadline: Number(deadline),
          signature,
          contractAddress,
          chainId: celo.id,
        },
      },
    },
    200,
  );
});

// ── GET /halo/raffle/history ────────────────────────────────────────────────

const haloRaffleHistoryRoute = createRoute({
  method: 'get',
  path: '/halo/raffle/history',
  tags: ['Halo Raffle'],
  summary: 'Halo raffle history',
  middleware: [userAuth] as const,
  request: {
    query: z.object({
      chain: chainSchema.describe('Chain to get history for'),
      date: z.string().describe('Date in YYYY-MM-DD format'),
    }),
  },
  responses: {
    200: {
      description: 'Success',
      content: {
        'application/json': {
          schema: dataSchema(
            z.object({
              totalEntryCount: z.number(),
              myRewards: z.array(
                z.object({
                  amountInUSDT: z.number(),
                  paidAt: z.string().nullable(),
                  txHash: z.string().nullable(),
                }),
              ),
              pools: z.array(
                z.object({
                  amountInUSDT: z.number(),
                  winner: winnerSchema.nullable(),
                }),
              ),
            }),
          ),
        },
      },
    },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: errorSchema } } },
  },
});

app.openapi(haloRaffleHistoryRoute, async (c) => {
  const { chain, date } = c.req.valid('query');
  const userAddress = c.get('address')!;
  const db = c.get('db');

  const rafflePoolRecords = await db.query.haloRafflePools.findMany({
    columns: {
      id: true,
      amountInUSDT: true,
      manualPayoutTxHash: true,
      manualPayoutAt: true,
    },
    with: { winner: { columns: { address: true, username: true } } },
    where: and(eq(haloRafflePools.chain, chain), eq(haloRafflePools.utcDate, date)),
    orderBy: [desc(haloRafflePools.amountInUSDT)],
  });

  if (rafflePoolRecords.length === 0) {
    return c.json({ data: { totalEntryCount: 0, myRewards: [], pools: [] } }, 200);
  }

  const sumEntriesCount = await db
    .select({ count: sum(haloRafflePoolEntries.entryCount) })
    .from(haloRafflePoolEntries)
    .where(
      inArray(
        haloRafflePoolEntries.rafflePoolId,
        rafflePoolRecords.map((rafflePool) => rafflePool.id),
      ),
    )
    .then((result: { count: string | null }[]) => Number(result[0]?.count ?? 0));

  return c.json(
    {
      data: {
        totalEntryCount: sumEntriesCount,
        myRewards: rafflePoolRecords
          .filter((rafflePool) => rafflePool.winner?.address === userAddress)
          .map((rafflePool) => ({
            amountInUSDT: rafflePool.amountInUSDT,
            paidAt: rafflePool.manualPayoutAt?.toISOString() ?? null,
            txHash: rafflePool.manualPayoutTxHash ?? null,
          })),
        pools: rafflePoolRecords.map((rafflePool) => ({
          amountInUSDT: rafflePool.amountInUSDT,
          winner: rafflePool.winner ?? null,
        })),
      },
    },
    200,
  );
});

// ── GET /halo/raffle/stats ──────────────────────────────────────────────────

const chainStatsSchema = z.object({
  awarded: z.number(),
  awardedCount: z.number(),
  paid: z.number(),
  paidCount: z.number(),
});

const raffleStatsRoute = createRoute({
  method: 'get',
  path: '/halo/raffle/stats',
  tags: ['Halo Raffle'],
  summary: 'Get combined raffle statistics across all chains',
  responses: {
    200: {
      description: 'Combined raffle statistics',
      content: {
        'application/json': {
          schema: dataSchema(
            z.object({
              // Awarded = a winner was drawn, regardless of whether the prize reached them.
              totalPrizesAwarded: z.number(),
              totalPrizesAwardedCount: z.number(),
              // Paid out = claimed through Drop on World, or manually transferred on Halo.
              totalPrizesPaidOut: z.number(),
              totalPrizesPaidOutCount: z.number(),
              breakdown: z.object({
                world: chainStatsSchema,
                celo: chainStatsSchema,
                kaia: chainStatsSchema,
              }),
            }),
          ),
        },
      },
    },
  },
});

app.openapi(raffleStatsRoute, async (c) => {
  const db = c.get('db');

  const [worldStats, celoStats, kaiaStats] = await Promise.all([
    db
      .select({
        awarded: sum(rafflePools.amountInUSDC),
        awardedCount: count(),
        paid: sql<number>`COALESCE(SUM(CASE WHEN ${rafflePools.claimedAt} IS NOT NULL THEN ${rafflePools.amountInUSDC} ELSE 0 END), 0)`,
        paidCount: sql<number>`COUNT(CASE WHEN ${rafflePools.claimedAt} IS NOT NULL THEN 1 END)`,
      })
      .from(rafflePools)
      .where(isNotNull(rafflePools.winnerAddress)),
    db
      .select({
        awarded: sum(haloRafflePools.amountInUSDT),
        awardedCount: count(),
        paid: sql<number>`COALESCE(SUM(CASE WHEN ${haloRafflePools.manualPayoutAt} IS NOT NULL THEN ${haloRafflePools.amountInUSDT} ELSE 0 END), 0)`,
        paidCount: sql<number>`COUNT(CASE WHEN ${haloRafflePools.manualPayoutAt} IS NOT NULL THEN 1 END)`,
      })
      .from(haloRafflePools)
      .where(and(isNotNull(haloRafflePools.winnerAddress), eq(haloRafflePools.chain, 'celo'))),
    db
      .select({
        awarded: sum(haloRafflePools.amountInUSDT),
        awardedCount: count(),
        paid: sql<number>`COALESCE(SUM(CASE WHEN ${haloRafflePools.manualPayoutAt} IS NOT NULL THEN ${haloRafflePools.amountInUSDT} ELSE 0 END), 0)`,
        paidCount: sql<number>`COUNT(CASE WHEN ${haloRafflePools.manualPayoutAt} IS NOT NULL THEN 1 END)`,
      })
      .from(haloRafflePools)
      .where(and(isNotNull(haloRafflePools.winnerAddress), eq(haloRafflePools.chain, 'kaia'))),
  ]);

  // Postgres returns aggregates as strings, so every field goes through Number().
  const toChainStats = (row: Record<string, unknown> | undefined) => ({
    awarded: Number(row?.awarded) || 0,
    awardedCount: Number(row?.awardedCount) || 0,
    paid: Number(row?.paid) || 0,
    paidCount: Number(row?.paidCount) || 0,
  });

  const world = toChainStats(worldStats[0]);
  const celoBreakdown = toChainStats(celoStats[0]);
  const kaia = toChainStats(kaiaStats[0]);

  return c.json(
    {
      data: {
        // USDC and USDT are treated as interchangeable for this headline figure.
        totalPrizesAwarded: world.awarded + celoBreakdown.awarded + kaia.awarded,
        totalPrizesAwardedCount:
          world.awardedCount + celoBreakdown.awardedCount + kaia.awardedCount,
        totalPrizesPaidOut: world.paid + celoBreakdown.paid + kaia.paid,
        totalPrizesPaidOutCount: world.paidCount + celoBreakdown.paidCount + kaia.paidCount,
        breakdown: { world, celo: celoBreakdown, kaia },
      },
    },
    200,
  );
});

// ── GET /halo/raffle/payouts ────────────────────────────────────────────────

const rafflePayoutsRoute = createRoute({
  method: 'get',
  path: '/halo/raffle/payouts',
  tags: ['Halo Raffle'],
  summary: 'Get paid raffle payouts with on-chain tx hashes',
  request: {
    query: z.object({
      chain: chainSchema.describe('Chain to get payouts for'),
      limit: z.coerce.number().int().min(1).max(100).default(20),
      offset: z.coerce.number().int().min(0).default(0),
    }),
  },
  responses: {
    200: {
      description: 'Paginated list of verified payouts',
      content: {
        'application/json': {
          schema: dataSchema(
            z.object({
              payouts: z.array(
                z.object({
                  utcDate: z.string(),
                  amountInUSDT: z.number(),
                  winner: winnerSchema,
                  txHash: z.string(),
                  paidAt: z.string(),
                }),
              ),
              total: z.number(),
              summary: z.object({ totalPaid: z.number(), totalPaidCount: z.number() }),
            }),
          ),
        },
      },
    },
  },
});

app.openapi(rafflePayoutsRoute, async (c) => {
  const { chain, limit, offset } = c.req.valid('query');
  const db = c.get('db');

  const payoutRecords = await db.query.haloRafflePools.findMany({
    columns: {
      utcDate: true,
      amountInUSDT: true,
      manualPayoutTxHash: true,
      manualPayoutAt: true,
    },
    with: { winner: { columns: { address: true, username: true } } },
    where: and(
      eq(haloRafflePools.chain, chain),
      isNotNull(haloRafflePools.manualPayoutTxHash),
    ),
    orderBy: [desc(haloRafflePools.utcDate), desc(haloRafflePools.amountInUSDT)],
    limit,
    offset,
  });

  const [summary] = await db
    .select({
      totalPaid: sum(haloRafflePools.amountInUSDT),
      totalPaidCount: count(),
    })
    .from(haloRafflePools)
    .where(and(eq(haloRafflePools.chain, chain), isNotNull(haloRafflePools.manualPayoutTxHash)));

  const payouts = payoutRecords.flatMap((record) => {
    // The winner relation and the payout timestamp are both set by the payout job; a row
    // missing either is mid-write, and publishing a half-row would misreport the totals.
    if (!record.winner || !record.manualPayoutTxHash || !record.manualPayoutAt) {
      return [];
    }

    return [
      {
        utcDate: record.utcDate,
        amountInUSDT: record.amountInUSDT,
        winner: { address: record.winner.address, username: record.winner.username },
        txHash: record.manualPayoutTxHash,
        paidAt: record.manualPayoutAt.toISOString(),
      },
    ];
  });

  return c.json(
    {
      data: {
        payouts,
        total: Number(summary?.totalPaidCount) || 0,
        summary: {
          totalPaid: Number(summary?.totalPaid) || 0,
          totalPaidCount: Number(summary?.totalPaidCount) || 0,
        },
      },
    },
    200,
  );
});

export const clientRaffleRoutes = app;
