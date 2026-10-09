-- T-39: indexes for the reads the screens make on every load. The plain
-- composite ones are declared in schema.prisma as well (@@index, same names
-- Prisma would generate); the two partial ones Prisma cannot express live
-- only here, like 0003's partial unique index. Nothing is dropped.

-- /trust (src/audit/query.ts listAudit): the organization's log filtered by
-- event, newest first. (npiOrgId, ts) alone scans every row of the
-- organization and discards the other events.
CREATE INDEX "llm_audit_npiOrgId_event_ts_idx" ON "llm_audit"("npiOrgId", "event", "ts");

-- Document counter (src/queries/usage.ts loadDocumentUsage): one document's
-- calls in time order; documentId had no index at all.
CREATE INDEX "llm_audit_npiOrgId_documentId_ts_idx" ON "llm_audit"("npiOrgId", "documentId", "ts");

-- /trust summary (auditSummary) and the imageSent filter: image rows are a
-- small minority of the log, so a partial index keeps the count and the
-- filtered page from reading the text rows.
CREATE INDEX "llm_audit_npiOrgId_imageSent_ts_idx" ON "llm_audit"("npiOrgId", "ts") WHERE "imageSent";

-- /trust summary: the error count.
CREATE INDEX "llm_audit_npiOrgId_error_idx" ON "llm_audit"("npiOrgId") WHERE "error" IS NOT NULL;

-- /metrics (src/metrics/load.ts): the organization's approved jobs. intake_jobs
-- had (npiUserId, createdAt) and (status) only — nothing starting with npiOrgId.
CREATE INDEX "intake_jobs_npiOrgId_approvedAt_idx" ON "intake_jobs"("npiOrgId", "approvedAt");

-- Handover (src/positions/reassign.ts): documents by position (the foreign
-- key had no index; `visibleDocsWhere` joins on it) and the predecessor check
-- (`conversationReadableBy`: positionId + fromUserId); the successor's own
-- documents (toUserId).
CREATE INDEX "handover_docs_positionId_fromUserId_idx" ON "handover_docs"("positionId", "fromUserId");
CREATE INDEX "handover_docs_toUserId_idx" ON "handover_docs"("toUserId");

-- Memory refresh gate (src/memory/extract-npi.ts latestNpiFactAt: max
-- updatedAt of the organization's npi facts, read before every turn that
-- might refresh) and the rewrite's read of the same rows.
CREATE INDEX "memory_facts_npiOrgId_sourceType_updatedAt_idx" ON "memory_facts"("npiOrgId", "sourceType", "updatedAt");
