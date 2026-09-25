import { relations } from 'drizzle-orm';
import { boolean, index, integer, timestamp, varchar } from 'drizzle-orm/pg-core';
import { schema } from './schema';
import { users } from './users';
import type { Platform } from './enums';

export const haloEmailVerifications = schema.table(
  'halo_email_verifications',
  {
    id: varchar('id', { length: 27 }).primaryKey(), // KSUID
    chain: varchar('chain', { length: 20 }).$type<Platform>().notNull(),
    userAddress: varchar('user_address', { length: 255 })
      .references(() => users.address, { onDelete: 'cascade' })
      .notNull(),
    /** Max email length per RFC 5321. */
    email: varchar('email', { length: 320 }).notNull(),
    /** Cleared once the address is verified. */
    otpCode: varchar('otp_code', { length: 6 }),
    otpExpiresAt: timestamp('otp_expires_at', { withTimezone: true }),
    otpAttempts: integer('otp_attempts').default(0).notNull(),
    /** Used to enforce the resend cooldown. */
    otpSentAt: timestamp('otp_sent_at', { withTimezone: true }),
    isVerified: boolean('is_verified').default(false).notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  // Both indexes were created by hand on production and were never declared
  // here. Written down so the schema matches the database — and so staging,
  // which has neither of them, stops answering these lookups with a scan.
  (table) => [
    // "Is this email already verified on this chain?" — the uniqueness rule the
    // comment below says is enforced in the application.
    index('halo_email_verifications_email_chain_idx').on(
      table.email,
      table.chain,
      table.isVerified,
    ),
    // "Has this wallet verified an email on this chain?"
    index('halo_email_verifications_user_chain_idx').on(
      table.userAddress,
      table.chain,
      table.isVerified,
    ),
  ],
);

// Email uniqueness is enforced per chain in the application, not here:
// one verified email per user per chain.

export const haloEmailVerificationsRelations = relations(haloEmailVerifications, ({ one }) => ({
  user: one(users, {
    fields: [haloEmailVerifications.userAddress],
    references: [users.address],
  }),
}));

export type HaloEmailVerification = typeof haloEmailVerifications.$inferSelect;
export type NewHaloEmailVerification = typeof haloEmailVerifications.$inferInsert;
