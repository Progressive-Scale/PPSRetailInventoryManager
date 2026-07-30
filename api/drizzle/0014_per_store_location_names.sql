DROP INDEX "store_locations_company_name_uniq";--> statement-breakpoint
-- Location names go back to being unique per STORE, so each store owns a plain
-- "Backroom" / "On Floor" again. 0013 had qualified them with the store name.
UPDATE store_locations
SET name = CASE kind WHEN 'BACKROOM' THEN 'Backroom' ELSE 'On Floor' END
WHERE kind <> 'CUSTOM';--> statement-breakpoint
-- Guard against a store that ended up with two rows of a required kind (or a
-- custom location already using the name): keep the lowest id plain, suffix others.
WITH dupes AS (
  SELECT id, row_number() OVER (PARTITION BY company_id, store_id, lower(name) ORDER BY id) AS rn
  FROM store_locations
  WHERE is_active
)
UPDATE store_locations l
SET name = l.name || ' ' || dupes.rn
FROM dupes
WHERE dupes.id = l.id AND dupes.rn > 1;--> statement-breakpoint
CREATE UNIQUE INDEX "store_locations_company_store_name_uniq" ON "store_locations" USING btree ("company_id","store_id",lower("name")) WHERE "store_locations"."is_active";
