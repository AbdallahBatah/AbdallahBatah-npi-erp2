-- Retention reversed by credit notes.
--
-- A partial credit note splits between AR and retention receivable in the
-- invoice's own proportion and books the retention half to the ledger, but the
-- RetentionEntry row was never reduced. The entry therefore kept claiming money
-- the ledger had already returned: the balance sheet overstated retention held,
-- and releasing it re-billed the customer for an amount already credited back.

ALTER TABLE "RetentionEntry"
  ADD COLUMN "creditedAmount" DECIMAL(18,2) NOT NULL DEFAULT 0;

-- Backfill. Existing rows carry the same error in their data, so adding the
-- column without repairing history would leave every already-credited invoice
-- wrong. The formula is the one the application uses when it posts the credit:
-- creditRetention = noteTotal * retentionAmount / sourceTotal, summed over
-- every credit note raised against the invoice.
UPDATE "RetentionEntry" re
SET "creditedAmount" = sub.credited
FROM (
  SELECT re2.id AS id,
         ROUND(
           COALESCE(SUM(cn.total), 0) * i."retentionAmount" / NULLIF(i.total, 0),
           2
         ) AS credited
  FROM "RetentionEntry" re2
  JOIN "Invoice" i ON i.id = re2."invoiceId"
  LEFT JOIN "Invoice" cn ON cn."creditedInvoiceId" = i.id
  GROUP BY re2.id, i."retentionAmount", i.total
) sub
WHERE re.id = sub.id
  AND sub.credited IS NOT NULL
  AND sub.credited > 0;
