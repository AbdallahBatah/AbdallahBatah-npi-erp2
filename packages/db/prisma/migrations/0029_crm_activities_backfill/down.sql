-- Reverses 0029_crm_activities_backfill (run this BEFORE 0028's down.sql).
--
--   npx prisma db execute --file packages/db/prisma/migrations/0029_crm_activities_backfill/down.sql --schema packages/db/prisma/schema.prisma
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '0029_crm_activities_backfill';
--
-- Removes what 0029 (or `db:seed`) wrote for the activity step: the two follow-up
-- reminder settings and the FOLLOWUP_TASK numbering sequence, for every organization.
--
-- What is lost: any change an administrator made to the two settings.
--
-- FAILS ON PURPOSE (and changes nothing — one transaction) if a follow-up task exists:
-- deleting the sequence while TSK- codes are in use would let the next task reuse a
-- code that was already issued. Decide what to do with the tasks first — for example,
-- only if they may be thrown away (they cannot be brought back):
--   DELETE FROM "FollowUpTask";
-- and then run this file again.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "FollowUpTask") THEN
    RAISE EXCEPTION 'Rollback of 0029 refused: follow-up tasks exist, and their TSK- codes must not be reissued. Remove or archive them first (see the header of down.sql).';
  END IF;
END $$;

DELETE FROM "NumberingSequence" WHERE "documentType" = 'FOLLOWUP_TASK';

DELETE FROM "OrgSetting" WHERE "key" IN ('crm.task.reminderDaysBefore', 'crm.task.reminderHour');
