import { relations } from 'drizzle-orm';
import { timestamp, varchar } from 'drizzle-orm/pg-core';
import { schema } from './schema';
import { kitoUsers } from './kito-users';

/**
 * Kito is no longer part of this codebase and no application code reads this
 * table, but it still exists in the production database with live rows. The
 * definition stays so the schema matches what is deployed and drizzle-kit does
 * not generate a migration that drops it.
 */
export const kitoPhoneVerifications = schema.table('kito_phone_verifications', {
  id: varchar('id', { length: 27 }).primaryKey(), // KSUID
  userAddress: varchar('user_address', { length: 255 })
    .references(() => kitoUsers.address, { onDelete: 'cascade' })
    .notNull()
    .unique(),
  /** E.164 format. */
  phoneNumber: varchar('phone_number', { length: 20 }).notNull().unique(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const kitoPhoneVerificationsRelations = relations(kitoPhoneVerifications, ({ one }) => ({
  user: one(kitoUsers, {
    fields: [kitoPhoneVerifications.userAddress],
    references: [kitoUsers.address],
  }),
}));

export type KitoPhoneVerification = typeof kitoPhoneVerifications.$inferSelect;
export type NewKitoPhoneVerification = typeof kitoPhoneVerifications.$inferInsert;
