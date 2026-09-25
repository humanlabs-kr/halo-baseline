CREATE INDEX IF NOT EXISTS "users_platform_idx" ON "receipto"."users" USING btree ("platform");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "raffle_pool_entries_pool_user_idx" ON "receipto"."raffle_pool_entries" USING btree ("raffle_pool_id","user_address");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "halo_raffle_pool_entries_pool_user_idx" ON "receipto"."halo_raffle_pool_entries" USING btree ("raffle_pool_id","user_address");
