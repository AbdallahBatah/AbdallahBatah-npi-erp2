-- M1: posting rules. Automatic journals resolve GL accounts through
-- AccountMapping(purpose -> account) instead of hardcoded account codes, so an
-- organization can run on its own chart of accounts.

-- CreateEnum
CREATE TYPE "PostingPurpose" AS ENUM ('AR', 'RETENTION_RECEIVABLE', 'CONTRACT_ASSET', 'CONTRACT_LIABILITY', 'VAT_OUTPUT', 'REVENUE', 'WIP', 'COST_OF_REVENUE', 'VAT_INPUT', 'AP', 'RETENTION_PAYABLE', 'BANK', 'CAPITAL', 'RETAINED_EARNINGS');

-- CreateTable
CREATE TABLE "AccountMapping" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "purpose" "PostingPurpose" NOT NULL,
    "accountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccountMapping_organizationId_idx" ON "AccountMapping"("organizationId");

-- CreateIndex
CREATE INDEX "AccountMapping_accountId_idx" ON "AccountMapping"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountMapping_organizationId_purpose_key" ON "AccountMapping"("organizationId", "purpose");

-- AddForeignKey
ALTER TABLE "AccountMapping" ADD CONSTRAINT "AccountMapping_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountMapping" ADD CONSTRAINT "AccountMapping_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
