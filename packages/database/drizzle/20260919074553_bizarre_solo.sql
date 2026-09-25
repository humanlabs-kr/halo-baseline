-- `IF NOT EXISTS` is deliberate. Building this index takes a full scan of
-- `receipts` under an ACCESS EXCLUSIVE lock, which on the production table
-- stalls every upload for the duration. The index is created by hand with
-- CREATE INDEX CONCURRENTLY ahead of the release, so this statement is a
-- no-op there and still correct for a fresh database.
CREATE INDEX IF NOT EXISTS "receipts_pending_created_at_idx" ON "receipto"."receipts" USING btree ("created_at") WHERE "receipto"."receipts"."status" = 'pending';
