CREATE TYPE "public"."import_check_status" AS ENUM('REQUESTED', 'MATCHED', 'NOT_FOUND', 'DISCREPANCY');--> statement-breakpoint
ALTER TYPE "public"."cycle_count_resolution" ADD VALUE 'RECEIVED';--> statement-breakpoint
ALTER TYPE "public"."cycle_count_resolution" ADD VALUE 'PENDING_NOT_RECEIVED';--> statement-breakpoint
ALTER TYPE "public"."cycle_count_resolution" ADD VALUE 'REINSTATED';--> statement-breakpoint
ALTER TYPE "public"."cycle_count_resolution" ADD VALUE 'MOVED_IN';--> statement-breakpoint
ALTER TYPE "public"."item_status" ADD VALUE 'PENDING' BEFORE 'ON_HAND';--> statement-breakpoint
ALTER TYPE "public"."transaction_type" ADD VALUE 'RECEIVE' BEFORE 'SALE';--> statement-breakpoint
ALTER TYPE "public"."transaction_type" ADD VALUE 'REINSTATE';--> statement-breakpoint
CREATE TABLE "cycle_count_products" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"cycle_count_id" integer NOT NULL,
	"product_id" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cycle_count_lines" ALTER COLUMN "product_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_items" ALTER COLUMN "product_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_items" ALTER COLUMN "location_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ALTER COLUMN "product_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cycle_counts" ADD COLUMN "location_id" integer;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "needs_review" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "import_check_status" "import_check_status";--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "import_check_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "import_check_resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "import_check_result" jsonb;--> statement-breakpoint
ALTER TABLE "cycle_count_products" ADD CONSTRAINT "cycle_count_products_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_count_products" ADD CONSTRAINT "cycle_count_products_cycle_count_id_cycle_counts_id_fk" FOREIGN KEY ("cycle_count_id") REFERENCES "public"."cycle_counts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_count_products" ADD CONSTRAINT "cycle_count_products_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cycle_count_products_count_product_uniq" ON "cycle_count_products" USING btree ("cycle_count_id","product_id");--> statement-breakpoint
CREATE INDEX "cycle_count_products_company_count_idx" ON "cycle_count_products" USING btree ("company_id","cycle_count_id");--> statement-breakpoint
ALTER TABLE "cycle_counts" ADD CONSTRAINT "cycle_counts_location_id_store_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."store_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_pending_has_no_location" CHECK ((status::text = 'PENDING' AND location_id IS NULL)
          OR (status::text <> 'PENDING' AND location_id IS NOT NULL));--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_productless_needs_review" CHECK (product_id IS NOT NULL OR needs_review);--> statement-breakpoint
-- RLS on the new tenant table (mirrors migration 0001). drizzle-kit only emits
-- structure, never the policy, so every new tenant table needs this by hand.
ALTER TABLE "cycle_count_products" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cycle_count_products" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "cycle_count_products"
  USING (current_setting('app.is_platform_admin', true) = 'on'
         OR company_id = nullif(current_setting('app.company_id', true), '')::int)
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'on'
         OR company_id = nullif(current_setting('app.company_id', true), '')::int);
