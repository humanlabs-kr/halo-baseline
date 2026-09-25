CREATE TABLE "receipto"."humanfi_users" (
	"address" varchar(255) PRIMARY KEY NOT NULL,
	"checksum_address" varchar(255) NOT NULL,
	"points_balance" integer DEFAULT 0 NOT NULL,
	"points_accumulated" integer DEFAULT 0 NOT NULL,
	"current_streak" integer DEFAULT 0 NOT NULL,
	"longest_streak" integer DEFAULT 0 NOT NULL,
	"last_claim_date" timestamp with time zone,
	"total_swaps" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "receipto"."humanfi_point_logs" (
	"id" varchar(27) PRIMARY KEY NOT NULL,
	"user_address" varchar(255) NOT NULL,
	"diff" integer NOT NULL,
	"after_balance" integer NOT NULL,
	"accumulated_balance" integer NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receipto"."humanfi_daily_claims" (
	"id" varchar(27) PRIMARY KEY NOT NULL,
	"user_address" varchar(255) NOT NULL,
	"claim_date" date NOT NULL,
	"streak_day" integer NOT NULL,
	"points_claimed" integer NOT NULL,
	"point_log_id" varchar(27) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "humanfi_daily_claims_user_date_unique" UNIQUE("user_address","claim_date")
);
--> statement-breakpoint
CREATE TABLE "receipto"."humanfi_swaps" (
	"id" varchar(27) PRIMARY KEY NOT NULL,
	"user_address" varchar(255) NOT NULL,
	"token_in_address" varchar(255) NOT NULL,
	"token_in_symbol" varchar(32) NOT NULL,
	"token_in_amount" numeric(78, 0) NOT NULL,
	"token_out_address" varchar(255) NOT NULL,
	"token_out_symbol" varchar(32) NOT NULL,
	"token_out_amount" numeric(78, 0) NOT NULL,
	"tx_hash" varchar(66),
	"status" text DEFAULT 'pending' NOT NULL,
	"points_awarded" integer DEFAULT 0 NOT NULL,
	"point_log_id" varchar(27),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "receipto"."humanfi_point_logs" ADD CONSTRAINT "humanfi_point_logs_user_address_humanfi_users_address_fk" FOREIGN KEY ("user_address") REFERENCES "receipto"."humanfi_users"("address") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipto"."humanfi_daily_claims" ADD CONSTRAINT "humanfi_daily_claims_user_address_humanfi_users_address_fk" FOREIGN KEY ("user_address") REFERENCES "receipto"."humanfi_users"("address") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipto"."humanfi_daily_claims" ADD CONSTRAINT "humanfi_daily_claims_point_log_id_humanfi_point_logs_id_fk" FOREIGN KEY ("point_log_id") REFERENCES "receipto"."humanfi_point_logs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipto"."humanfi_swaps" ADD CONSTRAINT "humanfi_swaps_user_address_humanfi_users_address_fk" FOREIGN KEY ("user_address") REFERENCES "receipto"."humanfi_users"("address") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipto"."humanfi_swaps" ADD CONSTRAINT "humanfi_swaps_point_log_id_humanfi_point_logs_id_fk" FOREIGN KEY ("point_log_id") REFERENCES "receipto"."humanfi_point_logs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "humanfi_point_logs_user_address_idx" ON "receipto"."humanfi_point_logs" USING btree ("user_address");--> statement-breakpoint
CREATE INDEX "humanfi_point_logs_source_idx" ON "receipto"."humanfi_point_logs" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "humanfi_point_logs_created_at_idx" ON "receipto"."humanfi_point_logs" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "humanfi_daily_claims_user_address_idx" ON "receipto"."humanfi_daily_claims" USING btree ("user_address");--> statement-breakpoint
CREATE INDEX "humanfi_daily_claims_claim_date_idx" ON "receipto"."humanfi_daily_claims" USING btree ("claim_date");--> statement-breakpoint
CREATE INDEX "humanfi_swaps_user_address_idx" ON "receipto"."humanfi_swaps" USING btree ("user_address");--> statement-breakpoint
CREATE INDEX "humanfi_swaps_tx_hash_idx" ON "receipto"."humanfi_swaps" USING btree ("tx_hash");--> statement-breakpoint
CREATE INDEX "humanfi_swaps_status_idx" ON "receipto"."humanfi_swaps" USING btree ("status");--> statement-breakpoint
CREATE INDEX "humanfi_swaps_created_at_idx" ON "receipto"."humanfi_swaps" USING btree ("created_at" DESC NULLS LAST);