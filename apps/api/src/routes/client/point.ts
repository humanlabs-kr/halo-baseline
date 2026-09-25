import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  dataSchema,
  DAILY_CHECK_IN_POINTS,
  DAILY_ONCHAIN_BONUS_POINTS,
  errorSchema,
  POINT_CLAIM_EIP712_DOMAIN_NAME,
} from '@halo/contracts';
import {
  and,
  count,
  dailyPointClaims,
  desc,
  eq,
  gte,
  inArray,
  lt,
  or,
  pointClaims,
  pointLogs,
  receipts,
  sql,
} from '@halo/database';
import KSUID from 'ksuid';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { celo } from 'viem/chains';
import { PointService } from '../../lib/point';
import { hashToField, verifyProof } from '../../lib/verify';
import { userAuth } from '../../middleware/auth';
import type { AppEnv } from '../../types';

/** How long an onchain claim signature stays redeemable. */
const CLAIM_SIGNATURE_TTL_SECONDS = 60 * 30;

// Offchain daily claim and the richer on-chain bonus, both inclusive. They
// live in `@halo/contracts` because the rewards screen prints them, and a
// second copy is how that screen came to advertise "+10" for a claim that has
// never paid more than 8.
const DAILY_CLAIM_MIN_POINT = DAILY_CHECK_IN_POINTS.min;
const DAILY_CLAIM_MAX_POINT = DAILY_CHECK_IN_POINTS.max;
const DAILY_ONCHAIN_CLAIM_MIN_POINT = DAILY_ONCHAIN_BONUS_POINTS.min;
const DAILY_ONCHAIN_CLAIM_MAX_POINT = DAILY_ONCHAIN_BONUS_POINTS.max;

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

/** Shape returned by every endpoint that hands the client a signature to redeem on Celo. */
const onchainClaimSchema = z.object({
  claimedPoint: z.number(),
  claimIdBytes32: z.string(),
  deadline: z.number(),
  signature: z.string(),
  contractAddress: z.string(),
  chainId: z.number(),
});

function randomPointInRange(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * `metadata` is a jsonb column, so the driver hands it back as `unknown`. Anything that is not
 * a plain object is not something a client can index into, so it becomes `{}` rather than
 * leaking a `null` or a bare array through a field the schema documents as a map.
 */
function asMetadata(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

// ── GET /point/stat ─────────────────────────────────────────────────────────

const pointStatRoute = createRoute({
  method: 'get',
  path: '/point/stat',
  tags: ['Point'],
  summary: 'Get point stat',
  middleware: [userAuth] as const,
  responses: {
    200: {
      description: 'Success',
      content: {
        'application/json': {
          schema: dataSchema(
            z.object({
              accumulatedPoint: z.number(),
              currentPoint: z.number(),
              claimablePoint: z.number(),
            }),
          ),
        },
      },
    },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: errorSchema } } },
  },
});

app.openapi(pointStatRoute, async (c) => {
  const userAddress = c.get('address')!;
  const db = c.get('db');

  const [userPoint, claimablePoint] = await Promise.all([
    PointService.getUserPoint(db, userAddress),
    db
      .select({ amount: sql<number>`sum(${receipts.assignedPoint})` })
      .from(receipts)
      .where(
        and(
          eq(receipts.userAddress, userAddress),
          // Rejected receipts still pay the participation reward, so they count as claimable.
          or(eq(receipts.status, 'claimable'), eq(receipts.status, 'rejected')),
        ),
      )
      // `sum()` over an integer column comes back numeric, and postgres.js
      // hands numerics over as strings to keep their precision — so this was
      // answering `"45"` from a field the schema declares as a number. Nothing
      // validates a response body, so it reached the client as a string and
      // only happened to render.
      .then((result: { amount: string | number | null }[]) => Number(result[0]?.amount ?? 0)),
  ]);

  return c.json(
    {
      data: {
        accumulatedPoint: userPoint.accumulatedBalance,
        currentPoint: userPoint.afterBalance,
        claimablePoint,
      },
    },
    200,
  );
});

// ── GET /point/logs ─────────────────────────────────────────────────────────

const listPointLogsRoute = createRoute({
  method: 'get',
  path: '/point/logs',
  tags: ['Point'],
  summary: 'List point logs',
  middleware: [userAuth] as const,
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).default(20).optional(),
      offset: z.coerce.number().int().min(0).default(0).optional(),
    }),
  },
  responses: {
    200: {
      description: 'Success',
      content: {
        'application/json': {
          schema: dataSchema(
            z.object({
              totalCount: z.number(),
              list: z.array(
                z.object({
                  id: z.string(),
                  diff: z.number(),
                  afterBalance: z.number(),
                  accumulatedBalance: z.number(),
                  sourceType: z.enum([
                    'airdrop',
                    'receipt-upload',
                    'raffle',
                    'manual',
                    'daily-claim',
                    'daily-claim-onchain',
                  ]),
                  sourceId: z.string().nullable(),
                  metadata: z.record(z.unknown()),
                  createdAt: z.coerce.date(),
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

app.openapi(listPointLogsRoute, async (c) => {
  const userAddress = c.get('address')!;
  const { limit = 20, offset = 0 } = c.req.valid('query');
  const db = c.get('db');

  const totalCount = await db
    .select({ count: count() })
    .from(pointLogs)
    .where(eq(pointLogs.userAddress, userAddress))
    .then((result: { count: number }[]) => result[0]?.count ?? 0);

  const pointLogRecords = await db.query.pointLogs.findMany({
    columns: {
      id: true,
      diff: true,
      afterBalance: true,
      accumulatedBalance: true,
      sourceType: true,
      sourceId: true,
      metadata: true,
      createdAt: true,
    },
    where: eq(pointLogs.userAddress, userAddress),
    orderBy: [desc(pointLogs.createdAt)],
    limit,
    offset,
  });

  return c.json(
    {
      data: {
        totalCount,
        list: pointLogRecords.map((log) => ({
          id: log.id,
          diff: log.diff,
          afterBalance: log.afterBalance,
          accumulatedBalance: log.accumulatedBalance,
          sourceType: log.sourceType,
          sourceId: log.sourceId,
          metadata: asMetadata(log.metadata),
          createdAt: log.createdAt,
        })),
      },
    },
    200,
  );
});

// ── POST /point/claim ───────────────────────────────────────────────────────

const claimPointRoute = createRoute({
  method: 'post',
  path: '/point/claim',
  tags: ['Point'],
  summary: 'Claim point',
  middleware: [userAuth] as const,
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.discriminatedUnion('platform', [
            z.object({
              platform: z.literal('world'),
              proof: z.string(),
              verification_level: z.enum(['orb', 'device']),
              merkle_root: z.string(),
              nullifier_hash: z.string(),
              signal: z.string(),
              action: z.string(),
            }),
            z.object({ platform: z.literal('celo') }),
            z.object({ platform: z.literal('kaia') }),
          ]),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Success',
      content: {
        'application/json': { schema: dataSchema(z.object({ claimedPoint: z.number() })) },
      },
    },
    400: {
      description: 'INVALID_PROOF',
      content: { 'application/json': { schema: errorSchema } },
    },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: errorSchema } } },
  },
});

/**
 * The detail World returns with a rejected proof.
 *
 * Typed loosely because the shape belongs to someone else's API and the useful
 * field has moved between versions. Reading it defensively costs nothing;
 * asserting a shape and being wrong would turn a diagnostic into a 500.
 */
function worldReason(response: unknown): string | null {
  if (typeof response !== 'object' || response === null) return null;
  const body = response as Record<string, unknown>;
  const code = body.code ?? body.error_code;
  const detail = body.detail ?? body.message;
  if (typeof code === 'string') {
    return typeof detail === 'string' ? `${code}: ${detail}` : code;
  }
  return typeof detail === 'string' ? detail : null;
}

app.openapi(claimPointRoute, async (c) => {
  const body = c.req.valid('json');
  const userAddress = c.get('address')!;
  const db = c.get('db');

  // World is the only platform with World ID proofs to check; Celo and Kaia claim directly.
  if (body.platform === 'world') {
    // Wrapped, because this is a call to somebody else's service and it was
    // the only unguarded `await` on the path. A timeout, a 502 from
    // developer.worldcoin.org or a non-JSON body threw straight past the
    // handler into the last-resort 500 — which is what a user saw as
    // INTERNAL_ERROR, with nothing to say whether their proof was bad or ours
    // was the service that was down.
    let response: Awaited<ReturnType<typeof verifyProof>>;

    try {
      response = await verifyProof(c.env.WORLD_APP_ID, {
        nullifier_hash: body.nullifier_hash,
        merkle_root: body.merkle_root,
        proof: body.proof,
        verification_level: body.verification_level,
        action: body.action,
        signal_hash: hashToField(body.signal).digest,
      });
    } catch (error) {
      console.error(
        '[claim] world verification unreachable',
        JSON.stringify({
          address: userAddress,
          app: c.env.WORLD_APP_ID,
          action: body.action,
          error: error instanceof Error ? error.message : String(error),
        }),
      );

      return c.json(
        {
          error: {
            code: 'INVALID_PROOF' as const,
            message: 'World ID could not be reached. Try again in a moment.',
          },
        },
        400,
      );
    }

    if (!response.success) {
      // World says why — `max_verifications_reached`, `invalid_merkle_root`,
      // an action that is not registered — and until this line existed none of
      // it was written down anywhere. A user reported the claim button doing
      // nothing and there was no record on either side of the request to say
      // which of those it was.
      console.error(
        '[claim] world proof rejected',
        JSON.stringify({
          address: userAddress,
          action: body.action,
          level: body.verification_level,
          nullifier: body.nullifier_hash,
          world: response,
        }),
      );

      return c.json(
        {
          error: {
            code: 'INVALID_PROOF' as const,
            // The reason travels to the screen. It is not copy anyone would
            // choose, and it is the difference between a user who can tell us
            // what happened and one who can only say "nothing happened".
            message: worldReason(response) ?? 'Invalid proof',
          },
        },
        400,
      );
    }
  }

  // Claiming is one transaction with five writes in it, and when it fails the
  // last-resort handler returns `INTERNAL_ERROR` with no indication of which.
  // A user reported exactly that and there was nothing to go on, so the shape
  // of the attempt is recorded before it starts and the failure is labelled on
  // the way out.
  const attempt = { address: userAddress, platform: body.platform };

  const claimedPoint = await settle();

  return c.json({ data: { claimedPoint } }, 200);

  async function settle() {
   try {
    return await db.transaction(async (tx) => {
    const claimablePointRecords: { id: string; assignedPoint: number }[] = await tx
      .select({ id: receipts.id, assignedPoint: receipts.assignedPoint })
      .from(receipts)
      .where(
        and(
          eq(receipts.userAddress, userAddress),
          or(eq(receipts.status, 'claimable'), eq(receipts.status, 'rejected')),
        ),
      );

    const totalClaimablePoint = claimablePointRecords.reduce(
      (acc, item) => acc + item.assignedPoint,
      0,
    );

    console.log(
      '[claim] settling',
      JSON.stringify({ ...attempt, receipts: claimablePointRecords.length, points: totalClaimablePoint }),
    );

    // `inArray` on an empty list is not a query that returns nothing — it is
    // invalid SQL. Nothing to settle is a successful claim of zero, not a 500.
    if (claimablePointRecords.length === 0) return 0;

    const createdPointLog = await PointService.insertPointLog(tx, {
      userAddress,
      diff: totalClaimablePoint,
      sourceType: 'receipt-upload',
    });

    const claimedReceiptIds = claimablePointRecords.map((item) => item.id);

    if (body.platform === 'world') {
      await tx.insert(pointClaims).values({
        id: KSUID.randomSync().string,
        userAddress,
        signal: body.signal,
        action: body.action,
        merkle_root: body.merkle_root,
        nullifier_hash: body.nullifier_hash,
        signal_hash: hashToField(body.signal).digest,
        verification_level: body.verification_level,
        proof: body.proof,
        totalAmount: totalClaimablePoint,
        receiptIds: claimedReceiptIds,
      });
    } else {
      // Celo/Kaia have no proof to record — the verification columns keep their defaults.
      await tx.insert(pointClaims).values({
        id: KSUID.randomSync().string,
        userAddress,
        totalAmount: totalClaimablePoint,
        receiptIds: claimedReceiptIds,
      });
    }

    // Two updates rather than one: a claimed receipt and a claimed-but-rejected receipt end in
    // different terminal states, and the status filter is what keeps them apart.
    await tx
      .update(receipts)
      .set({ status: 'claimed', pointLogId: createdPointLog.id })
      .where(and(inArray(receipts.id, claimedReceiptIds), eq(receipts.status, 'claimable')));

    await tx
      .update(receipts)
      .set({ status: 'rejected-claimed', pointLogId: createdPointLog.id })
      .where(and(inArray(receipts.id, claimedReceiptIds), eq(receipts.status, 'rejected')));

    return totalClaimablePoint;
    });
   } catch (error) {
    // Labelled on the way out. Five writes happen inside that transaction and
    // the last-resort handler cannot say which of them failed.
    console.error(
      '[claim] settle failed',
      JSON.stringify({ ...attempt, error: error instanceof Error ? error.message : String(error) }),
    );
    throw error;
   }
  }
});

// ── POST /point/claim-single-celo ───────────────────────────────────────────

const claimSingleCeloRoute = createRoute({
  method: 'post',
  path: '/point/claim-single-celo',
  tags: ['Point'],
  summary: 'Claim a single receipt to Celo, returning an onchain claim signature',
  middleware: [userAuth] as const,
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: z.object({ receiptId: z.string() }) } },
    },
  },
  responses: {
    200: {
      description: 'Success',
      content: { 'application/json': { schema: dataSchema(onchainClaimSchema) } },
    },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: errorSchema } } },
    404: {
      description: 'RECEIPT_NOT_CLAIMABLE',
      content: { 'application/json': { schema: errorSchema } },
    },
  },
});

app.openapi(claimSingleCeloRoute, async (c) => {
  const { receiptId } = c.req.valid('json');
  const userAddress = c.get('address')!;
  const db = c.get('db');
  const claimId = KSUID.randomSync().string;

  let claimedPoint: number;

  try {
    claimedPoint = await db.transaction(async (tx) => {
      const claimablePointRecord = await tx
        .select({ id: receipts.id, assignedPoint: receipts.assignedPoint })
        .from(receipts)
        .where(
          and(
            eq(receipts.id, receiptId),
            or(eq(receipts.status, 'claimable'), eq(receipts.status, 'rejected')),
          ),
        )
        .then((result: { id: string; assignedPoint: number }[]) => result.at(0));

      if (!claimablePointRecord) {
        throw new Error('RECEIPT_NOT_CLAIMABLE');
      }

      const totalClaimablePoint = claimablePointRecord.assignedPoint;

      const createdPointLog = await PointService.insertPointLog(tx, {
        userAddress,
        diff: totalClaimablePoint,
        sourceType: 'receipt-upload',
      });

      await tx.insert(pointClaims).values({
        id: claimId,
        userAddress,
        totalAmount: totalClaimablePoint,
        receiptIds: [claimablePointRecord.id],
      });

      await tx
        .update(receipts)
        .set({ status: 'claimed', pointLogId: createdPointLog.id })
        .where(and(eq(receipts.id, claimablePointRecord.id), eq(receipts.status, 'claimable')));

      await tx
        .update(receipts)
        .set({ status: 'rejected-claimed', pointLogId: createdPointLog.id })
        .where(and(eq(receipts.id, claimablePointRecord.id), eq(receipts.status, 'rejected')));

      return totalClaimablePoint;
    });
  } catch (error) {
    console.error('[point/claim-single-celo] claim failed:', error);
    return c.json(
      {
        error: {
          code: 'RECEIPT_NOT_CLAIMABLE' as const,
          message: 'Claimable receipt record not found',
        },
      },
      404,
    );
  }

  const signed = await signCeloClaim(
    c.env.SERVER_SIGNER_PRIVATE_KEY,
    c.env.POINT_CLAIM_CONTRACT_CELO,
    userAddress,
    claimedPoint,
    claimId,
  );

  return c.json({ data: { claimedPoint, ...signed } }, 200);
});

// ── POST /daily-point-claim/claim ───────────────────────────────────────────

const claimDailyPointRoute = createRoute({
  method: 'post',
  path: '/daily-point-claim/claim',
  tags: ['Daily Point Claim'],
  summary: 'Claim daily point',
  middleware: [userAuth] as const,
  responses: {
    200: {
      description: 'Success',
      content: {
        'application/json': { schema: dataSchema(z.object({ claimedPoint: z.number() })) },
      },
    },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: errorSchema } } },
    409: {
      description: 'ALREADY_CLAIMED',
      content: { 'application/json': { schema: errorSchema } },
    },
  },
});

app.openapi(claimDailyPointRoute, async (c) => {
  const userAddress = c.get('address')!;
  const db = c.get('db');

  // The claim day is UTC midnight, not the user's local midnight — otherwise the window
  // would move with the traveller and let one wallet claim twice in a day.
  const now = new Date();
  const claimDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const existingClaim = await db.query.dailyPointClaims.findFirst({
    where: and(
      eq(dailyPointClaims.userAddress, userAddress),
      eq(dailyPointClaims.claimDate, claimDate),
    ),
  });

  if (existingClaim) {
    return c.json(
      {
        error: {
          code: 'ALREADY_CLAIMED' as const,
          message: 'Daily point already claimed for today',
        },
      },
      409,
    );
  }

  const claimedPoint = randomPointInRange(DAILY_CLAIM_MIN_POINT, DAILY_CLAIM_MAX_POINT);

  await db.transaction(async (tx) => {
    const createdPointLog = await PointService.insertPointLog(tx, {
      userAddress,
      diff: claimedPoint,
      sourceType: 'daily-claim',
      sourceId: undefined,
      metadata: { type: 'daily-claim', claimDate: claimDate.toISOString().split('T')[0] },
    });

    await tx.insert(dailyPointClaims).values({
      id: KSUID.randomSync().string,
      userAddress,
      claimDate,
      claimedPoint,
      pointLogId: createdPointLog.id,
    });
  });

  return c.json({ data: { claimedPoint } }, 200);
});

// ── POST /daily-point-claim/claim-celo ──────────────────────────────────────

const claimDailyPointCeloRoute = createRoute({
  method: 'post',
  path: '/daily-point-claim/claim-celo',
  tags: ['Daily Point Claim'],
  summary: 'Claim daily onchain bonus point for celo (with onchain signature)',
  middleware: [userAuth] as const,
  responses: {
    200: {
      description: 'Success',
      content: { 'application/json': { schema: dataSchema(onchainClaimSchema) } },
    },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: errorSchema } } },
    409: {
      description: 'ALREADY_CLAIMED',
      content: { 'application/json': { schema: errorSchema } },
    },
  },
});

app.openapi(claimDailyPointCeloRoute, async (c) => {
  const userAddress = c.get('address')!;
  const db = c.get('db');

  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const tomorrowStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );

  // The onchain bonus has no dedicated table — the point log is the record of record.
  const existingOnchainClaim = await db.query.pointLogs.findFirst({
    where: and(
      eq(pointLogs.userAddress, userAddress),
      eq(pointLogs.sourceType, 'daily-claim-onchain'),
      gte(pointLogs.createdAt, todayStart),
      lt(pointLogs.createdAt, tomorrowStart),
    ),
  });

  if (existingOnchainClaim) {
    return c.json(
      {
        error: {
          code: 'ALREADY_CLAIMED' as const,
          message: 'Daily onchain bonus already claimed for today',
        },
      },
      409,
    );
  }

  const claimedPoint = randomPointInRange(
    DAILY_ONCHAIN_CLAIM_MIN_POINT,
    DAILY_ONCHAIN_CLAIM_MAX_POINT,
  );
  const claimId = KSUID.randomSync().string;

  await db.transaction(async (tx) => {
    await PointService.insertPointLog(tx, {
      userAddress,
      diff: claimedPoint,
      sourceType: 'daily-claim-onchain',
      sourceId: claimId,
      metadata: {
        type: 'daily-claim-onchain',
        claimDate: todayStart.toISOString().split('T')[0],
      },
    });
  });

  const signed = await signCeloClaim(
    c.env.SERVER_SIGNER_PRIVATE_KEY,
    c.env.POINT_CLAIM_CONTRACT_CELO,
    userAddress,
    claimedPoint,
    claimId,
  );

  return c.json({ data: { claimedPoint, ...signed } }, 200);
});

/**
 * EIP-712 claim signature the client redeems against the Celo point-claim contract.
 *
 * The claim id is hashed rather than sent raw so the contract can key its replay set on a
 * fixed-width value, and the deadline caps how long a leaked signature stays useful.
 */
async function signCeloClaim(
  serverSignerPrivateKey: string,
  contractAddress: string,
  userAddress: `0x${string}`,
  claimedPoint: number,
  claimId: string,
): Promise<{
  claimIdBytes32: string;
  deadline: number;
  signature: string;
  contractAddress: string;
  chainId: number;
}> {
  const account = privateKeyToAccount(serverSignerPrivateKey as `0x${string}`);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + CLAIM_SIGNATURE_TTL_SECONDS);
  const claimIdBytes32 = keccak256(toHex(claimId));

  const signature = await account.signTypedData({
    domain: {
      name: POINT_CLAIM_EIP712_DOMAIN_NAME,
      version: '1',
      chainId: celo.id,
      verifyingContract: contractAddress as `0x${string}`,
    },
    types: {
      Claim: [
        { name: 'user', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'claimId', type: 'bytes32' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'Claim',
    message: {
      user: userAddress,
      amount: BigInt(claimedPoint),
      claimId: claimIdBytes32,
      deadline,
    },
  });

  return {
    claimIdBytes32,
    deadline: Number(deadline),
    signature,
    contractAddress,
    chainId: celo.id,
  };
}

export const clientPointRoutes = app;
