-- pg_trgm is required for the trigram similarity index on memory_facts.
-- We deliberately do NOT enable the "unaccent" extension here: Arabic
-- normalization (alef/teh-marbuta/hamza folding, tashkeel stripping, digit
-- folding) is done in the application (see src/text/normalize.ts) and stored
-- pre-normalized in "searchText". Likewise "fts" below uses the "simple"
-- text-search configuration on purpose, not "arabic" or "english": those
-- configurations run a stemmer that would mangle proper names, project
-- codes, and item codes (e.g. folding "PRJ-00012" or a vendor name into
-- something a stemmer thinks is a root word).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateEnum
CREATE TYPE "DocumentKind" AS ENUM ('pdf_text', 'pdf_scanned', 'image');

-- CreateEnum
CREATE TYPE "FlowType" AS ENUM ('customer_contract', 'pr', 'po', 'grn', 'vendor_bill');

-- CreateEnum
CREATE TYPE "IntakeStatus" AS ENUM ('extracting', 'preview', 'approved', 'executing', 'done', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "ConsentDecision" AS ENUM ('approved', 'cancelled');

-- CreateEnum
CREATE TYPE "MemoryScope" AS ENUM ('company', 'position');

-- CreateEnum
CREATE TYPE "MemoryEntityType" AS ENUM ('customer', 'vendor', 'project', 'item', 'position');

-- CreateEnum
CREATE TYPE "MemorySourceType" AS ENUM ('npi', 'chat');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('user', 'assistant');

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "npiOrgId" TEXT NOT NULL,
    "npiUserId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "kind" "DocumentKind" NOT NULL,
    "sensitivityFlag" BOOLEAN NOT NULL DEFAULT false,
    "consentEventId" TEXT,
    "extractedTextRedactedRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_events" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "npiOrgId" TEXT NOT NULL,
    "npiUserId" TEXT NOT NULL,
    "decision" "ConsentDecision" NOT NULL,
    "policyLine" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" TEXT NOT NULL,
    "npiOrgId" TEXT NOT NULL,
    "npiUserId" TEXT NOT NULL,
    "positionId" TEXT,
    "titleAr" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" "MessageRole" NOT NULL,
    "contentAr" TEXT NOT NULL,
    "badge" TEXT,
    "memoryNoteJson" JSONB,
    "intakeJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intake_jobs" (
    "id" TEXT NOT NULL,
    "npiOrgId" TEXT NOT NULL,
    "npiUserId" TEXT NOT NULL,
    "documentId" TEXT,
    "conversationId" TEXT,
    "flowType" "FlowType" NOT NULL,
    "status" "IntakeStatus" NOT NULL DEFAULT 'extracting',
    "extractedJson" JSONB,
    "previewJson" JSONB,
    "executionLogJson" JSONB,
    "npiEntityRefs" JSONB,
    "error" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "intake_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- "fts" is a generated column derived from the already-normalized
-- "searchText" (see src/text/normalize.ts / src/memory/fts.ts). Prisma
-- cannot express generated columns, so this table is not reproducible by
-- `prisma migrate diff` alone; it must stay hand-written like the rest of
-- this file.
CREATE TABLE "memory_facts" (
    "id" TEXT NOT NULL,
    "npiOrgId" TEXT NOT NULL,
    "scope" "MemoryScope" NOT NULL,
    "positionId" TEXT,
    "entityType" "MemoryEntityType" NOT NULL,
    "npiEntityId" TEXT,
    "factAr" TEXT NOT NULL,
    "searchText" TEXT NOT NULL,
    "valueJson" JSONB,
    "sourceType" "MemorySourceType" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "fts" tsvector GENERATED ALWAYS AS (to_tsvector('simple', "searchText")) STORED,

    CONSTRAINT "memory_facts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "redaction_sessions" (
    "id" TEXT NOT NULL,
    "npiOrgId" TEXT NOT NULL,
    "npiUserId" TEXT NOT NULL,
    "conversationId" TEXT,
    "mapEncrypted" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "redaction_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- "conversationId", "intakeJobId" and "documentId" are plain columns with NO
-- foreign key: an audit row must survive the deletion of the conversation,
-- intake job, or document it refers to (append-only, never cascaded away).
-- The CHECK constraint below enforces invariant I4: an image is never sent
-- to the model provider without a recorded consent event.
CREATE TABLE "llm_audit" (
    "id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "npiOrgId" TEXT NOT NULL,
    "npiUserId" TEXT NOT NULL,
    "conversationId" TEXT,
    "intakeJobId" TEXT,
    "documentId" TEXT,
    "event" TEXT NOT NULL,
    "modelTier" TEXT,
    "modelId" TEXT,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "costUsdMicro" BIGINT NOT NULL DEFAULT 0,
    "outboundRedactedText" TEXT,
    "imageSent" BOOLEAN NOT NULL DEFAULT false,
    "consentEventId" TEXT,
    "latencyMs" INTEGER,
    "error" TEXT,

    CONSTRAINT "llm_audit_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "llm_audit_image_requires_consent_check" CHECK ("imageSent" = false OR "consentEventId" IS NOT NULL)
);

-- CreateTable
CREATE TABLE "eval_runs" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "score" DOUBLE PRECISION,
    "passed" BOOLEAN,
    "detailsJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "eval_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_usage" (
    "id" TEXT NOT NULL,
    "npiOrgId" TEXT NOT NULL,
    "npiUserId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "costUsdMicro" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "documents_npiOrgId_sha256_key" ON "documents"("npiOrgId", "sha256");

-- CreateIndex
CREATE INDEX "documents_npiUserId_idx" ON "documents"("npiUserId");

-- CreateIndex
CREATE INDEX "consent_events_documentId_idx" ON "consent_events"("documentId");

-- CreateIndex
CREATE INDEX "conversations_npiUserId_updatedAt_idx" ON "conversations"("npiUserId", "updatedAt");

-- CreateIndex
CREATE INDEX "conversations_positionId_idx" ON "conversations"("positionId");

-- CreateIndex
CREATE INDEX "messages_conversationId_createdAt_idx" ON "messages"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "intake_jobs_npiUserId_createdAt_idx" ON "intake_jobs"("npiUserId", "createdAt");

-- CreateIndex
CREATE INDEX "intake_jobs_status_idx" ON "intake_jobs"("status");

-- CreateIndex
CREATE INDEX "memory_facts_npiOrgId_scope_idx" ON "memory_facts"("npiOrgId", "scope");

-- CreateIndex
CREATE INDEX "memory_facts_positionId_idx" ON "memory_facts"("positionId");

-- CreateIndex
CREATE INDEX "memory_facts_npiOrgId_entityType_npiEntityId_idx" ON "memory_facts"("npiOrgId", "entityType", "npiEntityId");

-- CreateIndex
-- GIN index over the generated tsvector column, for `fts @@ plainto_tsquery(...)`.
CREATE INDEX "memory_facts_fts_idx" ON "memory_facts" USING GIN ("fts");

-- CreateIndex
-- GIN trigram index over the raw normalized text, for `word_similarity(...)`
-- / `%` fuzzy matches (misspelled names) that a tsvector match would miss.
CREATE INDEX "memory_facts_searchText_trgm_idx" ON "memory_facts" USING GIN ("searchText" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "redaction_sessions_conversationId_idx" ON "redaction_sessions"("conversationId");

-- CreateIndex
CREATE INDEX "redaction_sessions_expiresAt_idx" ON "redaction_sessions"("expiresAt");

-- CreateIndex
CREATE INDEX "llm_audit_npiOrgId_ts_idx" ON "llm_audit"("npiOrgId", "ts");

-- CreateIndex
CREATE INDEX "llm_audit_npiUserId_ts_idx" ON "llm_audit"("npiUserId", "ts");

-- CreateIndex
CREATE INDEX "eval_runs_kind_startedAt_idx" ON "eval_runs"("kind", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "daily_usage_npiUserId_day_key" ON "daily_usage"("npiUserId", "day");

-- CreateIndex
CREATE INDEX "daily_usage_npiOrgId_day_idx" ON "daily_usage"("npiOrgId", "day");

-- AddForeignKey
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "positions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_intakeJobId_fkey" FOREIGN KEY ("intakeJobId") REFERENCES "intake_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intake_jobs" ADD CONSTRAINT "intake_jobs_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intake_jobs" ADD CONSTRAINT "intake_jobs_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_facts" ADD CONSTRAINT "memory_facts_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "positions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "redaction_sessions" ADD CONSTRAINT "redaction_sessions_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
