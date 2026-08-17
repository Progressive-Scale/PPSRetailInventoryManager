-- products.price_embedded_code — the 5-digit product code inside an in-store
-- price-embedded label (`2{code5}{price5}{check}`).
--
-- Why a second column rather than reusing `upc`: prefix 2 is AMBIGUOUS. GS1
-- reserves it for in-store/variable-weight use, but nothing stops a supplier's
-- genuine catalog UPC from starting with 2, and the two mean completely different
-- things — one identifies a product to buy, the other is a price sticker whose
-- digits change with every piece. Storing them apart is what lets the resolver
-- answer "catalog UPC or price label?" from data instead of from the format.
--
-- TEXT because leading zeros are significant: 07318 is a real code and 7318 is not.

ALTER TABLE "products" ADD COLUMN "price_embedded_code" text;--> statement-breakpoint

-- A lookup key, so duplicates would make a scan ambiguous exactly where it must
-- not be. Partial, so the many products without one do not collide on NULL.
CREATE UNIQUE INDEX "products_company_price_code_uniq"
  ON "products" USING btree ("company_id","price_embedded_code")
  WHERE "price_embedded_code" IS NOT NULL;--> statement-breakpoint

-- Exactly five digits. Also validated in the DTO; repeated here because the
-- symptom of a malformed code is a scan that resolves to nothing, at a shelf,
-- days after somebody typed it.
ALTER TABLE "products" ADD CONSTRAINT "products_price_code_5_digits"
  CHECK ("price_embedded_code" IS NULL OR "price_embedded_code" ~ '^[0-9]{5}$');
