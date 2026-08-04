ALTER TABLE "inventory_items" ADD COLUMN "sold_at" timestamp with time zone;
--> statement-breakpoint
-- Backfill from the ledger for units that are SOLD right now. The newest SALE row
-- wins: a unit can be sold, reinstated by a count, and sold again, and only the
-- last sale describes the current status. Units in any other status keep NULL,
-- which is the same thing reinstate does going forward.
UPDATE "inventory_items" i
SET "sold_at" = s."created_at"
FROM (
  SELECT DISTINCT ON (t."item_id") t."item_id", t."created_at"
  FROM "inventory_transactions" t
  WHERE t."type" = 'SALE' AND t."item_id" IS NOT NULL
  ORDER BY t."item_id", t."created_at" DESC, t."id" DESC
) s
WHERE s."item_id" = i."id" AND i."status" = 'SOLD';
--> statement-breakpoint
-- Anything sold before the ledger existed (or sold by a path that skipped it)
-- would otherwise sort as "never sold"; fall back to the row's last touch.
UPDATE "inventory_items"
SET "sold_at" = "updated_at"
WHERE "status" = 'SOLD' AND "sold_at" IS NULL;
