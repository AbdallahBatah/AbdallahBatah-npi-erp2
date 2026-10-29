-- Package 3 · P3-1 (ADR-03 §4-1) — the lead becomes the company's negotiation
-- record: «جارٍ التفاوض ← تم القبول | تم الرفض».
--
-- 1. LeadStatus is rebuilt with the three company statuses. Every stored row is
--    mapped explicitly, so no lead loses its meaning:
--       NEW, QUALIFIED -> NEGOTIATING   (still being worked)
--       CONVERTED      -> ACCEPTED      (it already has its opportunity)
--       DISQUALIFIED   -> REJECTED      (no reason was ever recorded for these)
-- 2. New nullable columns: address, project site (text and coordinates), the
--    rejection reason (from the LossReason list) with notes, and the moment the
--    status last changed.
--
-- Deploy note: deploy.sh runs this before the containers are swapped. For that
-- short window the old API, which still writes NEW/CONVERTED, answers 500 on
-- the lead routes only; nothing else reads LeadStatus. Down: down.sql.

-- AlterEnum (rebuild: Postgres cannot drop enum values)
ALTER TYPE "LeadStatus" RENAME TO "LeadStatus_old";
CREATE TYPE "LeadStatus" AS ENUM ('NEGOTIATING', 'ACCEPTED', 'REJECTED');
ALTER TABLE "Lead" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Lead" ALTER COLUMN "status" TYPE "LeadStatus" USING (
  CASE "status"::text
    WHEN 'CONVERTED' THEN 'ACCEPTED'
    WHEN 'DISQUALIFIED' THEN 'REJECTED'
    ELSE 'NEGOTIATING'
  END
)::"LeadStatus";
ALTER TABLE "Lead" ALTER COLUMN "status" SET DEFAULT 'NEGOTIATING';
DROP TYPE "LeadStatus_old";

-- AlterTable
ALTER TABLE "Lead"
  ADD COLUMN "address" TEXT,
  ADD COLUMN "siteLocation" TEXT,
  ADD COLUMN "siteLat" DECIMAL(9,6),
  ADD COLUMN "siteLng" DECIMAL(9,6),
  ADD COLUMN "rejectionReasonId" TEXT,
  ADD COLUMN "rejectionNotes" TEXT,
  ADD COLUMN "statusChangedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Lead_rejectionReasonId_idx" ON "Lead"("rejectionReasonId");

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_rejectionReasonId_fkey"
  FOREIGN KEY ("rejectionReasonId") REFERENCES "LossReason"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
