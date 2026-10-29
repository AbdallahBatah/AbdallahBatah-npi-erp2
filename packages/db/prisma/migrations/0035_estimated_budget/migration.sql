-- Package 3 · P3-4 (ADR-03 §4-4) — the proposal revision becomes the
-- company's estimated budget («الموازنة التقديرية»).
--
-- BomLine: a line is now a project work item, which may or may not stand for a
-- stock item — itemId becomes nullable, workItemId / description / uom are
-- added, and a CHECK keeps at least one of itemId and workItemId, so no line
-- is ever about nothing. Every existing line has an itemId and passes.
--
-- ProposalRevision: pricingMode (every existing revision is PER_LINE, the only
-- mode there was), the lump-sum selling total, and a risk contingency
-- (percentage, amount, notes). All defaulted or nullable.
--
-- Additive for every existing row; nothing is rewritten. Down: down.sql.

-- CreateEnum
CREATE TYPE "PricingMode" AS ENUM ('PER_LINE', 'LUMP_SUM');

-- AlterTable: BomLine
ALTER TABLE "BomLine" ALTER COLUMN "itemId" DROP NOT NULL;
ALTER TABLE "BomLine"
  ADD COLUMN "workItemId" TEXT,
  ADD COLUMN "description" TEXT,
  ADD COLUMN "uom" TEXT;
ALTER TABLE "BomLine" ADD CONSTRAINT "BomLine_item_or_work_item_check"
  CHECK ("itemId" IS NOT NULL OR "workItemId" IS NOT NULL);

CREATE INDEX "BomLine_workItemId_idx" ON "BomLine"("workItemId");
ALTER TABLE "BomLine" ADD CONSTRAINT "BomLine_workItemId_fkey"
  FOREIGN KEY ("workItemId") REFERENCES "WorkItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable: ProposalRevision
ALTER TABLE "ProposalRevision"
  ADD COLUMN "pricingMode" "PricingMode" NOT NULL DEFAULT 'PER_LINE',
  ADD COLUMN "sellingTotal" DECIMAL(18,2),
  ADD COLUMN "contingencyPct" DECIMAL(6,3) NOT NULL DEFAULT 0,
  ADD COLUMN "contingencyAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN "riskNotes" TEXT;
