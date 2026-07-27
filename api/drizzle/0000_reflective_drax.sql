CREATE TYPE "public"."company_status" AS ENUM('ACTIVE', 'SUSPENDED');--> statement-breakpoint
CREATE TYPE "public"."cycle_count_resolution" AS ENUM('SCANNED', 'COUNTED_BY_UPC', 'MARKED_SOLD', 'NEW_ITEM');--> statement-breakpoint
CREATE TYPE "public"."cycle_count_status" AS ENUM('OPEN', 'CLOSED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."item_status" AS ENUM('ON_HAND', 'SOLD', 'RETURNED_TO_WAREHOUSE', 'ADJUSTED_OUT');--> statement-breakpoint
CREATE TYPE "public"."tracking_type" AS ENUM('SERIALIZED', 'QUANTITY');--> statement-breakpoint
CREATE TYPE "public"."transaction_source" AS ENUM('PORTAL', 'SYNC', 'CYCLE_COUNT');--> statement-breakpoint
CREATE TYPE "public"."transaction_type" AS ENUM('RECEIPT', 'SALE', 'ADJUSTMENT', 'RETURN');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('PLATFORM_ADMIN', 'COMPANY_ADMIN', 'STORE_USER');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('ACTIVE', 'SUSPENDED');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"custom_domain" text,
	"branding" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "company_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cycle_count_lines" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"cycle_count_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"item_id" uuid,
	"serial" text,
	"quantity" integer,
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
CREATE TABLE "inventory_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" integer NOT NULL,
	"store_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"serial" text NOT NULL,
	"status" "item_status" DEFAULT 'ON_HAND' NOT NULL,
	"expiration_date" date,
	"received_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_stock" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"store_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"quantity_on_hand" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_stock_qty_nonneg" CHECK ("inventory_stock"."quantity_on_hand" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_transactions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"store_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"item_id" uuid,
	"type" "transaction_type" NOT NULL,
	"quantity_delta" integer NOT NULL,
	"note" text,
	"performed_by_user_id" integer,
	"source" "transaction_source" NOT NULL,
	"cycle_count_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"email" text NOT NULL,
	"role" "user_role" NOT NULL,
	"store_id" integer,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_returns" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"store_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"item_id" uuid,
	"serial" text,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"price" numeric(12, 2) DEFAULT '0' NOT NULL,
	"upc" text,
	"tracking_type" "tracking_type" DEFAULT 'SERIALIZED' NOT NULL,
	"needs_review" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stores" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"external_building_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_receipts" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"handoff_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer,
	"store_id" integer,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" NOT NULL,
	"status" "user_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_count_lines" ADD CONSTRAINT "cycle_count_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_count_lines" ADD CONSTRAINT "cycle_count_lines_cycle_count_id_cycle_counts_id_fk" FOREIGN KEY ("cycle_count_id") REFERENCES "public"."cycle_counts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_count_lines" ADD CONSTRAINT "cycle_count_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_count_lines" ADD CONSTRAINT "cycle_count_lines_item_id_inventory_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."inventory_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_counts" ADD CONSTRAINT "cycle_counts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_counts" ADD CONSTRAINT "cycle_counts_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_counts" ADD CONSTRAINT "cycle_counts_opened_by_user_id_users_id_fk" FOREIGN KEY ("opened_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_counts" ADD CONSTRAINT "cycle_counts_closed_by_user_id_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_stock" ADD CONSTRAINT "inventory_stock_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_stock" ADD CONSTRAINT "inventory_stock_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_stock" ADD CONSTRAINT "inventory_stock_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_item_id_inventory_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."inventory_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_performed_by_user_id_users_id_fk" FOREIGN KEY ("performed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_cycle_count_id_cycle_counts_id_fk" FOREIGN KEY ("cycle_count_id") REFERENCES "public"."cycle_counts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_returns" ADD CONSTRAINT "outbox_returns_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_returns" ADD CONSTRAINT "outbox_returns_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_returns" ADD CONSTRAINT "outbox_returns_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_returns" ADD CONSTRAINT "outbox_returns_item_id_inventory_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."inventory_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_receipts" ADD CONSTRAINT "sync_receipts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_company_idx" ON "api_keys" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash_uniq" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "companies_slug_uniq" ON "companies" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "companies_custom_domain_uniq" ON "companies" USING btree ("custom_domain");--> statement-breakpoint
CREATE INDEX "cc_lines_company_count_idx" ON "cycle_count_lines" USING btree ("company_id","cycle_count_id");--> statement-breakpoint
CREATE INDEX "cc_lines_company_resolution_idx" ON "cycle_count_lines" USING btree ("company_id","resolution");--> statement-breakpoint
CREATE INDEX "cycle_counts_company_store_idx" ON "cycle_counts" USING btree ("company_id","store_id");--> statement-breakpoint
CREATE INDEX "cycle_counts_company_status_idx" ON "cycle_counts" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_items_company_serial_uniq" ON "inventory_items" USING btree ("company_id","serial");--> statement-breakpoint
CREATE INDEX "inventory_items_company_store_status_idx" ON "inventory_items" USING btree ("company_id","store_id","status");--> statement-breakpoint
CREATE INDEX "inventory_items_company_product_idx" ON "inventory_items" USING btree ("company_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_stock_company_store_product_uniq" ON "inventory_stock" USING btree ("company_id","store_id","product_id");--> statement-breakpoint
CREATE INDEX "inventory_stock_company_idx" ON "inventory_stock" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "inv_tx_company_store_created_idx" ON "inventory_transactions" USING btree ("company_id","store_id","created_at");--> statement-breakpoint
CREATE INDEX "inv_tx_company_item_idx" ON "inventory_transactions" USING btree ("company_id","item_id");--> statement-breakpoint
CREATE INDEX "inv_tx_company_product_idx" ON "inventory_transactions" USING btree ("company_id","product_id");--> statement-breakpoint
CREATE INDEX "invitations_company_idx" ON "invitations" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_token_uniq" ON "invitations" USING btree ("token");--> statement-breakpoint
CREATE INDEX "outbox_returns_company_idx" ON "outbox_returns" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "outbox_returns_pending_idx" ON "outbox_returns" USING btree ("delivered_at","id");--> statement-breakpoint
CREATE INDEX "products_company_idx" ON "products" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "products_company_sku_uniq" ON "products" USING btree ("company_id","sku");--> statement-breakpoint
CREATE UNIQUE INDEX "products_company_upc_uniq" ON "products" USING btree ("company_id","upc") WHERE "products"."upc" is not null;--> statement-breakpoint
CREATE INDEX "stores_company_idx" ON "stores" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_company_code_uniq" ON "stores" USING btree ("company_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_company_building_uniq" ON "stores" USING btree ("company_id","external_building_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_receipts_company_handoff_uniq" ON "sync_receipts" USING btree ("company_id","handoff_id");--> statement-breakpoint
CREATE INDEX "users_company_idx" ON "users" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_company_email_uniq" ON "users" USING btree ("company_id","email");