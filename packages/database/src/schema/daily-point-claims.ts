import { relations } from 'drizzle-orm';
import { date, index, integer, timestamp, unique, varchar } from 'drizzle-orm/pg-core';
import { schema } from './schema';
import { users } from './users';
import { pointLogs } from './point-logs';

export const dailyPointClaims = schema.table(
  'daily_point_claims',
  {
    id: varchar('id', { length: 27 }).primaryKey(), // KSUID
    userAddress: varchar('user_address', { length: 255 })
      .references(() => users.address, { onDelete: 'cascade' })
      .notNull(),
    /** Calendar date in UTC. */
    claimDate: date('claim_date', { mode: 'date' }).notNull(),
    claimedPoint: integer('claimed_point').notNull(),
    pointLogId: varchar('point_log_id', { length: 27 })
      .references(() => pointLogs.id, { onDelete: 'restrict' })
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('daily_point_claims_user_address_idx').on(table.userAddress),
    index('daily_point_claims_claim_date_idx').on(table.claimDate),
    unique('daily_point_claims_user_date_unique').on(table.userAddress, table.claimDate),
  ],
);

export const dailyPointClaimsRelations = relations(dailyPointClaims, ({ one }) => ({
  user: one(users, {
    fields: [dailyPointClaims.userAddress],
    references: [users.address],
  }),
  pointLog: one(pointLogs, {
    fields: [dailyPointClaims.pointLogId],
    references: [pointLogs.id],
  }),
}));

export type DailyPointClaim = typeof dailyPointClaims.$inferSelect;
export type NewDailyPointClaim = typeof dailyPointClaims.$inferInsert;
