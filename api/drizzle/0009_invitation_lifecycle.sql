-- Invitation lifecycle: hashed tokens, revocation, and email delivery status.
--
-- The plaintext token now appears exactly once (in the emailed accept URL); only
-- its sha256 is stored. Existing open invitations are PRESERVED by hashing their
-- current plaintext token in place, so links already sent keep working.
CREATE TYPE "public"."invitation_email_status" AS ENUM('PENDING', 'SENT', 'FAILED');--> statement-breakpoint

ALTER TABLE "invitations" RENAME COLUMN "token" TO "token_hash";--> statement-breakpoint
DROP INDEX IF EXISTS "invitations_token_uniq";--> statement-breakpoint
-- Hash the existing plaintext tokens in place (pgcrypto-free: sha256() is core
-- since PG 11 and returns bytea, so encode to hex to match the app's format).
UPDATE "invitations" SET "token_hash" = encode(sha256("token_hash"::bytea), 'hex');--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_token_hash_uniq" ON "invitations" USING btree ("token_hash");--> statement-breakpoint

ALTER TABLE "invitations" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "revoked_by_user_id" integer;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "email_status" "invitation_email_status" DEFAULT 'PENDING' NOT NULL;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "email_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "email_error" text;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- Invitations that predate email delivery were shared manually; treat them as
-- sent so they don't show up as "pending email" forever.
UPDATE "invitations" SET "email_status" = 'SENT', "email_sent_at" = "created_at";
