-- CreateEnum
CREATE TYPE "BillingCycle" AS ENUM ('MONTHLY', 'QUARTERLY');

-- CreateEnum
CREATE TYPE "PpaStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'ENDED');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('INVOICED', 'CANCELLED');

-- CreateTable
CREATE TABLE "PpaTerm" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "ratePerKwh" DECIMAL(10,4) NOT NULL,
    "escalationPctPerYear" DECIMAL(6,3) NOT NULL DEFAULT 0,
    "fixedMonthlyFee" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "billingCycle" "BillingCycle" NOT NULL DEFAULT 'MONTHLY',
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "status" "PpaStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PpaTerm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementRun" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "ppaTermId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "energyKwh" DECIMAL(14,3) NOT NULL,
    "appliedRate" DECIMAL(10,4) NOT NULL,
    "escalationApplied" DECIMAL(6,3) NOT NULL DEFAULT 0,
    "variableAmount" DECIMAL(18,2) NOT NULL,
    "fixedAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "subtotal" DECIMAL(18,2) NOT NULL,
    "status" "SettlementStatus" NOT NULL DEFAULT 'INVOICED',
    "invoiceId" TEXT,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettlementRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PpaTerm_contractId_key" ON "PpaTerm"("contractId");

-- CreateIndex
CREATE INDEX "PpaTerm_organizationId_status_idx" ON "PpaTerm"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PpaTerm_organizationId_code_key" ON "PpaTerm"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementRun_invoiceId_key" ON "SettlementRun"("invoiceId");

-- CreateIndex
CREATE INDEX "SettlementRun_ppaTermId_periodStart_idx" ON "SettlementRun"("ppaTermId", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementRun_organizationId_code_key" ON "SettlementRun"("organizationId", "code");

-- AddForeignKey
ALTER TABLE "PpaTerm" ADD CONSTRAINT "PpaTerm_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PpaTerm" ADD CONSTRAINT "PpaTerm_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PpaTerm" ADD CONSTRAINT "PpaTerm_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementRun" ADD CONSTRAINT "SettlementRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementRun" ADD CONSTRAINT "SettlementRun_ppaTermId_fkey" FOREIGN KEY ("ppaTermId") REFERENCES "PpaTerm"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementRun" ADD CONSTRAINT "SettlementRun_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

