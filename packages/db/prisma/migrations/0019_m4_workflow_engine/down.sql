-- Reverses 0017_m4_workflow_engine.
--
-- Prisma does not generate or run down migrations; this file is the reversibility
-- artifact the architecture requires ("لا تحذف ولا تعدّل أي جدول قائم إلا بترحيل
-- قابل للتراجع"). Apply it by hand:
--
--   psql "$DATABASE_URL" -f down.sql
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '0017_m4_workflow_engine';
--
-- WARNING — this is lossy by nature: dropping the workflow tables discards
-- every recorded state transition. Take a dump first. Nothing that existed
-- before 0017 is touched: the added columns are dropped, and no pre-existing
-- column, row or enum value is altered.

-- Drop the added foreign keys before the tables they point at.
ALTER TABLE "ApprovalRule" DROP CONSTRAINT IF EXISTS "ApprovalRule_departmentId_fkey";
ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "User_departmentId_fkey";

-- Added columns on pre-existing tables.
DROP INDEX IF EXISTS "ApprovalRule_organizationId_documentType_departmentId_isActi_idx";
DROP INDEX IF EXISTS "User_organizationId_departmentId_idx";
ALTER TABLE "ApprovalRule"    DROP COLUMN IF EXISTS "departmentId";
ALTER TABLE "ApprovalRule"    DROP COLUMN IF EXISTS "escalationHours";
ALTER TABLE "ApprovalRequest" DROP COLUMN IF EXISTS "currentStepAt";
ALTER TABLE "ApprovalRequest" DROP COLUMN IF EXISTS "departmentId";
ALTER TABLE "ApprovalStep"    DROP COLUMN IF EXISTS "escalatedAt";
ALTER TABLE "ApprovalStep"    DROP COLUMN IF EXISTS "delegationId";
ALTER TABLE "User"            DROP COLUMN IF EXISTS "departmentId";

-- New tables, children first.
DROP TABLE IF EXISTS "ApprovalDelegation";
DROP TABLE IF EXISTS "wf_history";
DROP TABLE IF EXISTS "wf_instances";
DROP TABLE IF EXISTS "wf_transitions";
DROP TABLE IF EXISTS "wf_states";
DROP TABLE IF EXISTS "wf_definitions";
DROP TABLE IF EXISTS "domain_events";
DROP TABLE IF EXISTS "Department";

-- New enums, only after every column using them is gone.
DROP TYPE IF EXISTS "WfEventStatus";
DROP TYPE IF EXISTS "WfStateKind";
