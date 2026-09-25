import { relations } from 'drizzle-orm';
import { index, integer, numeric, text, timestamp, varchar } from 'drizzle-orm/pg-core';
import { schema } from './schema';
import { humanfiUsers } from './humanfi-users';
import { humanfiPointLogs } from './humanfi-point-logs';

/**
 * HumanFi is no longer part of this codebase and no application code reads
 * this table, but it still exists in the production database with live rows.
 * The definition stays so the schema matches what is deployed and drizzle-kit
 * does not generate a migration that drops it.
 */

/** Lifecycle of a swap, from submission to the receipt landing onchain. */
export const HUMANFI_SWAP_STATUSES = ['pending', 'confirmed', 'failed'] as const;
export type HumanfiSwapStatus = (typeof HUMANFI_SWAP_STATUSES)[number];

export const humanfiSwaps = schema.table(
  'humanfi_swaps',
  {
    id: varchar('id', { length: 27 }).primaryKey(), // KSUID
    userAddress: varchar('user_address', { length: 255 })
      .references(() => humanfiUsers.address, { onDelete: 'cascade' })
      .notNull(),

    // Token in.
    tokenInAddress: varchar('token_in_address', { length: 255 }).notNull(),
    tokenInSymbol: varchar('token_in_symbol', { length: 32 }).notNull(),
    /** Amount in wei. */
    tokenInAmount: numeric('token_in_amount', { precision: 78, scale: 0 }).notNull(),

    // Token out.
    tokenOutAddress: varchar('token_out_address', { length: 255 }).notNull(),
    tokenOutSymbol: varchar('token_out_symbol', { length: 32 }).notNull(),
    /** Amount in wei. */
    tokenOutAmount: numeric('token_out_amount', { precision: 78, scale: 0 }).notNull(),

    // Transaction.
    txHash: varchar('tx_hash', { length: 66 }),
    status: text('status').$type<HumanfiSwapStatus>().notNull().default('pending'),

    /** Gas fee from the transaction receipt, always in CELO wei. */
    gasFeeAmount: numeric('gas_fee_amount', { precision: 78, scale: 0 }),
    /** Always "CELO". */
    gasFeeSymbol: varchar('gas_fee_symbol', { length: 32 }),
    /** Fee-abstraction token, e.g. "USDT". Null when the fee was paid in CELO. */
    gasFeePaidWith: varchar('gas_fee_paid_with', { length: 32 }),

    // Points awarded for this swap, linked to the point log that recorded them.
    pointsAwarded: integer('points_awarded').default(0).notNull(),
    pointLogId: varchar('point_log_id', { length: 27 }).references(() => humanfiPointLogs.id, {
      onDelete: 'set null',
    }),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).$onUpdate(() => new Date()),
  },
  (table) => [
    index('humanfi_swaps_user_address_idx').on(table.userAddress),
    index('humanfi_swaps_tx_hash_idx').on(table.txHash),
    index('humanfi_swaps_status_idx').on(table.status),
    index('humanfi_swaps_created_at_idx').on(table.createdAt.desc()),
  ],
);

export const humanfiSwapsRelations = relations(humanfiSwaps, ({ one }) => ({
  user: one(humanfiUsers, {
    fields: [humanfiSwaps.userAddress],
    references: [humanfiUsers.address],
  }),
  pointLog: one(humanfiPointLogs, {
    fields: [humanfiSwaps.pointLogId],
    references: [humanfiPointLogs.id],
  }),
}));

export type HumanfiSwap = typeof humanfiSwaps.$inferSelect;
export type NewHumanfiSwap = typeof humanfiSwaps.$inferInsert;
