ALTER TYPE "public"."cycle_count_status" ADD VALUE 'AWAITING_REVIEW' BEFORE 'CLOSED';--> statement-breakpoint
ALTER TABLE "cycle_count_lines" ADD COLUMN "location_id" integer;--> statement-breakpoint
ALTER TABLE "cycle_count_lines" ADD COLUMN "location_from_id" integer;--> statement-breakpoint
ALTER TABLE "cycle_count_lines" ADD COLUMN "applied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cycle_counts" ADD COLUMN "submitted_by_user_id" integer;--> statement-breakpoint
ALTER TABLE "cycle_counts" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cycle_count_lines" ADD CONSTRAINT "cycle_count_lines_location_id_store_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."store_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_count_lines" ADD CONSTRAINT "cycle_count_lines_location_from_id_store_locations_id_fk" FOREIGN KEY ("location_from_id") REFERENCES "public"."store_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_counts" ADD CONSTRAINT "cycle_counts_submitted_by_user_id_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;