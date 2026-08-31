-- M4 · the workflow engine, the outbox, and the three dimensions the approval
-- matrix was missing (department, escalation, delegation).
--
-- Purely additive. No existing column is dropped or retyped, and the two
-- enums that grow only gain values, so every row written before this migration
-- keeps its meaning. `down.sql` in this directory reverses it.

-- CreateEnum
CREATE TYPE "WfStateKind" AS ENUM ('INITIAL', 'INTERMEDIATE', 'FINAL');

-- CreateEnum
CREATE TYPE "WfEventStatus" AS ENUM ('PENDING', 'PROCESSED', 'FAILED');

-- CreateTable
CREATE TABLE "wf_definitions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "documentType" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wf_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wf_states" (
    "id" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "kind" "WfStateKind" NOT NULL DEFAULT 'INTERMEDIATE',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "wf_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wf_transitions" (
    "id" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "fromState" TEXT NOT NULL,
    "toState" TEXT NOT NULL,
    "actionCode" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "requiredPermission" TEXT NOT NULL,
    "conditionExpr" TEXT,
    "emitsEvent" TEXT,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "wf_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wf_instances" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "documentType" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "documentCode" TEXT NOT NULL,
    "currentState" TEXT NOT NULL,
    "assigneeRoleId" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "wf_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wf_history" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "fromState" TEXT NOT NULL,
    "toState" TEXT NOT NULL,
    "actionCode" TEXT NOT NULL,
    "actorId" TEXT,
    "onBehalfOfRoleId" TEXT,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wf_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domain_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "eventCode" TEXT NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "status" "WfEventStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "domain_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Department" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "parentId" TEXT,
    "managerId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalDelegation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalDelegation_pkey" PRIMARY KEY ("id")
);

-- AlterTable: the matrix gains its department and escalation dimensions.
ALTER TABLE "ApprovalRule" ADD COLUMN "departmentId" TEXT;
ALTER TABLE "ApprovalRule" ADD COLUMN "escalationHours" INTEGER;

-- AlterTable: escalation is measured from when the step became current.
-- Existing open chains are backfilled from createdAt, which is the only
-- honest answer available for them.
ALTER TABLE "ApprovalRequest" ADD COLUMN "currentStepAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "ApprovalRequest" ADD COLUMN "departmentId" TEXT;
UPDATE "ApprovalRequest" SET "currentStepAt" = "createdAt";

-- AlterTable
ALTER TABLE "ApprovalStep" ADD COLUMN "escalatedAt" TIMESTAMP(3);
ALTER TABLE "ApprovalStep" ADD COLUMN "delegationId" TEXT;

-- AlterTable: users belong to a department.
ALTER TABLE "User" ADD COLUMN "departmentId" TEXT;

-- CreateIndex
CREATE INDEX "wf_definitions_organizationId_code_isActive_idx" ON "wf_definitions"("organizationId", "code", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "wf_definitions_organizationId_code_version_key" ON "wf_definitions"("organizationId", "code", "version");

-- CreateIndex
CREATE INDEX "wf_states_definitionId_idx" ON "wf_states"("definitionId");

-- CreateIndex
CREATE UNIQUE INDEX "wf_states_definitionId_code_key" ON "wf_states"("definitionId", "code");

-- CreateIndex
CREATE INDEX "wf_transitions_definitionId_idx" ON "wf_transitions"("definitionId");

-- CreateIndex
CREATE INDEX "wf_transitions_definitionId_toState_idx" ON "wf_transitions"("definitionId", "toState");

-- CreateIndex
CREATE UNIQUE INDEX "wf_transitions_definitionId_fromState_actionCode_key" ON "wf_transitions"("definitionId", "fromState", "actionCode");

-- CreateIndex
CREATE INDEX "wf_instances_organizationId_documentType_currentState_idx" ON "wf_instances"("organizationId", "documentType", "currentState");

-- CreateIndex
CREATE INDEX "wf_instances_organizationId_assigneeRoleId_closedAt_idx" ON "wf_instances"("organizationId", "assigneeRoleId", "closedAt");

-- CreateIndex
CREATE UNIQUE INDEX "wf_instances_organizationId_documentType_documentId_key" ON "wf_instances"("organizationId", "documentType", "documentId");

-- CreateIndex
CREATE INDEX "wf_history_instanceId_createdAt_idx" ON "wf_history"("instanceId", "createdAt");

-- CreateIndex
CREATE INDEX "domain_events_status_nextAttemptAt_idx" ON "domain_events"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "domain_events_organizationId_eventCode_createdAt_idx" ON "domain_events"("organizationId", "eventCode", "createdAt");

-- CreateIndex
CREATE INDEX "Department_organizationId_isActive_idx" ON "Department"("organizationId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Department_organizationId_code_key" ON "Department"("organizationId", "code");

-- CreateIndex
CREATE INDEX "ApprovalDelegation_organizationId_toUserId_isActive_idx" ON "ApprovalDelegation"("organizationId", "toUserId", "isActive");

-- CreateIndex
CREATE INDEX "ApprovalDelegation_organizationId_fromUserId_isActive_idx" ON "ApprovalDelegation"("organizationId", "fromUserId", "isActive");

-- CreateIndex
CREATE INDEX "ApprovalRule_organizationId_documentType_departmentId_isActi_idx" ON "ApprovalRule"("organizationId", "documentType", "departmentId", "isActive");

-- CreateIndex
CREATE INDEX "User_organizationId_departmentId_idx" ON "User"("organizationId", "departmentId");

-- AddForeignKey
ALTER TABLE "wf_definitions" ADD CONSTRAINT "wf_definitions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wf_states" ADD CONSTRAINT "wf_states_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "wf_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wf_transitions" ADD CONSTRAINT "wf_transitions_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "wf_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: a transition may only name states that exist in its own
-- definition. This composite FK is what makes a typo in a seed file a failed
-- insert rather than a flow with an unreachable state.
ALTER TABLE "wf_transitions" ADD CONSTRAINT "wf_transitions_definitionId_fromState_fkey" FOREIGN KEY ("definitionId", "fromState") REFERENCES "wf_states"("definitionId", "code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wf_transitions" ADD CONSTRAINT "wf_transitions_definitionId_toState_fkey" FOREIGN KEY ("definitionId", "toState") REFERENCES "wf_states"("definitionId", "code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wf_instances" ADD CONSTRAINT "wf_instances_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wf_instances" ADD CONSTRAINT "wf_instances_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "wf_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wf_instances" ADD CONSTRAINT "wf_instances_definitionId_currentState_fkey" FOREIGN KEY ("definitionId", "currentState") REFERENCES "wf_states"("definitionId", "code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wf_instances" ADD CONSTRAINT "wf_instances_assigneeRoleId_fkey" FOREIGN KEY ("assigneeRoleId") REFERENCES "Role"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wf_history" ADD CONSTRAINT "wf_history_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "wf_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wf_history" ADD CONSTRAINT "wf_history_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalRule" ADD CONSTRAINT "ApprovalRule_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalDelegation" ADD CONSTRAINT "ApprovalDelegation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalDelegation" ADD CONSTRAINT "ApprovalDelegation_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalDelegation" ADD CONSTRAINT "ApprovalDelegation_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalDelegation" ADD CONSTRAINT "ApprovalDelegation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A delegation window that ends before it starts is not a window. Checked by
-- the database, not only by the DTO, because the DTO is not the only writer.
ALTER TABLE "ApprovalDelegation" ADD CONSTRAINT "ApprovalDelegation_window_check" CHECK ("endsAt" > "startsAt");

-- Lending your authority to yourself is not a delegation.
ALTER TABLE "ApprovalDelegation" ADD CONSTRAINT "ApprovalDelegation_distinct_parties_check" CHECK ("fromUserId" <> "toUserId");

-- One open flow per document, enforced where it cannot be raced: two users
-- submitting the same requisition at the same instant must not open two
-- instances. Mirrors the partial unique index the approval matrix already has.
CREATE UNIQUE INDEX "wf_instances_one_open_per_document"
  ON "wf_instances" ("organizationId", "documentType", "documentId")
  WHERE "closedAt" IS NULL;
