CREATE TABLE "receipto"."kito_users" (
	"address" varchar(255) PRIMARY KEY NOT NULL,
	"checksum_address" varchar(255) NOT NULL,
	"offchain_balance" integer DEFAULT 0 NOT NULL,
	"is_verified" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp with time zone,
	"on_chain_verified" boolean DEFAULT false NOT NULL,
	"last_claim_time" timestamp with time zone,
	"current_streak" integer DEFAULT 0 NOT NULL,
	"longest_streak" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "receipto"."kito_phone_verifications" (
	"id" varchar(27) PRIMARY KEY NOT NULL,
	"user_address" varchar(255) NOT NULL,
	"phone_number" varchar(20) NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kito_phone_verifications_user_address_unique" UNIQUE("user_address"),
	CONSTRAINT "kito_phone_verifications_phone_number_unique" UNIQUE("phone_number")
);
--> statement-breakpoint
CREATE TABLE "receipto"."kito_pending_onchain" (
	"user_address" varchar(255) PRIMARY KEY NOT NULL,
	"status" varchar(20) NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receipto"."kito_claims" (
	"id" varchar(27) PRIMARY KEY NOT NULL,
	"user_address" varchar(255) NOT NULL,
	"amount" integer NOT NULL,
	"type" varchar(20) NOT NULL,
	"tx_hash" varchar(66),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "receipto"."kito_phone_verifications" ADD CONSTRAINT "kito_phone_verifications_user_address_kito_users_address_fk" FOREIGN KEY ("user_address") REFERENCES "receipto"."kito_users"("address") ON DELETE cascade ON UPDATE no action;