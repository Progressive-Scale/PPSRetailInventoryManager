-- STORE_MANAGER: a store-scoped role that may correct its own store's inventory.
--
-- Appended rather than inserted in rank order because the enum's stored order is
-- physical: reordering means recreating the type and rewriting every users row,
-- and nothing sorts by this column. Rank is expressed in code, not in the enum.
--
-- IF NOT EXISTS keeps this idempotent, and PostgreSQL 12+ permits ADD VALUE inside
-- a transaction block as long as the new value is not used in the same one. This
-- migration only declares it; the first STORE_MANAGER row comes later.
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'STORE_MANAGER';
