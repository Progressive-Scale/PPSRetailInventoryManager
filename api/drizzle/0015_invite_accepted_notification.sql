ALTER TYPE "public"."notification_type" ADD VALUE 'INVITE_ACCEPTED';--> statement-breakpoint
ALTER TABLE "notifications" ALTER COLUMN "store_id" DROP NOT NULL;