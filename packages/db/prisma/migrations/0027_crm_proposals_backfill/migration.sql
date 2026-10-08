-- CRM Phase 1 · Step 4 (§4.3, §8, §9) — the data half of the proposal step, for
-- every organization that exists when this migration runs.
--
-- It lives apart from 0026 because it USES the enum values 0026 adds
-- ('PROPOSAL' on "ApprovalDocument"; the new "ProposalStatus" states are written
-- by the application afterwards) and Postgres refuses to use a value added in
-- the same transaction. On the live server `db:seed` is not part of a deploy, so
-- everything the application needs to start working is written here:
--
--   1. the two proposal settings (default validity, cost-age warning limit),
--   2. the approval rule «every proposal, from 0 SAR up, is signed by the
--      executive» (CRM-S4-a): one band [0, no ceiling), one step, the seeded
--      role `executive` — only where that role exists and no active PROPOSAL rule does,
--   3. the PROPOSAL workflow (7 states, 12 transitions) as DATA, the same one
--      `db:seed` writes,
--   4. a workflow instance for each proposal that already exists, in the state it
--      is in, with an ADOPT history row (no actor) — closed when it is ACCEPTED.
--
-- Idempotent and non-destructive: every INSERT is guarded (WHERE NOT EXISTS /
-- ON CONFLICT DO NOTHING), so re-running it, or running `db:seed` before or
-- after, never duplicates or overwrites a row an administrator has tuned (a
-- changed band or validity is never reset). Organizations created later get the
-- same from `db:seed`.

-- ── 1. settings ────────────────────────────────────────────────────────────
INSERT INTO "OrgSetting" ("id", "organizationId", "key", "valueJson", "updatedAt")
SELECT gen_random_uuid()::text, o."id", 'crm.proposal.validityDays', '30'::jsonb, CURRENT_TIMESTAMP
FROM "Organization" o
ON CONFLICT ("organizationId", "key") DO NOTHING;

INSERT INTO "OrgSetting" ("id", "organizationId", "key", "valueJson", "updatedAt")
SELECT gen_random_uuid()::text, o."id", 'crm.proposal.costAgeWarnDays', '30'::jsonb, CURRENT_TIMESTAMP
FROM "Organization" o
ON CONFLICT ("organizationId", "key") DO NOTHING;

-- ── 2. the approval rule ───────────────────────────────────────────────────
WITH exec AS (
  SELECT r."id" AS "roleId", r."organizationId" AS "organizationId"
  FROM "Role" r
  WHERE r."key" = 'executive'
),
new_rules AS (
  INSERT INTO "ApprovalRule" ("id", "organizationId", "documentType", "minAmount", "maxAmount", "departmentId", "escalationHours", "isActive", "createdAt", "updatedAt")
  SELECT gen_random_uuid()::text, e."organizationId", 'PROPOSAL', 0, NULL, NULL, 48, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM exec e
  WHERE NOT EXISTS (
    SELECT 1 FROM "ApprovalRule" ar
    WHERE ar."organizationId" = e."organizationId" AND ar."documentType" = 'PROPOSAL' AND ar."isActive" = true
  )
  RETURNING "id", "organizationId"
)
INSERT INTO "ApprovalRuleStep" ("id", "ruleId", "sequence", "roleId")
SELECT gen_random_uuid()::text, nr."id", 1, e."roleId"
FROM new_rules nr
JOIN exec e ON e."organizationId" = nr."organizationId";

-- ── 3. the PROPOSAL workflow ───────────────────────────────────────────────
INSERT INTO "wf_definitions" ("id", "organizationId", "code", "nameAr", "nameEn", "documentType", "version", "isActive", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, o."id", 'PROPOSAL', 'عرض سعر', 'Proposal', 'Proposal', 1, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Organization" o
WHERE NOT EXISTS (
  SELECT 1 FROM "wf_definitions" d WHERE d."organizationId" = o."id" AND d."code" = 'PROPOSAL' AND d."version" = 1
);

INSERT INTO "wf_states" ("id", "definitionId", "code", "nameAr", "nameEn", "kind", "sortOrder")
SELECT gen_random_uuid()::text, d."id", s."code", s."nameAr", s."nameEn", s."kind"::"WfStateKind", s."sortOrder"
FROM "wf_definitions" d
CROSS JOIN (VALUES
  ('DRAFT',            'مسودة',            'Draft',                 'INITIAL',      0),
  ('PENDING_APPROVAL', 'بانتظار الاعتماد', 'Pending approval',      'INTERMEDIATE', 1),
  ('APPROVED',         'معتمد',            'Approved',              'INTERMEDIATE', 2),
  ('SENT',             'مُرسَل',           'Sent to customer',      'INTERMEDIATE', 3),
  ('ACCEPTED',         'مقبول',            'Accepted',              'FINAL',        4),
  ('REJECTED',         'مرفوض',            'Rejected by customer',  'INTERMEDIATE', 5),
  ('EXPIRED',          'منتهي الصلاحية',   'Expired',               'INTERMEDIATE', 6)
) AS s("code", "nameAr", "nameEn", "kind", "sortOrder")
WHERE d."code" = 'PROPOSAL' AND d."version" = 1
ON CONFLICT ("definitionId", "code") DO NOTHING;

INSERT INTO "wf_transitions" ("id", "definitionId", "fromState", "toState", "actionCode", "nameAr", "nameEn", "requiredPermission", "conditionExpr", "emitsEvent", "requiresApproval", "sortOrder")
SELECT gen_random_uuid()::text, d."id", t."fromState", t."toState", t."actionCode", t."nameAr", t."nameEn", t."permission", t."conditionExpr", t."emitsEvent", t."requiresApproval", t."sortOrder"
FROM "wf_definitions" d
CROSS JOIN (VALUES
  ('DRAFT',            'PENDING_APPROVAL', 'SUBMIT',  'رفع للاعتماد',      'Submit for approval', 'commercial.proposal.write',   'total > 0', NULL::text,          true,  0),
  ('PENDING_APPROVAL', 'APPROVED',         'APPROVE', 'اعتماد',            'Approve',             'commercial.proposal.approve', NULL::text,  'proposal.approved', false, 1),
  ('PENDING_APPROVAL', 'DRAFT',            'RETURN',  'إعادة للمسودة',     'Return to draft',     'commercial.proposal.approve', NULL::text,  NULL::text,          false, 2),
  ('APPROVED',         'SENT',             'SEND',    'إرسال للعميل',      'Send to customer',    'commercial.proposal.write',   NULL::text,  'proposal.sent',     false, 3),
  ('SENT',             'ACCEPTED',         'ACCEPT',  'قبول العميل',       'Customer accepted',   'commercial.proposal.write',   NULL::text,  'proposal.accepted', false, 4),
  ('SENT',             'REJECTED',         'REJECT',  'رفض العميل',        'Customer rejected',   'commercial.proposal.write',   NULL::text,  NULL::text,          false, 5),
  ('APPROVED',         'EXPIRED',          'EXPIRE',  'انتهاء الصلاحية',   'Expire',              'commercial.proposal.write',   NULL::text,  'proposal.expired',  false, 6),
  ('SENT',             'EXPIRED',          'EXPIRE',  'انتهاء الصلاحية',   'Expire',              'commercial.proposal.write',   NULL::text,  'proposal.expired',  false, 7),
  ('APPROVED',         'DRAFT',            'REVISE',  'نسخة جديدة',        'New revision',        'commercial.proposal.write',   NULL::text,  NULL::text,          false, 8),
  ('SENT',             'DRAFT',            'REVISE',  'نسخة جديدة',        'New revision',        'commercial.proposal.write',   NULL::text,  NULL::text,          false, 9),
  ('REJECTED',         'DRAFT',            'REVISE',  'نسخة جديدة',        'New revision',        'commercial.proposal.write',   NULL::text,  NULL::text,          false, 10),
  ('EXPIRED',          'DRAFT',            'REVISE',  'نسخة جديدة',        'New revision',        'commercial.proposal.write',   NULL::text,  NULL::text,          false, 11)
) AS t("fromState", "toState", "actionCode", "nameAr", "nameEn", "permission", "conditionExpr", "emitsEvent", "requiresApproval", "sortOrder")
WHERE d."code" = 'PROPOSAL' AND d."version" = 1
ON CONFLICT ("definitionId", "fromState", "actionCode") DO NOTHING;

-- ── 4. adopt the proposals that exist ──────────────────────────────────────
-- A proposal is adopted in the state it is in (DRAFT, SENT, ACCEPTED or REJECTED
-- — the only ones that existed); an ACCEPTED one is finished, so its instance is
-- closed and never parks in a task box.
INSERT INTO "wf_instances" ("id", "organizationId", "definitionId", "documentType", "documentId", "documentCode", "currentState", "assigneeRoleId", "openedAt", "closedAt")
SELECT gen_random_uuid()::text, p."organizationId", d."id", 'Proposal', p."id", p."code", p."status"::text, NULL, CURRENT_TIMESTAMP,
       CASE WHEN p."status"::text = 'ACCEPTED' THEN CURRENT_TIMESTAMP ELSE NULL END
FROM "Proposal" p
JOIN "wf_definitions" d ON d."organizationId" = p."organizationId" AND d."code" = 'PROPOSAL' AND d."version" = 1
WHERE NOT EXISTS (
  SELECT 1 FROM "wf_instances" i
  WHERE i."organizationId" = p."organizationId" AND i."documentType" = 'Proposal' AND i."documentId" = p."id"
);

INSERT INTO "wf_history" ("id", "instanceId", "fromState", "toState", "actionCode", "actorId", "comment", "createdAt")
SELECT gen_random_uuid()::text, i."id", i."currentState", i."currentState", 'ADOPT', NULL,
       'Adopted into the workflow engine at the CRM Step 4 migration', CURRENT_TIMESTAMP
FROM "wf_instances" i
WHERE i."documentType" = 'Proposal'
  AND NOT EXISTS (SELECT 1 FROM "wf_history" h WHERE h."instanceId" = i."id");
