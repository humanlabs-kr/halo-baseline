import { integer, timestamp, varchar } from 'drizzle-orm/pg-core';
import { schema } from './schema';

/**
 * HumanFi is no longer part of this codebase and no application code reads
 * this table, but it still exists in the production database with live rows.
 * The definition stays so the schema matches what is deployed and drizzle-kit
 * does not generate a migration that drops it.
 */
export const humanfiUsers = schema.table('humanfi_users', {
  /** Lower-cased, normalized address. */
  address: varchar('address', { length: 255 }).$type<`0x${string}`>().primaryKey(),
  checksumAddress: varchar('checksum_address', { length: 255 })
    .$type<`0x${string}`>()
    .notNull(),

  // Points balance, cached from humanfi_point_logs.
  pointsBalance: integer('points_balance').default(0).notNull(),
  pointsAccumulated: integer('points_accumulated').default(0).notNull(),

  // Streak tracking.
  currentStreak: integer('current_streak').default(0).notNull(),
  longestStreak: integer('longest_streak').default(0).notNull(),
  lastClaimDate: timestamp('last_claim_date', { withTimezone: true }),

  // Stats.
  totalSwaps: integer('total_swaps').default(0).notNull(),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).$onUpdate(() => new Date()),
});

export type HumanfiUser = typeof humanfiUsers.$inferSelect;
export type NewHumanfiUser = typeof humanfiUsers.$inferInsert;
