-- Reverses 0025_loss_reasons_backfill.
--
--   npx prisma db execute --file packages/db/prisma/migrations/0025_loss_reasons_backfill/down.sql --schema packages/db/prisma/schema.prisma
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '0025_loss_reasons_backfill';
--
-- Deletes only the default reasons that are still untouched and unused: the six
-- seeded names, still active, still at their seeded sort order, and not
-- referenced by any opportunity (the FK is RESTRICT, so a used reason could not
-- be deleted anyway). A reason the administrator renamed, reordered or switched
-- off is theirs and stays; so does one that was created by `db:seed` with the
-- same shape — the two sources are indistinguishable by design, which is why
-- this file never needs to run before 0024's down.sql (that one drops the table).

DELETE FROM "LossReason" lr
WHERE lr."isActive" = true
  AND (lr."nameAr", lr."sortOrder") IN (
    ('السعر', 1),
    ('اختيار منافس', 2),
    ('إلغاء المشروع أو تأجيله', 3),
    ('عدم توفر التمويل', 4),
    ('عدم استيفاء شروط المناقصة', 5),
    ('أخرى', 6)
  )
  AND NOT EXISTS (SELECT 1 FROM "Opportunity" op WHERE op."lossReasonId" = lr."id");
