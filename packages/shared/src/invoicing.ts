/**
 * How a credit note counts when invoices are added up.
 *
 * A credit note (ZATCA InvoiceTypeCode 381) is stored as an `Invoice` row like
 * any other, with **positive** amounts — that is what the fiscal document
 * itself carries, and a cleared e-invoice is never rewritten. The consequence
 * is that any aggregation which simply sums invoices counts a correction as an
 * extra sale, inflating the VAT return, receivables, and contract billing.
 *
 * The sign lives here rather than as a `where` filter in each query, because a
 * filter has to be remembered at every call site and silently does the wrong
 * thing when it is forgotten — which is exactly how this was missed. Summing
 * through `signedTotal` cannot forget.
 */

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Widened so callers can pass a Prisma enum without importing it. */
export type InvoiceTypeLike = 'MILESTONE' | 'SETTLEMENT' | 'SERVICE' | 'CREDIT_NOTE' | string;

/** +1 for a sale, −1 for a credit note. */
export function invoiceSign(invoiceType: InvoiceTypeLike): 1 | -1 {
  return invoiceType === 'CREDIT_NOTE' ? -1 : 1;
}

export function isCreditNote(invoiceType: InvoiceTypeLike): boolean {
  return invoiceType === 'CREDIT_NOTE';
}

/**
 * Sums `amount` across rows, subtracting credit notes.
 * Decimal columns arrive as strings from Prisma, hence the `Number(...)`.
 */
export function signedTotal<T extends { invoiceType: InvoiceTypeLike }>(
  rows: readonly T[],
  amount: (row: T) => unknown,
): number {
  return round2(
    rows.reduce((sum, row) => sum + invoiceSign(row.invoiceType) * Number(amount(row) ?? 0), 0),
  );
}

/**
 * Statuses of an invoice that has been reported to the authority.
 *
 * `CANCELLED` belongs here. It is set in exactly one place — when an invoice is
 * credited in full — and that invoice *was* reported in its own period. Dropping
 * it would erase the original from the period it was filed in, while its credit
 * note lands in a later one; the pair has to remain visible so it nets to zero.
 */
export const REPORTED_INVOICE_STATUSES = ['ISSUED', 'CLEARED', 'PAID', 'CANCELLED'] as const;

/**
 * Statuses of an invoice that can still be collected. A cancelled invoice is
 * not collectible, and a paid one is settled.
 */
export const OPEN_INVOICE_STATUSES = ['ISSUED', 'CLEARED'] as const;
