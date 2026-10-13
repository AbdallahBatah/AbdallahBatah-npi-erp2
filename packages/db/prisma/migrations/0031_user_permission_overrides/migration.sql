-- ADR-02 task 5 (P1-7) — per-user permission overrides.
--
-- One new enum and one new table, no change to any existing one:
--
--   "PermissionEffect"        GRANT adds a key to what the user's roles give,
--                             DENY takes one away and beats every grant.
--   "UserPermissionOverride"  one row per (user, key). A user's effective set is
--                             (union of the primary and extra roles' keys ∪ GRANT)
--                             − DENY, computed by `effectivePermissions` in
--                             @npi/shared. The whole set is replaced by
--                             PUT /admin/users/:id/permissions and audited in the
--                             same transaction.
--
-- Additive only, and no row is written: with the table empty every user's
-- permissions are exactly what their roles give today. A user's overrides go
-- with the user (CASCADE); users are switched off, not removed, so in practice
-- they stay. "createdById" carries no foreign key, like "AuditLog"."actorId".

-- CreateEnum
CREATE TYPE "PermissionEffect" AS ENUM ('GRANT', 'DENY');

-- CreateTable
CREATE TABLE "UserPermissionOverride" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "effect" "PermissionEffect" NOT NULL,
    "reason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserPermissionOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: "who holds this key effectively?" — the lockout guard, the
-- notification fan-out and the proposal's other-approver check look up the
-- overrides of one key and one effect inside one organization.
CREATE INDEX "UserPermissionOverride_organizationId_permission_effect_idx" ON "UserPermissionOverride"("organizationId", "permission", "effect");

-- CreateIndex: a key is either granted or denied to a user, never both.
CREATE UNIQUE INDEX "UserPermissionOverride_userId_permission_key" ON "UserPermissionOverride"("userId", "permission");

-- AddForeignKey
ALTER TABLE "UserPermissionOverride" ADD CONSTRAINT "UserPermissionOverride_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: the overrides go with the user.
ALTER TABLE "UserPermissionOverride" ADD CONSTRAINT "UserPermissionOverride_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
