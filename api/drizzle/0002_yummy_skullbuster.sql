DROP INDEX "stores_company_code_uniq";--> statement-breakpoint
DROP INDEX "stores_company_building_uniq";--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "address1" text;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "address2" text;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "state" text;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "zip" text;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "stores" DROP COLUMN "code";--> statement-breakpoint
ALTER TABLE "stores" DROP COLUMN "external_building_id";