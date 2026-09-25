CREATE INDEX IF NOT EXISTS "receipts_user_address_created_at_idx" ON "receipto"."receipts" USING btree ("user_address","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "receipt_images_receipt_id_idx" ON "receipto"."receipt_images" USING btree ("receipt_id");
