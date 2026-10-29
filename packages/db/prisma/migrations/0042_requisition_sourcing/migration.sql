-- Package 4 · P4-4 (ADR-04 §4-4): the projects GM sources a requisition while
-- its chain is open (vendor, prices, date, delivery place); the last signature
-- raises the purchase order already APPROVED. The PO carries where and when.
-- No existing approval rule is touched (ADR-02 §2-7): the new default chain
-- pm → finance_manager → executive is a proposal the owner applies.

ALTER TABLE "PurchaseRequisition" ADD COLUMN "vendorId" TEXT;
ALTER TABLE "PurchaseRequisition" ADD COLUMN "deliveryLocationId" TEXT;
ALTER TABLE "PurchaseRequisition" ADD COLUMN "sourcedById" TEXT;
ALTER TABLE "PurchaseRequisition" ADD COLUMN "sourcedAt" TIMESTAMP(3);
ALTER TABLE "PurchaseRequisition" ADD CONSTRAINT "PurchaseRequisition_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PurchaseRequisition" ADD CONSTRAINT "PurchaseRequisition_deliveryLocationId_fkey" FOREIGN KEY ("deliveryLocationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PurchaseOrder" ADD COLUMN "deliveryLocationId" TEXT;
ALTER TABLE "PurchaseOrder" ADD COLUMN "expectedDelivery" TIMESTAMP(3);
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_deliveryLocationId_fkey" FOREIGN KEY ("deliveryLocationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;
