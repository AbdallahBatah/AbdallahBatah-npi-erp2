-- Reverses 0036_budget_templates.
--
--   psql "$DATABASE_URL" -f down.sql
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '0036_budget_templates';
--
-- Run it before 0035's down.sql. The templates are lost (their edits are in
-- "AuditLog"); budgets built from them keep every line, only the pointer goes.

ALTER TABLE "ProposalRevision" DROP CONSTRAINT IF EXISTS "ProposalRevision_templateId_fkey";
ALTER TABLE "ProposalRevision" DROP COLUMN IF EXISTS "templateId";
DROP TABLE IF EXISTS "BudgetTemplateLine";
DROP TABLE IF EXISTS "BudgetTemplate";
