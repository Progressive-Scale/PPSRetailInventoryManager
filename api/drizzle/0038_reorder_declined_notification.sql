-- The ERP can now say no to a reorder, and the person who asked should hear it rather
-- than waiting for a delivery nobody is sending.
ALTER TYPE "public"."notification_type" ADD VALUE IF NOT EXISTS 'REORDER_DECLINED';
