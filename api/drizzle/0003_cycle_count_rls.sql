-- RLS for the cycle-count tables (same tenant_isolation policy as the rest).
-- app_user already has table privileges via the ALTER DEFAULT PRIVILEGES set in
-- 0001 (these tables were created by the migration owner), so only policies are
-- needed here.

ALTER TABLE cycle_counts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE cycle_counts FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON cycle_counts
  USING (current_setting('app.is_platform_admin', true) = 'on'
         OR company_id = nullif(current_setting('app.company_id', true), '')::int)
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'on'
         OR company_id = nullif(current_setting('app.company_id', true), '')::int);--> statement-breakpoint

ALTER TABLE cycle_count_lines ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE cycle_count_lines FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON cycle_count_lines
  USING (current_setting('app.is_platform_admin', true) = 'on'
         OR company_id = nullif(current_setting('app.company_id', true), '')::int)
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'on'
         OR company_id = nullif(current_setting('app.company_id', true), '')::int);--> statement-breakpoint

-- Belt-and-suspenders explicit grants (in case default privileges didn't apply).
GRANT SELECT, INSERT, UPDATE, DELETE ON cycle_counts TO app_user;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON cycle_count_lines TO app_user;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE cycle_counts_id_seq TO app_user;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE cycle_count_lines_id_seq TO app_user;
