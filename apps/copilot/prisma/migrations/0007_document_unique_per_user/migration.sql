-- D-T31-11 (T-31): a document is deduplicated per user within the organization.
-- T-21's org-wide unique key returned the first uploader's row to any colleague
-- who uploaded the same bytes, and the chat (which looks a document up by its
-- owner) then answered 404. Same bytes, same organization, different user: a
-- row of their own, sharing the content-addressed storage path.
DROP INDEX "documents_npiOrgId_sha256_key";

CREATE UNIQUE INDEX "documents_npiOrgId_npiUserId_sha256_key" ON "documents"("npiOrgId", "npiUserId", "sha256");
