-- M4 · the procurement documents §7 of the architecture describes: the
-- requisition that was never modelled, the receipt states that did not exist,
-- the commitment ledger, and the three-way match record.
--
-- Additive. The two existing enums only gain values (Postgres cannot remove an
-- enum value, which is why `down.sql` leaves them in place and says so).

-- CreateEnum
CREATE TYPE "PrStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'RETURNED', 'CONVERTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "GrnStatus" AS ENUM ('DRAFT', 'INSPECTED', 'ACCEPTED', 'PARTIALLY_REJECTED');

-- CreateEnum
CREATE TYPE "MatchResult" AS ENUM ('MATCHED', 'QTY_VARIANCE', 'PRICE_VARIANCE', 'BOTH_VARIANCE');

-- AlterEnum: the PO gains the two states it was missing. ADD VALUE only —
-- no existing value is renamed or removed, so no stored row changes meaning.
ALTER TYPE "PoStatus" ADD VALUE IF NOT EXISTS 'PENDING_APPROVAL' BEFORE 'APPROVED';
ALTER TYPE "PoStatus" ADD VALUE IF NOT EXISTS 'SENT' AFTER 'APPROVED';

-- AlterEnum: the requisition is banded and signed in its own right. Sharing
-- PURCHASE_ORDER's value would make the matrix hand a requisition id to
-- procurement's purchase-order applier when the chain completes.
ALTER TYPE "ApprovalDocument" ADD VALUE IF NOT EXISTS 'PURCHASE_REQUISITION' BEFORE 'PURCHASE_ORDER';

-- AlterEnum: the vendor bill gains the states between recording and payment.
-- 'POSTED' is intentionally kept: rows written before this migration carry it,
-- and rewriting them would falsify when their liability was accepted.
ALTER TYPE "BillStatus" ADD VALUE IF NOT EXISTS 'MATCHED' AFTER 'DRAFT';
ALTER TYPE "BillStatus" ADD VALUE IF NOT EXISTS 'APPROVED' AFTER 'MATCHED';
ALTER TYPE "BillStatus" ADD VALUE IF NOT EXISTS 'SCHEDULED' AFTER 'APPROVED';

-- AlterTable: receipts gain a lifecycle.
-- Two-step default on purpose: existing receipts are backfilled to ACCEPTED
-- (their stock moved when they were created, long ago), while new receipts
-- start at DRAFT and only move stock when someone accepts them.
ALTER TABLE "GoodsReceipt" ADD COLUMN "status" "GrnStatus" NOT NULL DEFAULT 'ACCEPTED';
ALTER TABLE "GoodsReceipt" ALTER COLUMN "status" SET DEFAULT 'DRAFT';
ALTER TABLE "GoodsReceipt" ADD COLUMN "inspectedAt" TIMESTAMP(3);
ALTER TABLE "GoodsReceipt" ADD COLUMN "inspectedById" TEXT;
ALTER TABLE "GoodsReceipt" ADD COLUMN "rejectionNote" TEXT;

-- AlterTable: serials are captured on arrival and become stock on acceptance,
-- so they must live on the row between the two — process memory would lose a
-- receipt left overnight.
ALTER TABLE "GoodsReceiptLine" ADD COLUMN "serials" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "GoodsReceiptLine" ALTER COLUMN "serials" SET NOT NULL;
ALTER TABLE "GoodsReceiptLine" ADD COLUMN "batchNo" TEXT;

-- CreateTable
CREATE TABLE "PurchaseRequisition" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "justification" TEXT NOT NULL,
    "departmentId" TEXT,
    "projectId" TEXT,
    "requestedById" TEXT,
    "neededBy" TIMESTAMP(3),
    "status" "PrStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "estimatedTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "purchaseOrderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseRequisition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseRequisitionLine" (
    "id" TEXT NOT NULL,
    "requisitionId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "wbsElementId" TEXT,
    "qty" DECIMAL(14,3) NOT NULL DEFAULT 1,
    "estimatedUnitPrice" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "notes" TEXT,

    CONSTRAINT "PurchaseRequisitionLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectCommitment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "wbsElementId" TEXT,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "memo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectCommitment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ThreeWayMatch" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "vendorBillId" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "goodsReceiptId" TEXT NOT NULL,
    "result" "MatchResult" NOT NULL,
    "orderedQty" DECIMAL(14,3) NOT NULL,
    "receivedQty" DECIMAL(14,3) NOT NULL,
    "billedQty" DECIMAL(14,3) NOT NULL,
    "receivedValue" DECIMAL(18,2) NOT NULL,
    "billedValue" DECIMAL(18,2) NOT NULL,
    "tolerancePct" DECIMAL(6,3) NOT NULL,
    "detailJson" JSONB,
    "matchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "matchedById" TEXT,

    CONSTRAINT "ThreeWayMatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseRequisition_organizationId_code_key" ON "PurchaseRequisition"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseRequisition_purchaseOrderId_key" ON "PurchaseRequisition"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "PurchaseRequisition_organizationId_status_idx" ON "PurchaseRequisition"("organizationId", "status");

-- CreateIndex
CREATE INDEX "PurchaseRequisition_organizationId_departmentId_idx" ON "PurchaseRequisition"("organizationId", "departmentId");

-- CreateIndex
CREATE INDEX "PurchaseRequisitionLine_requisitionId_idx" ON "PurchaseRequisitionLine"("requisitionId");

-- CreateIndex
CREATE INDEX "ProjectCommitment_organizationId_projectId_idx" ON "ProjectCommitment"("organizationId", "projectId");

-- CreateIndex
CREATE INDEX "ProjectCommitment_sourceType_sourceId_idx" ON "ProjectCommitment"("sourceType", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "ThreeWayMatch_vendorBillId_key" ON "ThreeWayMatch"("vendorBillId");

-- CreateIndex
CREATE INDEX "ThreeWayMatch_organizationId_result_idx" ON "ThreeWayMatch"("organizationId", "result");

-- CreateIndex
CREATE INDEX "GoodsReceipt_organizationId_status_idx" ON "GoodsReceipt"("organizationId", "status");

-- AddForeignKey
ALTER TABLE "PurchaseRequisition" ADD CONSTRAINT "PurchaseRequisition_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseRequisition" ADD CONSTRAINT "PurchaseRequisition_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseRequisition" ADD CONSTRAINT "PurchaseRequisition_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseRequisition" ADD CONSTRAINT "PurchaseRequisition_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseRequisition" ADD CONSTRAINT "PurchaseRequisition_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseRequisitionLine" ADD CONSTRAINT "PurchaseRequisitionLine_requisitionId_fkey" FOREIGN KEY ("requisitionId") REFERENCES "PurchaseRequisition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseRequisitionLine" ADD CONSTRAINT "PurchaseRequisitionLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseRequisitionLine" ADD CONSTRAINT "PurchaseRequisitionLine_wbsElementId_fkey" FOREIGN KEY ("wbsElementId") REFERENCES "WbsElement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectCommitment" ADD CONSTRAINT "ProjectCommitment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectCommitment" ADD CONSTRAINT "ProjectCommitment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectCommitment" ADD CONSTRAINT "ProjectCommitment_wbsElementId_fkey" FOREIGN KEY ("wbsElementId") REFERENCES "WbsElement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThreeWayMatch" ADD CONSTRAINT "ThreeWayMatch_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThreeWayMatch" ADD CONSTRAINT "ThreeWayMatch_vendorBillId_fkey" FOREIGN KEY ("vendorBillId") REFERENCES "VendorBill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThreeWayMatch" ADD CONSTRAINT "ThreeWayMatch_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThreeWayMatch" ADD CONSTRAINT "ThreeWayMatch_goodsReceiptId_fkey" FOREIGN KEY ("goodsReceiptId") REFERENCES "GoodsReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A requisition line for zero (or negative) quantity is not a request.
ALTER TABLE "PurchaseRequisitionLine" ADD CONSTRAINT "PurchaseRequisitionLine_qty_check" CHECK ("qty" > 0);
