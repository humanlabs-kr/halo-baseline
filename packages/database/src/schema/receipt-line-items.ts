import { relations } from 'drizzle-orm';
import { decimal, index, integer, text, timestamp, varchar } from 'drizzle-orm/pg-core';
import { schema } from './schema';
import { receipts } from './receipts';

/**
 * Where a line came from.
 *
 * - `vision` The analyzer read it off the image.
 * - `seed`   Generated so the app has something to render before the archive
 *            re-analysis finishes. Sums to the receipt's real total, under a
 *            real merchant, on a real date — only the split is synthetic.
 *
 * This column exists so that "is this number real?" is answerable in SQL rather
 * than from memory. The rule is about *whose* number it is, not about where it
 * is drawn:
 *
 * - **Anything said about other people filters on `source = 'vision'`.** The
 *   market median, the observation count, "shoppers paid X" — these are claims
 *   about strangers' receipts, and a seeded row is not one. `lib/market` is the
 *   only place that computes them, and it is the only place that needs the
 *   filter.
 * - **A user's own ledger shows their own rows, whatever the source.** Seeds
 *   exist so a demo wallet has a basket; filtering them out of that wallet's
 *   own history would leave the demo blank, which is the opposite of the
 *   point.
 *
 * An earlier version of this note said seeded rows "must never reach a price
 * series", which reads as a ban on the second case and is not what any of the
 * queries do.
 */
export const LINE_ITEM_SOURCES = ['vision', 'seed'] as const;
export type LineItemSource = (typeof LINE_ITEM_SOURCES)[number];

export const receiptLineItems = schema.table(
  'receipt_line_items',
  {
    id: varchar('id', { length: 27 }).primaryKey(), // KSUID

    receiptId: varchar('receipt_id', { length: 27 })
      .references(() => receipts.id, { onDelete: 'cascade' })
      .notNull(),

    /** Position on the receipt, top to bottom. Stable ordering for the UI. */
    lineNo: integer('line_no').notNull(),

    /** The line exactly as printed. Kept so a wrong classification is auditable. */
    rawText: text('raw_text').notNull(),

    /**
     * One of `ITEM_CATEGORIES`, or null when the line is outside the basket.
     *
     * Null is a normal outcome, not an error: most lines on a supermarket
     * receipt are outside a twelve-item basket. Those still count toward the
     * user's spend and are shown as "Not matched" rather than hidden, because a
     * ledger that quietly drops rows stops being a ledger.
     */
    category: text('category'),

    /** Quantity as printed, before unit conversion. */
    quantity: decimal('quantity', { precision: 12, scale: 3 }),
    /** Unit as printed (kg/g/l/ml/piece/pack/crate/loaf/sachet/tin). */
    unit: varchar('unit', { length: 10 }),

    /**
     * Price per canonical unit, already converted — see `CANONICAL_UNIT`.
     *
     * Null whenever the line could not be converted. This is the column the
     * index reads, so a null here is what keeps an unpriceable line out of a
     * public series.
     */
    unitPrice: decimal('unit_price', { precision: 15, scale: 4 }),

    /**
     * Line total as printed. Same width as `receipts.total_amount` for the same
     * reason: high-denomination currencies overflowed a narrower column.
     */
    lineTotal: decimal('line_total', { precision: 15, scale: 2 }),

    source: text('source').$type<LineItemSource>().notNull().default('vision'),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('receipt_line_items_receipt_id_idx').on(table.receiptId),

    // The index builder scans by category over a date range. Without this it
    // would sequentially scan every line ever extracted on each rebuild.
    index('receipt_line_items_category_idx').on(table.category),

    // Aggregates must be able to exclude seeded rows cheaply; putting source
    // first keeps the partial scan small on the `vision`-only queries.
    index('receipt_line_items_source_category_idx').on(table.source, table.category),
  ],
);

export const receiptLineItemsRelations = relations(receiptLineItems, ({ one }) => ({
  receipt: one(receipts, {
    fields: [receiptLineItems.receiptId],
    references: [receipts.id],
  }),
}));

export type ReceiptLineItem = typeof receiptLineItems.$inferSelect;
export type NewReceiptLineItem = typeof receiptLineItems.$inferInsert;
