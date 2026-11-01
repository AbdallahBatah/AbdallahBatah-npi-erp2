-- Package 7 · P7-1: PROJECT_CLOSURE from 0 SAR — projects GM, then general manager (owner work cycle step 16).
-- Only for organizations holding both roles and no active rule; editable in /admin → approval matrix.

WITH orgs AS (
  SELECT o."id" AS org, pm."id" AS pm_role, ex."id" AS ex_role
  FROM "Organization" o
  JOIN "Role" pm ON pm."organizationId" = o."id" AND pm."key" = 'pm'
  JOIN "Role" ex ON ex."organizationId" = o."id" AND ex."key" = 'executive'
  WHERE NOT EXISTS (
    SELECT 1 FROM "ApprovalRule" r
    WHERE r."organizationId" = o."id" AND r."documentType" = 'PROJECT_CLOSURE' AND r."isActive" = true
  )
),
created AS (
  INSERT INTO "ApprovalRule" ("id", "organizationId", "documentType", "minAmount", "isActive", "createdAt", "updatedAt")
  SELECT gen_random_uuid()::text, orgs.org, 'PROJECT_CLOSURE', 0, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM orgs
  RETURNING "id", "organizationId"
)
INSERT INTO "ApprovalRuleStep" ("id", "ruleId", "sequence", "roleId")
SELECT gen_random_uuid()::text, created."id", s.seq, s.role
FROM created
JOIN orgs ON orgs.org = created."organizationId"
CROSS JOIN LATERAL (VALUES (1, orgs.pm_role), (2, orgs.ex_role)) AS s(seq, role);
