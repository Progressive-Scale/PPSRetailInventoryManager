CREATE TABLE "products" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"price" numeric(12, 2) DEFAULT '0' NOT NULL,
	"upc" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "product_id" integer;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "products_company_idx" ON "products" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "products_company_sku_uniq" ON "products" USING btree ("company_id","sku");--> statement-breakpoint
CREATE INDEX "products_company_upc_idx" ON "products" USING btree ("company_id","upc");--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;