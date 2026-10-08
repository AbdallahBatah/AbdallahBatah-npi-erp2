-- Reverses 0026_crm_proposals (run 0027's down.sql FIRST).
--
--   npx prisma db execute --file packages/db/prisma/migrations/0027_crm_proposals_backfill/down.sql --schema packages/db/prisma/schema.prisma
--   npx prisma db execute --file packages/db/prisma/migrations/0026_crm_proposals/down.sql --schema packages/db/prisma/schema.prisma
--   DELETE FROM "_prisma_migrations" WHERE migration_name IN ('0027_crm_proposals_backfill', '0026_crm_proposals');
--   (or: npx prisma migrate resolve --rolled-back <name>)
--
-- What is lost, stated plainly because a rollback file that hides it is worse
-- than none:
--
-- 1. Every proposal revision's validity date, submitted / approved / sent /
--    closed dates, superseded-by link and author, and every BOM line's cost,
--    original cost, cost source / date / age and manual-change record are
--    dropped with their columns. Nothing else holds that information. Take a
--    dump first. Revisions and lines themselves, and their prices, stay.
--
-- 2. Postgres cannot remove a value from an enum type. 'PENDING_APPROVAL',
--    'APPROVED', 'EXPIRED' and 'SUPERSEDED' on "ProposalStatus" and 'PROPOSAL' on
--    "ApprovalDocument" SURVIVE this rollback (the convention of 0020, 0022 and
--    0024); all are harmless once the Step 4 code is gone.
--
-- 3. A proposal or revision that sits in one of the four new states, or an
--    approval request for a PROPOSAL, would be unreadable by the pre-Step-4 code
--    (which does not know the values). This file therefore FAILS ON PURPOSE if
--    any exists. Bring them back deliberately first, for example:
--      UPDATE "ProposalRevision" SET "status" = 'DRAFT' WHERE "status" IN ('PENDING_APPROVAL', 'APPROVED');
--      UPDATE "ProposalRevision" SET "status" = 'SENT'  WHERE "status" IN ('EXPIRED', 'SUPERSEDED');
--      UPDATE "Proposal"         SET "status" = 'DRAFT' WHERE "status" IN ('PENDING_APPROVAL', 'APPROVED');
--      UPDATE "Proposal"         SET "status" = 'SENT'  WHERE "status" IN ('EXPIRED', 'SUPERSEDED');
--      DELETE FROM "ApprovalRequest" WHERE "documentType" = 'PROPOSAL';
--    and then run this file again. The whole file runs in one transaction, so a
--    refusal changes nothing.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "ProposalRevision" WHERE "status"::text IN ('PENDING_APPROVAL', 'APPROVED', 'EXPIRED', 'SUPERSEDED')
  ) OR EXISTS (
    SELECT 1 FROM "Proposal" WHERE "status"::text IN ('PENDING_APPROVAL', 'APPROVED', 'EXPIRED', 'SUPERSEDED')
  ) THEN
    RAISE EXCEPTION 'Rollback of 0026 refused: proposals or revisions still sit in PENDING_APPROVAL / APPROVED / EXPIRED / SUPERSEDED. Bring them back first (see the header of down.sql).';
  END IF;
  IF EXISTS (SELECT 1 FROM "ApprovalRequest" WHERE "documentType"::text = 'PROPOSAL')
     OR EXISTS (SELECT 1 FROM "ApprovalRule" WHERE "documentType"::text = 'PROPOSAL') THEN
    RAISE EXCEPTION 'Rollback of 0026 refused: approval requests or rules of type PROPOSAL exist. Run 0027''s down.sql first, and delete the requests (see the header of down.sql).';
  END IF;
END $$;

ALTER TABLE "ProposalRevision" DROP CONSTRAINT IF EXISTS "ProposalRevision_createdById_fkey";
DROP INDEX IF EXISTS "ProposalRevision_status_validUntil_idx";

ALTER TABLE "ProposalRevision"
  DROP COLUMN IF EXISTS "approvedAt",
  DROP COLUMN IF EXISTS "closedAt",
  DROP COLUMN IF EXISTS "createdById",
  DROP COLUMN IF EXISTS "sentAt",
  DROP COLUMN IF EXISTS "submittedAt",
  DROP COLUMN IF EXISTS "supersededById",
  DROP COLUMN IF EXISTS "validUntil";

ALTER TABLE "BomLine"
  DROP COLUMN IF EXISTS "costAgeDays",
  DROP COLUMN IF EXISTS "costDate",
  DROP COLUMN IF EXISTS "costOverriddenAt",
  DROP COLUMN IF EXISTS "costOverriddenById",
  DROP COLUMN IF EXISTS "costOverrideReason",
  DROP COLUMN IF EXISTS "costSource",
  DROP COLUMN IF EXISTS "originalUnitCost",
  DROP COLUMN IF EXISTS "unitCost";

DROP TYPE IF EXISTS "CostSource";
