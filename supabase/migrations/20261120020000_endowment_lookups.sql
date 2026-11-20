CREATE TABLE "endowment_lookups" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"outcome" varchar(20) NOT NULL,
	"code" varchar(80),
	"latency_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "endowment_lookups_created_at_idx" ON "endowment_lookups" USING btree ("created_at");