-- Row-Level Security backstop for multi-tenancy.
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
-- Enable + FORCE RLS and attach the tenant-isolation policy to every
-- tenant-owned table. (companies is the registry, has no company_id, and is
-- intentionally NOT under RLS so tenant resolution can read it.)
-- ---------------------------------------------------------------------------
ALTER TABLE stores ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE stores FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON stores
  USING (current_setting('app.is_platform_admin', true) = 'on'
         OR company_id = nullif(current_setting('app.company_id', true), '')::int)
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'on'
         OR company_id = nullif(current_setting('app.company_id', true), '')::int);--> statement-breakpoint

ALTER TABLE users ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE users FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON users
  USING (current_setting('app.is_platform_admin', true) = 'on'
         OR company_id = nullif(current_setting('app.company_id', true), '')::int)
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'on'
         OR company_id = nullif(current_setting('app.company_id', true), '')::int);--> statement-breakpoint

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON invitations
  USING (current_setting('app.is_platform_admin', true) = 'on'
         OR company_id = nullif(current_setting('app.company_id', true), '')::int)
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'on'
         OR company_id = nullif(current_setting('app.company_id', true), '')::int);--> statement-breakpoint

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON api_keys
  USING (current_setting('app.is_platform_admin', true) = 'on'
         OR company_id = nullif(current_setting('app.company_id', true), '')::int)
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'on'
         OR company_id = nullif(current_setting('app.company_id', true), '')::int);--> statement-breakpoint

ALTER TABLE inventory_items ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE inventory_items FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON inventory_items
  USING (current_setting('app.is_platform_admin', true) = 'on'
         OR company_id = nullif(current_setting('app.company_id', true), '')::int)
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'on'
         OR company_id = nullif(current_setting('app.company_id', true), '')::int);--> statement-breakpoint

ALTER TABLE inventory_transactions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE inventory_transactions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON inventory_transactions
  USING (current_setting('app.is_platform_admin', true) = 'on'
         OR company_id = nullif(current_setting('app.company_id', true), '')::int)
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'on'
         OR company_id = nullif(current_setting('app.company_id', true), '')::int);--> statement-breakpoint

ALTER TABLE outbox_returns ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE outbox_returns FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON outbox_returns
  USING (current_setting('app.is_platform_admin', true) = 'on'
         OR company_id = nullif(current_setting('app.company_id', true), '')::int)
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'on'
         OR company_id = nullif(current_setting('app.company_id', true), '')::int);--> statement-breakpoint

-- companies: registry, no RLS, but grant the runtime role access.
GRANT SELECT, INSERT, UPDATE ON companies TO app_user;
