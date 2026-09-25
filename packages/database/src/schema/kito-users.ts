import { boolean, integer, timestamp, varchar } from 'drizzle-orm/pg-core';
import { schema } from './schema';

/**
 * Kito is no longer part of this codebase and no application code reads this
 * table, but it still exists in the production database with live rows. The
 * definition stays so the schema matches what is deployed and drizzle-kit does
 * not generate a migration that drops it.
 */
export const kitoUsers = schema.table('kito_users', {
  /** Lower-cased, normalized address. */
  address: varchar('address', { length: 255 }).$type<`0x${string}`>().primaryKey(),
  checksumAddress: varchar('checksum_address', { length: 255 })
    .$type<`0x${string}`>()
    .notNull(),

  /** Balance held offchain until the user settles it onchain. */
  offchainBalance: integer('offchain_balance').default(0).notNull(),

  isVerified: boolean('is_verified').default(false).notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  onChainVerified: boolean('on_chain_verified').default(false).notNull(),

  lastClaimTime: timestamp('last_claim_time', { withTimezone: true }),

  currentStreak: integer('current_streak').default(0).notNull(),
  longestStreak: integer('longest_streak').default(0).notNull(),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).$onUpdate(() => new Date()),
});

export type KitoUser = typeof kitoUsers.$inferSelect;
export type NewKitoUser = typeof kitoUsers.$inferInsert;
