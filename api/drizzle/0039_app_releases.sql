-- Scanner self-update: published releases, named channels, per-company channel
-- assignment, and what each device reports it is running.
--
-- app_releases and release_channels are PLATFORM-scoped — no company_id, no RLS,
-- exactly like `companies`. device_app_versions IS tenant-owned and gets the
-- standard tenant_isolation policy at the bottom of this file.
--
-- NOTE on the generated snapshot accompanying this migration: `drizzle-kit
-- generate` also re-emitted the enum values and inventory_items columns added by
-- the hand-written 0034-0038, because those never updated the snapshot. They are
-- verified present in the database and are deliberately NOT repeated here; the
-- refreshed snapshot brings drizzle's model back in line with reality.

CREATE TABLE "app_releases" (
	"id" serial PRIMARY KEY NOT NULL,
	"version_code" integer NOT NULL,
	"version_name" text NOT NULL,
	"apk_url" text NOT NULL,
	"apk_sha256" text NOT NULL,
	"release_notes" text,
	"file_size_bytes" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- Enforced here as well as in the DTO: a bad URL or a mistyped hash is only
	-- discovered on a store's device, as a failed update, hours later.
	CONSTRAINT "app_releases_url_https" CHECK ("app_releases"."apk_url" LIKE 'https://%'),
	CONSTRAINT "app_releases_sha256_hex" CHECK ("app_releases"."apk_sha256" ~ '^[0-9a-f]{64}$')
);--> statement-breakpoint

CREATE UNIQUE INDEX "app_releases_version_code_uniq" ON "app_releases" USING btree ("version_code");--> statement-breakpoint

CREATE TABLE "release_channels" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"release_id" integer,
	"min_supported_release_id" integer
);--> statement-breakpoint

CREATE UNIQUE INDEX "release_channels_name_uniq" ON "release_channels" USING btree ("name");--> statement-breakpoint

ALTER TABLE "release_channels" ADD CONSTRAINT "release_channels_release_id_app_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."app_releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_channels" ADD CONSTRAINT "release_channels_min_supported_release_id_app_releases_id_fk" FOREIGN KEY ("min_supported_release_id") REFERENCES "public"."app_releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- The two seeded channels. Both start pointing at nothing, which reads as "no
-- update available" — the correct answer until a release row exists.
INSERT INTO "release_channels" ("name") VALUES ('stable'), ('beta')
ON CONFLICT ("name") DO NOTHING;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- companies.release_channel_id — added nullable, backfilled, then made NOT NULL,
-- because the column has to exist before existing rows can be given a value.
-- ---------------------------------------------------------------------------
ALTER TABLE "companies" ADD COLUMN "release_channel_id" integer;--> statement-breakpoint

UPDATE "companies"
SET "release_channel_id" = (SELECT "id" FROM "release_channels" WHERE "name" = 'stable')
WHERE "release_channel_id" IS NULL;--> statement-breakpoint

-- A real database-level DEFAULT, so a company created by any code path — including
-- one written before this feature existed — lands on the conservative channel
-- rather than failing or landing on none. Looked up rather than hard-coded as 1:
-- the id is data, and assuming it is the reason defaults like this rot.
DO $$
DECLARE
  stable_id int;
BEGIN
  SELECT id INTO STRICT stable_id FROM release_channels WHERE name = 'stable';
  EXECUTE format('ALTER TABLE companies ALTER COLUMN release_channel_id SET DEFAULT %s', stable_id);
END
$$;--> statement-breakpoint

ALTER TABLE "companies" ALTER COLUMN "release_channel_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_release_channel_id_release_channels_id_fk" FOREIGN KEY ("release_channel_id") REFERENCES "public"."release_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- device_app_versions — tenant-owned, one row per device.
-- ---------------------------------------------------------------------------
CREATE TABLE "device_app_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"user_id" integer,
	"device_identifier" text NOT NULL,
	"version_code" integer NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "device_app_versions" ADD CONSTRAINT "device_app_versions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_app_versions" ADD CONSTRAINT "device_app_versions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- The upsert target for a version report.
CREATE UNIQUE INDEX "device_app_versions_company_device_uniq" ON "device_app_versions" USING btree ("company_id","device_identifier");--> statement-breakpoint
CREATE INDEX "device_app_versions_company_idx" ON "device_app_versions" USING btree ("company_id");--> statement-breakpoint

-- RLS, identical in shape to migration 0001. Only device_app_versions gets this:
-- the other two tables here are platform-scoped and have no company_id to filter on.
ALTER TABLE "device_app_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "device_app_versions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "device_app_versions"
  USING (current_setting('app.is_platform_admin', true) = 'on'
         OR company_id = nullif(current_setting('app.company_id', true), '')::int)
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'on'
         OR company_id = nullif(current_setting('app.company_id', true), '')::int);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Privilege tightening, in the style of 0029.
--
-- 0001 set ALTER DEFAULT PRIVILEGES granting app_user SELECT/INSERT/UPDATE/DELETE
-- on every future table, so all three tables here are already writable. That is
-- more than any of them needs, and these two are platform-scoped: they carry no
-- company_id, so RLS is not what protects them — only the PlatformAdminGuard is.
-- Note withBypass is a session variable, NOT a second role: platform-admin writes
-- arrive as app_user like everything else. Narrowing the grant is therefore the
-- one control that survives a routing or guard mistake.
--
-- app_releases is append-only by design (see the schema comment: editing a hash
-- under devices that already verified it turns a good install into a corrupt one).
REVOKE UPDATE, DELETE ON "app_releases" FROM app_user;--> statement-breakpoint
-- Channels are repointed constantly — that IS the rollout mechanism — but a channel
-- is never deleted; companies reference it.
REVOKE DELETE ON "release_channels" FROM app_user;--> statement-breakpoint
-- Device reports are upserted and never removed by the app.
REVOKE DELETE ON "device_app_versions" FROM app_user;
