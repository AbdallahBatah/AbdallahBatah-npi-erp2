/**
 * CRM Phase 1 · Step 4 (contract §3) — the money arithmetic of a proposal revision.
 *
 * Decimal only (the copy Prisma bundles; `decimal.js` is not a package of its own
 * in this repository). Every amount is rounded half-up to two decimals at the line,
 * so a revision's total is exactly the sum of the line totals a reader can check
 * with a calculator — which 3 x 0.335 is not, in floating point.
 *
 * Meaning of the figures (unchanged from before Step 4 — base + margin = total):
 *   subtotal     = Σ qty × unitCost    the cost base
 *   totalAmount  = Σ qty × unitPrice   the selling price
 *   marginAmount = totalAmount − subtotal   (negative when sold below cost)
 */
import { Prisma } from '@npi/db';

export type Money = Prisma.Decimal | string | number;

const D = (v: Money): Prisma.Decimal => new Prisma.Decimal(v);
const round2 = (v: Prisma.Decimal): Prisma.Decimal => v.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

export interface PricingLineInput {
  qty: Money;
  unitCost: Money;
  unitPrice: Money;
}

export interface PricedRevision {
  subtotal: Prisma.Decimal;
  marginAmount: Prisma.Decimal;
  totalAmount: Prisma.Decimal;
  /** In the order given: what the line costs and what it sells for. */
  lines: Array<{ lineCost: Prisma.Decimal; lineTotal: Prisma.Decimal }>;
}

export function priceRevision(lines: PricingLineInput[]): PricedRevision {
  const priced = lines.map((l) => ({
    lineCost: round2(D(l.qty).mul(D(l.unitCost))),
    lineTotal: round2(D(l.qty).mul(D(l.unitPrice))),
  }));
  const subtotal = priced.reduce((s, l) => s.add(l.lineCost), D(0));
  const totalAmount = priced.reduce((s, l) => s.add(l.lineTotal), D(0));
  return { subtotal, marginAmount: totalAmount.sub(subtotal), totalAmount, lines: priced };
}

/** Cost plus a margin percentage (12.5 = 12.5 %), rounded half-up to 2 decimals. */
export function sellingPrice(unitCost: Money, marginPct: Money): Prisma.Decimal {
  return round2(D(unitCost).mul(D(1).add(D(marginPct).div(100))));
}

/**
 * Package 3 · P3-4 (ADR-03 §4-4) — the estimated budget's head figures.
 *
 *   contingencyAmount = subtotal × contingencyPct ÷ 100        (risk reserve on cost)
 *   totalAmount       = PER_LINE: Σ line selling totals
 *                       LUMP_SUM: the selling total (0 until one is set)
 *   marginAmount      = totalAmount − subtotal − contingencyAmount
 *
 * With no contingency a PER_LINE revision keeps exactly the old meaning
 * (margin = total − cost base).
 */
export function budgetTotals(input: {
  pricingMode: 'PER_LINE' | 'LUMP_SUM';
  subtotal: Money;
  lineTotal: Money;
  sellingTotal?: Money | null;
  contingencyPct?: Money | null;
}): {
  pricingMode: 'PER_LINE' | 'LUMP_SUM';
  sellingTotal: Prisma.Decimal | null;
  contingencyPct: Prisma.Decimal;
  contingencyAmount: Prisma.Decimal;
  totalAmount: Prisma.Decimal;
  marginAmount: Prisma.Decimal;
} {
  const subtotal = D(input.subtotal);
  const contingencyPct = D(input.contingencyPct ?? 0);
  const contingencyAmount = round2(subtotal.mul(contingencyPct).div(100));
  const sellingTotal =
    input.pricingMode === 'LUMP_SUM' && input.sellingTotal !== undefined && input.sellingTotal !== null
      ? round2(D(input.sellingTotal))
      : null;
  const totalAmount = input.pricingMode === 'LUMP_SUM' ? (sellingTotal ?? D(0)) : D(input.lineTotal);
  return {
    pricingMode: input.pricingMode,
    sellingTotal,
    contingencyPct,
    contingencyAmount,
    totalAmount,
    marginAmount: totalAmount.sub(subtotal).sub(contingencyAmount),
  };
}
