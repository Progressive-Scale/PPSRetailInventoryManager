-- Location names become unique per COMPANY (case-insensitively) among ACTIVE
-- rows, so a cross-store list is unambiguous. Existing data has one "Backroom"
-- and one "On Floor" per store, so qualify the required-kind names with their
-- store before the index can be created.
UPDATE store_locations l
SET name = s.name || ' ' || CASE l.kind WHEN 'BACKROOM' THEN 'Backroom' ELSE 'On Floor' END
FROM stores s
WHERE s.id = l.store_id AND l.kind <> 'CUSTOM';--> statement-breakpoint
-- Anything still colliding (custom names, or two stores sharing a name) gets a
-- numeric suffix, keeping the lowest id unchanged.
WITH dupes AS (
  SELECT id, row_number() OVER (PARTITION BY company_id, lower(name) ORDER BY id) AS rn
  FROM store_locations
  WHERE is_active
)
UPDATE store_locations l
SET name = l.name || ' ' || dupes.rn
FROM dupes
WHERE dupes.id = l.id AND dupes.rn > 1;--> statement-breakpoint
DROP INDEX "store_locations_company_store_name_uniq";--> statement-breakpoint
CREATE UNIQUE INDEX "store_locations_company_name_uniq" ON "store_locations" USING btree ("company_id",lower("name")) WHERE "store_locations"."is_active";
