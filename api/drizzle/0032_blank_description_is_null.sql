-- Same fault as the blank UPC, different consequence.
--
-- The edit form submitted '' for a description the user never filled in, and the row went
-- from NULL to '' — a change to the database and no change to anything a person can read.
-- The audit trail dutifully reported "Changed description: — → ", which is noise that makes
-- the real edits harder to find.
--
-- Blanks are normalised to NULL on write now (products, ERP import answers, the catalog
-- helper) and the diff treats '' and NULL as the same absence. This clears the rows already
-- stored that way, so their next edit does not report a phantom change on the way past.
--
-- No CHECK here, unlike upc: a blank description breaks nothing structurally, and a
-- constraint would turn a sloppy ERP payload into a failed sync instead of a tidy NULL.
UPDATE "products" SET "description" = NULL
 WHERE "description" IS NOT NULL AND btrim("description") = '';
