import { integer, timestamp, varchar } from 'drizzle-orm/pg-core';
import { schema } from './schema';

/**
 * Kito is no longer part of this codebase and no application code reads this
 * table, but it still exists in the production database with live rows. The
 * definition stays so the schema matches what is deployed and drizzle-kit does
 * not generate a migration that drops it.
 */
export const kitoClaims = schema.table('kito_claims', {
  id: varchar('id', { length: 27 }).primaryKey(), // KSUID
  userAddress: varchar('user_address', { length: 255 }).notNull(),
  amount: integer('amount').notNull(),
  type: varchar('type', { length: 20 }).notNull(),
  txHash: varchar('tx_hash', { length: 66 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export type KitoClaim = typeof kitoClaims.$inferSelect;
export type NewKitoClaim = typeof kitoClaims.$inferInsert;
