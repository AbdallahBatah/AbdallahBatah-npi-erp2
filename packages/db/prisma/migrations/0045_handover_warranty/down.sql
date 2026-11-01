DELETE FROM "NumberingSequence" WHERE "documentType" = 'PROJECT_HANDOVER';
ALTER TABLE "Invoice" DROP COLUMN IF EXISTS "dueDate";
DROP TABLE IF EXISTS "ProjectWarranty";
DROP TABLE IF EXISTS "ProjectHandover";
DROP TYPE IF EXISTS "WarrantyKind";
DROP TYPE IF EXISTS "HandoverStatus";
-- 'PROJECT_CLOSURE' stays on "ApprovalDocument" (Postgres cannot drop an enum value); 0046 down removes its rules.
