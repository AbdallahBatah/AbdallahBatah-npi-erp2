-- Reverses 0027_crm_proposals_backfill (run this BEFORE 0026's down.sql).
--
--   npx prisma db execute --file packages/db/prisma/migrations/0027_crm_proposals_backfill/down.sql --schema packages/db/prisma/schema.prisma
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '0027_crm_proposals_backfill';
--
-- Removes what 0027 (or `db:seed`) wrote for the proposal step: the workflow
-- instances and their history for every proposal, the PROPOSAL workflow
-- definition (its states and transitions go with it), the PROPOSAL approval rule
-- and the two proposal settings.
--
-- What is lost: the workflow history of proposals (who submitted, approved, sent,
-- revised — the proposals' own tables keep their statuses and dates), and any
-- change an administrator made to the PROPOSAL rule or settings.
--
-- FAILS ON PURPOSE (and changes nothing — one transaction) if a PROPOSAL approval
-- chain is still open: deleting the rule while people owe signatures would strand
-- those proposals in «بانتظار الاعتماد». Decide or reject them first. Chains that
-- are already closed are kept (their rule link is cleared by the foreign key).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "ApprovalRequest" WHERE "documentType"::text = 'PROPOSAL' AND "status"::text = 'PENDING') THEN
    RAISE EXCEPTION 'Rollback of 0027 refused: a PROPOSAL approval chain is still PENDING. Decide or reject it first (see the header of down.sql).';
  END IF;
END $$;

-- history cascades from the instance
DELETE FROM "wf_instances" WHERE "documentType" = 'Proposal';

-- states and transitions cascade from the definition
DELETE FROM "wf_definitions" WHERE "code" = 'PROPOSAL' AND "documentType" = 'Proposal';

-- steps cascade from the rule; a closed request keeps existing with ruleId set to NULL
DELETE FROM "ApprovalRule" WHERE "documentType"::text = 'PROPOSAL';

DELETE FROM "OrgSetting" WHERE "key" IN ('crm.proposal.validityDays', 'crm.proposal.costAgeWarnDays');
