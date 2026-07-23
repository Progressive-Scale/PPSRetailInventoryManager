CREATE TYPE "public"."cycle_count_resolution" AS ENUM('SCANNED', 'COUNTED_BY_UPC', 'MARKED_SOLD', 'NEW_ITEM');--> statement-breakpoint
CREATE TYPE "public"."cycle_count_status" AS ENUM('OPEN', 'CLOSED', 'CANCELLED');--> statement-breakpoint
ALTER TYPE "public"."transaction_source" ADD VALUE 'CYCLE_COUNT';--> statement-breakpoint
CREATE TABLE "cycle_count_lines" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"cycle_count_id" integer NOT NULL,
	"item_id" uuid NOT NULL,
	"serial" text NOT NULL,
	"resolution" "cycle_count_resolution" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cycle_counts" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"store_id" integer NOT NULL,
	"status" "cycle_count_status" DEFAULT 'OPEN' NOT NULL,
	"opened_by_user_id" integer NOT NULL,
	"closed_by_user_id" integer,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"expected_count" integer DEFAULT 0 NOT NULL,
	"scanned_count" integer DEFAULT 0 NOT NULL,
	"sold_generated_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "upc" text;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "needs_review" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "cycle_count_lines" ADD CONSTRAINT "cycle_count_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_count_lines" ADD CONSTRAINT "cycle_count_lines_cycle_count_id_cycle_counts_id_fk" FOREIGN KEY ("cycle_count_id") REFERENCES "public"."cycle_counts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_count_lines" ADD CONSTRAINT "cycle_count_lines_item_id_inventory_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."inventory_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_counts" ADD CONSTRAINT "cycle_counts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_counts" ADD CONSTRAINT "cycle_counts_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_counts" ADD CONSTRAINT "cycle_counts_opened_by_user_id_users_id_fk" FOREIGN KEY ("opened_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_counts" ADD CONSTRAINT "cycle_counts_closed_by_user_id_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cc_lines_company_count_idx" ON "cycle_count_lines" USING btree ("company_id","cycle_count_id");--> statement-breakpoint
CREATE INDEX "cc_lines_company_resolution_idx" ON "cycle_count_lines" USING btree ("company_id","resolution");--> statement-breakpoint
CREATE INDEX "cycle_counts_company_store_idx" ON "cycle_counts" USING btree ("company_id","store_id");--> statement-breakpoint
CREATE INDEX "cycle_counts_company_status_idx" ON "cycle_counts" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "inventory_items_company_upc_idx" ON "inventory_items" USING btree ("company_id","upc");