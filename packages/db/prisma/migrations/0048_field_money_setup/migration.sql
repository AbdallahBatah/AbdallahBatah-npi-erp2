-- Package 6 (ADR-06): accounts, posting rules, approval rules and numbering
-- for vendor payment requests and petty cash. Separate from 0047 because new
-- enum values cannot be used in the transaction that adds them.

-- Two asset accounts per organization (codes 1050, 1500 unless taken).
INSERT INTO "Account" ("id", "organizationId", "code", "nameAr", "nameEn", "accountType", "createdAt")
SELECT gen_random_uuid()::text, o."id", a.code, a.ar, a.en, 'ASSET', CURRENT_TIMESTAMP
FROM "Organization" o
CROSS JOIN (VALUES ('1050', 'العُهد النقدية', 'Petty Cash (Custody)'), ('1500', 'دفعات مقدمة للموردين', 'Advances to Suppliers')) AS a(code, ar, en)
WHERE NOT EXISTS (SELECT 1 FROM "Account" x WHERE x."organizationId" = o."id" AND x."code" = a.code);

INSERT INTO "AccountMapping" ("id", "organizationId", "purpose", "accountId", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, a."organizationId", m.purpose::"PostingPurpose", a."id", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Account" a
JOIN (VALUES ('1050', 'PETTY_CASH'), ('1500', 'VENDOR_ADVANCE')) AS m(code, purpose) ON m.code = a."code"
WHERE NOT EXISTS (
  SELECT 1 FROM "AccountMapping" x WHERE x."organizationId" = a."organizationId" AND x."purpose" = m.purpose::"PostingPurpose"
);

INSERT INTO "NumberingSequence" ("id", "organizationId", "documentType", "prefix", "nextValue", "fiscalYear", "padding")
SELECT gen_random_uuid()::text, o."id", d.t, d.p, 1, EXTRACT(YEAR FROM now())::int, 5
FROM "Organization" o
CROSS JOIN (VALUES ('VENDOR_PAYMENT_REQUEST', 'VPR'), ('PETTY_CASH_CUSTODY', 'PCC'), ('PETTY_CASH_MOVEMENT', 'PCM')) AS d(t, p)
WHERE NOT EXISTS (
  SELECT 1 FROM "NumberingSequence" ns WHERE ns."organizationId" = o."id" AND ns."documentType" = d.t
);

-- Vendor payment request: projects GM, then general manager.
WITH orgs AS (
  SELECT o."id" AS org, pm."id" AS pm_role, ex."id" AS ex_role
  FROM "Organization" o
  JOIN "Role" pm ON pm."organizationId" = o."id" AND pm."key" = 'pm'
  JOIN "Role" ex ON ex."organizationId" = o."id" AND ex."key" = 'executive'
  WHERE NOT EXISTS (
    SELECT 1 FROM "ApprovalRule" r
    WHERE r."organizationId" = o."id" AND r."documentType" = 'VENDOR_PAYMENT_REQUEST' AND r."isActive" = true
  )
),
created AS (
  INSERT INTO "ApprovalRule" ("id", "organizationId", "documentType", "minAmount", "isActive", "createdAt", "updatedAt")
  SELECT gen_random_uuid()::text, orgs.org, 'VENDOR_PAYMENT_REQUEST', 0, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM orgs
  RETURNING "id", "organizationId"
)
INSERT INTO "ApprovalRuleStep" ("id", "ruleId", "sequence", "roleId")
SELECT gen_random_uuid()::text, created."id", s.seq, s.role
FROM created
JOIN orgs ON orgs.org = created."organizationId"
CROSS JOIN LATERAL (VALUES (1, orgs.pm_role), (2, orgs.ex_role)) AS s(seq, role);

-- Petty cash settlement: projects GM.
WITH orgs AS (
  SELECT o."id" AS org, pm."id" AS pm_role, ex."id" AS ex_role
  FROM "Organization" o
  JOIN "Role" pm ON pm."organizationId" = o."id" AND pm."key" = 'pm'
  JOIN "Role" ex ON ex."organizationId" = o."id" AND ex."key" = 'executive'
  WHERE NOT EXISTS (
    SELECT 1 FROM "ApprovalRule" r
    WHERE r."organizationId" = o."id" AND r."documentType" = 'PETTY_CASH_SETTLEMENT' AND r."isActive" = true
  )
),
created AS (
  INSERT INTO "ApprovalRule" ("id", "organizationId", "documentType", "minAmount", "isActive", "createdAt", "updatedAt")
  SELECT gen_random_uuid()::text, orgs.org, 'PETTY_CASH_SETTLEMENT', 0, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM orgs
  RETURNING "id", "organizationId"
)
INSERT INTO "ApprovalRuleStep" ("id", "ruleId", "sequence", "roleId")
SELECT gen_random_uuid()::text, created."id", s.seq, s.role
FROM created
JOIN orgs ON orgs.org = created."organizationId"
CROSS JOIN LATERAL (VALUES (1, orgs.pm_role)) AS s(seq, role);
