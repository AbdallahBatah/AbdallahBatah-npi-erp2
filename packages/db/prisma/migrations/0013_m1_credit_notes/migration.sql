-- M1: ZATCA credit notes (InvoiceTypeCode 381). A cleared e-invoice is a
-- statutory record and is never edited: a correction is a new document
-- that points back at the one it corrects.

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "creditReason" TEXT,
ADD COLUMN     "creditedInvoiceId" TEXT;

-- CreateIndex
CREATE INDEX "Invoice_creditedInvoiceId_idx" ON "Invoice"("creditedInvoiceId");

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_creditedInvoiceId_fkey" FOREIGN KEY ("creditedInvoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

