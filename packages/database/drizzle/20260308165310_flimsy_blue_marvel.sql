CREATE TABLE "receipto"."humanfi_phone_verifications" (
	"id" varchar(27) PRIMARY KEY NOT NULL,
	"user_address" varchar(255) NOT NULL,
	"phone_number" varchar(20) NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "humanfi_phone_verifications_user_address_unique" UNIQUE("user_address"),
	CONSTRAINT "humanfi_phone_verifications_phone_number_unique" UNIQUE("phone_number")
);
--> statement-breakpoint
ALTER TABLE "receipto"."humanfi_phone_verifications" ADD CONSTRAINT "humanfi_phone_verifications_user_address_humanfi_users_address_fk" FOREIGN KEY ("user_address") REFERENCES "receipto"."humanfi_users"("address") ON DELETE cascade ON UPDATE no action;