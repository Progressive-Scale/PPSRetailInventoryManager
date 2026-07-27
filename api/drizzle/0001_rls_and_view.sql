-- Row-Level Security backstop for multi-tenancy + the store_inventory read view.
--
-- The API connects at runtime as a NON-superuser role (app_user) so these
-- policies actually apply (superusers/owners bypass RLS). Per request the API
-- opens a transaction and sets:
--     set_config('app.company_id', '<id>', true)      -- tenant scope
--     set_config('app.is_platform_admin', 'on', true) -- explicit bypass
-- Policies allow a row when the request is in platform-admin bypass mode OR the
-- row's company_id matches app.company_id. Unset settings -> NULL -> deny.

-- ---------------------------------------------------------------------------
-- Restricted runtime role (local dev convenience). For production, create a
-- least-privileged role yourself and point APP_DATABASE_URL at it.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN PASSWORD 'app_user_dev_pw';
  END IF;
END
$$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO app_user;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;--> statement-breakpoint
-- Future tables/sequences created by the migration owner.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_user;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Enable + FORCE RLS and attach the identical tenant-isolation policy to every
-- tenant-owned table. (companies is the registry, has no company_id, and is
-- intentionally NOT under RLS so tenant resolution can read it.)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'stores', 'users', 'invitations', 'api_keys', 'products',
    'inventory_items', 'inventory_stock', 'inventory_transactions',
    'sync_receipts', 'outbox_returns', 'cycle_counts', 'cycle_count_lines'
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
$$;
--> statement-breakpoint

-- companies: registry, no RLS, but grant the runtime role access.
GRANT SELECT, INSERT, UPDATE ON companies TO app_user;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- store_inventory — product-level on-hand per store, unifying both tracking
-- types. security_invoker=true so the underlying tables' RLS still applies
-- (the view runs as the querying app_user, honoring app.company_id).
--   serialized -> COUNT of ON_HAND units per (store, product)
--   quantity   -> the stock counter row
-- Serialized products keep a row even at 0 on-hand (all units sold) so they
-- remain visible/drillable in the portal.
-- ---------------------------------------------------------------------------
CREATE VIEW store_inventory WITH (security_invoker = true) AS
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
    s.quantity_on_hand                                     AS on_hand
  FROM inventory_stock s
  JOIN products p ON p.id = s.product_id;--> statement-breakpoint

GRANT SELECT ON store_inventory TO app_user;
