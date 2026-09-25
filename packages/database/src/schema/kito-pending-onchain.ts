import { integer, text, timestamp, varchar } from 'drizzle-orm/pg-core';
import { schema } from './schema';

/**
 * Kito is no longer part of this codebase and no application code reads this
 * table, but it still exists in the production database with live rows. The
 * definition stays so the schema matches what is deployed and drizzle-kit does
 * not generate a migration that drops it.
 *
 * Queue of users whose onchain verification has not settled yet. One row per
 * address, so the address is the primary key.
 */
export const kitoPendingOnchain = schema.table('kito_pending_onchain', {
  userAddress: varchar('user_address', { length: 255 }).primaryKey(),
  status: varchar('status', { length: 20 }).notNull(),
  retryCount: integer('retry_count').default(0).notNull(),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type KitoPendingOnchain = typeof kitoPendingOnchain.$inferSelect;
export type NewKitoPendingOnchain = typeof kitoPendingOnchain.$inferInsert;
