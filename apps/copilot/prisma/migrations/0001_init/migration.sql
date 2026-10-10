-- CreateTable
CREATE TABLE "copilot_sessions" (
    "id" TEXT NOT NULL,
    "npiUserId" TEXT NOT NULL,
    "npiOrgId" TEXT NOT NULL,
    "roleKey" TEXT NOT NULL,
    "departmentId" TEXT,
    "tokenEncrypted" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "copilot_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" TEXT NOT NULL,
    "npiOrgId" TEXT NOT NULL,
    "roleKey" TEXT NOT NULL,
    "departmentId" TEXT,
    "titleAr" TEXT NOT NULL,
    "personaAr" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "position_assignments" (
    "id" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "npiUserId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "handoverDocId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "position_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "handover_docs" (
    "id" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "fromUserId" TEXT,
    "toUserId" TEXT NOT NULL,
    "bodyJson" JSONB NOT NULL,
    "bodyAr" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "handover_docs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "firm_config" (
    "id" TEXT NOT NULL,
    "npiOrgId" TEXT NOT NULL,
    "profileKey" TEXT,
    "visibleModulesJson" JSONB NOT NULL,
    "acceptedDocTypesJson" JSONB NOT NULL,
    "terminologyJson" JSONB NOT NULL,
    "npiApiGapsJson" JSONB NOT NULL,
    "setupCompletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "firm_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onboarding_sessions" (
    "id" TEXT NOT NULL,
    "npiOrgId" TEXT NOT NULL,
    "npiUserId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "stepsJson" JSONB NOT NULL,
    "profileChosen" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "onboarding_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_attempts" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "succeeded" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "copilot_sessions_npiUserId_idx" ON "copilot_sessions"("npiUserId");

-- CreateIndex
CREATE INDEX "copilot_sessions_expiresAt_idx" ON "copilot_sessions"("expiresAt");

-- CreateIndex
-- NULLS NOT DISTINCT (PostgreSQL 15+) so that a NULL departmentId is treated
-- as equal to another NULL: only one position per (org, role) is allowed
-- when there is no department, matching the "one position per role when no
-- department" rule from the copilot's business logic.
CREATE UNIQUE INDEX "positions_npiOrgId_roleKey_departmentId_key" ON "positions"("npiOrgId", "roleKey", "departmentId") NULLS NOT DISTINCT;

-- CreateIndex
CREATE INDEX "position_assignments_positionId_endedAt_idx" ON "position_assignments"("positionId", "endedAt");

-- CreateIndex
CREATE INDEX "position_assignments_npiUserId_idx" ON "position_assignments"("npiUserId");

-- CreateIndex
CREATE UNIQUE INDEX "firm_config_npiOrgId_key" ON "firm_config"("npiOrgId");

-- CreateIndex
CREATE INDEX "onboarding_sessions_npiOrgId_idx" ON "onboarding_sessions"("npiOrgId");

-- CreateIndex
CREATE INDEX "login_attempts_key_attemptedAt_idx" ON "login_attempts"("key", "attemptedAt");

-- AddForeignKey
ALTER TABLE "position_assignments" ADD CONSTRAINT "position_assignments_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "position_assignments" ADD CONSTRAINT "position_assignments_handoverDocId_fkey" FOREIGN KEY ("handoverDocId") REFERENCES "handover_docs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "handover_docs" ADD CONSTRAINT "handover_docs_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

