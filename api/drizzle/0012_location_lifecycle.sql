DROP INDEX "store_locations_store_systemkind_uniq";--> statement-breakpoint
DROP INDEX "store_locations_company_store_name_uniq";--> statement-breakpoint
CREATE UNIQUE INDEX "store_locations_company_store_name_uniq" ON "store_locations" USING btree ("company_id","store_id","name") WHERE "store_locations"."is_active";