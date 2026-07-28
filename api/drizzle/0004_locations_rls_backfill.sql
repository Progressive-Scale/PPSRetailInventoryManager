-- Inventory Locations: RLS on the 3 new tenant tables, store_inventory view
-- replace (sum on-hand across locations), and a production-safe backfill that
-- gives every existing store its two SYSTEM locations and lands every existing
-- item/stock row in that store's BACKROOM. Runs after 0003 (which adds the
-- location columns nullable); this migration backfills them and sets NOT NULL.

-- ---------------------------------------------------------------------------
-- RLS: enable + FORCE + attach the identical tenant-isolation policy to the
-- three new tenant-owned tables (mirrors migration 0001).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'store_locations', 'notification_settings', 'notifications'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      'USING (current_setting(''app.is_platform_admin'', true) = ''on'' '
      '       OR company_id = nullif(current_setting(''app.company_id'', true), '''')::int) '
      'WITH CHECK (current_setting(''app.is_platform_admin'', true) = ''on'' '
      '       OR company_id = nullif(current_setting(''app.company_id'', true), '''')::int)',
      t
    );
  END LOOP;
END
$$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Backfill: every existing store gets a BACKROOM + ON_FLOOR system location,
-- then existing inventory_items / inventory_stock land in that store's BACKROOM.
-- Idempotent via ON CONFLICT against the (store_id, kind) system-kind unique.
-- Runs as the migration owner (bypasses RLS) so it sees all companies' rows.
-- ---------------------------------------------------------------------------
INSERT INTO store_locations (company_id, store_id, name, kind, sort_order)
SELECT s.company_id, s.id, 'Backroom', 'BACKROOM', 0 FROM stores s
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO store_locations (company_id, store_id, name, kind, sort_order)
SELECT s.company_id, s.id, 'On Floor', 'ONFLOOR', 1 FROM stores s
ON CONFLICT DO NOTHING;--> statement-breakpoint

UPDATE inventory_items i
SET location_id = l.id
FROM store_locations l
WHERE l.store_id = i.store_id
  AND l.kind = 'BACKROOM'
  AND i.location_id IS NULL;--> statement-breakpoint

UPDATE inventory_stock s
SET location_id = l.id
FROM store_locations l
WHERE l.store_id = s.store_id
  AND l.kind = 'BACKROOM'
  AND s.location_id IS NULL;--> statement-breakpoint

-- Now that every row has a location, enforce NOT NULL.
ALTER TABLE inventory_items ALTER COLUMN location_id SET NOT NULL;--> statement-breakpoint
ALTER TABLE inventory_stock ALTER COLUMN location_id SET NOT NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- store_inventory view replace: on_hand now sums quantity_on_hand across all
-- locations for quantity products (serialized branch unchanged). Keeps
-- security_invoker=true so tenant RLS still applies.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW store_inventory WITH (security_invoker = true) AS
  SELECT
    i.company_id,
    i.store_id,
    p.id                                                   AS product_id,
    p.sku,
    p.upc,
    p.name,
    p.tracking_type,
    (count(*) FILTER (WHERE i.status = 'ON_HAND'))::int    AS on_hand
  FROM inventory_items i
  JOIN products p ON p.id = i.product_id
  GROUP BY i.company_id, i.store_id, p.id, p.sku, p.upc, p.name, p.tracking_type
  UNION ALL
  SELECT
    s.company_id,
    s.store_id,
    p.id                                                   AS product_id,
    p.sku,
    p.upc,
    p.name,
    p.tracking_type,
    (sum(s.quantity_on_hand))::int                         AS on_hand
  FROM inventory_stock s
  JOIN products p ON p.id = s.product_id
  GROUP BY s.company_id, s.store_id, p.id, p.sku, p.upc, p.name, p.tracking_type;
