CREATE TABLE "receipto"."blacklisted_addresses" (
	"address" varchar(255) PRIMARY KEY NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
