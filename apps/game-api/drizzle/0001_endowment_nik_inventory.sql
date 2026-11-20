CREATE TABLE "player_inventory" (
	"donor_id" uuid PRIMARY KEY NOT NULL,
	"points" integer DEFAULT 0 NOT NULL,
	"owned_accessories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_inventory_points_check" CHECK ("player_inventory"."points" >= 0)
);
--> statement-breakpoint
ALTER TABLE "fish" ALTER COLUMN "donation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "donors" ADD COLUMN "nik" varchar(20);--> statement-breakpoint
ALTER TABLE "donors" ADD COLUMN "total_donation" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "donors" ADD COLUMN "tier" varchar(30);--> statement-breakpoint
ALTER TABLE "donors" ADD COLUMN "last_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "player_inventory" ADD CONSTRAINT "player_inventory_donor_id_donors_id_fk" FOREIGN KEY ("donor_id") REFERENCES "public"."donors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "donors" ADD CONSTRAINT "donors_nik_unique" UNIQUE("nik");