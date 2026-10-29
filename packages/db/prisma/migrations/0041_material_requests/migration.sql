-- Package 4 · P4-2 / P4-3 (ADR-04 §4-2, §4-3) — the material request
-- (engineer → projects general manager → warehouse keeper) and the issue
-- voucher that sends materials from a store to the project site, confirmed by
-- the engineer before stock moves. A requisition may now name the material
-- request whose shortage it buys. Numbering sequences MR and MIS are opened for
-- every organization. Additive only. Down: down.sql.

-- CreateEnum
CREATE TYPE "MaterialRequestStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'PARTIAL', 'FULFILLED', 'CANCELLED');
CREATE TYPE "MaterialIssueStatus" AS ENUM ('ISSUED', 'RECEIVED', 'CANCELLED');

-- CreateTable
CREATE TABLE "MaterialRequest" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "status" "MaterialRequestStatus" NOT NULL DEFAULT 'DRAFT',
    "neededBy" TIMESTAMP(3),
    "notes" TEXT,
    "submittedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "rejectionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MaterialRequest_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "MaterialRequestLine" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "wbsElementId" TEXT,
    "qty" DECIMAL(14,3) NOT NULL,
    "issuedQty" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "receivedQty" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "purchasedQty" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "notes" TEXT,
    CONSTRAINT "MaterialRequestLine_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "MaterialIssue" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "fromLocationId" TEXT NOT NULL,
    "toLocationId" TEXT NOT NULL,
    "status" "MaterialIssueStatus" NOT NULL DEFAULT 'ISSUED',
    "issuedById" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedById" TEXT,
    "receivedAt" TIMESTAMP(3),
    "notes" TEXT,
    CONSTRAINT "MaterialIssue_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "MaterialIssueLine" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "requestLineId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "qty" DECIMAL(14,3) NOT NULL,
    "serialUnitIds" TEXT[],
    CONSTRAINT "MaterialIssueLine_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "PurchaseRequisition" ADD COLUMN "materialRequestId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "MaterialRequest_organizationId_code_key" ON "MaterialRequest"("organizationId", "code");
CREATE INDEX "MaterialRequest_organizationId_status_idx" ON "MaterialRequest"("organizationId", "status");
CREATE INDEX "MaterialRequest_projectId_idx" ON "MaterialRequest"("projectId");
CREATE INDEX "MaterialRequestLine_requestId_idx" ON "MaterialRequestLine"("requestId");
CREATE INDEX "MaterialRequestLine_itemId_idx" ON "MaterialRequestLine"("itemId");
CREATE UNIQUE INDEX "MaterialIssue_organizationId_code_key" ON "MaterialIssue"("organizationId", "code");
CREATE INDEX "MaterialIssue_requestId_idx" ON "MaterialIssue"("requestId");
CREATE INDEX "MaterialIssue_organizationId_status_idx" ON "MaterialIssue"("organizationId", "status");
CREATE INDEX "MaterialIssueLine_issueId_idx" ON "MaterialIssueLine"("issueId");
CREATE INDEX "MaterialIssueLine_requestLineId_idx" ON "MaterialIssueLine"("requestLineId");

-- AddForeignKey
ALTER TABLE "MaterialRequest" ADD CONSTRAINT "MaterialRequest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MaterialRequest" ADD CONSTRAINT "MaterialRequest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MaterialRequestLine" ADD CONSTRAINT "MaterialRequestLine_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "MaterialRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MaterialRequestLine" ADD CONSTRAINT "MaterialRequestLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MaterialRequestLine" ADD CONSTRAINT "MaterialRequestLine_wbsElementId_fkey" FOREIGN KEY ("wbsElementId") REFERENCES "WbsElement"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MaterialIssue" ADD CONSTRAINT "MaterialIssue_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MaterialIssue" ADD CONSTRAINT "MaterialIssue_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "MaterialRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MaterialIssue" ADD CONSTRAINT "MaterialIssue_fromLocationId_fkey" FOREIGN KEY ("fromLocationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MaterialIssue" ADD CONSTRAINT "MaterialIssue_toLocationId_fkey" FOREIGN KEY ("toLocationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MaterialIssueLine" ADD CONSTRAINT "MaterialIssueLine_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "MaterialIssue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MaterialIssueLine" ADD CONSTRAINT "MaterialIssueLine_requestLineId_fkey" FOREIGN KEY ("requestLineId") REFERENCES "MaterialRequestLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MaterialIssueLine" ADD CONSTRAINT "MaterialIssueLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseRequisition" ADD CONSTRAINT "PurchaseRequisition_materialRequestId_fkey" FOREIGN KEY ("materialRequestId") REFERENCES "MaterialRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Numbering: MR-00001 and MIS-00001 for every organization that lacks them.
INSERT INTO "NumberingSequence" ("id", "organizationId", "documentType", "prefix", "nextValue", "fiscalYear", "padding")
SELECT gen_random_uuid()::text, o."id", d.t, d.p, 1, EXTRACT(YEAR FROM now())::int, 5
FROM "Organization" o
CROSS JOIN (VALUES ('MATERIAL_REQUEST', 'MR'), ('MATERIAL_ISSUE', 'MIS')) AS d(t, p)
WHERE NOT EXISTS (
  SELECT 1 FROM "NumberingSequence" ns WHERE ns."organizationId" = o."id" AND ns."documentType" = d.t
);
