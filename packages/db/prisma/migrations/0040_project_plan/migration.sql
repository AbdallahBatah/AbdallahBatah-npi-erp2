-- Package 4 · P4-1 (ADR-04 §4-1) — the project's plan on its budget lines.
-- WbsElement gains the work item it stands for, its quantity and unit (set when
-- a project is opened from a lump-sum budget, one element per line) and the
-- engineer's planned start and end. Additive, all nullable. Down: down.sql.

ALTER TABLE "WbsElement"
  ADD COLUMN "workItemId" TEXT,
  ADD COLUMN "qty" DECIMAL(14,3),
  ADD COLUMN "uom" TEXT,
  ADD COLUMN "plannedStart" TIMESTAMP(3),
  ADD COLUMN "plannedEnd" TIMESTAMP(3);

CREATE INDEX "WbsElement_workItemId_idx" ON "WbsElement"("workItemId");
ALTER TABLE "WbsElement" ADD CONSTRAINT "WbsElement_workItemId_fkey"
  FOREIGN KEY ("workItemId") REFERENCES "WorkItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
