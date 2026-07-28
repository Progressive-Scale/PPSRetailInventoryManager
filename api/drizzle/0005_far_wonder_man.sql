ALTER TABLE "inventory_stock" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- Backfill created_at from the earliest RECEIPT into that location (best effort;
-- rows with no matching receipt keep the now() default).
UPDATE inventory_stock s
SET created_at = t.first_receipt
FROM (
  SELECT company_id, store_id, product_id, location_to_id AS location_id,
         min(created_at) AS first_receipt
  FROM inventory_transactions
  WHERE type = 'RECEIPT' AND location_to_id IS NOT NULL
  GROUP BY company_id, store_id, product_id, location_to_id
) t
WHERE s.company_id = t.company_id
  AND s.store_id = t.store_id
  AND s.product_id = t.product_id
  AND s.location_id = t.location_id;