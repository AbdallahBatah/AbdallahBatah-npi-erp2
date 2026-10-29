-- Reverses 0040_project_plan.
--   psql "$DATABASE_URL" -f down.sql
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '0040_project_plan';
-- The elements stay with their budgets; their work item, quantity, unit and
-- planned dates are dropped.

ALTER TABLE "WbsElement" DROP CONSTRAINT IF EXISTS "WbsElement_workItemId_fkey";
DROP INDEX IF EXISTS "WbsElement_workItemId_idx";
ALTER TABLE "WbsElement"
  DROP COLUMN IF EXISTS "workItemId",
  DROP COLUMN IF EXISTS "qty",
  DROP COLUMN IF EXISTS "uom",
  DROP COLUMN IF EXISTS "plannedStart",
  DROP COLUMN IF EXISTS "plannedEnd";
