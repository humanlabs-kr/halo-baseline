import {
  and,
  count,
  desc,
  eq,
  haloRafflePoolEntries,
  haloRafflePools,
  isNull,
  sum,
  type Database,
  type HaloRaffleChain,
} from '@halo/database';
import { drawWeightedWinner } from './weighted-draw';

/**
 * Daily raffle rounds for the chains that settle by hand (Celo, Kaia).
 *
 * A round is a pool: users spend points to buy entries, and at UTC midnight one
 * entry is drawn per pool. Prizes are recorded against the pool and paid out
 * separately — there is no payout link on these chains.
 *
 * `db` and `projectEnv` are arguments rather than a module-level
 * `cloudflare:workers` import so the same code runs from a request (where the
 * connection already exists on the context) and from the cron handler.
 */

/** Prize amounts are scaled down outside production so test runs cost nothing. */
const NON_PRODUCTION_PRIZE_DIVISOR = 100;

export interface RafflePoolConfig {
  amountInUSDT: number;
  pointPerEntry: number;
  maxEntriesPerUser: number;
}

/**
 * Tiered pools. Cheap tiers exist so a casual user can enter at all; the
 * unlimited ones (`maxEntriesPerUser: -1`) act as a sink for large balances.
 */
const CELO_POOLS: RafflePoolConfig[] = [
  { amountInUSDT: 0.05, pointPerEntry: 5, maxEntriesPerUser: 2 },
  { amountInUSDT: 0.05, pointPerEntry: 5, maxEntriesPerUser: 2 },
  { amountInUSDT: 0.05, pointPerEntry: 5, maxEntriesPerUser: 2 },
  { amountInUSDT: 0.05, pointPerEntry: 5, maxEntriesPerUser: 2 },
  { amountInUSDT: 0.05, pointPerEntry: 5, maxEntriesPerUser: 2 },
  { amountInUSDT: 0.05, pointPerEntry: 5, maxEntriesPerUser: 2 },
  { amountInUSDT: 0.05, pointPerEntry: 5, maxEntriesPerUser: 2 },
  { amountInUSDT: 0.05, pointPerEntry: 5, maxEntriesPerUser: 2 },
  { amountInUSDT: 0.05, pointPerEntry: 5, maxEntriesPerUser: 2 },
  { amountInUSDT: 0.05, pointPerEntry: 7, maxEntriesPerUser: -1 },
  { amountInUSDT: 0.1, pointPerEntry: 10, maxEntriesPerUser: 3 },
  { amountInUSDT: 0.1, pointPerEntry: 10, maxEntriesPerUser: 3 },
  { amountInUSDT: 0.1, pointPerEntry: 10, maxEntriesPerUser: 3 },
  { amountInUSDT: 0.1, pointPerEntry: 10, maxEntriesPerUser: 3 },
  { amountInUSDT: 0.1, pointPerEntry: 12, maxEntriesPerUser: -1 },
  { amountInUSDT: 0.25, pointPerEntry: 20, maxEntriesPerUser: 5 },
  { amountInUSDT: 0.25, pointPerEntry: 20, maxEntriesPerUser: 5 },
  { amountInUSDT: 0.25, pointPerEntry: 20, maxEntriesPerUser: 5 },
  { amountInUSDT: 0.25, pointPerEntry: 20, maxEntriesPerUser: 5 },
  { amountInUSDT: 0.5, pointPerEntry: 45, maxEntriesPerUser: 5 },
  { amountInUSDT: 0.5, pointPerEntry: 45, maxEntriesPerUser: 5 },
  { amountInUSDT: 1, pointPerEntry: 90, maxEntriesPerUser: -1 },
];

const KAIA_POOLS: RafflePoolConfig[] = [
  { amountInUSDT: 0.1, pointPerEntry: 10, maxEntriesPerUser: 3 },
  { amountInUSDT: 0.25, pointPerEntry: 20, maxEntriesPerUser: 5 },
  { amountInUSDT: 0.5, pointPerEntry: 45, maxEntriesPerUser: 5 },
  { amountInUSDT: 1, pointPerEntry: 90, maxEntriesPerUser: 5 },
];

export const HaloRaffleService = {
  getRaffleConfig(chain: HaloRaffleChain, projectEnv: Env['PROJECT_ENV']): RafflePoolConfig[] {
    const pools = chain === 'celo' ? CELO_POOLS : KAIA_POOLS;

    if (projectEnv === 'production') {
      return pools;
    }

    return pools.map((pool) => ({
      ...pool,
      amountInUSDT: pool.amountInUSDT / NON_PRODUCTION_PRIZE_DIVISOR,
    }));
  },

  /** Opens today's pools. Run after `closeRafflePools`, never before. */
  async createNewRafflePools(
    db: Database,
    chain: HaloRaffleChain,
    projectEnv: Env['PROJECT_ENV'],
  ): Promise<number> {
    const utcDate = new Date().toISOString().slice(0, 10);
    const pools = this.getRaffleConfig(chain, projectEnv);

    await db.insert(haloRafflePools).values(pools.map((pool) => ({ ...pool, chain, utcDate })));

    return pools.length;
  },

  /**
   * Draws a winner for every open pool of a day.
   *
   * @param utcDate Defaults to the most recent day that has pools, which is
   *   what the cron wants: it runs just after midnight and settles the day that
   *   has only now ended.
   */
  async closeRafflePools(
    db: Database,
    chain: HaloRaffleChain,
    utcDate?: string,
  ): Promise<{ winnerAddress: string; amountInUSDT: number }[]> {
    const poolCount = await db
      .select({ count: count() })
      .from(haloRafflePools)
      .where(eq(haloRafflePools.chain, chain))
      .then((rows) => rows[0]?.count ?? 0);

    // Nothing has ever been created for this chain — first run, not an error.
    if (poolCount === 0) {
      return [];
    }

    let targetDate = utcDate;

    if (!targetDate) {
      const latestPool = await db.query.haloRafflePools.findFirst({
        where: eq(haloRafflePools.chain, chain),
        orderBy: [desc(haloRafflePools.utcDate)],
      });

      if (!latestPool) {
        return [];
      }

      targetDate = latestPool.utcDate;
    }

    const poolsToClose = await db.query.haloRafflePools.findMany({
      where: and(
        eq(haloRafflePools.chain, chain),
        eq(haloRafflePools.utcDate, targetDate),
        isNull(haloRafflePools.winnerAddress),
      ),
    });

    const winners: { winnerAddress: string; amountInUSDT: number }[] = [];

    for (const pool of poolsToClose) {
      const entries = await db
        .select({
          userAddress: haloRafflePoolEntries.userAddress,
          entryCount: sum(haloRafflePoolEntries.entryCount),
        })
        .from(haloRafflePoolEntries)
        .where(eq(haloRafflePoolEntries.rafflePoolId, pool.id))
        .groupBy(haloRafflePoolEntries.userAddress);

      const winnerAddress = drawWeightedWinner(entries);

      // No entries: the pool simply expires unclaimed.
      if (!winnerAddress) {
        continue;
      }

      await db
        .update(haloRafflePools)
        .set({ winnerAddress })
        .where(eq(haloRafflePools.id, pool.id));

      winners.push({ winnerAddress, amountInUSDT: pool.amountInUSDT });
    }

    return winners;
  },
};
