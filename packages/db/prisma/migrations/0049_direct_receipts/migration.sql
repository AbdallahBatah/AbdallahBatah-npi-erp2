-- P4-7 (owner work cycle step 15): receipt of materials without a purchase order.
CREATE TABLE "DirectReceipt" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "vendorId" TEXT NOT NULL,
  "locationId" TEXT NOT NULL,
  "projectId" TEXT,
  "deliveryNoteRef" TEXT,
  "notes" TEXT,
  "receivedById" TEXT NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DirectReceipt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DirectReceipt_organizationId_code_key" ON "DirectReceipt"("organizationId", "code");
CREATE INDEX "DirectReceipt_organizationId_receivedAt_idx" ON "DirectReceipt"("organizationId", "receivedAt");
ALTER TABLE "DirectReceipt" ADD CONSTRAINT "DirectReceipt_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DirectReceipt" ADD CONSTRAINT "DirectReceipt_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DirectReceipt" ADD CONSTRAINT "DirectReceipt_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "DirectReceiptLine" (
  "id" TEXT NOT NULL,
  "receiptId" TEXT NOT NULL,
  "itemId" TEXT NOT NULL,
  "qty" DECIMAL(14,3) NOT NULL,
  "unitCost" DECIMAL(18,2),
  CONSTRAINT "DirectReceiptLine_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DirectReceiptLine_qty_positive" CHECK ("qty" > 0)
);
CREATE INDEX "DirectReceiptLine_receiptId_idx" ON "DirectReceiptLine"("receiptId");
ALTER TABLE "DirectReceiptLine" ADD CONSTRAINT "DirectReceiptLine_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "DirectReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DirectReceiptLine" ADD CONSTRAINT "DirectReceiptLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "NumberingSequence" ("id", "organizationId", "documentType", "prefix", "nextValue", "fiscalYear", "padding")
SELECT gen_random_uuid()::text, o."id", 'DIRECT_RECEIPT', 'DRN', 1, EXTRACT(YEAR FROM now())::int, 5
FROM "Organization" o
WHERE NOT EXISTS (SELECT 1 FROM "NumberingSequence" ns WHERE ns."organizationId" = o."id" AND ns."documentType" = 'DIRECT_RECEIPT');
