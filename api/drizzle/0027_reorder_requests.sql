CREATE TYPE "public"."reorder_status" AS ENUM('OPEN', 'ACKNOWLEDGED', 'CANCELLED');--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'REORDER_ACKNOWLEDGED';--> statement-breakpoint
CREATE TABLE "reorder_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"store_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"status" "reorder_status" DEFAULT 'OPEN' NOT NULL,
	"quantity_requested" integer,
	"note" text,
	"requested_by_user_id" integer,
	"external_order_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "user_id" integer;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "reorder_threshold" integer;--> statement-breakpoint
ALTER TABLE "reorder_requests" ADD CONSTRAINT "reorder_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reorder_requests" ADD CONSTRAINT "reorder_requests_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reorder_requests" ADD CONSTRAINT "reorder_requests_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reorder_requests" ADD CONSTRAINT "reorder_requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reorder_requests_company_status_idx" ON "reorder_requests" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "reorder_requests_company_store_idx" ON "reorder_requests" USING btree ("company_id","store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reorder_requests_open_uniq" ON "reorder_requests" USING btree ("company_id","store_id","product_id") WHERE status = 'OPEN';--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_company_user_idx" ON "notifications" USING btree ("company_id","user_id");--> statement-breakpoint
-- Tenant isolation, same shape as every other tenant table: the platform-admin
-- escape hatch first, then the company predicate. FORCE so the policy also applies
-- to the table owner, which is who the app connects as.
ALTER TABLE "reorder_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reorder_requests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "reorder_requests"
  USING (current_setting('app.is_platform_admin', true) = 'on'
         OR company_id = nullif(current_setting('app.company_id', true), '')::int)
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'on'
         OR company_id = nullif(current_setting('app.company_id', true), '')::int);
