CREATE TABLE "receipto"."receipt_line_items" (
	"id" varchar(27) PRIMARY KEY NOT NULL,
	"receipt_id" varchar(27) NOT NULL,
	"line_no" integer NOT NULL,
	"raw_text" text NOT NULL,
	"category" text,
	"quantity" numeric(12, 3),
	"unit" varchar(10),
	"unit_price" numeric(15, 4),
	"line_total" numeric(15, 2),
	"source" text DEFAULT 'vision' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "receipto"."receipt_line_items" ADD CONSTRAINT "receipt_line_items_receipt_id_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "receipto"."receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "receipt_line_items_receipt_id_idx" ON "receipto"."receipt_line_items" USING btree ("receipt_id");--> statement-breakpoint
CREATE INDEX "receipt_line_items_category_idx" ON "receipto"."receipt_line_items" USING btree ("category");--> statement-breakpoint
CREATE INDEX "receipt_line_items_source_category_idx" ON "receipto"."receipt_line_items" USING btree ("source","category");