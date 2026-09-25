import { relations } from 'drizzle-orm';
import { doublePrecision, integer, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { schema } from './schema';
import { users } from './users';
import { haloRafflePoolEntries } from './halo-raffle-pool-entries';

/**
 * One raffle round on the Halo side, paid out in USDT. Only the chains that
 * settle manually take part here, so this is narrower than `Platform`.
 */
export const HALO_RAFFLE_CHAINS = ['celo', 'kaia'] as const;
export type HaloRaffleChain = (typeof HALO_RAFFLE_CHAINS)[number];

export const haloRafflePools = schema.table('halo_raffle_pools', {
  id: uuid('id').primaryKey().defaultRandom(),
  chain: varchar('chain', { length: 20 }).$type<HaloRaffleChain>().notNull(),
  amountInUSDT: doublePrecision('amount_in_usdt').notNull(),
  pointPerEntry: integer('point_per_entry').notNull(),
  maxEntriesPerUser: integer('max_entries_per_user').notNull(),
  /** YYYY-MM-DD, in UTC. */
  utcDate: text('utc_date').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),

  totalEntryCount: integer('total_entry_count').notNull().default(0),
  winnerAddress: varchar('winner_address', { length: 255 }).references(() => users.address, {
    onDelete: 'restrict',
  }),

  // Paid out by hand — there is no Drop Protocol on these chains.
  manualPayoutTxHash: varchar('manual_payout_tx_hash', { length: 66 }),
  manualPayoutAt: timestamp('manual_payout_at', { withTimezone: true }),
});

export const haloRafflePoolsRelations = relations(haloRafflePools, ({ one, many }) => ({
  winner: one(users, {
    fields: [haloRafflePools.winnerAddress],
    references: [users.address],
  }),
  entries: many(haloRafflePoolEntries),
}));

export type HaloRafflePool = typeof haloRafflePools.$inferSelect;
export type NewHaloRafflePool = typeof haloRafflePools.$inferInsert;
