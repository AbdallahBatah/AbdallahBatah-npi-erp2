-- D-17 (T-29b): every fact derived from NPI data carries the permission of its
-- source, and retrieval filters by the caller's permissions. NULL = visible to
-- everyone the scope already allows (chat facts, position facts).
ALTER TABLE "memory_facts" ADD COLUMN "sourcePermission" TEXT;

-- Backfill the rows T-29 already wrote. The map is KINDS_OF_SOURCE x
-- PERMISSION_OF_SOURCE of src/memory/npi-facts.ts; keep them in step.
UPDATE "memory_facts"
SET "sourcePermission" = CASE "valueJson"->>'kind'
  WHEN 'customer_credit_terms' THEN 'crm.customer.read'
  WHEN 'contract_payment_terms' THEN 'commercial.contract.read'
  WHEN 'vendor_lead_time' THEN 'scm.procurement.read'
  WHEN 'recurring_item' THEN 'scm.procurement.read'
  WHEN 'active_project' THEN 'projects.project.read'
END
WHERE "sourceType" = 'npi' AND "valueJson" ? 'kind';
