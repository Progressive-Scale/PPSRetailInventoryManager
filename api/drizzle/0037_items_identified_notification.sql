-- The answer side of the review queue: pps named a serial the store could not, and the
-- people who asked should hear about it without going back to look.
ALTER TYPE "public"."notification_type" ADD VALUE IF NOT EXISTS 'ITEMS_IDENTIFIED';
