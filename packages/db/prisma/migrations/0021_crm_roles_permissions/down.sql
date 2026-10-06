-- Reverses 0021_crm_roles_permissions.
--
--   psql "$DATABASE_URL" -f down.sql
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '0021_crm_roles_permissions';
--
-- Removing the four keys from every role restores the previous state EXACTLY:
-- the migration only ever *appended* these keys to roles that already held
-- the corresponding old key (read/write), and the old code ignores keys it
-- does not know. Anything an administrator granted through the new roles
-- editor after the migration (e.g. an approve key without write) is lost — by
-- design, since the old system cannot express it.
--
-- Extra roles held through "UserRole" are discarded with the table: after the
-- rollback each user has only their primary role (User.roleId, never touched).

-- Put the workflow transitions back on the key the old code expects, BEFORE
-- the approve key disappears from the roles.
UPDATE "wf_transitions" SET "requiredPermission" = 'scm.procurement.write'
WHERE "actionCode" IN ('APPROVE', 'REJECT')
  AND "requiredPermission" = 'scm.procurement.approve';

UPDATE "Role" SET "permissions" = array_remove("permissions", 'finance.costs.view');
UPDATE "Role" SET "permissions" = array_remove("permissions", 'scm.procurement.approve');
UPDATE "Role" SET "permissions" = array_remove("permissions", 'projects.project.approve');
UPDATE "Role" SET "permissions" = array_remove("permissions", 'commercial.proposal.approve');

DROP TABLE IF EXISTS "UserRole";
