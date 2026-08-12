-- Pieces out of a tray-pack case carry the case's serial as grouping metadata.
--
-- The case itself gets no row: the pieces are the inventory (own product, weight,
-- sell-by, price) and the case is the barcode on the box meaning "these pieces". A row
-- for the case would double the store's on-hand and offer a unit nobody can sell.
--
-- Stored as the GS1 AI (21) value, the same form `serial` uses, so scanning the box and
-- scanning a piece resolve against comparable strings.
--
-- Existing rows get NULL, which is the ordinary "arrived on its own" case. Nothing about
-- their behaviour changes.
ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "case_serial" text;
--> statement-breakpoint
-- A case scan resolves to every piece sharing the value, on the hot path of a cycle
-- count. Partial because most units are not pieces; not unique because sharing is the point.
CREATE INDEX IF NOT EXISTS "inventory_items_company_case_serial_idx"
  ON "inventory_items" ("company_id", "case_serial")
  WHERE "case_serial" IS NOT NULL;
