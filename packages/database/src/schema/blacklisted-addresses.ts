import { text, timestamp, varchar } from 'drizzle-orm/pg-core';
import { schema } from './schema';

export const blacklistedAddresses = schema.table('blacklisted_addresses', {
  address: varchar('address', { length: 255 }).$type<`0x${string}`>().primaryKey(),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export type BlacklistedAddress = typeof blacklistedAddresses.$inferSelect;
export type NewBlacklistedAddress = typeof blacklistedAddresses.$inferInsert;
