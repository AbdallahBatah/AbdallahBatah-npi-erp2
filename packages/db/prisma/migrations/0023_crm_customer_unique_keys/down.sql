-- Reverses 0023_crm_customer_unique_keys.
--
--   npx prisma db execute --file packages/db/prisma/migrations/0023_crm_customer_unique_keys/down.sql --schema packages/db/prisma/schema.prisma
--   (or: psql "$DATABASE_URL" -f down.sql)
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '0023_crm_customer_unique_keys';
--
-- Dropping the indexes loses no data. After this the database no longer refuses
-- a second customer with the same CR / VAT / mobile; only the application-level
-- check (CustomersService.assertNoDuplicateKeys) stands in the way.

DROP INDEX IF EXISTS "Customer_org_crNumber_active_key";
DROP INDEX IF EXISTS "Customer_org_vatNumber_active_key";
DROP INDEX IF EXISTS "Customer_org_mobile_active_key";
