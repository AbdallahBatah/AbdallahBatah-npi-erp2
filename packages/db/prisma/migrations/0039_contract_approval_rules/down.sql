-- Reverses 0039_contract_approval_rules.
--
--   psql "$DATABASE_URL" -f down.sql
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '0039_contract_approval_rules';
--
-- Removes every CONTRACT rule with no request against it (the requests keep
-- their rule by SET NULL anyway); steps go with their rule (CASCADE).

DELETE FROM "ApprovalRule" r
WHERE r."documentType" = 'CONTRACT'
  AND NOT EXISTS (SELECT 1 FROM "ApprovalRequest" q WHERE q."ruleId" = r."id");
