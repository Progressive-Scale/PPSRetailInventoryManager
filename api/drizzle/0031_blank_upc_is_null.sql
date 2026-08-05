-- A blank UPC means "no barcode", and only NULL says that.
--
-- products.upc is unique per company WHERE upc IS NOT NULL (migration 0001). An empty
-- string is not null, so two products whose UPC had been cleared to '' collided on that
-- index — and the error a user saw was "A product with that SKU or UPC already exists",
-- which is true of the constraint and useless as an explanation. Editing a serialized
-- product (which usually has no barcode at all) hit it first.
--
-- The API now normalises blank to NULL on every write path. This does the same to the rows
-- already stored, and the CHECK makes it structural: a future writer that forgets cannot
-- put the collision back.
UPDATE "products" SET "upc" = NULL WHERE "upc" IS NOT NULL AND btrim("upc") = '';--> statement-breakpoint

ALTER TABLE "products"
  ADD CONSTRAINT "products_upc_not_blank"
  CHECK ("upc" IS NULL OR btrim("upc") <> '');
