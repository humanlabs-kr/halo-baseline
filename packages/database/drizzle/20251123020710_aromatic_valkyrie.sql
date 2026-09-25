--> statement-breakpoint
CREATE TABLE "receipto"."users" (
	"address" varchar(255) PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"profile_picture_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	"verification_level" text DEFAULT 'none' NOT NULL,
	"checksum_address" varchar(255) DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receipto"."receipts" (
	"id" varchar(27) PRIMARY KEY NOT NULL,
	"user_address" varchar(255) NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"assigned_point" integer DEFAULT 0 NOT NULL,
	"merchant_name" text,
	"issued_at" timestamp with time zone,
	"country_code" varchar(10),
	"currency" varchar(10),
	"total_amount" numeric(10, 2),
	"payment_method" text,
	"quality_rate" integer,
	"analysis_started_at" timestamp with time zone,
	"analysis_completed_at" timestamp with time zone,
	"analysis_error" text,
	"point_log_id" varchar(27),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "receipto"."receipt_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"num_order" integer NOT NULL,
	"receipt_id" varchar(27) NOT NULL,
	"synapse_upload_started_at" timestamp with time zone,
	"synapse_upload_completed_at" timestamp with time zone,
	"synapse_piece_cid" varchar(255),
	"synapse_upload_error" text,
	"fluence_ocr_started_at" timestamp with time zone,
	"fluence_ocr_completed_at" timestamp with time zone,
	"fluence_ocr_result" jsonb,
	"fluence_ocr_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "receipto"."point_logs" (
	"id" varchar(27) PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"diff" integer NOT NULL,
	"after_balance" integer NOT NULL,
	"accumulated_balance" integer NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receipto"."point_claims" (
	"id" varchar(27) PRIMARY KEY NOT NULL,
	"user_address" varchar(255) NOT NULL,
	"signal" text NOT NULL,
	"action" text NOT NULL,
	"merkle_root" text NOT NULL,
	"nullifier_hash" text NOT NULL,
	"signal_hash" text NOT NULL,
	"verification_level" text NOT NULL,
	"proof" text NOT NULL,
	"total_amount" integer NOT NULL,
	"receipt_ids" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "receipto"."receipts" ADD CONSTRAINT "receipts_user_address_users_address_fk" FOREIGN KEY ("user_address") REFERENCES "receipto"."users"("address") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipto"."receipts" ADD CONSTRAINT "receipts_point_log_id_point_logs_id_fk" FOREIGN KEY ("point_log_id") REFERENCES "receipto"."point_logs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipto"."receipt_images" ADD CONSTRAINT "receipt_images_receipt_id_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "receipto"."receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipto"."point_claims" ADD CONSTRAINT "point_claims_user_address_users_address_fk" FOREIGN KEY ("user_address") REFERENCES "receipto"."users"("address") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "point_logs_address_idx" ON "receipto"."point_logs" USING btree ("address");--> statement-breakpoint
CREATE INDEX "point_logs_source_idx" ON "receipto"."point_logs" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "point_logs_created_at_idx" ON "receipto"."point_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "point_logs_address_created_at_idx" ON "receipto"."point_logs" USING btree ("address","created_at" DESC NULLS LAST);