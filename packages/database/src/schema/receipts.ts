import { relations } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { decimal, index, integer, text, timestamp, varchar } from 'drizzle-orm/pg-core';
import { schema } from './schema';
import { users } from './users';
import { receiptImages } from './receipt-images';
import { receiptLineItems } from './receipt-line-items';
import { pointLogs } from './point-logs';

/**
 * Receipt lifecycle. Mirrors `RECEIPT_STATUSES` in `@halo/contracts`.
 *
 * - `pending`          Queued for AI analysis the moment the receipt is scanned.
 * - `rejected`         The analyzer scored it 30 or below, or one of the three
 *                      required fields is missing (when / total amount / where).
 *                      The purchase must also be no more than a week old.
 * - `claimable`        Scored above 30 and all three required fields were found.
 * - `claimed`          The user completed the claim (verify) by hand from the
 *                      history screen.
 * - `rejected-claimed` Only the participation reward was claimed, on a receipt
 *                      that had been rejected.
 */
export const RECEIPT_STATUSES = [
  'pending',
  'rejected',
  'claimable',
  'claimed',
  'rejected-claimed',
] as const;

export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

/**
 * Why a receipt was rejected.
 *
 * `status` says a scan did not count; it does not say what to do differently,
 * and those are five different pieces of advice. Without this column the app
 * could only guess from the fields that came back, which reads fine for a
 * blurry photo and tells someone holding a sharp, complete, two-week-old
 * receipt to photograph it again — the one action that cannot help them.
 *
 * - `unreadable`  Scored at or below the quality threshold.
 * - `no-merchant` No shop name on it.
 * - `no-total`    No total, or one too large to store.
 * - `too-old`     A purchase older than the window we pay for.
 * - `duplicate`   Same wallet, same purchase timestamp: photographed twice.
 *
 * Null on every receipt settled before this column existed, and on every
 * receipt that was not rejected.
 *
 * Mirrors `REJECTION_REASONS` in `@halo/contracts`, the same way
 * `RECEIPT_STATUSES` above does. The mini app reads this value and must not
 * depend on a package that carries a Postgres driver.
 */
export const REJECTION_REASONS = [
  'not-a-receipt',
  'unreadable',
  'no-merchant',
  'no-total',
  'no-date',
  'too-old',
  'duplicate',
] as const;

export type RejectionReason = (typeof REJECTION_REASONS)[number];

export const receipts = schema.table(
  'receipts',
  {
    id: varchar('id', { length: 27 }).primaryKey(), // KSUID

    userAddress: varchar('user_address', { length: 255 })
      .references(() => users.address, { onDelete: 'restrict' })
      .notNull(),

    status: varchar('status', { length: 20 })
      .$type<ReceiptStatus>()
      .default('pending')
      .notNull(),

    assignedPoint: integer('assigned_point').notNull().default(0),

    rejectionReason: text('rejection_reason').$type<RejectionReason>(),

    merchantName: text('merchant_name'),
    issuedAt: timestamp('issued_at', { withTimezone: true }),
    countryCode: varchar('country_code', { length: 10 }),
    currency: varchar('currency', { length: 10 }),
    /**
     * numeric(15, 2) — up to 9,999,999,999,999.99.
     *
     * Was numeric(10, 2), which caps at 99,999,999.99, and receipts in
     * high-denomination currencies sat right under that ceiling: TZS reached
     * 89M and IDR 83M, at 89% and 83% of the old limit. Anything past it threw
     * `numeric field overflow` *after* the vision model had already read the
     * receipt, so the write failed and the receipt was never settled.
     *
     * 15 rather than something larger because the value is a JS `number` at
     * both ends of this pipeline — the model returns one and the mini app
     * formats one — and `Number.MAX_SAFE_INTEGER` is ~9.007e15. A column wider
     * than that would accept values the rest of the system cannot represent
     * exactly. This leaves roughly 100,000x headroom over the largest amount
     * ever recorded.
     */
    totalAmount: decimal('total_amount', { precision: 15, scale: 2 }),
    paymentMethod: text('payment_method'),
    qualityRate: integer('quality_rate'),

    analysisStartedAt: timestamp('analysis_started_at', { withTimezone: true }),
    analysisCompletedAt: timestamp('analysis_completed_at', { withTimezone: true }),
    analysisError: text('analysis_error'),

    pointLogId: varchar('point_log_id', { length: 27 }).references(() => pointLogs.id, {
      onDelete: 'restrict',
    }),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).$onUpdate(() => new Date()),
  },
  (table) => [
    // Hot path: filter by user_address, then sort or range over created_at
    // (balance sum / count over a period / history list). The primary key on id
    // was the only index, so every one of those calls scanned the whole table.
    // The user_address prefix also covers the status and issued_at filters.
    index('receipts_user_address_created_at_idx').on(table.userAddress, table.createdAt.desc()),
    // Full ordering for the admin receipt list
    // (order by analysis_completed_at desc nulls last, id). Matching the index
    // order to the query removes a multi-gigabyte sort spill.
    index('receipts_analysis_completed_at_id_idx').on(
      table.analysisCompletedAt.desc().nullsLast(),
      table.id,
    ),
    // The sweeper asks "what is still pending?" every fifteen minutes, and
    // status had no index at all — that question was a sequential scan of every
    // receipt ever uploaded. Partial because pending is a state a receipt
    // passes through in seconds: the index stays a few pages wide no matter how
    // large the table grows, and it only has to be maintained for the handful
    // of rows currently in flight.
    index('receipts_pending_created_at_idx')
      .on(table.createdAt)
      .where(sql`${table.status} = 'pending'`),
    // Covers the claimable-balance query in `routes/client/point.ts`, which
    // sums `assigned_point` for one wallet across two statuses.
    //
    // This index was created by hand on production and existed for months
    // without ever being declared here — `db:push` against that database would
    // have dropped it. It is written down now so the schema and the database
    // agree.
    //
    // Production additionally carries `INCLUDE (assigned_point)`, which makes
    // the sum index-only. Drizzle 0.43 cannot express an INCLUDE payload, so
    // the migration SQL beside this file spells it out and is the more precise
    // of the two definitions.
    index('receipts_user_status_point_idx').on(table.userAddress, table.status),
  ],
);

export const receiptsRelations = relations(receipts, ({ one, many }) => ({
  user: one(users, {
    fields: [receipts.userAddress],
    references: [users.address],
  }),
  images: many(receiptImages),
  lineItems: many(receiptLineItems),
}));

export type Receipt = typeof receipts.$inferSelect;
export type NewReceipt = typeof receipts.$inferInsert;
