-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('UNDERPERFORMANCE', 'OFFLINE', 'COMM_LOSS', 'OVERTEMP');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'WORK_ORDERED', 'RESOLVED');

-- CreateTable
CREATE TABLE "TelemetryReading" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "readingDate" TIMESTAMP(3) NOT NULL,
    "energyKwh" DECIMAL(14,3) NOT NULL,
    "expectedKwh" DECIMAL(14,3),
    "performanceRatio" DECIMAL(6,3),
    "source" TEXT NOT NULL DEFAULT 'SIMULATED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelemetryReading_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerformanceAlert" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "readingId" TEXT,
    "alertType" "AlertType" NOT NULL,
    "severity" "AlertSeverity" NOT NULL DEFAULT 'WARNING',
    "status" "AlertStatus" NOT NULL DEFAULT 'OPEN',
    "message" TEXT NOT NULL,
    "ruleRef" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedById" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "workOrderId" TEXT,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "PerformanceAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TelemetryReading_organizationId_readingDate_idx" ON "TelemetryReading"("organizationId", "readingDate");

-- CreateIndex
CREATE UNIQUE INDEX "TelemetryReading_assetId_readingDate_key" ON "TelemetryReading"("assetId", "readingDate");

-- CreateIndex
CREATE UNIQUE INDEX "PerformanceAlert_workOrderId_key" ON "PerformanceAlert"("workOrderId");

-- CreateIndex
CREATE INDEX "PerformanceAlert_organizationId_status_idx" ON "PerformanceAlert"("organizationId", "status");

-- CreateIndex
CREATE INDEX "PerformanceAlert_assetId_idx" ON "PerformanceAlert"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "PerformanceAlert_organizationId_code_key" ON "PerformanceAlert"("organizationId", "code");

-- AddForeignKey
ALTER TABLE "TelemetryReading" ADD CONSTRAINT "TelemetryReading_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetryReading" ADD CONSTRAINT "TelemetryReading_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceAlert" ADD CONSTRAINT "PerformanceAlert_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceAlert" ADD CONSTRAINT "PerformanceAlert_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceAlert" ADD CONSTRAINT "PerformanceAlert_readingId_fkey" FOREIGN KEY ("readingId") REFERENCES "TelemetryReading"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceAlert" ADD CONSTRAINT "PerformanceAlert_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "WorkOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

