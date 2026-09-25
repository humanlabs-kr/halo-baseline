CREATE TABLE "receipto"."halo_email_verifications" (
	"id" varchar(27) PRIMARY KEY NOT NULL,
	"chain" varchar(20) NOT NULL,
	"user_address" varchar(255) NOT NULL,
	"email" varchar(320) NOT NULL,
	"otp_code" varchar(6),
	"otp_expires_at" timestamp with time zone,
	"otp_attempts" integer DEFAULT 0 NOT NULL,
	"otp_sent_at" timestamp with time zone,
	"is_verified" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receipto"."halo_raffle_pool_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"raffle_pool_id" uuid NOT NULL,
	"user_address" varchar(255) NOT NULL,
	"entry_count" integer NOT NULL,
	"point_spent" integer NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "receipto"."halo_raffle_pools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain" varchar(20) NOT NULL,
	"amount_in_usdt" double precision NOT NULL,
	"point_per_entry" integer NOT NULL,
	"max_entries_per_user" integer NOT NULL,
	"utc_date" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"total_entry_count" integer DEFAULT 0 NOT NULL,
	"winner_address" varchar(255),
	"manual_payout_tx_hash" varchar(66),
	"manual_payout_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "receipto"."halo_email_verifications" ADD CONSTRAINT "halo_email_verifications_user_address_users_address_fk" FOREIGN KEY ("user_address") REFERENCES "receipto"."users"("address") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipto"."halo_raffle_pool_entries" ADD CONSTRAINT "halo_raffle_pool_entries_raffle_pool_id_halo_raffle_pools_id_fk" FOREIGN KEY ("raffle_pool_id") REFERENCES "receipto"."halo_raffle_pools"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipto"."halo_raffle_pool_entries" ADD CONSTRAINT "halo_raffle_pool_entries_user_address_users_address_fk" FOREIGN KEY ("user_address") REFERENCES "receipto"."users"("address") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipto"."halo_raffle_pools" ADD CONSTRAINT "halo_raffle_pools_winner_address_users_address_fk" FOREIGN KEY ("winner_address") REFERENCES "receipto"."users"("address") ON DELETE restrict ON UPDATE no action;