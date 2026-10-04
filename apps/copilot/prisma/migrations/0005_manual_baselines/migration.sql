-- Manual baselines («الزمن اليدوي المرجعي»): one minutes-measurement per
-- (org, flow), entered once from /settings (spec/madar/02 §5.9) and read by
-- the ROI comparison against the copilot's own timings.
CREATE TABLE "manual_baselines" (
    "id" TEXT NOT NULL,
    "npiOrgId" TEXT NOT NULL,
    "flowType" TEXT NOT NULL,
    "minutes" INTEGER NOT NULL,
    "measuredAt" TIMESTAMP(3) NOT NULL,
    "npiUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "manual_baselines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "manual_baselines_npiOrgId_flowType_key" ON "manual_baselines"("npiOrgId", "flowType");
