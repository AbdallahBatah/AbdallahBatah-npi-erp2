-- Reverses 0034_work_items.
--
--   psql "$DATABASE_URL" -f down.sql
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '0034_work_items';
--
-- Run it only after 0035's down.sql (budget lines point at work items).
-- The work-item list is lost; its creation and edits are in "AuditLog".

DROP TABLE IF EXISTS "WorkItem";
DROP TYPE IF EXISTS "WorkItemKind";
