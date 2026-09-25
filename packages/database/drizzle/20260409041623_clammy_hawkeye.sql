CREATE TABLE "receipto"."email_campaign_sends" (
	"id" varchar(27) PRIMARY KEY NOT NULL,
	"campaign_id" varchar(27) NOT NULL,
	"email" varchar(320) NOT NULL,
	"user_address" varchar(255) NOT NULL,
	"batch_index" integer DEFAULT 0 NOT NULL,
	"status" varchar(20) NOT NULL,
	"is_opened" boolean DEFAULT false NOT NULL,
	"opened_at" timestamp with time zone,
	"open_count" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receipto"."email_campaigns" (
	"id" varchar(27) PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"subject" varchar(200) NOT NULL,
	"template_name" varchar(100) NOT NULL,
	"chain" varchar(20),
	"target_type" varchar(20) NOT NULL,
	"target_wallets" text,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"total_recipients" integer DEFAULT 0 NOT NULL,
	"sent_count" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"open_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "receipto"."email_campaign_sends" ADD CONSTRAINT "email_campaign_sends_campaign_id_email_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "receipto"."email_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipto"."email_campaign_sends" ADD CONSTRAINT "email_campaign_sends_user_address_users_address_fk" FOREIGN KEY ("user_address") REFERENCES "receipto"."users"("address") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_campaign_sends_campaign_id_idx" ON "receipto"."email_campaign_sends" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "email_campaign_sends_user_address_idx" ON "receipto"."email_campaign_sends" USING btree ("user_address");--> statement-breakpoint
CREATE INDEX "email_campaign_sends_is_opened_idx" ON "receipto"."email_campaign_sends" USING btree ("is_opened");--> statement-breakpoint
CREATE INDEX "email_campaigns_status_idx" ON "receipto"."email_campaigns" USING btree ("status");--> statement-breakpoint
CREATE INDEX "email_campaigns_created_at_idx" ON "receipto"."email_campaigns" USING btree ("created_at");