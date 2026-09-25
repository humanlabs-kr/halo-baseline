import { relations } from 'drizzle-orm';
import { index, integer, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { schema } from './schema';
import { users } from './users';
import { rafflePools } from './raffle-pools';

export const rafflePoolEntries = schema.table(
  'raffle_pool_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    rafflePoolId: uuid('raffle_pool_id')
      .references(() => rafflePools.id, { onDelete: 'restrict' })
      .notNull(),
    userAddress: varchar('user_address', { length: 255 })
      .references(() => users.address, { onDelete: 'restrict' })
      .notNull(),
    entryCount: integer('entry_count').notNull(),
    pointSpent: integer('point_spent').notNull(),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => [
    // sum(entry_count) and the per-user lookups both filter on raffle_pool_id
    // (= or IN) and then on the user.
    index('raffle_pool_entries_pool_user_idx').on(table.rafflePoolId, table.userAddress),
  ],
);

export const rafflePoolEntriesRelations = relations(rafflePoolEntries, ({ one }) => ({
  user: one(users, {
    fields: [rafflePoolEntries.userAddress],
    references: [users.address],
  }),
  rafflePool: one(rafflePools, {
    fields: [rafflePoolEntries.rafflePoolId],
    references: [rafflePools.id],
  }),
}));

export type RafflePoolEntry = typeof rafflePoolEntries.$inferSelect;
export type NewRafflePoolEntry = typeof rafflePoolEntries.$inferInsert;
