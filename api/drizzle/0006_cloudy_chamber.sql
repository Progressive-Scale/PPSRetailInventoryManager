CREATE TYPE "public"."item_audit_source" AS ENUM('BULK_EDIT', 'SINGLE_EDIT', 'SYNC');--> statement-breakpoint
CREATE TABLE "item_audit" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"item_id" uuid NOT NULL,
	"field" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"changed_by_user_id" integer,
	"source" "item_audit_source" NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "item_audit" ADD CONSTRAINT "item_audit_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_audit" ADD CONSTRAINT "item_audit_item_id_inventory_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."inventory_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_audit" ADD CONSTRAINT "item_audit_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "item_audit_company_item_idx" ON "item_audit" USING btree ("company_id","item_id");--> statement-breakpoint
-- RLS: enable + FORCE + tenant-isolation policy (mirrors migration 0001).
ALTER TABLE "item_audit" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "item_audit" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "item_audit"
  USING (current_setting('app.is_platform_admin', true) = 'on'
         OR company_id = nullif(current_setting('app.company_id', true), '')::int)
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'on'
         OR company_id = nullif(current_setting('app.company_id', true), '')::int);