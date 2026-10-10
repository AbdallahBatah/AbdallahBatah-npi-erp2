-- Reverses 0022_crm_unified_customer. Run 0023's down.sql FIRST if 0023 was applied.
--
--   npx prisma db execute --file packages/db/prisma/migrations/0022_crm_unified_customer/down.sql --schema packages/db/prisma/schema.prisma
--   (or: psql "$DATABASE_URL" -f down.sql)
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '0022_crm_unified_customer';
--
-- What is lost, stated plainly because a rollback file that hides it is worse
-- than none:
--
-- 1. Contacts, the merge log and the settings rows are dropped with their
--    tables. Nothing else holds that information. Take a dump first.
--
-- 2. Customers that were merged away are NOT un-merged. The documents that
--    were moved to the surviving record stay there; only the pointer
--    (mergedIntoId) and the merge log disappear. After this rollback the
--    merged-away rows look like ordinary customers again, with no documents —
--    the way back from a merge is the database backup taken before it.
--
-- 3. Postgres cannot remove a value from an enum type. 'CUSTOMER' on
--    "AttachmentEntity" survives this rollback; it is harmless once the
--    Step 2 code is gone. Rows still HOLDING it are deleted below (the files
--    stay on disk under the uploads volume, unreferenced) because a client
--    that does not know the value would fail on meeting such a row.

DELETE FROM "Attachment" WHERE "entityType" = 'CUSTOMER';

-- Tables, children first. Their indexes and foreign keys go with them.
DROP TABLE IF EXISTS "CustomerContact";
DROP TABLE IF EXISTS "CustomerMergeLog";
DROP TABLE IF EXISTS "OrgSetting";

-- Indexes added on existing tables. The two on crNumber / vatNumber must be
-- dropped explicitly: those columns are older than this migration and stay, so
-- nothing drops their indexes for us. (The indexes on the new Customer columns
-- go with the columns, below.)
DROP INDEX IF EXISTS "Contract_customerId_idx";
DROP INDEX IF EXISTS "Invoice_customerId_idx";
DROP INDEX IF EXISTS "Customer_organizationId_crNumber_idx";
DROP INDEX IF EXISTS "Customer_organizationId_vatNumber_idx";

-- Dropping a column drops the indexes and the self-referencing foreign key
-- that mention it.
ALTER TABLE "Customer"
  DROP COLUMN IF EXISTS "entityKind",
  DROP COLUMN IF EXISTS "mobile",
  DROP COLUMN IF EXISTS "nameNormalized",
  DROP COLUMN IF EXISTS "mergedIntoId",
  DROP COLUMN IF EXISTS "mergedAt";

DROP TYPE IF EXISTS "CustomerEntityKind";

DROP FUNCTION IF EXISTS "npi_normalize_arabic_name"(TEXT);
DROP FUNCTION IF EXISTS "npi_normalize_saudi_mobile"(TEXT);
