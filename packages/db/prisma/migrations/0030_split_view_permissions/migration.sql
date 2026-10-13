-- ADR-02 task 4 (P1-6) — one view key per screen.
--
-- Three keys used to open several sidebar screens each. Four new keys take one
-- screen each off them, and the routes of that screen move with it:
--   crm.task.read           /tasks         (was crm.customer.read)
--   scm.requisition.read    /requisitions  (was scm.procurement.read)
--   finance.report.read     /finance       (was finance.ledger.read)
--   finance.statement.read  /statements    (was finance.ledger.read)
-- The old keys are neither removed nor renamed: each keeps its remaining
-- screen (/customers, /procurement, /ledger) and its routes.
--
-- Data only, no schema change. Every role that holds an old key is granted the
-- new one, in every organization, so no role sees or reaches anything
-- different after the deploy; narrowing a role is the owner's click later. No
-- user, role name, role assignment or approval rule is touched, and no read key
-- appears in the workflow transitions. Idempotent: a role that already holds
-- the new key is skipped, so running this twice equals running it once.
-- Reversed by down.sql.

-- The follow-up tasks screen and the open-tasks section of the customer page.
UPDATE "Role" SET "permissions" = array_append("permissions", 'crm.task.read')
WHERE 'crm.customer.read' = ANY("permissions")
  AND NOT ('crm.task.read' = ANY("permissions"));

-- The purchase requisitions screen.
UPDATE "Role" SET "permissions" = array_append("permissions", 'scm.requisition.read')
WHERE 'scm.procurement.read' = ANY("permissions")
  AND NOT ('scm.requisition.read' = ANY("permissions"));

-- The finance reports screen: POC, VAT return, contract profitability.
UPDATE "Role" SET "permissions" = array_append("permissions", 'finance.report.read')
WHERE 'finance.ledger.read' = ANY("permissions")
  AND NOT ('finance.report.read' = ANY("permissions"));

-- The financial statements screen: income statement, balance sheet and the
-- fiscal-year list (closing periods stays on finance.period.manage).
UPDATE "Role" SET "permissions" = array_append("permissions", 'finance.statement.read')
WHERE 'finance.ledger.read' = ANY("permissions")
  AND NOT ('finance.statement.read' = ANY("permissions"));
