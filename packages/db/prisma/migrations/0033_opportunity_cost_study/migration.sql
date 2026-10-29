-- Package 3 · P3-2 (ADR-03 §4-2) — the opportunity's second stage becomes the
-- company's «دراسة وتكلفة» (cost study). A rename in place: every opportunity
-- that was in QUALIFICATION is now in COST_STUDY, its stage history (audit
-- rows hold the old text) is untouched, and the funnel keeps its counts.
-- Postgres applies RENAME VALUE without rewriting the table.
--
-- Deploy note: for the moment between this migration and the container swap,
-- the old API answers 500 when asked to move an opportunity to QUALIFICATION;
-- every other stage keeps working. Down: down.sql.

ALTER TYPE "OpportunityStage" RENAME VALUE 'QUALIFICATION' TO 'COST_STUDY';
