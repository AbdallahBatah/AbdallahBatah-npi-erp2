-- Reverses 0028_crm_activities (run 0029's down.sql FIRST).
--
--   npx prisma db execute --file packages/db/prisma/migrations/0029_crm_activities_backfill/down.sql --schema packages/db/prisma/schema.prisma
--   npx prisma db execute --file packages/db/prisma/migrations/0028_crm_activities/down.sql --schema packages/db/prisma/schema.prisma
--   DELETE FROM "_prisma_migrations" WHERE migration_name IN ('0029_crm_activities_backfill', '0028_crm_activities');
--   (or: npx prisma migrate resolve --rolled-back <name>)
--
-- What is lost, stated plainly because a rollback file that hides it is worse than none:
--
-- 1. EVERY communication-log entry and EVERY follow-up task is dropped with its table.
--    Nothing else holds that information. Take a dump first. (0029's down.sql already
--    refuses to run while a task exists, which protects the tasks; nothing protects
--    the log entries, so look before you run this file.) The audit-trail rows about
--    them (entityType 'Activity' / 'FollowUpTask') stay: the audit log is append-only.
--
-- 2. The attachment rows of the log entries ('ACTIVITY') are deleted below; the files
--    stay on disk under the uploads volume, unreferenced.
--
-- 3. Postgres cannot remove a value from an enum type. 'ACTIVITY' on
--    "AttachmentEntity" SURVIVES this rollback (the convention of 0020, 0022, 0024 and
--    0026); it is harmless once the Step 5 code is gone. The enums "ActivityType" and
--    "FollowUpTaskStatus" belong to the dropped tables and ARE dropped.
--
-- The whole file runs in one transaction, so a failure changes nothing.

DELETE FROM "Attachment" WHERE "entityType" = 'ACTIVITY';

-- Foreign keys go with the tables. No table points at either of them.
DROP TABLE IF EXISTS "FollowUpTask";
DROP TABLE IF EXISTS "Activity";

DROP TYPE IF EXISTS "FollowUpTaskStatus";
DROP TYPE IF EXISTS "ActivityType";
