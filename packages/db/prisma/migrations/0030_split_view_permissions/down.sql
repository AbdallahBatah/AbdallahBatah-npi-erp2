-- Reverses 0030_split_view_permissions.
--
--   psql "$DATABASE_URL" -f down.sql
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '0030_split_view_permissions';
--
-- Run it before rolling the containers back to an image older than P1-6: the
-- old code rejects saving a role that carries a key it does not know
-- (admin.service.ts updateRole), so a role editor would fail until then.
--
-- Removing the four keys gives every role the migration touched back its
-- previous array EXACTLY, order included, unless the role was edited since: the
-- migration only ever appended each key, at the end of the array, to a role
-- that did not hold it (no key could exist before, the old code rejects it),
-- and array_remove keeps the order of what is left. A new key an administrator
-- granted after the migration is removed as well — by design, since the old
-- code cannot express it.

UPDATE "Role" SET "permissions" = array_remove("permissions", 'crm.task.read')
WHERE 'crm.task.read' = ANY("permissions");

UPDATE "Role" SET "permissions" = array_remove("permissions", 'scm.requisition.read')
WHERE 'scm.requisition.read' = ANY("permissions");

UPDATE "Role" SET "permissions" = array_remove("permissions", 'finance.report.read')
WHERE 'finance.report.read' = ANY("permissions");

UPDATE "Role" SET "permissions" = array_remove("permissions", 'finance.statement.read')
WHERE 'finance.statement.read' = ANY("permissions");
