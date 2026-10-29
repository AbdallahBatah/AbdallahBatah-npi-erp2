-- Reverses 0033_opportunity_cost_study.
--
--   psql "$DATABASE_URL" -f down.sql
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '0033_opportunity_cost_study';
--
-- Run it before rolling the containers back to an image older than P3-2.

ALTER TYPE "OpportunityStage" RENAME VALUE 'COST_STUDY' TO 'QUALIFICATION';
