-- Reverses 0031_user_permission_overrides.
--
--   psql "$DATABASE_URL" -f down.sql
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '0031_user_permission_overrides';
--
-- Run it before rolling the containers back to an image older than P1-7. Every
-- user's permissions go back to exactly what their roles give: the old code
-- never read this table. The exceptions an administrator saved are lost with
-- it — by design, since the old code cannot express them — but each save left
-- a PERMISSION_OVERRIDE row on "User" in "AuditLog", which this does not touch.

DROP TABLE IF EXISTS "UserPermissionOverride";

DROP TYPE IF EXISTS "PermissionEffect";
