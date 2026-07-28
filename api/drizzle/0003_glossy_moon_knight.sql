CREATE TYPE "public"."location_kind" AS ENUM('BACKROOM', 'ONFLOOR', 'CUSTOM');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('UNREAD', 'READ', 'DISMISSED');--> statement-breakpoint
CREATE TYPE "public"."notification_type" AS ENUM('EXPIRATION_WARNING');--> statement-breakpoint
ALTER TYPE "public"."transaction_type" ADD VALUE 'MOVE';--> statement-breakpoint
CREATE TABLE "notification_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"store_id" integer,
	"expiration_alert_days" integer DEFAULT 30 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"store_id" integer NOT NULL,
	"type" "notification_type" NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "notification_status" DEFAULT 'UNREAD' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "store_locations" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"store_id" integer NOT NULL,
	"name" text NOT NULL,
	"kind" "location_kind" DEFAULT 'CUSTOM' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "inventory_stock_company_store_product_uniq";--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "location_id" integer;--> statement-breakpoint
ALTER TABLE "inventory_stock" ADD COLUMN "location_id" integer;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD COLUMN "location_from_id" integer;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD COLUMN "location_to_id" integer;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_locations" ADD CONSTRAINT "store_locations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_locations" ADD CONSTRAINT "store_locations_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_settings_company_store_uniq" ON "notification_settings" USING btree ("company_id","store_id");--> statement-breakpoint
CREATE INDEX "notifications_company_status_idx" ON "notifications" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "notifications_company_store_idx" ON "notifications" USING btree ("company_id","store_id");--> statement-breakpoint
CREATE INDEX "store_locations_company_store_idx" ON "store_locations" USING btree ("company_id","store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "store_locations_company_store_name_uniq" ON "store_locations" USING btree ("company_id","store_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "store_locations_store_systemkind_uniq" ON "store_locations" USING btree ("store_id","kind") WHERE "store_locations"."kind" <> 'CUSTOM';--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_location_id_store_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."store_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_stock" ADD CONSTRAINT "inventory_stock_location_id_store_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."store_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_location_from_id_store_locations_id_fk" FOREIGN KEY ("location_from_id") REFERENCES "public"."store_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_location_to_id_store_locations_id_fk" FOREIGN KEY ("location_to_id") REFERENCES "public"."store_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_items_company_location_idx" ON "inventory_items" USING btree ("company_id","location_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_stock_company_store_product_location_uniq" ON "inventory_stock" USING btree ("company_id","store_id","product_id","location_id");