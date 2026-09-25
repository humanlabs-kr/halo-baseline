import { index, text, timestamp, varchar } from 'drizzle-orm/pg-core';
import { schema } from './schema';
import type { Platform, VerificationLevel } from './enums';

export const users = schema.table(
  'users',
  {
    platform: text('platform').$type<Platform>().notNull().default('world'),
    /** Lower-cased, normalized address. */
    address: varchar('address', { length: 255 }).$type<`0x${string}`>().primaryKey(),
    username: text('username').notNull(),
    profilePictureUrl: text('profile_picture_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).$onUpdate(() => new Date()),
    verificationLevel: text('verification_level')
      .$type<VerificationLevel>()
      .default('none')
      .notNull(),
    /** EIP-55 checksummed form of `address`, kept for display and onchain calls. */
    checksumAddress: varchar('checksum_address', { length: 255 })
      .default('')
      .$type<`0x${string}`>()
      .notNull(),
  },
  (table) => [
    // Stats and dashboard queries filter users by platform. Without this index the
    // primary key was the only one, so those queries fell back to a full scan.
    index('users_platform_idx').on(table.platform),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
