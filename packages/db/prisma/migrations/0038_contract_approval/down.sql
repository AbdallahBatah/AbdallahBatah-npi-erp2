-- Reverses 0038_contract_approval as far as Postgres allows (run 0039's down first).
--
--   psql "$DATABASE_URL" -f down.sql
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '0038_contract_approval';
--
-- Enum values cannot be dropped: PENDING_APPROVAL, APPROVED and CONTRACT stay in
-- their types, unused by older code. Contracts waiting on or past an approval
-- are put back to DRAFT so an older image can read and activate them; their
-- open CONTRACT approval requests are closed as rejected. The audit log keeps
-- what happened.

UPDATE "ApprovalRequest" SET "status" = 'REJECTED', "closedAt" = CURRENT_TIMESTAMP
WHERE "documentType" = 'CONTRACT' AND "status" = 'PENDING';
UPDATE "Contract" SET "status" = 'DRAFT' WHERE "status" IN ('PENDING_APPROVAL', 'APPROVED');

ALTER TABLE "Contract"
  DROP COLUMN IF EXISTS "submittedAt",
  DROP COLUMN IF EXISTS "approvedAt",
  DROP COLUMN IF EXISTS "approvedById",
  DROP COLUMN IF EXISTS "activatedAt";
