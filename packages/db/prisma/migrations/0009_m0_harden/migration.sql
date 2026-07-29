-- M0 hardening:
-- 1. Organization delete guard: statutory records (audit trail, GL, invoices)
--    switch from CASCADE to RESTRICT so a tenant row can never take the
--    legally-retained financial history down with it.
-- 2. SettlementRun period uniqueness: the DB now prevents double-billing the
--    same PPA period (previously only an application-level check).

-- DropForeignKey
ALTER TABLE "AuditLog" DROP CONSTRAINT "AuditLog_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "Invoice" DROP CONSTRAINT "Invoice_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "JournalEntry" DROP CONSTRAINT "JournalEntry_organizationId_fkey";

-- DropIndex
DROP INDEX "SettlementRun_ppaTermId_periodStart_idx";

-- CreateIndex
CREATE UNIQUE INDEX "SettlementRun_ppaTermId_periodStart_periodEnd_key" ON "SettlementRun"("ppaTermId", "periodStart", "periodEnd");

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
