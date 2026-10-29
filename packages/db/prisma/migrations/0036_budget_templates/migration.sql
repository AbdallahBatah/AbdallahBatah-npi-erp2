-- Package 3 · P3-5 (ADR-03 §4-5) — standard estimated budgets (e.g. the
-- company's 990-panel and 1230-panel models). A template is a list of work
-- items with quantities; picking one copies its lines into a draft budget,
-- and ProposalRevision.templateId records which one (provenance only: a
-- deleted template leaves the budget untouched, SET NULL).
-- Additive only. Down: down.sql.

-- CreateTable
CREATE TABLE "BudgetTemplate" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "panelCount" INTEGER,
    "capacityKwp" DECIMAL(12,3),
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BudgetTemplate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BudgetTemplateLine" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "qty" DECIMAL(14,3) NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "BudgetTemplateLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BudgetTemplate_organizationId_code_key" ON "BudgetTemplate"("organizationId", "code");
CREATE INDEX "BudgetTemplate_organizationId_isActive_idx" ON "BudgetTemplate"("organizationId", "isActive");
CREATE INDEX "BudgetTemplateLine_templateId_idx" ON "BudgetTemplateLine"("templateId");
CREATE INDEX "BudgetTemplateLine_workItemId_idx" ON "BudgetTemplateLine"("workItemId");

-- AddForeignKey
ALTER TABLE "BudgetTemplate" ADD CONSTRAINT "BudgetTemplate_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BudgetTemplateLine" ADD CONSTRAINT "BudgetTemplateLine_templateId_fkey"
  FOREIGN KEY ("templateId") REFERENCES "BudgetTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BudgetTemplateLine" ADD CONSTRAINT "BudgetTemplateLine_workItemId_fkey"
  FOREIGN KEY ("workItemId") REFERENCES "WorkItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "ProposalRevision" ADD COLUMN "templateId" TEXT;
ALTER TABLE "ProposalRevision" ADD CONSTRAINT "ProposalRevision_templateId_fkey"
  FOREIGN KEY ("templateId") REFERENCES "BudgetTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
