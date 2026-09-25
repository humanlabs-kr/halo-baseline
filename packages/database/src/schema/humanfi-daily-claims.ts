import { relations } from 'drizzle-orm';
import { date, index, integer, timestamp, unique, varchar } from 'drizzle-orm/pg-core';
import { schema } from './schema';
import { humanfiUsers } from './humanfi-users';
import { humanfiPointLogs } from './humanfi-point-logs';

/**
 * HumanFi is no longer part of this codebase and no application code reads
 * this table, but it still exists in the production database with live rows.
 * The definition stays so the schema matches what is deployed and drizzle-kit
 * does not generate a migration that drops it.
 */
export const humanfiDailyClaims = schema.table(
  'humanfi_daily_claims',
  {
    id: varchar('id', { length: 27 }).primaryKey(), // KSUID
    userAddress: varchar('user_address', { length: 255 })
      .references(() => humanfiUsers.address, { onDelete: 'cascade' })
      .notNull(),
    /** Calendar date in UTC. */
    claimDate: date('claim_date', { mode: 'date' }).notNull(),
    /** Position in the streak this claim landed on (1-7+). */
    streakDay: integer('streak_day').notNull(),
    pointsClaimed: integer('points_claimed').notNull(),
    pointLogId: varchar('point_log_id', { length: 27 })
      .references(() => humanfiPointLogs.id, { onDelete: 'restrict' })
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('humanfi_daily_claims_user_address_idx').on(table.userAddress),
    index('humanfi_daily_claims_claim_date_idx').on(table.claimDate),
    unique('humanfi_daily_claims_user_date_unique').on(table.userAddress, table.claimDate),
  ],
);

export const humanfiDailyClaimsRelations = relations(humanfiDailyClaims, ({ one }) => ({
  user: one(humanfiUsers, {
    fields: [humanfiDailyClaims.userAddress],
    references: [humanfiUsers.address],
  }),
  pointLog: one(humanfiPointLogs, {
    fields: [humanfiDailyClaims.pointLogId],
    references: [humanfiPointLogs.id],
  }),
}));

export type HumanfiDailyClaim = typeof humanfiDailyClaims.$inferSelect;
export type NewHumanfiDailyClaim = typeof humanfiDailyClaims.$inferInsert;
