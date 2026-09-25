import { relations } from 'drizzle-orm';
import { index, integer, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { schema } from './schema';
import { users } from './users';
import { haloRafflePools } from './halo-raffle-pools';

export const haloRafflePoolEntries = schema.table(
  'halo_raffle_pool_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    rafflePoolId: uuid('raffle_pool_id')
      .references(() => haloRafflePools.id, { onDelete: 'restrict' })
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
    // (= or IN) and then on the user. The foreign key had no covering index, so
    // this hot path scanned all 270k rows on every call.
    index('halo_raffle_pool_entries_pool_user_idx').on(table.rafflePoolId, table.userAddress),
  ],
);

export const haloRafflePoolEntriesRelations = relations(haloRafflePoolEntries, ({ one }) => ({
  user: one(users, {
    fields: [haloRafflePoolEntries.userAddress],
    references: [users.address],
  }),
  rafflePool: one(haloRafflePools, {
    fields: [haloRafflePoolEntries.rafflePoolId],
    references: [haloRafflePools.id],
  }),
}));

export type HaloRafflePoolEntry = typeof haloRafflePoolEntries.$inferSelect;
export type NewHaloRafflePoolEntry = typeof haloRafflePoolEntries.$inferInsert;
