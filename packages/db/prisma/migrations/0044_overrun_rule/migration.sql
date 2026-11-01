-- Package 5 · P5-2 (ADR-05 §2-3): the EXECUTION_OVERRUN band of the matrix.
-- Owner decision 2026-10-29 (a): executing beyond the budget needs the projects
-- general manager AND the general manager. Every organization holding both
-- roles ('pm', 'executive') and no active EXECUTION_OVERRUN rule gets one from
-- 0 SAR: step 1 pm, step 2 executive. Editable in /admin → approval matrix.
-- Separate from 0043 because a new enum value cannot be used in the
-- transaction that adds it.

WITH orgs AS (
  SELECT o."id" AS org, pm."id" AS pm_role, ex."id" AS ex_role
  FROM "Organization" o
  JOIN "Role" pm ON pm."organizationId" = o."id" AND pm."key" = 'pm'
  JOIN "Role" ex ON ex."organizationId" = o."id" AND ex."key" = 'executive'
  WHERE NOT EXISTS (
    SELECT 1 FROM "ApprovalRule" r
    WHERE r."organizationId" = o."id" AND r."documentType" = 'EXECUTION_OVERRUN' AND r."isActive" = true
  )
),
created AS (
  INSERT INTO "ApprovalRule" ("id", "organizationId", "documentType", "minAmount", "isActive", "createdAt", "updatedAt")
  SELECT gen_random_uuid()::text, orgs.org, 'EXECUTION_OVERRUN', 0, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM orgs
  RETURNING "id", "organizationId"
)
INSERT INTO "ApprovalRuleStep" ("id", "ruleId", "sequence", "roleId")
SELECT gen_random_uuid()::text, created."id", s.seq, s.role
FROM created
JOIN orgs ON orgs.org = created."organizationId"
CROSS JOIN LATERAL (VALUES (1, orgs.pm_role), (2, orgs.ex_role)) AS s(seq, role);
