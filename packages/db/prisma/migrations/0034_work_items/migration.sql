-- Package 3 · P3-3 (ADR-03 §4-3) — the company's list of project work items
-- («بنود المشاريع»): materials, labour, equipment rental, subcontract,
-- expenses and financing, each with a unit and a default unit cost, optionally
-- standing for a stock item. Additive only: a new type and a new table.

-- CreateEnum
CREATE TYPE "WorkItemKind" AS ENUM ('MATERIAL', 'LABOUR', 'EQUIPMENT', 'SUBCONTRACT', 'EXPENSE', 'FINANCING');

-- CreateTable
CREATE TABLE "WorkItem" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "kind" "WorkItemKind" NOT NULL,
    "uom" TEXT NOT NULL DEFAULT 'unit',
    "defaultUnitCost" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "itemId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkItem_organizationId_code_key" ON "WorkItem"("organizationId", "code");
CREATE INDEX "WorkItem_organizationId_isActive_sortOrder_idx" ON "WorkItem"("organizationId", "isActive", "sortOrder");
CREATE INDEX "WorkItem_itemId_idx" ON "WorkItem"("itemId");

-- AddForeignKey
ALTER TABLE "WorkItem" ADD CONSTRAINT "WorkItem_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkItem" ADD CONSTRAINT "WorkItem_itemId_fkey"
  FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
