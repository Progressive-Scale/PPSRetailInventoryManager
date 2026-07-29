CREATE TABLE "user_stores" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"store_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_stores" ADD CONSTRAINT "user_stores_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_stores" ADD CONSTRAINT "user_stores_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_stores" ADD CONSTRAINT "user_stores_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_stores_user_store_uniq" ON "user_stores" USING btree ("user_id","store_id");--> statement-breakpoint
CREATE INDEX "user_stores_company_user_idx" ON "user_stores" USING btree ("company_id","user_id");--> statement-breakpoint
-- RLS: enable + FORCE + tenant-isolation policy (mirrors migration 0001).
ALTER TABLE "user_stores" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_stores" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "user_stores"
  USING (current_setting('app.is_platform_admin', true) = 'on'
         OR company_id = nullif(current_setting('app.company_id', true), '')::int)
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'on'
         OR company_id = nullif(current_setting('app.company_id', true), '')::int);--> statement-breakpoint
-- Backfill: every user already pinned to a store gets that store as permitted.
INSERT INTO user_stores (company_id, user_id, store_id)
SELECT u.company_id, u.id, u.store_id
FROM users u
WHERE u.company_id IS NOT NULL AND u.store_id IS NOT NULL
ON CONFLICT (user_id, store_id) DO NOTHING;
