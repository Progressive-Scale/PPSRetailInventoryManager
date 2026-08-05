-- Append-only for audit_events, enforced for EVERY role.
--
-- Migration 0029 revoked UPDATE and DELETE from app_user, which is the role the API is
-- meant to run as. Verification found that insufficient on its own: the dev DATABASE_URL
-- connects as the table OWNER, and an owner keeps its implicit privileges no matter what is
-- revoked from anyone else. A trail that the application's own connection can rewrite is not
-- a trail — and "which role is in the connection string" is a deployment detail, not
-- something the guarantee should depend on.
--
-- A trigger is role-proof: it fires for owners, superusers and app_user alike. The grants
-- from 0029 stay as the first line of defence (a revoked privilege never reaches a trigger);
-- this is the line that holds when the grant does not.
--
-- NOTE: inventory_transactions — the movement ledger — is still protected by grants alone.
-- Tightening it the same way is a separate change with its own verification, deliberately
-- not smuggled in here.
CREATE OR REPLACE FUNCTION audit_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'audit_events is append-only: % is not permitted (attempted on table %)',
    TG_OP, TG_TABLE_NAME
    USING HINT = 'Record a corrective event instead of altering history.';
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS audit_events_no_update ON "audit_events";--> statement-breakpoint
CREATE TRIGGER audit_events_no_update
  BEFORE UPDATE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();--> statement-breakpoint

DROP TRIGGER IF EXISTS audit_events_no_delete ON "audit_events";--> statement-breakpoint
CREATE TRIGGER audit_events_no_delete
  BEFORE DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();--> statement-breakpoint

-- TRUNCATE takes no row-level trigger, and it is the one statement that could empty the
-- table in a single line by accident.
DROP TRIGGER IF EXISTS audit_events_no_truncate ON "audit_events";--> statement-breakpoint
CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON "audit_events"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_append_only();
