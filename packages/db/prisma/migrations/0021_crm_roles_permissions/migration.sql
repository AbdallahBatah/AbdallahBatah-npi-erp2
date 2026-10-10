-- CRM Phase 1 · Step 1 — roles and permissions.
--
-- 1. A user may hold roles *in addition to* the primary one (`User.roleId`
--    is untouched). Effective permissions become the union over all roles.
-- 2. Four new permission keys are introduced and backfilled so that nobody
--    loses a capability they had yesterday:
--      finance.costs.view         — sees unit cost / margin / budget figures
--      scm.procurement.approve    — decides PR / PO / progress-claim approvals
--      projects.project.approve   — decides change-order approvals
--      commercial.proposal.approve— decides proposal approvals (used from Step 4)
--
-- Additive only: one new table, no existing column or table is altered. The
-- UPDATEs below change the *data* of existing rows (Role.permissions and the
-- workflow transitions' requiredPermission) and are reversed by down.sql.

-- CreateTable
CREATE TABLE "UserRole" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserRole_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserRole_userId_roleId_key" ON "UserRole"("userId", "roleId");

-- CreateIndex
CREATE INDEX "UserRole_roleId_idx" ON "UserRole"("roleId");

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Data: preserve today's behaviour literally ─────────────────────────────

-- Before this migration costs and margins were visible to anyone who could read
-- the screens that show them. Whoever holds any of those read keys keeps seeing
-- them; a role that never had such a key is unaffected.
UPDATE "Role" SET "permissions" = array_append("permissions", 'finance.costs.view')
WHERE NOT ('finance.costs.view' = ANY("permissions"))
  AND "permissions" && ARRAY[
    'commercial.item.read',
    'commercial.proposal.read',
    'projects.project.read',
    'finance.ledger.read',
    'fsm.workorder.read'
  ]::text[];

-- Approving used to be the same key as writing. Everyone who can write keeps
-- the right to approve; the roles editor can now separate the two.
UPDATE "Role" SET "permissions" = array_append("permissions", 'scm.procurement.approve')
WHERE NOT ('scm.procurement.approve' = ANY("permissions"))
  AND "permissions" && ARRAY['scm.procurement.write']::text[];

UPDATE "Role" SET "permissions" = array_append("permissions", 'projects.project.approve')
WHERE NOT ('projects.project.approve' = ANY("permissions"))
  AND "permissions" && ARRAY['projects.project.write']::text[];

UPDATE "Role" SET "permissions" = array_append("permissions", 'commercial.proposal.approve')
WHERE NOT ('commercial.proposal.approve' = ANY("permissions"))
  AND "permissions" && ARRAY['commercial.proposal.write']::text[];

-- The workflow engine checks `requiredPermission` against the actor's live
-- permission set. The APPROVE / REJECT moves of the two procurement flows that
-- were gated by scm.procurement.write now require the approve key. (The vendor
-- bill's APPROVE is gated by finance.payment.write — a different authority with
-- no approve key — and is deliberately left alone.)
UPDATE "wf_transitions" SET "requiredPermission" = 'scm.procurement.approve'
WHERE "actionCode" IN ('APPROVE', 'REJECT')
  AND "requiredPermission" = 'scm.procurement.write'
  AND "definitionId" IN (
    SELECT "id" FROM "wf_definitions" WHERE "code" IN ('PURCHASE_REQUISITION', 'PURCHASE_ORDER')
  );
