-- Collapse pre-existing duplicates so the unique index below can be created:
-- keep the NEWEST live invitation per address and revoke the older ones.
UPDATE invitations SET revoked_at = now()
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           row_number() OVER (PARTITION BY company_id, lower(email) ORDER BY id DESC) AS rn
    FROM invitations
    WHERE accepted_at IS NULL AND revoked_at IS NULL
  ) ranked
  WHERE ranked.rn > 1
);--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_one_live_per_email_uniq" ON "invitations" USING btree ("company_id",lower("email")) WHERE "invitations"."accepted_at" is null and "invitations"."revoked_at" is null;
