import { relations } from 'drizzle-orm';
import { index, integer, jsonb, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { schema } from './schema';
import { receipts } from './receipts';

// The R2 object key for an image is the row id.
export const receiptImages = schema.table(
  'receipt_images',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    numOrder: integer('num_order').notNull(),
    receiptId: varchar('receipt_id', { length: 27 })
      .references(() => receipts.id, { onDelete: 'cascade' })
      .notNull(),

    // Synapse decentralized-storage upload and Fluence OCR are no longer part
    // of the pipeline, and no application code reads these columns. They stay
    // in the schema because the columns exist on the production table: drop
    // them here and drizzle-kit would generate a migration that destroys the
    // stored data.
    synapseUploadStartedAt: timestamp('synapse_upload_started_at', { withTimezone: true }),
    synapseUploadCompletedAt: timestamp('synapse_upload_completed_at', { withTimezone: true }),
    synapsePieceCid: varchar('synapse_piece_cid', { length: 255 }),
    synapseUploadError: text('synapse_upload_error'),

    fluenceOcrStartedAt: timestamp('fluence_ocr_started_at', { withTimezone: true }),
    fluenceOcrCompletedAt: timestamp('fluence_ocr_completed_at', { withTimezone: true }),
    fluenceOcrResult: jsonb('fluence_ocr_result'),
    fluenceOcrError: text('fluence_ocr_error'),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).$onUpdate(() => new Date()),
  },
  (table) => [
    // Looking up images by receipt_id (the lateral join on the receipt detail
    // view). The foreign key had no covering index, so every call scanned the
    // whole receipt_images table.
    index('receipt_images_receipt_id_idx').on(table.receiptId),
  ],
);

export const receiptImagesRelations = relations(receiptImages, ({ one }) => ({
  receipt: one(receipts, {
    fields: [receiptImages.receiptId],
    references: [receipts.id],
  }),
}));

export type ReceiptImage = typeof receiptImages.$inferSelect;
export type NewReceiptImage = typeof receiptImages.$inferInsert;
