-- Two notification types for the review queues: a count handed in for approval, and
-- unidentified items or products that an approval dropped into Needs Review.
--
-- ADD VALUE is safe inside drizzle's migration transaction because nothing here reads
-- the new labels; the first row using them is written by application code afterwards.
-- Same shape as 0027, which added REORDER_ACKNOWLEDGED.
ALTER TYPE "public"."notification_type" ADD VALUE IF NOT EXISTS 'CYCLE_COUNT_REVIEW';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE IF NOT EXISTS 'ITEMS_NEED_REVIEW';
