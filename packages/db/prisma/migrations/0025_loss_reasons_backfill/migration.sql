-- CRM Phase 1 · Step 3 follow-up (CRM-S3-b, 2026-10-08) — the six default loss
-- reasons for every organization that exists when this migration runs.
--
-- Step 3 (0024) created "LossReason" empty and left the defaults to `db:seed`.
-- On the live server the seed is not part of a deploy, so an organization
-- would have had no reason to pick when marking an opportunity lost (the
-- reason is mandatory). This migration gives every existing organization the
-- same six reasons the seed writes, in the same order, with the same names.
--
-- Idempotent and non-destructive: the unique key ("organizationId", "nameAr")
-- makes the INSERT a no-op for any reason that already exists — seeded,
-- renamed, reordered or switched off by an administrator — so re-running it,
-- or running `db:seed` before or after it, never duplicates or touches a row.
-- Organizations created later get their reasons from the seed (or from
-- Admin > Loss reasons), exactly as before.

INSERT INTO "LossReason" ("id", "organizationId", "nameAr", "nameEn", "isActive", "sortOrder", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, o."id", r."nameAr", r."nameEn", true, r."sortOrder", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Organization" o
CROSS JOIN (VALUES
    ('السعر',                        'Price',                          1),
    ('اختيار منافس',                 'Competitor chosen',              2),
    ('إلغاء المشروع أو تأجيله',       'Project cancelled or postponed', 3),
    ('عدم توفر التمويل',             'Funding not available',          4),
    ('عدم استيفاء شروط المناقصة',    'Tender requirements not met',    5),
    ('أخرى',                         'Other',                          6)
) AS r("nameAr", "nameEn", "sortOrder")
ON CONFLICT ("organizationId", "nameAr") DO NOTHING;
