-- Package 5 (ADR-05): daily progress on the budget line, overrun requests,
-- site attendance, material returns from site to store.

ALTER TYPE "ApprovalDocument" ADD VALUE IF NOT EXISTS 'EXECUTION_OVERRUN';

CREATE TYPE "OverrunStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
CREATE TYPE "MaterialReturnStatus" AS ENUM ('RAISED', 'RECEIVED', 'CANCELLED');

CREATE TABLE "WorkProgressEntry" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "wbsElementId" TEXT NOT NULL,
  "workDate" DATE NOT NULL,
  "qty" DECIMAL(14,3) NOT NULL,
  "notes" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkProgressEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkProgressEntry_qty_positive" CHECK ("qty" > 0)
);
CREATE INDEX "WorkProgressEntry_projectId_workDate_idx" ON "WorkProgressEntry"("projectId", "workDate");
CREATE INDEX "WorkProgressEntry_wbsElementId_idx" ON "WorkProgressEntry"("wbsElementId");
ALTER TABLE "WorkProgressEntry" ADD CONSTRAINT "WorkProgressEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkProgressEntry" ADD CONSTRAINT "WorkProgressEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkProgressEntry" ADD CONSTRAINT "WorkProgressEntry_wbsElementId_fkey" FOREIGN KEY ("wbsElementId") REFERENCES "WbsElement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ExecutionOverrun" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "wbsElementId" TEXT NOT NULL,
  "extraQty" DECIMAL(14,3) NOT NULL,
  "amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "reason" TEXT NOT NULL,
  "status" "OverrunStatus" NOT NULL DEFAULT 'PENDING',
  "requestedById" TEXT NOT NULL,
  "decidedAt" TIMESTAMP(3),
  "decisionNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExecutionOverrun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ExecutionOverrun_extraQty_positive" CHECK ("extraQty" > 0)
);
CREATE UNIQUE INDEX "ExecutionOverrun_organizationId_code_key" ON "ExecutionOverrun"("organizationId", "code");
CREATE INDEX "ExecutionOverrun_projectId_status_idx" ON "ExecutionOverrun"("projectId", "status");
CREATE INDEX "ExecutionOverrun_wbsElementId_idx" ON "ExecutionOverrun"("wbsElementId");
ALTER TABLE "ExecutionOverrun" ADD CONSTRAINT "ExecutionOverrun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExecutionOverrun" ADD CONSTRAINT "ExecutionOverrun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExecutionOverrun" ADD CONSTRAINT "ExecutionOverrun_wbsElementId_fkey" FOREIGN KEY ("wbsElementId") REFERENCES "WbsElement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SiteAttendance" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "workDate" DATE NOT NULL,
  "workerName" TEXT NOT NULL,
  "trade" TEXT,
  "checkInAt" TIMESTAMP(3) NOT NULL,
  "checkOutAt" TIMESTAMP(3),
  "notes" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SiteAttendance_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SiteAttendance_out_after_in" CHECK ("checkOutAt" IS NULL OR "checkOutAt" > "checkInAt")
);
CREATE INDEX "SiteAttendance_projectId_workDate_idx" ON "SiteAttendance"("projectId", "workDate");
ALTER TABLE "SiteAttendance" ADD CONSTRAINT "SiteAttendance_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SiteAttendance" ADD CONSTRAINT "SiteAttendance_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "MaterialReturn" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "fromLocationId" TEXT NOT NULL,
  "toLocationId" TEXT NOT NULL,
  "status" "MaterialReturnStatus" NOT NULL DEFAULT 'RAISED',
  "raisedById" TEXT NOT NULL,
  "raisedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "receivedById" TEXT,
  "receivedAt" TIMESTAMP(3),
  "notes" TEXT,
  CONSTRAINT "MaterialReturn_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MaterialReturn_organizationId_code_key" ON "MaterialReturn"("organizationId", "code");
CREATE INDEX "MaterialReturn_projectId_idx" ON "MaterialReturn"("projectId");
CREATE INDEX "MaterialReturn_organizationId_status_idx" ON "MaterialReturn"("organizationId", "status");
ALTER TABLE "MaterialReturn" ADD CONSTRAINT "MaterialReturn_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MaterialReturn" ADD CONSTRAINT "MaterialReturn_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MaterialReturn" ADD CONSTRAINT "MaterialReturn_fromLocationId_fkey" FOREIGN KEY ("fromLocationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MaterialReturn" ADD CONSTRAINT "MaterialReturn_toLocationId_fkey" FOREIGN KEY ("toLocationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "MaterialReturnLine" (
  "id" TEXT NOT NULL,
  "returnId" TEXT NOT NULL,
  "itemId" TEXT NOT NULL,
  "qty" DECIMAL(14,3) NOT NULL,
  "serialUnitIds" TEXT[],
  CONSTRAINT "MaterialReturnLine_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MaterialReturnLine_qty_positive" CHECK ("qty" > 0)
);
CREATE INDEX "MaterialReturnLine_returnId_idx" ON "MaterialReturnLine"("returnId");
ALTER TABLE "MaterialReturnLine" ADD CONSTRAINT "MaterialReturnLine_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "MaterialReturn"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MaterialReturnLine" ADD CONSTRAINT "MaterialReturnLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "NumberingSequence" ("id", "organizationId", "documentType", "prefix", "nextValue", "fiscalYear", "padding")
SELECT gen_random_uuid()::text, o."id", d.t, d.p, 1, EXTRACT(YEAR FROM now())::int, 5
FROM "Organization" o
CROSS JOIN (VALUES ('EXECUTION_OVERRUN', 'OVR'), ('MATERIAL_RETURN', 'MRT')) AS d(t, p)
WHERE NOT EXISTS (
  SELECT 1 FROM "NumberingSequence" ns WHERE ns."organizationId" = o."id" AND ns."documentType" = d.t
);
