-- Package 6 (ADR-06): vendor payment requests and petty cash (custody).

ALTER TYPE "ApprovalDocument" ADD VALUE IF NOT EXISTS 'VENDOR_PAYMENT_REQUEST';
ALTER TYPE "ApprovalDocument" ADD VALUE IF NOT EXISTS 'PETTY_CASH_SETTLEMENT';
ALTER TYPE "PostingPurpose" ADD VALUE IF NOT EXISTS 'VENDOR_ADVANCE';
ALTER TYPE "PostingPurpose" ADD VALUE IF NOT EXISTS 'PETTY_CASH';

CREATE TYPE "VendorPaymentKind" AS ENUM ('ADVANCE', 'AGAINST_BILL');
CREATE TYPE "PaymentRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'PAID', 'CANCELLED');
CREATE TYPE "CustodyStatus" AS ENUM ('OPEN', 'CLOSED');
CREATE TYPE "PettyCashMovementKind" AS ENUM ('FUND', 'SETTLEMENT', 'RETURN');
CREATE TYPE "PettyCashMovementStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'POSTED');

CREATE TABLE "VendorPaymentRequest" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "vendorId" TEXT NOT NULL,
  "projectId" TEXT,
  "kind" "VendorPaymentKind" NOT NULL,
  "vendorBillId" TEXT,
  "purchaseOrderId" TEXT,
  "amount" DECIMAL(18,2) NOT NULL,
  "reason" TEXT NOT NULL,
  "status" "PaymentRequestStatus" NOT NULL DEFAULT 'PENDING',
  "requestedById" TEXT NOT NULL,
  "decidedAt" TIMESTAMP(3),
  "decisionNote" TEXT,
  "paidAt" TIMESTAMP(3),
  "paidById" TEXT,
  "paymentRef" TEXT,
  "vendorPaymentId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VendorPaymentRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "VendorPaymentRequest_amount_positive" CHECK ("amount" > 0),
  CONSTRAINT "VendorPaymentRequest_bill_when_against" CHECK ("kind" <> 'AGAINST_BILL' OR "vendorBillId" IS NOT NULL)
);
CREATE UNIQUE INDEX "VendorPaymentRequest_organizationId_code_key" ON "VendorPaymentRequest"("organizationId", "code");
CREATE INDEX "VendorPaymentRequest_organizationId_status_idx" ON "VendorPaymentRequest"("organizationId", "status");
ALTER TABLE "VendorPaymentRequest" ADD CONSTRAINT "VendorPaymentRequest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VendorPaymentRequest" ADD CONSTRAINT "VendorPaymentRequest_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VendorPaymentRequest" ADD CONSTRAINT "VendorPaymentRequest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "PettyCashCustody" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "custodianId" TEXT NOT NULL,
  "status" "CustodyStatus" NOT NULL DEFAULT 'OPEN',
  "balance" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "notes" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closedAt" TIMESTAMP(3),
  CONSTRAINT "PettyCashCustody_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PettyCashCustody_balance_nonneg" CHECK ("balance" >= 0)
);
CREATE UNIQUE INDEX "PettyCashCustody_organizationId_code_key" ON "PettyCashCustody"("organizationId", "code");
CREATE INDEX "PettyCashCustody_organizationId_custodianId_idx" ON "PettyCashCustody"("organizationId", "custodianId");
ALTER TABLE "PettyCashCustody" ADD CONSTRAINT "PettyCashCustody_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PettyCashMovement" (
  "id" TEXT NOT NULL,
  "custodyId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "kind" "PettyCashMovementKind" NOT NULL,
  "status" "PettyCashMovementStatus" NOT NULL DEFAULT 'POSTED',
  "amount" DECIMAL(18,2) NOT NULL,
  "memo" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedAt" TIMESTAMP(3),
  "decisionNote" TEXT,
  CONSTRAINT "PettyCashMovement_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PettyCashMovement_amount_positive" CHECK ("amount" > 0)
);
CREATE INDEX "PettyCashMovement_custodyId_idx" ON "PettyCashMovement"("custodyId");
ALTER TABLE "PettyCashMovement" ADD CONSTRAINT "PettyCashMovement_custodyId_fkey" FOREIGN KEY ("custodyId") REFERENCES "PettyCashCustody"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PettyCashLine" (
  "id" TEXT NOT NULL,
  "movementId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "wbsElementId" TEXT,
  "description" TEXT NOT NULL,
  "amount" DECIMAL(18,2) NOT NULL,
  "spentOn" DATE NOT NULL,
  CONSTRAINT "PettyCashLine_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PettyCashLine_amount_positive" CHECK ("amount" > 0)
);
CREATE INDEX "PettyCashLine_movementId_idx" ON "PettyCashLine"("movementId");
CREATE INDEX "PettyCashLine_projectId_idx" ON "PettyCashLine"("projectId");
ALTER TABLE "PettyCashLine" ADD CONSTRAINT "PettyCashLine_movementId_fkey" FOREIGN KEY ("movementId") REFERENCES "PettyCashMovement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PettyCashLine" ADD CONSTRAINT "PettyCashLine_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PettyCashLine" ADD CONSTRAINT "PettyCashLine_wbsElementId_fkey" FOREIGN KEY ("wbsElementId") REFERENCES "WbsElement"("id") ON DELETE SET NULL ON UPDATE CASCADE;
