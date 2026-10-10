-- CRM Phase 1 · Step 2 (§4.1) — one customer per commercial-registration number,
-- per VAT number and per mobile number.
--
-- These are PARTIAL unique indexes, per organization:
--   * only rows that HAVE the key (NULL, and the empty string, never collide);
--   * only rows that have NOT been merged away — a duplicate that was merged
--     into a survivor keeps its old key on the row for the audit trail, and must
--     not block the survivor from holding the same key.
--
-- Prisma cannot express a WHERE on an index, so these live only here (and are
-- therefore invisible to schema.prisma; `migrate deploy` is unaffected).
--
-- DEPLOY ORDER — read before shipping this file. It is a separate migration
-- on purpose. Release 2-a (0022 + the merge tool) goes out first; the duplicates
-- on the live server are counted (docs/crm-phase-1/customer-duplicates-census.sql),
-- the owner approves the list, a backup is taken, the duplicates are merged, and
-- only THEN does release 2-b (this file) go out. If a duplicate key is still
-- there when this runs, CREATE UNIQUE INDEX fails — on purpose: `deploy.sh`
-- migrates before it switches traffic, so the failure leaves the previous
-- release serving. The error names the offending value; merge it and redeploy.
--
-- Locally both migrations apply together (no real duplicates exist).

-- CreateIndex
CREATE UNIQUE INDEX "Customer_org_crNumber_active_key" ON "Customer"("organizationId", "crNumber")
  WHERE "crNumber" IS NOT NULL AND "crNumber" <> '' AND "mergedIntoId" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Customer_org_vatNumber_active_key" ON "Customer"("organizationId", "vatNumber")
  WHERE "vatNumber" IS NOT NULL AND "vatNumber" <> '' AND "mergedIntoId" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Customer_org_mobile_active_key" ON "Customer"("organizationId", "mobile")
  WHERE "mobile" IS NOT NULL AND "mobile" <> '' AND "mergedIntoId" IS NULL;
