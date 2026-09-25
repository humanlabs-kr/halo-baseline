-- Three indexes that production has had for months and the schema never did.
-- They were created by hand against the live database; this migration is the
-- moment they become declared, so staging (which has none of them) gets them
-- too and `db:push` can no longer drop them.
--
-- `IF NOT EXISTS` on every statement: on production each one already exists and
-- must stay exactly as it is, while a fresh database still gets the full set.
--
-- The INCLUDE payload below is deliberate and is NOT what `drizzle-kit`
-- generated. Drizzle 0.43 cannot express a covering index, so the generated SQL
-- omitted `INCLUDE (assigned_point)` — which is the entire point of the index
-- on production, where it makes the claimable-balance sum index-only. Written
-- out here so a database built from these migrations matches production rather
-- than a weaker version of it.
CREATE INDEX IF NOT EXISTS "receipts_user_status_point_idx" ON "receipto"."receipts" USING btree ("user_address","status") INCLUDE ("assigned_point");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "halo_email_verifications_email_chain_idx" ON "receipto"."halo_email_verifications" USING btree ("email","chain","is_verified");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "halo_email_verifications_user_chain_idx" ON "receipto"."halo_email_verifications" USING btree ("user_address","chain","is_verified");
