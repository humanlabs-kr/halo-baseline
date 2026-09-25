import { relations } from 'drizzle-orm';
import { timestamp, varchar } from 'drizzle-orm/pg-core';
import { schema } from './schema';
import { humanfiUsers } from './humanfi-users';

/**
 * HumanFi is no longer part of this codebase and no application code reads
 * this table, but it still exists in the production database with live rows.
 * The definition stays so the schema matches what is deployed and drizzle-kit
 * does not generate a migration that drops it.
 */
export const humanfiPhoneVerifications = schema.table('humanfi_phone_verifications', {
  id: varchar('id', { length: 27 }).primaryKey(), // KSUID
  userAddress: varchar('user_address', { length: 255 })
    .references(() => humanfiUsers.address, { onDelete: 'cascade' })
    .notNull()
    .unique(),
  /** E.164 format. */
  phoneNumber: varchar('phone_number', { length: 20 }).notNull().unique(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const humanfiPhoneVerificationsRelations = relations(
  humanfiPhoneVerifications,
  ({ one }) => ({
    user: one(humanfiUsers, {
      fields: [humanfiPhoneVerifications.userAddress],
      references: [humanfiUsers.address],
    }),
  }),
);

export type HumanfiPhoneVerification = typeof humanfiPhoneVerifications.$inferSelect;
export type NewHumanfiPhoneVerification = typeof humanfiPhoneVerifications.$inferInsert;
