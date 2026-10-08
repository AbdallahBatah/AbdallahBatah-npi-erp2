-- CRM Phase 1 · Step 3 (§4.2) — opportunities and the sales funnel.
--
-- `Opportunity` stays THE opportunity table. This migration adds what the funnel
-- needs: a qualification stage between prospecting and proposal, the
-- direct / tender type with the tender's close date and bid-bond particulars, a
-- loss reason (from an editable list) with free notes, the moment an
-- opportunity was closed and the moment its stage last changed.
--
-- Additive only: no existing column, table or enum value is altered or removed.
-- Every new column on "Opportunity" is nullable or defaulted, so the code that
-- was running before this migration keeps working against the new schema, and
-- every existing opportunity keeps the stage it has (no back-fill).
--
-- The two new enum VALUES ('QUALIFICATION', 'OPPORTUNITY') are not used inside
-- this file: Postgres refuses to use a value added in the same transaction.

-- CreateEnum
CREATE TYPE "OpportunityType" AS ENUM ('DIRECT', 'TENDER');

-- AlterEnum: the stage between «محتمل» and «عرض سعر». ADD VALUE only — no stored
-- row changes meaning.
ALTER TYPE "OpportunityStage" ADD VALUE IF NOT EXISTS 'QUALIFICATION' AFTER 'PROSPECTING';

-- AlterEnum: attachments may now hang off an opportunity.
ALTER TYPE "AttachmentEntity" ADD VALUE IF NOT EXISTS 'OPPORTUNITY';

-- CreateTable
CREATE TABLE "LossReason" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LossReason_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Opportunity" ADD COLUMN     "bidBondAmount" DECIMAL(18,2),
ADD COLUMN     "bidBondBank" TEXT,
ADD COLUMN     "bidBondExpiry" TIMESTAMP(3),
ADD COLUMN     "bidBondReference" TEXT,
ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "lossNotes" TEXT,
ADD COLUMN     "lossReasonId" TEXT,
ADD COLUMN     "opportunityType" "OpportunityType" NOT NULL DEFAULT 'DIRECT',
ADD COLUMN     "stageChangedAt" TIMESTAMP(3),
ADD COLUMN     "tenderCloseDate" TIMESTAMP(3),
ADD COLUMN     "tenderReference" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "LossReason_organizationId_nameAr_key" ON "LossReason"("organizationId", "nameAr");

-- CreateIndex
CREATE INDEX "LossReason_organizationId_isActive_sortOrder_idx" ON "LossReason"("organizationId", "isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "Opportunity_organizationId_opportunityType_idx" ON "Opportunity"("organizationId", "opportunityType");

-- CreateIndex
CREATE INDEX "Opportunity_lossReasonId_idx" ON "Opportunity"("lossReasonId");

-- AddForeignKey
ALTER TABLE "LossReason" ADD CONSTRAINT "LossReason_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: a reason that was used is never deleted (RESTRICT) — it is
-- switched off with "isActive" instead.
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_lossReasonId_fkey" FOREIGN KEY ("lossReasonId") REFERENCES "LossReason"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
