CREATE TABLE "receipto"."raffle_pool_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"raffle_pool_id" uuid NOT NULL,
	"user_address" varchar(255) NOT NULL,
	"entry_count" integer NOT NULL,
	"point_spent" integer NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "receipto"."raffle_pools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"amount_in_usdc" double precision NOT NULL,
	"point_per_entry" integer NOT NULL,
	"max_entries_per_user" integer NOT NULL,
	"utc_date" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"total_entry_count" integer DEFAULT 0 NOT NULL,
	"winner_address" varchar(255),
	"drop_link" text,
	"drop_link_base58_id" varchar(255),
	"claimed_at" timestamp with time zone,
	CONSTRAINT "unique_raffle_pools_utc_date_amount_in_usdc" UNIQUE("utc_date","amount_in_usdc")
);
--> statement-breakpoint
ALTER TABLE "receipto"."raffle_pool_entries" ADD CONSTRAINT "raffle_pool_entries_raffle_pool_id_raffle_pools_id_fk" FOREIGN KEY ("raffle_pool_id") REFERENCES "receipto"."raffle_pools"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipto"."raffle_pool_entries" ADD CONSTRAINT "raffle_pool_entries_user_address_users_address_fk" FOREIGN KEY ("user_address") REFERENCES "receipto"."users"("address") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipto"."raffle_pools" ADD CONSTRAINT "raffle_pools_winner_address_users_address_fk" FOREIGN KEY ("winner_address") REFERENCES "receipto"."users"("address") ON DELETE restrict ON UPDATE no action;