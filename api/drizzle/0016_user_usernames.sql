-- Sign-in usernames, unique per company.
--
-- drizzle-kit generates this as a single `ADD COLUMN ... NOT NULL`, which cannot
-- work on a populated users table. Added nullable instead, backfilled, and only
-- then constrained. The index statement is left exactly as generated so the
-- snapshot stays in step.
ALTER TABLE "users" ADD COLUMN "username" text;--> statement-breakpoint

-- Backfill from the email local part: lowercased, with runs of characters not
-- allowed in a username collapsed to a single dot and the dots trimmed off the
-- ends. Anything that comes out empty or shorter than the 3-character minimum
-- falls back to "user<id>", which is always valid and always unique.
--
-- Collisions are real: alice@a.com and alice@b.com both derive "alice" within one
-- company. row_number() over the derived value orders them by id and suffixes the
-- second onwards, so the oldest account keeps the bare name. company_id is null
-- for PLATFORM_ADMIN and window partitioning treats those nulls as one group,
-- which is what we want — they compete with each other, not with a tenant.
WITH derived AS (
  SELECT
    id,
    company_id,
    COALESCE(
      NULLIF(
        BTRIM(
          REGEXP_REPLACE(
            LOWER(SPLIT_PART(email, '@', 1)),
            '[^a-z0-9._-]+', '.', 'g'
          ),
          '.'
        ),
        ''
      ),
      'user' || id
    ) AS candidate
  FROM "users"
),
guarded AS (
  SELECT
    id,
    company_id,
    CASE WHEN LENGTH(candidate) < 3 THEN 'user' || id ELSE candidate END AS candidate
  FROM derived
),
numbered AS (
  SELECT
    id,
    candidate,
    ROW_NUMBER() OVER (PARTITION BY company_id, candidate ORDER BY id) AS rn
  FROM guarded
)
UPDATE "users" u
SET username = CASE WHEN n.rn = 1 THEN n.candidate ELSE n.candidate || n.rn END
FROM numbered n
WHERE u.id = n.id;--> statement-breakpoint

ALTER TABLE "users" ALTER COLUMN "username" SET NOT NULL;--> statement-breakpoint

-- Case-insensitive so two accounts cannot differ only by capitalisation when
-- either spelling can be typed at login. coalesce because a null company_id
-- (PLATFORM_ADMIN) would otherwise count as distinct and go unconstrained.
CREATE UNIQUE INDEX "users_company_username_uniq" ON "users" USING btree (coalesce("company_id", 0),lower("username"));
