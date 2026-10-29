-- Reverses 0037_proposal_attachments as far as Postgres allows.
--
--   psql "$DATABASE_URL" -f down.sql
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '0037_proposal_attachments';
--
-- Postgres cannot drop an enum value, so 'PROPOSAL' stays in the type (unused
-- by older code). What this does: refuses while any proposal attachment exists,
-- since an older image cannot list or serve it. Move those files first, e.g.
--   SELECT id, "entityId", "fileName" FROM "Attachment" WHERE "entityType" = 'PROPOSAL';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Attachment" WHERE "entityType" = 'PROPOSAL') THEN
    RAISE EXCEPTION 'Proposal attachments exist — an older image cannot serve them; move them first';
  END IF;
END $$;
