CREATE EXTENSION IF NOT EXISTS "pgcrypto";--> statement-breakpoint
CREATE TYPE "public"."donation_status" AS ENUM('pending', 'confirmed', 'failed', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."fish_mood" AS ENUM('happy', 'neutral', 'hungry');--> statement-breakpoint
CREATE TYPE "public"."webhook_status" AS ENUM('received', 'processed', 'failed', 'duplicate');--> statement-breakpoint
CREATE TABLE "access_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"donor_id" uuid NOT NULL,
	"token_hash" varchar(255) NOT NULL,
	"expires_at" timestamp with time zone,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "aquariums" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"donor_id" uuid NOT NULL,
	"public_slug" varchar(120) NOT NULL,
	"name" varchar(150),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "aquariums_donor_id_unique" UNIQUE("donor_id"),
	CONSTRAINT "aquariums_public_slug_unique" UNIQUE("public_slug")
);
--> statement-breakpoint
CREATE TABLE "donations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"donor_id" uuid NOT NULL,
	"webhook_event_id" uuid,
	"source" varchar(50) NOT NULL,
	"external_donation_id" varchar(255) NOT NULL,
	"amount" bigint NOT NULL,
	"currency" char(3) DEFAULT 'IDR' NOT NULL,
	"status" "donation_status" DEFAULT 'confirmed' NOT NULL,
	"donated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "donations_source_external_donation_id_unique" UNIQUE("source","external_donation_id"),
	CONSTRAINT "donations_amount_check" CHECK ("donations"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "donors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_id" varchar(255),
	"display_name" varchar(150),
	"email" varchar(255),
	"show_name_publicly" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "donors_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "fish" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aquarium_id" uuid NOT NULL,
	"donation_id" uuid NOT NULL,
	"tier_code" varchar(30) NOT NULL,
	"species_code" varchar(50) NOT NULL,
	"display_name" varchar(100),
	"color_code" varchar(50) DEFAULT 'DEFAULT' NOT NULL,
	"accessory_code" varchar(50) DEFAULT 'NONE' NOT NULL,
	"hunger" integer DEFAULT 100 NOT NULL,
	"mood" "fish_mood" DEFAULT 'happy' NOT NULL,
	"last_fed_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fish_donation_id_unique" UNIQUE("donation_id"),
	CONSTRAINT "fish_hunger_check" CHECK ("fish"."hunger" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "fish_species" (
	"code" varchar(50) PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"default_tier_code" varchar(30) NOT NULL,
	"unity_asset_code" varchar(100) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fish_species_unity_asset_code_unique" UNIQUE("unity_asset_code")
);
--> statement-breakpoint
CREATE TABLE "fish_tiers" (
	"code" varchar(30) PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"min_amount" bigint NOT NULL,
	"max_amount" bigint,
	"rarity_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fish_tiers_rarity_order_unique" UNIQUE("rarity_order"),
	CONSTRAINT "fish_tiers_min_amount_check" CHECK ("fish_tiers"."min_amount" >= 0),
	CONSTRAINT "fish_tiers_max_amount_check" CHECK ("fish_tiers"."max_amount" is null or "fish_tiers"."max_amount" >= "fish_tiers"."min_amount"),
	CONSTRAINT "fish_tiers_rarity_order_check" CHECK ("fish_tiers"."rarity_order" > 0)
);
--> statement-breakpoint
CREATE TABLE "game_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"aquarium_id" uuid NOT NULL,
	"fish_id" uuid,
	"event_type" varchar(80) NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" varchar(50) NOT NULL,
	"external_event_id" varchar(255) NOT NULL,
	"event_type" varchar(80) NOT NULL,
	"payload" jsonb NOT NULL,
	"signature_valid" boolean DEFAULT false NOT NULL,
	"status" "webhook_status" DEFAULT 'received' NOT NULL,
	"processing_attempts" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "webhook_events_source_external_event_id_unique" UNIQUE("source","external_event_id"),
	CONSTRAINT "webhook_events_processing_attempts_check" CHECK ("webhook_events"."processing_attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "access_tokens" ADD CONSTRAINT "access_tokens_donor_id_donors_id_fk" FOREIGN KEY ("donor_id") REFERENCES "public"."donors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aquariums" ADD CONSTRAINT "aquariums_donor_id_donors_id_fk" FOREIGN KEY ("donor_id") REFERENCES "public"."donors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "donations" ADD CONSTRAINT "donations_donor_id_donors_id_fk" FOREIGN KEY ("donor_id") REFERENCES "public"."donors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "donations" ADD CONSTRAINT "donations_webhook_event_id_webhook_events_id_fk" FOREIGN KEY ("webhook_event_id") REFERENCES "public"."webhook_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fish" ADD CONSTRAINT "fish_aquarium_id_aquariums_id_fk" FOREIGN KEY ("aquarium_id") REFERENCES "public"."aquariums"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fish" ADD CONSTRAINT "fish_donation_id_donations_id_fk" FOREIGN KEY ("donation_id") REFERENCES "public"."donations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fish" ADD CONSTRAINT "fish_tier_code_fish_tiers_code_fk" FOREIGN KEY ("tier_code") REFERENCES "public"."fish_tiers"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fish" ADD CONSTRAINT "fish_species_code_fish_species_code_fk" FOREIGN KEY ("species_code") REFERENCES "public"."fish_species"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fish_species" ADD CONSTRAINT "fish_species_default_tier_code_fish_tiers_code_fk" FOREIGN KEY ("default_tier_code") REFERENCES "public"."fish_tiers"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_events" ADD CONSTRAINT "game_events_aquarium_id_aquariums_id_fk" FOREIGN KEY ("aquarium_id") REFERENCES "public"."aquariums"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_events" ADD CONSTRAINT "game_events_fish_id_fish_id_fk" FOREIGN KEY ("fish_id") REFERENCES "public"."fish"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "donations_donor_id_idx" ON "donations" USING btree ("donor_id");--> statement-breakpoint
CREATE INDEX "donations_donated_at_idx" ON "donations" USING btree ("donated_at");--> statement-breakpoint
CREATE INDEX "donations_status_idx" ON "donations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "fish_aquarium_id_idx" ON "fish" USING btree ("aquarium_id");--> statement-breakpoint
CREATE INDEX "fish_tier_code_idx" ON "fish" USING btree ("tier_code");--> statement-breakpoint
CREATE INDEX "fish_species_code_idx" ON "fish" USING btree ("species_code");--> statement-breakpoint
CREATE INDEX "fish_is_active_created_at_idx" ON "fish" USING btree ("is_active","created_at");--> statement-breakpoint
CREATE INDEX "game_events_aquarium_id_id_idx" ON "game_events" USING btree ("aquarium_id","id");--> statement-breakpoint
CREATE INDEX "game_events_event_type_created_at_idx" ON "game_events" USING btree ("event_type","created_at");--> statement-breakpoint
CREATE INDEX "webhook_events_status_received_at_idx" ON "webhook_events" USING btree ("status","received_at");
