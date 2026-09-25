import {
  and,
  count,
  desc,
  eq,
  isNull,
  rafflePoolEntries,
  rafflePools,
  sum,
  type Database,
} from '@halo/database';
import { parseUnits } from 'viem';
import { drawWeightedWinner } from '../weighted-draw';
import { DropService, dropConfigFromEnv } from './drop-service';

/**
 * Daily raffle rounds on World, paid out in USDC.
 *
 * Same shape as the Halo raffle, with one difference: the winner is handed a
 * claim link minted by the payout service rather than a manual transfer. When
 * no payout service is configured the winner is still recorded and the link
 * columns stay null.
 */

/** USDC has six decimals. */
const USDC_DECIMALS = 6;

/** Prize amounts are scaled down outside production so test runs cost nothing. */
const NON_PRODUCTION_PRIZE_DIVISOR = 100;

export interface RafflePoolConfig {
  amountInUSDC: number;
  pointPerEntry: number;
  maxEntriesPerUser: number;
}

/**
 * Tiered pools. The cheap tiers exist so a casual balance can enter at all; the
 * unlimited ones (`maxEntriesPerUser: -1`) are the sink for large balances.
 */
const WORLD_POOLS: RafflePoolConfig[] = [
  { amountInUSDC: 0.1, pointPerEntry: 10, maxEntriesPerUser: 3 },
  { amountInUSDC: 0.1, pointPerEntry: 10, maxEntriesPerUser: 3 },
  { amountInUSDC: 0.1, pointPerEntry: 10, maxEntriesPerUser: 3 },
  { amountInUSDC: 0.1, pointPerEntry: 10, maxEntriesPerUser: 3 },
  { amountInUSDC: 0.1, pointPerEntry: 15, maxEntriesPerUser: -1 },
  { amountInUSDC: 0.25, pointPerEntry: 20, maxEntriesPerUser: 5 },
  { amountInUSDC: 0.25, pointPerEntry: 20, maxEntriesPerUser: 5 },
  { amountInUSDC: 0.5, pointPerEntry: 45, maxEntriesPerUser: 5 },
  { amountInUSDC: 0.5, pointPerEntry: 45, maxEntriesPerUser: 5 },
  { amountInUSDC: 1, pointPerEntry: 90, maxEntriesPerUser: 5 },
  { amountInUSDC: 2, pointPerEntry: 150, maxEntriesPerUser: -1 },
];

export const RaffleService = {
  getRaffleConfig(projectEnv: Env['PROJECT_ENV']): RafflePoolConfig[] {
    if (projectEnv === 'production') {
      return WORLD_POOLS;
    }

    return WORLD_POOLS.map((pool) => ({
      ...pool,
      amountInUSDC: pool.amountInUSDC / NON_PRODUCTION_PRIZE_DIVISOR,
    }));
  },

  /** Opens today's pools. Run after `closeRafflePools`, never before. */
  async createNewRafflePools(db: Database, projectEnv: Env['PROJECT_ENV']): Promise<number> {
    const utcDate = new Date().toISOString().slice(0, 10);
    const pools = this.getRaffleConfig(projectEnv);

    await db.insert(rafflePools).values(pools.map((pool) => ({ ...pool, utcDate })));

    return pools.length;
  },

  /**
   * Draws a winner for every open pool of a day and mints a payout link.
   *
   * @param utcDate Defaults to the most recent day that has pools, which is
   *   what the cron wants: it runs just after midnight and settles the day that
   *   has only now ended.
   */
  async closeRafflePools(db: Database, env: Env, utcDate?: string): Promise<number> {
    const poolCount = await db
      .select({ count: count() })
      .from(rafflePools)
      .then((rows) => rows[0]?.count ?? 0);

    // Nothing has ever been created — first run, not an error.
    if (poolCount === 0) {
      return 0;
    }

    let targetDate = utcDate;

    if (!targetDate) {
      const latestPool = await db.query.rafflePools.findFirst({
        orderBy: [desc(rafflePools.utcDate)],
      });

      if (!latestPool) {
        return 0;
      }

      targetDate = latestPool.utcDate;
    }

    const poolsToClose = await db.query.rafflePools.findMany({
      where: and(eq(rafflePools.utcDate, targetDate), isNull(rafflePools.winnerAddress)),
    });

    const dropConfig = dropConfigFromEnv(env);
    const dropService = dropConfig ? new DropService(dropConfig) : null;

    let closed = 0;

    for (const pool of poolsToClose) {
      const entries = await db
        .select({
          userAddress: rafflePoolEntries.userAddress,
          entryCount: sum(rafflePoolEntries.entryCount),
        })
        .from(rafflePoolEntries)
        .where(eq(rafflePoolEntries.rafflePoolId, pool.id))
        .groupBy(rafflePoolEntries.userAddress);

      const winnerAddress = drawWeightedWinner(entries);

      // No entries: the pool simply expires unclaimed.
      if (!winnerAddress) {
        continue;
      }

      // The winner is written even if the link cannot be minted, so a payout
      // service outage costs a claim link and not the draw itself.
      const link = dropService
        ? await mintPayoutLink(dropService, winnerAddress, pool.amountInUSDC, pool.utcDate)
        : null;

      await db
        .update(rafflePools)
        .set({
          winnerAddress,
          dropLink: link?.worldAppDeepLink ?? null,
          dropLinkBase58Id: link?.base58Id ?? null,
        })
        .where(eq(rafflePools.id, pool.id));

      closed += 1;
    }

    return closed;
  },
};

async function mintPayoutLink(
  dropService: DropService,
  winnerAddress: string,
  amountInUSDC: number,
  utcDate: string,
) {
  try {
    return await dropService.createLink({
      amount: parseUnits(amountInUSDC.toString(), USDC_DECIMALS).toString(),
      receiver: winnerAddress,
      title: `Halo Raffle (${utcDate}) Winner`,
    });
  } catch (error) {
    console.error('Failed to mint raffle payout link:', error);
    return null;
  }
}
