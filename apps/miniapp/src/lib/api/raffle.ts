import type { Platform } from '@halo/contracts';
import { apiFetch, type ApiRequestInit } from './client';

/**
 * Raffle endpoints — `apps/api/src/routes/client/raffle.ts`.
 *
 * The server exposes two raffle surfaces and they settle prizes differently:
 *
 * - `/v1/raffle/*`      — World. Winners claim the prize themselves through a
 *                         Drop Protocol link, so a reward carries a `dropLink`
 *                         and a `claimedAt`. Amounts are denominated in USDC.
 * - `/v1/halo/raffle/*` — Celo and Kaia. Prizes are transferred by us on a
 *                         schedule, so a reward carries a payout `txHash` and
 *                         a `paidAt`. Amounts are denominated in USDT.
 *
 * Both are declared below exactly as the server returns them, and then
 * normalised into one shape for the screens. A screen should not have to know
 * which surface it is on; the difference survives only as which settlement
 * field is populated.
 */

/** Module-private: every client route is mounted under `/v1`. */
function call<T>(path: string, init?: ApiRequestInit): Promise<T> {
  return apiFetch<T>(`/v1${path}`, init);
}

/** World settles through Drop Protocol, so only these two run Halo raffles. */
export type HaloRaffleChain = Exclude<Platform, 'world'>;

export interface RaffleWinner {
  address: string;
  username: string;
}

export interface RaffleEntryRequest {
  rafflePoolId: string;
  entryCount: number;
}

/**
 * Onchain spend descriptor. Returned only where entering a raffle also burns
 * points onchain (Celo today); elsewhere entry is recorded offchain only.
 */
export interface SpendSignature {
  amount: number;
  spendIdBytes32: string;
  deadline: number;
  signature: string;
  contractAddress: string;
  chainId: number;
}

/** Codes `POST /raffle/apply` and `POST /halo/raffle/apply` answer with. */
export type RaffleApplyErrorCode =
  | 'RAFFLE_POOL_NOT_FOUND'
  | 'MAX_ENTRIES_PER_USER_REACHED'
  | 'INSUFFICIENT_POINT'
  | 'CHAIN_MISMATCH'
  | 'EMAIL_NOT_VERIFIED'
  | 'INTERNAL_ERROR';

// ── World: /v1/raffle/* ─────────────────────────────────────────────────────

interface WorldRafflePool {
  id: string;
  amountInUSDC: number;
  pointPerEntry: number;
  /** -1 means unlimited. */
  maxEntriesPerUser: number;
  totalEntryCount: number;
  userEntryCount: number;
  isClosed: boolean;
}

interface WorldRaffleHistory {
  totalEntryCount: number;
  myRewards: { amountInUSDC: number; claimedAt: string | null; dropLink: string }[];
  pools: { amountInUSDC: number; winner: RaffleWinner | null }[];
}

// ── Halo: /v1/halo/raffle/* ─────────────────────────────────────────────────

interface HaloRafflePool {
  id: string;
  amountInUSDT: number;
  pointPerEntry: number;
  /** -1 means unlimited. */
  maxEntriesPerUser: number;
  totalEntryCount: number;
  userEntryCount: number;
  isClosed: boolean;
}

interface HaloRaffleHistory {
  totalEntryCount: number;
  myRewards: { amountInUSDT: number; paidAt: string | null; txHash: string | null }[];
  pools: { amountInUSDT: number; winner: RaffleWinner | null }[];
}

/**
 * Lifetime totals for one chain.
 *
 * `awarded` counts every drawn prize; `paid` counts only the ones that reached
 * the winner. All three chains report the same four fields — World's claims
 * are not a separate shape, they are just its `paid` figures.
 */
export interface RaffleChainStats {
  awarded: number;
  awardedCount: number;
  paid: number;
  paidCount: number;
}

export interface RaffleStats {
  totalPrizesAwarded: number;
  totalPrizesAwardedCount: number;
  totalPrizesPaidOut: number;
  totalPrizesPaidOutCount: number;
  breakdown: Record<Platform, RaffleChainStats>;
}

export interface HaloRafflePayout {
  utcDate: string;
  amountInUSDT: number;
  winner: RaffleWinner;
  txHash: string;
  paidAt: string;
}

export interface HaloRafflePayouts {
  payouts: HaloRafflePayout[];
  total: number;
  summary: { totalPaid: number; totalPaidCount: number };
}

export interface RafflePayoutsQuery {
  limit?: number;
  offset?: number;
}

export const raffleApi = {
  worldPools(): Promise<{ list: WorldRafflePool[] }> {
    return call('/raffle/list');
  },

  worldHistory(date: string): Promise<WorldRaffleHistory> {
    return call('/raffle/history', { query: { date } });
  },

  worldApply(request: RaffleEntryRequest): Promise<{ success: true }> {
    return call('/raffle/apply', { method: 'POST', body: request });
  },

  haloPools(chain: HaloRaffleChain): Promise<{ list: HaloRafflePool[] }> {
    return call('/halo/raffle/list', { query: { chain } });
  },

  haloHistory(chain: HaloRaffleChain, date: string): Promise<HaloRaffleHistory> {
    return call('/halo/raffle/history', { query: { chain, date } });
  },

  haloApply(
    chain: HaloRaffleChain,
    request: RaffleEntryRequest,
  ): Promise<{ success: true; spendSignature?: SpendSignature }> {
    return call('/halo/raffle/apply', { method: 'POST', query: { chain }, body: request });
  },

  /** Public — combined across all three chains, no session required. */
  stats(): Promise<RaffleStats> {
    return call('/halo/raffle/stats');
  },

  /** Public — the settled-payout ledger for one Halo chain. */
  payouts(chain: HaloRaffleChain, query: RafflePayoutsQuery = {}): Promise<HaloRafflePayouts> {
    return call('/halo/raffle/payouts', { query: { chain, ...query } });
  },
};

// ── Normalised view ─────────────────────────────────────────────────────────

export interface RafflePool {
  id: string;
  /** Prize size, in the chain's reward currency (see `REWARD_CURRENCY`). */
  amount: number;
  pointPerEntry: number;
  /** -1 means unlimited. */
  maxEntriesPerUser: number;
  totalEntryCount: number;
  userEntryCount: number;
  isClosed: boolean;
}

export interface RaffleReward {
  amount: number;
  /** When the prize reached the user; null while it is still outstanding. */
  settledAt: string | null;
  /** World: the user finishes the claim themselves at this link. */
  claimUrl?: string;
  /** Celo / Kaia: hash of the payout transaction we sent. */
  txHash?: string;
}

export interface RaffleHistoryView {
  totalEntryCount: number;
  myRewards: RaffleReward[];
  pools: { amount: number; winner: RaffleWinner | null }[];
}

export interface RaffleEntryResult {
  spendSignature?: SpendSignature;
}

/** The Halo raffle surface serves these; anything else is World's. */
function haloChain(platform: Platform): HaloRaffleChain | null {
  return platform === 'world' ? null : platform;
}

export async function fetchRafflePools(platform: Platform): Promise<RafflePool[]> {
  const chain = haloChain(platform);

  if (chain) {
    const { list } = await raffleApi.haloPools(chain);
    return list.map(({ amountInUSDT, ...pool }) => ({ ...pool, amount: amountInUSDT }));
  }

  const { list } = await raffleApi.worldPools();
  return list.map(({ amountInUSDC, ...pool }) => ({ ...pool, amount: amountInUSDC }));
}

export async function applyForRaffle(
  platform: Platform,
  entry: RaffleEntryRequest,
): Promise<RaffleEntryResult> {
  const chain = haloChain(platform);

  if (chain) {
    const { spendSignature } = await raffleApi.haloApply(chain, entry);
    return { spendSignature };
  }

  await raffleApi.worldApply(entry);
  return {};
}

export async function fetchRaffleHistory(
  platform: Platform,
  date: string,
): Promise<RaffleHistoryView> {
  const chain = haloChain(platform);

  if (chain) {
    const history = await raffleApi.haloHistory(chain, date);
    return {
      totalEntryCount: history.totalEntryCount,
      myRewards: history.myRewards.map((reward) => ({
        amount: reward.amountInUSDT,
        settledAt: reward.paidAt,
        txHash: reward.txHash ?? undefined,
      })),
      pools: history.pools.map((pool) => ({ amount: pool.amountInUSDT, winner: pool.winner })),
    };
  }

  const history = await raffleApi.worldHistory(date);
  return {
    totalEntryCount: history.totalEntryCount,
    myRewards: history.myRewards.map((reward) => ({
      amount: reward.amountInUSDC,
      settledAt: reward.claimedAt,
      claimUrl: reward.dropLink,
    })),
    pools: history.pools.map((pool) => ({ amount: pool.amountInUSDC, winner: pool.winner })),
  };
}
