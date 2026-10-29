-- Reverses 0035_estimated_budget.
--
--   psql "$DATABASE_URL" -f down.sql
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '0035_estimated_budget';
--
-- Run it before rolling the containers back to an image older than P3-4, and
-- before 0034's down.sql. It REFUSES (the SET NOT NULL fails) while any budget
-- line has no stock item: the old code cannot read such a line. Delete or
-- re-key those revisions first; they are listed by
--   SELECT "proposalRevisionId" FROM "BomLine" WHERE "itemId" IS NULL;

ALTER TABLE "ProposalRevision"
  DROP COLUMN IF EXISTS "pricingMode",
  DROP COLUMN IF EXISTS "sellingTotal",
  DROP COLUMN IF EXISTS "contingencyPct",
  DROP COLUMN IF EXISTS "contingencyAmount",
  DROP COLUMN IF EXISTS "riskNotes";

ALTER TABLE "BomLine" DROP CONSTRAINT IF EXISTS "BomLine_workItemId_fkey";
DROP INDEX IF EXISTS "BomLine_workItemId_idx";
ALTER TABLE "BomLine" DROP CONSTRAINT IF EXISTS "BomLine_item_or_work_item_check";
ALTER TABLE "BomLine"
  DROP COLUMN IF EXISTS "workItemId",
  DROP COLUMN IF EXISTS "description",
  DROP COLUMN IF EXISTS "uom";
ALTER TABLE "BomLine" ALTER COLUMN "itemId" SET NOT NULL;

DROP TYPE IF EXISTS "PricingMode";
