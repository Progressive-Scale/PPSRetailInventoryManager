-- RLS for the products catalog (same tenant_isolation policy as the rest).
ALTER TABLE products ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE products FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON products
  USING (current_setting('app.is_platform_admin', true) = 'on'
         OR company_id = nullif(current_setting('app.company_id', true), '')::int)
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'on'
         OR company_id = nullif(current_setting('app.company_id', true), '')::int);--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON products TO app_user;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE products_id_seq TO app_user;
