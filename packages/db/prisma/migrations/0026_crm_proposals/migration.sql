-- CRM Phase 1 · Step 4 (§4.3, §8, §9) — proposals with numbered revisions and approval.
--
-- `Proposal`, `ProposalRevision` and `BomLine` stay THE proposal tables. This
-- migration adds what the step needs and nothing else: four more states on the
-- ProposalStatus enum (بانتظار الاعتماد، معتمد، منتهي الصلاحية، مُستبدَل), the
-- approval matrix's PROPOSAL document type, the cost source enum, the dates a
-- revision lives by, and on each BOM line the cost with its source, its age and
-- the record of a manual change.
--
-- Additive only: no existing column, table or enum value is altered or removed.
-- Every new column is nullable, so the code that ran before this migration keeps
-- working against the new schema and every existing proposal keeps its status
-- (the next migration, 0027, adopts them into the workflow engine).
--
-- The new enum VALUES ('PENDING_APPROVAL', 'APPROVED', 'EXPIRED', 'SUPERSEDED',
-- 'PROPOSAL') are not used inside this file: Postgres refuses to use a value
-- added in the same transaction. That is why the data back-fill is its own
-- migration, 0027.

-- CreateEnum
CREATE TYPE "CostSource" AS ENUM ('GRN', 'PO', 'CATALOGUE', 'MANUAL');

-- AlterEnum: the proposal joins the approval matrix.
ALTER TYPE "ApprovalDocument" ADD VALUE IF NOT EXISTS 'PROPOSAL';

-- AlterEnum: the states of the proposal flow that did not exist (DRAFT, SENT,
-- ACCEPTED, REJECTED are unchanged). ADD VALUE only — no stored row changes
-- meaning. Positioned so the enum reads in the document's order
-- (DRAFT, PENDING_APPROVAL, APPROVED, SENT, ACCEPTED, REJECTED, EXPIRED, SUPERSEDED),
-- which is what ORDER BY "status" sorts by.
ALTER TYPE "ProposalStatus" ADD VALUE IF NOT EXISTS 'PENDING_APPROVAL' AFTER 'DRAFT';
ALTER TYPE "ProposalStatus" ADD VALUE IF NOT EXISTS 'APPROVED' AFTER 'PENDING_APPROVAL';
ALTER TYPE "ProposalStatus" ADD VALUE IF NOT EXISTS 'EXPIRED' AFTER 'REJECTED';
ALTER TYPE "ProposalStatus" ADD VALUE IF NOT EXISTS 'SUPERSEDED' AFTER 'EXPIRED';

-- AlterTable: what a revision lives by.
ALTER TABLE "ProposalRevision" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "sentAt" TIMESTAMP(3),
ADD COLUMN     "submittedAt" TIMESTAMP(3),
ADD COLUMN     "supersededById" TEXT,
ADD COLUMN     "validUntil" TIMESTAMP(3);

-- AlterTable: the cost of a line, where it came from, how old it is, and the
-- record of a manual change.
ALTER TABLE "BomLine" ADD COLUMN     "costAgeDays" INTEGER,
ADD COLUMN     "costDate" TIMESTAMP(3),
ADD COLUMN     "costOverriddenAt" TIMESTAMP(3),
ADD COLUMN     "costOverriddenById" TEXT,
ADD COLUMN     "costOverrideReason" TEXT,
ADD COLUMN     "costSource" "CostSource",
ADD COLUMN     "originalUnitCost" DECIMAL(18,2),
ADD COLUMN     "unitCost" DECIMAL(18,2);

-- CreateIndex: the nightly expiry sweep looks up (status, validUntil).
CREATE INDEX "ProposalRevision_status_validUntil_idx" ON "ProposalRevision"("status", "validUntil");

-- AddForeignKey: who created the revision; the person leaving does not delete the revision.
ALTER TABLE "ProposalRevision" ADD CONSTRAINT "ProposalRevision_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
