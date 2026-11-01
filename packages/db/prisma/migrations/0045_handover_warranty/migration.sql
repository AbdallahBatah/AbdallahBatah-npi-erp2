-- Package 7 (ADR-07): project handover / acceptance & commissioning certificate,
-- warranty register, invoice due dates.

ALTER TYPE "ApprovalDocument" ADD VALUE IF NOT EXISTS 'PROJECT_CLOSURE';
CREATE TYPE "HandoverStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED');
CREATE TYPE "WarrantyKind" AS ENUM ('PANELS_PRODUCT', 'PANELS_PERFORMANCE', 'INVERTER', 'STRUCTURE', 'WORKMANSHIP');

CREATE TABLE "ProjectHandover" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "status" "HandoverStatus" NOT NULL DEFAULT 'DRAFT',
  "completionDate" DATE,
  "commissionedAt" DATE,
  "checklist" JSONB NOT NULL DEFAULT '[]',
  "readings" JSONB NOT NULL DEFAULT '[]',
  "snags" TEXT,
  "snagsDueDate" DATE,
  "clientRepName" TEXT,
  "warrantyYears" JSONB NOT NULL DEFAULT '{}',
  "notes" TEXT,
  "createdById" TEXT NOT NULL,
  "submittedById" TEXT,
  "submittedAt" TIMESTAMP(3),
  "decidedAt" TIMESTAMP(3),
  "decisionNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProjectHandover_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProjectHandover_projectId_key" ON "ProjectHandover"("projectId");
CREATE UNIQUE INDEX "ProjectHandover_organizationId_code_key" ON "ProjectHandover"("organizationId", "code");
ALTER TABLE "ProjectHandover" ADD CONSTRAINT "ProjectHandover_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectHandover" ADD CONSTRAINT "ProjectHandover_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ProjectWarranty" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "kind" "WarrantyKind" NOT NULL,
  "years" INTEGER NOT NULL,
  "startsAt" DATE NOT NULL,
  "endsAt" DATE NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectWarranty_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectWarranty_years_positive" CHECK ("years" > 0)
);
CREATE UNIQUE INDEX "ProjectWarranty_projectId_kind_key" ON "ProjectWarranty"("projectId", "kind");
CREATE INDEX "ProjectWarranty_organizationId_endsAt_idx" ON "ProjectWarranty"("organizationId", "endsAt");
ALTER TABLE "ProjectWarranty" ADD CONSTRAINT "ProjectWarranty_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectWarranty" ADD CONSTRAINT "ProjectWarranty_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Invoices: a due date. Existing issued invoices get issue date + 30 days (the default terms).
ALTER TABLE "Invoice" ADD COLUMN "dueDate" TIMESTAMP(3);
UPDATE "Invoice" SET "dueDate" = "issueDate" + INTERVAL '30 days'
WHERE "dueDate" IS NULL AND "invoiceType" <> 'CREDIT_NOTE';

INSERT INTO "NumberingSequence" ("id", "organizationId", "documentType", "prefix", "nextValue", "fiscalYear", "padding")
SELECT gen_random_uuid()::text, o."id", 'PROJECT_HANDOVER', 'HND', 1, EXTRACT(YEAR FROM now())::int, 5
FROM "Organization" o
WHERE NOT EXISTS (
  SELECT 1 FROM "NumberingSequence" ns WHERE ns."organizationId" = o."id" AND ns."documentType" = 'PROJECT_HANDOVER'
);
