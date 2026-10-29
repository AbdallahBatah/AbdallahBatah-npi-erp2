-- Package 2 · P2-2 — seed the CONTRACT band of the approval matrix.
--
-- Every organization whose matrix has an active PROPOSAL rule from 0 SAR (the
-- owner's 2026-10-12 decision: the general manager signs every proposal) gets
-- one active CONTRACT rule from 0 SAR with the same signatories, in the same
-- order — the general manager signs every contract too, and that one signature
-- is the approval of the accepted offer and of the contract's terms. An
-- organization that already has an active CONTRACT rule is left alone, so a
-- rerun or a hand-made rule is never duplicated. Rules stay editable in
-- /admin → approval matrix. Down: down.sql.

WITH src AS (
  SELECT DISTINCT ON (r."organizationId") r."organizationId", r."id" AS src_rule
  FROM "ApprovalRule" r
  WHERE r."documentType" = 'PROPOSAL' AND r."isActive" = true AND r."minAmount" = 0 AND r."departmentId" IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM "ApprovalRule" c
      WHERE c."organizationId" = r."organizationId" AND c."documentType" = 'CONTRACT' AND c."isActive" = true
    )
  ORDER BY r."organizationId", r."createdAt"
),
created AS (
  INSERT INTO "ApprovalRule" ("id", "organizationId", "documentType", "minAmount", "isActive", "createdAt", "updatedAt")
  SELECT gen_random_uuid()::text, src."organizationId", 'CONTRACT', 0, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM src
  RETURNING "id", "organizationId"
)
INSERT INTO "ApprovalRuleStep" ("id", "ruleId", "sequence", "roleId")
SELECT gen_random_uuid()::text, created."id", s."sequence", s."roleId"
FROM created
JOIN src ON src."organizationId" = created."organizationId"
JOIN "ApprovalRuleStep" s ON s."ruleId" = src.src_rule;
