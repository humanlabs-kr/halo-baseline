import { relations } from 'drizzle-orm';
import { integer, jsonb, text, timestamp, varchar } from 'drizzle-orm/pg-core';
import { schema } from './schema';
import { users } from './users';
import type { VerificationLevel } from './enums';

export const pointClaims = schema.table('point_claims', {
  id: varchar('id', { length: 27 }).primaryKey(), // KSUID
  userAddress: varchar('user_address', { length: 255 })
    .references(() => users.address, { onDelete: 'cascade' })
    .notNull(),

  // World Miniapp verification result, stored as returned by the proof check.
  signal: text('signal').notNull().default(''),
  action: text('action').notNull().default(''),
  merkle_root: text('merkle_root').notNull().default(''),
  nullifier_hash: text('nullifier_hash').notNull().default(''),
  signal_hash: text('signal_hash').notNull().default(''),
  verification_level: text('verification_level')
    .$type<VerificationLevel>()
    .notNull()
    .default('none'),
  proof: text('proof').notNull().default(''),
  // End of the World Miniapp verification result.

  totalAmount: integer('total_amount').notNull(),
  /** Receipts settled by this claim, kept for the record. */
  receiptIds: jsonb('receipt_ids').$type<string[]>().notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const pointClaimsRelations = relations(pointClaims, ({ one }) => ({
  user: one(users, {
    fields: [pointClaims.userAddress],
    references: [users.address],
  }),
}));

export type PointClaim = typeof pointClaims.$inferSelect;
export type NewPointClaim = typeof pointClaims.$inferInsert;
