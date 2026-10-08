-- CRM Phase 1 · Step 5 (§4.4, §10, §11) — the communication log and the follow-up tasks.
--
-- Two new tables, no change to any existing one:
--
--   "Activity"     what happened with a customer: a note, a call, a meeting. Always
--                  tied to a customer; optionally to an opportunity, a project and a
--                  contact. Edited by its author only and never deleted by the
--                  application (the log is evidence, like the audit trail).
--   "FollowUpTask" what must happen next: a title, a due DAY, an assignee, a reminder.
--
-- Additive only: no existing column, table or enum value is altered or removed. The
-- customer of an entry or a task is RESTRICT (a customer is never deleted; a merged
-- one is marked), the optional links are SET NULL.
--
-- The new enum VALUE 'ACTIVITY' (on "AttachmentEntity", so a file can hang off a log
-- entry) is not used inside this file: Postgres refuses to use a value added in the
-- same transaction. The data half (settings and the TSK- numbering sequence) is
-- 0029, a migration of its own.

-- CreateEnum
CREATE TYPE "ActivityType" AS ENUM ('NOTE', 'CALL', 'MEETING');

-- CreateEnum
CREATE TYPE "FollowUpTaskStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED');

-- AlterEnum: attachments may now hang off a log entry. ADD VALUE only.
ALTER TYPE "AttachmentEntity" ADD VALUE IF NOT EXISTS 'ACTIVITY';

-- CreateTable
CREATE TABLE "Activity" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "opportunityId" TEXT,
    "projectId" TEXT,
    "contactId" TEXT,
    "activityType" "ActivityType" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "body" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FollowUpTask" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "opportunityId" TEXT,
    "projectId" TEXT,
    "title" TEXT NOT NULL,
    "details" TEXT,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "remindAt" TIMESTAMP(3),
    "assigneeId" TEXT NOT NULL,
    "status" "FollowUpTaskStatus" NOT NULL DEFAULT 'OPEN',
    "completedAt" TIMESTAMP(3),
    "completedById" TEXT,
    "cancelReason" TEXT,
    "reminderSentAt" TIMESTAMP(3),
    "overdueNotifiedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FollowUpTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: a customer's timeline, newest first.
CREATE INDEX "Activity_organizationId_customerId_occurredAt_idx" ON "Activity"("organizationId", "customerId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "Activity_organizationId_opportunityId_idx" ON "Activity"("organizationId", "opportunityId");

-- CreateIndex
CREATE INDEX "Activity_createdById_idx" ON "Activity"("createdById");

-- CreateIndex: a person's open tasks by due day (the inbox and /tasks).
CREATE INDEX "FollowUpTask_organizationId_assigneeId_status_dueAt_idx" ON "FollowUpTask"("organizationId", "assigneeId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "FollowUpTask_organizationId_customerId_status_idx" ON "FollowUpTask"("organizationId", "customerId", "status");

-- CreateIndex
CREATE INDEX "FollowUpTask_organizationId_opportunityId_idx" ON "FollowUpTask"("organizationId", "opportunityId");

-- CreateIndex: the hourly sweep looks up (status, remindAt) and (status, dueAt).
CREATE INDEX "FollowUpTask_status_remindAt_idx" ON "FollowUpTask"("status", "remindAt");

-- CreateIndex
CREATE INDEX "FollowUpTask_status_dueAt_idx" ON "FollowUpTask"("status", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "FollowUpTask_organizationId_code_key" ON "FollowUpTask"("organizationId", "code");

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: a customer that has a log is never deleted (it is marked when merged).
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "CustomerContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: the author leaving does not delete the entry.
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUpTask" ADD CONSTRAINT "FollowUpTask_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUpTask" ADD CONSTRAINT "FollowUpTask_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUpTask" ADD CONSTRAINT "FollowUpTask_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUpTask" ADD CONSTRAINT "FollowUpTask_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: a user who still owns a task is not deleted (users are switched off, not removed).
ALTER TABLE "FollowUpTask" ADD CONSTRAINT "FollowUpTask_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUpTask" ADD CONSTRAINT "FollowUpTask_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUpTask" ADD CONSTRAINT "FollowUpTask_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
