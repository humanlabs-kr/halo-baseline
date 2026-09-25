ALTER TABLE "receipto"."humanfi_swaps" ADD COLUMN "gas_fee_amount" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "receipto"."humanfi_swaps" ADD COLUMN "gas_fee_symbol" varchar(32);