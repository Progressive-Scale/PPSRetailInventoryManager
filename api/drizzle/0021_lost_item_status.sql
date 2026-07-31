ALTER TYPE "public"."item_status" ADD VALUE 'LOST';--> statement-breakpoint
ALTER TABLE "inventory_items" DROP CONSTRAINT "inventory_items_pending_has_no_location";--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_pending_has_no_location" CHECK ((status::text = 'PENDING' AND location_id IS NULL)
          OR status::text = 'LOST'
          OR (status::text NOT IN ('PENDING', 'LOST') AND location_id IS NOT NULL));