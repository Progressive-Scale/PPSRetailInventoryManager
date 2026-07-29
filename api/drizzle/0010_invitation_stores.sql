CREATE TABLE "invitation_stores" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"invitation_id" integer NOT NULL,
	"store_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invitation_stores" ADD CONSTRAINT "invitation_stores_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_stores" ADD CONSTRAINT "invitation_stores_invitation_id_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_stores" ADD CONSTRAINT "invitation_stores_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invitation_stores_invitation_store_uniq" ON "invitation_stores" USING btree ("invitation_id","store_id");--> statement-breakpoint
CREATE INDEX "invitation_stores_company_invitation_idx" ON "invitation_stores" USING btree ("company_id","invitation_id");--> statement-breakpoint
-- RLS: enable + FORCE + tenant-isolation policy (mirrors migration 0001).
ALTER TABLE "invitation_stores" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invitation_stores" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "invitation_stores"
  USING (current_setting('app.is_platform_admin', true) = 'on'
         OR company_id = nullif(current_setting('app.company_id', true), '')::int)
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'on'
         OR company_id = nullif(current_setting('app.company_id', true), '')::int);--> statement-breakpoint
-- Backfill: an existing invitation pinned to one store keeps that store.
INSERT INTO invitation_stores (company_id, invitation_id, store_id)
SELECT i.company_id, i.id, i.store_id
FROM invitations i
WHERE i.store_id IS NOT NULL
ON CONFLICT (invitation_id, store_id) DO NOTHING;
