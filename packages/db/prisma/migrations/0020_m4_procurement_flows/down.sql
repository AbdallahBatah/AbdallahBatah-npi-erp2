-- Reverses 0018_m4_procurement_flows.
--
--   psql "$DATABASE_URL" -f down.sql
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '0018_m4_procurement_flows';
--
-- Two honest caveats, because a rollback file that hides them is worse than none:
--
-- 1. Postgres cannot remove a value from an enum type. 'PENDING_APPROVAL' and
--    'SENT' on PoStatus, and 'MATCHED'/'APPROVED'/'SCHEDULED' on BillStatus,
--    survive this rollback. They are harmless — nothing reads them once the
--    M4 code is gone — but any row still *holding* one must be moved to a
--    pre-M4 value first, or the old code will meet a status it cannot render.
--    The two UPDATEs below do exactly that, and they are lossy on purpose:
--    a bill that reached APPROVED had its journal posted, which is what POSTED
--    meant before M4.
--
-- 2. Dropping ProjectCommitment discards the committed-cost ledger. Nothing
--    else in the system holds that information. Take a dump first.

-- Move rows off the M4-only enum values before the M4 code disappears.
UPDATE "PurchaseOrder" SET "status" = 'DRAFT'    WHERE "status" = 'PENDING_APPROVAL';
UPDATE "PurchaseOrder" SET "status" = 'APPROVED' WHERE "status" = 'SENT';
UPDATE "VendorBill"    SET "status" = 'DRAFT'    WHERE "status" = 'MATCHED';
UPDATE "VendorBill"    SET "status" = 'POSTED'   WHERE "status" IN ('APPROVED', 'SCHEDULED');

-- New tables, children first.
DROP TABLE IF EXISTS "ThreeWayMatch";
DROP TABLE IF EXISTS "ProjectCommitment";
DROP TABLE IF EXISTS "PurchaseRequisitionLine";
DROP TABLE IF EXISTS "PurchaseRequisition";

ALTER TABLE "GoodsReceiptLine" DROP COLUMN IF EXISTS "serials";
ALTER TABLE "GoodsReceiptLine" DROP COLUMN IF EXISTS "batchNo";

-- Added columns on the pre-existing receipt table.
DROP INDEX IF EXISTS "GoodsReceipt_organizationId_status_idx";
ALTER TABLE "GoodsReceipt" DROP COLUMN IF EXISTS "status";
ALTER TABLE "GoodsReceipt" DROP COLUMN IF EXISTS "inspectedAt";
ALTER TABLE "GoodsReceipt" DROP COLUMN IF EXISTS "inspectedById";
ALTER TABLE "GoodsReceipt" DROP COLUMN IF EXISTS "rejectionNote";

-- Enums used by nothing else.
DROP TYPE IF EXISTS "MatchResult";
DROP TYPE IF EXISTS "GrnStatus";
DROP TYPE IF EXISTS "PrStatus";

-- PoStatus / BillStatus keep their added values — see caveat 1 above.
