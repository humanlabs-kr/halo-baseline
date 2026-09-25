ALTER TABLE "receipto"."point_claims" ALTER COLUMN "signal" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "receipto"."point_claims" ALTER COLUMN "action" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "receipto"."point_claims" ALTER COLUMN "merkle_root" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "receipto"."point_claims" ALTER COLUMN "nullifier_hash" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "receipto"."point_claims" ALTER COLUMN "signal_hash" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "receipto"."point_claims" ALTER COLUMN "verification_level" SET DEFAULT 'none';--> statement-breakpoint
ALTER TABLE "receipto"."point_claims" ALTER COLUMN "proof" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "receipto"."users" ADD COLUMN "platform" text DEFAULT 'world' NOT NULL;