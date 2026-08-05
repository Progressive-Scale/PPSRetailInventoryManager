CREATE TYPE "public"."audit_actor_type" AS ENUM('USER', 'SYNC_AGENT', 'SYSTEM_JOB');--> statement-breakpoint
CREATE TYPE "public"."audit_source" AS ENUM('WEB', 'SCANNER', 'SYNC', 'JOB');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"store_id" integer,
	"actor_type" "audit_actor_type" NOT NULL,
	"user_id" integer,
	"api_key_id" integer,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"action" text NOT NULL,
	"field" text,
	"old_value" text,
	"new_value" text,
	"details" jsonb,
	"source" "audit_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_company_created_idx" ON "audit_events" USING btree ("company_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_events_company_entity_idx" ON "audit_events" USING btree ("company_id","entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_company_user_idx" ON "audit_events" USING btree ("company_id","user_id","created_at");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Tenancy: the same isolation policy every other tenant-owned table carries.
-- ---------------------------------------------------------------------------
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "audit_events"
  USING (current_setting('app.is_platform_admin', true) = 'on'
         OR company_id = nullif(current_setting('app.company_id', true), '')::int)
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'on'
         OR company_id = nullif(current_setting('app.company_id', true), '')::int);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Append-only. An audit trail an application can edit is not an audit trail.
--
-- The REVOKE is explicit and must come AFTER the CREATE TABLE, because
-- 0001_rls_and_view.sql set ALTER DEFAULT PRIVILEGES granting SELECT/INSERT/
-- UPDATE/DELETE on every future table to app_user — this table included.
--
-- Scope, stated plainly: this binds app_user, which is the role the API runs as.
-- It does NOT bind the migration owner or a superuser; a DBA with those rights can
-- still rewrite history, and no grant-based scheme can prevent that. What it does
-- prevent is the application doing it, deliberately or by accident.
-- ---------------------------------------------------------------------------
REVOKE UPDATE, DELETE ON "audit_events" FROM app_user;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Carry the existing item_audit rows in. They are all field edits on inventory
-- items; their source enum maps onto the new one, and BULK_EDIT vs SINGLE_EDIT is
-- preserved in details rather than lost, since the new source column records the
-- door the write came through (WEB) rather than the shape of the edit.
-- ---------------------------------------------------------------------------
INSERT INTO "audit_events" (
  company_id, store_id, actor_type, user_id, api_key_id,
  entity_type, entity_id, action, field, old_value, new_value, details, source, created_at
)
SELECT
  a.company_id,
  i.store_id,
  CASE WHEN a.source = 'SYNC' THEN 'SYNC_AGENT' ELSE 'USER' END::audit_actor_type,
  CASE WHEN a.source = 'SYNC' THEN NULL ELSE a.changed_by_user_id END,
  NULL,
  'INVENTORY_ITEM',
  a.item_id::text,
  'UPDATED',
  a.field,
  a.old_value,
  a.new_value,
  jsonb_strip_nulls(jsonb_build_object('editKind', a.source::text, 'note', a.note, 'migratedFrom', 'item_audit')),
  CASE WHEN a.source = 'SYNC' THEN 'SYNC' ELSE 'WEB' END::audit_source,
  a.created_at
FROM item_audit a
JOIN inventory_items i ON i.id = a.item_id;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- item_audit becomes a view over the new stream, so ad-hoc SQL and anything
-- reading it keep working while there is exactly one place rows are written.
-- security_invoker so the reader's RLS applies (same posture as store_inventory).
-- ---------------------------------------------------------------------------
DROP TABLE item_audit;--> statement-breakpoint
CREATE VIEW item_audit WITH (security_invoker = true) AS
SELECT
  e.id,
  e.company_id,
  e.entity_id::uuid AS item_id,
  e.field,
  e.old_value,
  e.new_value,
  e.user_id AS changed_by_user_id,
  COALESCE(e.details->>'editKind', CASE WHEN e.actor_type = 'SYNC_AGENT' THEN 'SYNC' ELSE 'SINGLE_EDIT' END) AS source,
  e.details->>'note' AS note,
  e.created_at
FROM audit_events e
WHERE e.entity_type = 'INVENTORY_ITEM' AND e.field IS NOT NULL;--> statement-breakpoint
GRANT SELECT ON item_audit TO app_user;
