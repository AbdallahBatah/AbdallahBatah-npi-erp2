-- Reverses 0024_crm_opportunities.
--
--   npx prisma db execute --file packages/db/prisma/migrations/0024_crm_opportunities/down.sql --schema packages/db/prisma/schema.prisma
--   (or: psql "$DATABASE_URL" -f down.sql)
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '0024_crm_opportunities';
--   (or: npx prisma migrate resolve --rolled-back 0024_crm_opportunities)
--
-- What is lost, stated plainly because a rollback file that hides it is worse
-- than none:
--
-- 1. The loss reasons, and every opportunity's loss reason / notes / closed-at /
--    stage-changed-at / tender and bid-bond data are dropped with their
--    columns and table. Nothing else holds that information. Take a dump first.
--
-- 2. Postgres cannot remove a value from an enum type. 'QUALIFICATION' on
--    "OpportunityStage" and 'OPPORTUNITY' on "AttachmentEntity" SURVIVE this
--    rollback (the convention of 0020 and 0022); both are harmless once the
--    Step 3 code is gone. Rows still HOLDING 'OPPORTUNITY' are deleted below
--    (the files stay on disk under the uploads volume, unreferenced).
--
-- 3. An opportunity that sits at 'QUALIFICATION' would be unreadable by the
--    pre-Step-3 code (which does not know the value). This file therefore FAILS
--    ON PURPOSE if any such opportunity exists: move them back to
--    'PROSPECTING' (or close them) first, deliberately —
--      UPDATE "Opportunity" SET "stage" = 'PROSPECTING' WHERE "stage" = 'QUALIFICATION';
--    and then run this file again. The whole file runs in one transaction, so
--    a refusal changes nothing.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Opportunity" WHERE "stage" = 'QUALIFICATION') THEN
    RAISE EXCEPTION 'Rollback of 0024 refused: opportunities still sit at QUALIFICATION. Move them to PROSPECTING first (see the header of down.sql).';
  END IF;
END $$;

DELETE FROM "Attachment" WHERE "entityType" = 'OPPORTUNITY';

-- The foreign key, then the indexes that mention the new columns, then the
-- columns (dropping a column would drop its indexes too; explicit is clearer).
ALTER TABLE "Opportunity" DROP CONSTRAINT IF EXISTS "Opportunity_lossReasonId_fkey";
DROP INDEX IF EXISTS "Opportunity_organizationId_opportunityType_idx";
DROP INDEX IF EXISTS "Opportunity_lossReasonId_idx";

ALTER TABLE "Opportunity"
  DROP COLUMN IF EXISTS "bidBondAmount",
  DROP COLUMN IF EXISTS "bidBondBank",
  DROP COLUMN IF EXISTS "bidBondExpiry",
  DROP COLUMN IF EXISTS "bidBondReference",
  DROP COLUMN IF EXISTS "closedAt",
  DROP COLUMN IF EXISTS "lossNotes",
  DROP COLUMN IF EXISTS "lossReasonId",
  DROP COLUMN IF EXISTS "opportunityType",
  DROP COLUMN IF EXISTS "stageChangedAt",
  DROP COLUMN IF EXISTS "tenderCloseDate",
  DROP COLUMN IF EXISTS "tenderReference";

-- The table goes with its indexes and its foreign key to "Organization".
DROP TABLE IF EXISTS "LossReason";

DROP TYPE IF EXISTS "OpportunityType";
