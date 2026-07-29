-- M1: close the accounts-payable cycle, and give the ledger a project
-- dimension so WIP can be relieved to cost of revenue per project.

-- AlterTable
ALTER TABLE "JournalEntry" ADD COLUMN     "projectId" TEXT;

-- AlterTable
ALTER TABLE "ProgressClaim" ADD COLUMN     "retentionReleasedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "VendorPayment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "paymentDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "amount" DECIMAL(18,2) NOT NULL,
    "method" "PaymentMethod" NOT NULL DEFAULT 'BANK_TRANSFER',
    "reference" TEXT,
    "memo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendorPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorPaymentAllocation" (
    "id" TEXT NOT NULL,
    "vendorPaymentId" TEXT NOT NULL,
    "vendorBillId" TEXT,
    "progressClaimId" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "VendorPaymentAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VendorPayment_organizationId_vendorId_idx" ON "VendorPayment"("organizationId", "vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "VendorPayment_organizationId_code_key" ON "VendorPayment"("organizationId", "code");

-- CreateIndex
CREATE INDEX "VendorPaymentAllocation_vendorPaymentId_idx" ON "VendorPaymentAllocation"("vendorPaymentId");

-- CreateIndex
CREATE INDEX "VendorPaymentAllocation_vendorBillId_idx" ON "VendorPaymentAllocation"("vendorBillId");

-- CreateIndex
CREATE INDEX "VendorPaymentAllocation_progressClaimId_idx" ON "VendorPaymentAllocation"("progressClaimId");

-- CreateIndex
CREATE INDEX "JournalEntry_projectId_idx" ON "JournalEntry"("projectId");

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorPayment" ADD CONSTRAINT "VendorPayment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorPayment" ADD CONSTRAINT "VendorPayment_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorPaymentAllocation" ADD CONSTRAINT "VendorPaymentAllocation_vendorPaymentId_fkey" FOREIGN KEY ("vendorPaymentId") REFERENCES "VendorPayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorPaymentAllocation" ADD CONSTRAINT "VendorPaymentAllocation_vendorBillId_fkey" FOREIGN KEY ("vendorBillId") REFERENCES "VendorBill"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorPaymentAllocation" ADD CONSTRAINT "VendorPaymentAllocation_progressClaimId_fkey" FOREIGN KEY ("progressClaimId") REFERENCES "ProgressClaim"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill the project dimension on journals already posted, so cost
-- recognition sees the WIP that existing vendor bills and subcontractor
-- claims put on the books rather than starting from zero.
UPDATE "JournalEntry" je
SET "projectId" = po."projectId"
FROM "VendorBill" vb
JOIN "PurchaseOrder" po ON po."id" = vb."purchaseOrderId"
WHERE je."sourceType" = 'VendorBill'
  AND je."sourceId" = vb."id"
  AND je."projectId" IS NULL
  AND po."projectId" IS NOT NULL;

UPDATE "JournalEntry" je
SET "projectId" = sa."projectId"
FROM "ProgressClaim" pc
JOIN "SubcontractAgreement" sa ON sa."id" = pc."agreementId"
WHERE je."sourceType" = 'ProgressClaim'
  AND je."sourceId" = pc."id"
  AND je."projectId" IS NULL;
