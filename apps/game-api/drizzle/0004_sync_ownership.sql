ALTER TABLE "fish" ADD COLUMN "source" varchar(20) DEFAULT 'donation' NOT NULL;--> statement-breakpoint
ALTER TABLE "fish" ADD COLUMN "deactivated_reason" varchar(40);--> statement-breakpoint
ALTER TABLE "player_inventory" ADD COLUMN "donation_points_granted" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Backfill: fish without a donation were created by NIK sync, unless an admin created them.
UPDATE "fish" SET "source" = 'endowment_sync' WHERE "donation_id" IS NULL;--> statement-breakpoint
UPDATE "fish" SET "source" = 'admin'
WHERE "id"::text IN (SELECT "target_id" FROM "admin_audit_log" WHERE "action" = 'fish.create');--> statement-breakpoint
-- Backfill why inactive fish are inactive.
UPDATE "fish" SET "deactivated_reason" = CASE
  WHEN "id"::text IN (
    SELECT "target_id" FROM "admin_audit_log"
    WHERE "action" = 'fish.update' AND "changes" ? 'isActive'
  ) THEN 'admin'
  WHEN "source" = 'donation' THEN 'refund'
  ELSE 'endowment_below_common'
END
WHERE NOT "is_active";--> statement-breakpoint
-- Points granted so far from donations = what the old sync awarded for the cached total.
UPDATE "player_inventory" AS i
SET "donation_points_granted" = LEAST(2147483647, FLOOR(d."total_donation" / 10000))::integer
FROM "donors" AS d
WHERE d."id" = i."donor_id";
