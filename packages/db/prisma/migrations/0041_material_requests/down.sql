-- Reverses 0041_material_requests.
--   psql "$DATABASE_URL" -f down.sql
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '0041_material_requests';
-- Material requests and issue vouchers are lost (their stock movements stay in
-- "StockMovement" with sourceType 'MaterialIssue'; the audit log keeps the rest).

ALTER TABLE "PurchaseRequisition" DROP CONSTRAINT IF EXISTS "PurchaseRequisition_materialRequestId_fkey";
ALTER TABLE "PurchaseRequisition" DROP COLUMN IF EXISTS "materialRequestId";
DROP TABLE IF EXISTS "MaterialIssueLine";
DROP TABLE IF EXISTS "MaterialIssue";
DROP TABLE IF EXISTS "MaterialRequestLine";
DROP TABLE IF EXISTS "MaterialRequest";
DROP TYPE IF EXISTS "MaterialIssueStatus";
DROP TYPE IF EXISTS "MaterialRequestStatus";
DELETE FROM "NumberingSequence" WHERE "documentType" IN ('MATERIAL_REQUEST', 'MATERIAL_ISSUE');
