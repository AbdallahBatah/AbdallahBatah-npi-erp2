-- Make the ZATCA PIH chain a structure instead of a convention.
--
-- Until now the only thing stopping two documents from claiming the same
-- predecessor was that exactly one code path ever appended to the chain, and
-- that path happened to run under Serializable isolation. That is a property of
-- today's application, not of the data: an import, a data migration or a manual
-- repair forks the chain silently, and a forked chain is rejected by ZATCA and
-- cannot be repaired retroactively.
--
-- The tenant has to live on this table for the rule to be expressible at all —
-- a UNIQUE constraint cannot span the join to Invoice.
--
-- Deployment safety (deploy/MIGRATIONS_AR.md): the previous release inserts
-- EInvoiceDocument rows without organizationId, and it keeps serving while this
-- migration is already applied. A NOT NULL column would break it, which is why
-- step 3 installs a trigger that derives the value the same way step 2 does.
-- That keeps this a single deployment rather than an expand/contract pair, and
-- it is not merely a compatibility shim: the previous release is itself an
-- example of the "write path that forgets" this migration exists to defend
-- against, and so is every importer written after it.
--
-- Index note for the review checklist: both indexes below are built with a
-- plain CREATE INDEX. The table holds one row per issued document — small
-- enough at this size that the brief lock is not worth splitting the migration
-- for. On an installation with a large history, run them manually with
-- CONCURRENTLY first, then apply this migration (the CREATE statements become
-- no-ops against the existing indexes only if named identically, so prefer
-- taking the lock during a maintenance window instead of guessing).

-- 1. Expand: nullable, so the backfill has somewhere to land.
ALTER TABLE "EInvoiceDocument" ADD COLUMN "organizationId" TEXT;

-- 2. Backfill every existing row from the invoice it already belongs to. This
--    fixes the rows that are on disk, not just the ones written from now on.
UPDATE "EInvoiceDocument" d
SET "organizationId" = i."organizationId"
FROM "Invoice" i
WHERE i."id" = d."invoiceId";

-- 3. Derive the tenant for any insert that omits it — the previous release,
--    an importer, a hand-written repair.
CREATE OR REPLACE FUNCTION "einvoice_document_fill_organization"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."organizationId" IS NULL THEN
    SELECT i."organizationId" INTO NEW."organizationId"
    FROM "Invoice" i WHERE i."id" = NEW."invoiceId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "einvoice_document_fill_organization_trg"
BEFORE INSERT ON "EInvoiceDocument"
FOR EACH ROW EXECUTE FUNCTION "einvoice_document_fill_organization"();

-- 4. Now the constraint is safe to enforce: a BEFORE INSERT trigger runs before
--    NOT NULL is checked, so an insert that omits the column still satisfies it.
ALTER TABLE "EInvoiceDocument" ALTER COLUMN "organizationId" SET NOT NULL;

-- 5. Restrict, matching Invoice and JournalEntry: a statutory record is not
--    deleted as a side effect of removing an organization row.
ALTER TABLE "EInvoiceDocument"
  ADD CONSTRAINT "EInvoiceDocument_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- 6. Fail loudly and legibly if the chain is already forked. Without this the
--    next statement reports an opaque duplicate-key error naming one row, when
--    what the operator needs is the list of documents to reconcile.
DO $$
DECLARE forked TEXT;
BEGIN
  SELECT string_agg(format('org=%s pih=%s count=%s', "organizationId", "previousInvoiceHash", n), '; ')
  INTO forked
  FROM (
    SELECT "organizationId", "previousInvoiceHash", count(*) AS n
    FROM "EInvoiceDocument"
    GROUP BY 1, 2 HAVING count(*) > 1
  ) dup;

  IF forked IS NOT NULL THEN
    RAISE EXCEPTION 'PIH chain is already forked — resolve before applying: %', forked;
  END IF;
END $$;

-- 7. The tail lookup runs inside the Serializable window of every issue, so its
--    cost is isolation-window time, which is what drives the retry rate.
--    Measured at 20k documents per organization: 59.3ms -> 0.075ms.
CREATE INDEX "EInvoiceDocument_organizationId_submittedAt_idx"
  ON "EInvoiceDocument"("organizationId", "submittedAt");

-- 8. "The chain does not fork", stated where no code path can forget it.
--    Scoped to the organization: every chain legitimately begins at the same
--    GENESIS_PIH, so a global unique on previousInvoiceHash alone would collide
--    between tenants on their first invoice.
CREATE UNIQUE INDEX "EInvoiceDocument_organizationId_previousInvoiceHash_key"
  ON "EInvoiceDocument"("organizationId", "previousInvoiceHash");
