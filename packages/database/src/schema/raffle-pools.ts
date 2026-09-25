import { relations } from 'drizzle-orm';
import { doublePrecision, integer, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { schema } from './schema';
import { users } from './users';
import { rafflePoolEntries } from './raffle-pool-entries';

/** One raffle round, paid out in USDC through a Drop Protocol link. */
export const rafflePools = schema.table('raffle_pools', {
  id: uuid('id').primaryKey().defaultRandom(),
  amountInUSDC: doublePrecision('amount_in_usdc').notNull(),
  pointPerEntry: integer('point_per_entry').notNull(),
  maxEntriesPerUser: integer('max_entries_per_user').notNull(),
  /** YYYY-MM-DD, in UTC. */
  utcDate: text('utc_date').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),

  totalEntryCount: integer('total_entry_count').notNull().default(0),
  winnerAddress: varchar('winner_address', { length: 255 }).references(() => users.address, {
    onDelete: 'restrict',
  }),
  dropLink: text('drop_link'),
  dropLinkBase58Id: varchar('drop_link_base58_id', { length: 255 }),

  claimedAt: timestamp('claimed_at', { withTimezone: true }),
});

export const rafflePoolsRelations = relations(rafflePools, ({ one, many }) => ({
  winner: one(users, {
    fields: [rafflePools.winnerAddress],
    references: [users.address],
  }),
  entries: many(rafflePoolEntries),
}));

export type RafflePool = typeof rafflePools.$inferSelect;
export type NewRafflePool = typeof rafflePools.$inferInsert;
