CREATE TABLE "receipto"."daily_point_claims" (
	"id" varchar(27) PRIMARY KEY NOT NULL,
	"user_address" varchar(255) NOT NULL,
	"claim_date" date NOT NULL,
	"claimed_point" integer NOT NULL,
	"point_log_id" varchar(27) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_point_claims_user_date_unique" UNIQUE("user_address","claim_date")
);
--> statement-breakpoint
ALTER TABLE "receipto"."daily_point_claims" ADD CONSTRAINT "daily_point_claims_user_address_users_address_fk" FOREIGN KEY ("user_address") REFERENCES "receipto"."users"("address") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipto"."daily_point_claims" ADD CONSTRAINT "daily_point_claims_point_log_id_point_logs_id_fk" FOREIGN KEY ("point_log_id") REFERENCES "receipto"."point_logs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "daily_point_claims_user_address_idx" ON "receipto"."daily_point_claims" USING btree ("user_address");--> statement-breakpoint
CREATE INDEX "daily_point_claims_claim_date_idx" ON "receipto"."daily_point_claims" USING btree ("claim_date");