-- CRM Phase 1 · Step 5 (§4.4, §10, §11) — the data half of the activity step, for every
-- organization that exists when this migration runs.
--
-- It lives apart from 0028 (schema) the way 0027 lives apart from 0026. On the live
-- server `db:seed` is not part of a deploy, so everything the application needs to
-- start working is written here (CRM-S3-b-2):
--
--   1. the two follow-up reminder settings: how many days before the due day the
--      reminder goes (1) and at which hour, Riyadh time (8),
--   2. the TSK- numbering sequence. NumberingService refuses a document type that has
--      no row for any year, so without it the first task would be a 500.
--
-- Idempotent and non-destructive: every INSERT is guarded (ON CONFLICT DO NOTHING /
-- WHERE NOT EXISTS), so re-running it, or running `db:seed` before or after, never
-- duplicates or overwrites a row an administrator has tuned (a changed hour is never
-- reset, and a sequence that has advanced is never rewound). Organizations created
-- later get the same from `db:seed`.

-- ── 1. settings ────────────────────────────────────────────────────────────
INSERT INTO "OrgSetting" ("id", "organizationId", "key", "valueJson", "updatedAt")
SELECT gen_random_uuid()::text, o."id", 'crm.task.reminderDaysBefore', '1'::jsonb, CURRENT_TIMESTAMP
FROM "Organization" o
ON CONFLICT ("organizationId", "key") DO NOTHING;

INSERT INTO "OrgSetting" ("id", "organizationId", "key", "valueJson", "updatedAt")
SELECT gen_random_uuid()::text, o."id", 'crm.task.reminderHour', '8'::jsonb, CURRENT_TIMESTAMP
FROM "Organization" o
ON CONFLICT ("organizationId", "key") DO NOTHING;

-- ── 2. the numbering sequence ──────────────────────────────────────────────
-- Skipped for an organization that already has a FOLLOWUP_TASK row for ANY year (the
-- service opens each new year from the previous one).
INSERT INTO "NumberingSequence" ("id", "organizationId", "documentType", "prefix", "nextValue", "fiscalYear", "padding")
SELECT gen_random_uuid()::text, o."id", 'FOLLOWUP_TASK', 'TSK', 1, EXTRACT(YEAR FROM now())::int, 5
FROM "Organization" o
WHERE NOT EXISTS (
  SELECT 1 FROM "NumberingSequence" ns
  WHERE ns."organizationId" = o."id" AND ns."documentType" = 'FOLLOWUP_TASK'
);
