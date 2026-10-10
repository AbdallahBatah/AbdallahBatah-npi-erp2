/**
 * CRM Phase 1 · Step 4 (contract §3, §8) — the pure pieces of proposal pricing
 * and of the validity / cost-age rules. No database, no clock but the one passed in.
 *
 * Money is Decimal (the copy Prisma bundles): the cases below are exactly the
 * ones a float gets wrong — 3 × 0.335 and ten lines of 0.10.
 */
import { Prisma } from '@npi/db';
import {
  costAge,
  isStale,
  isValidityExpired,
  isValidityFuture,
  normalizeValidUntil,
  riyadhDayStart,
} from '@npi/shared';
import { priceRevision, sellingPrice } from './proposal-pricing';

const D = (v: string | number) => new Prisma.Decimal(v);

describe('priceRevision — Decimal pricing of a proposal revision', () => {
  it('sums line totals (selling), the cost base, and derives the margin', () => {
    const out = priceRevision([
      { qty: D('2'), unitCost: D('100.00'), unitPrice: D('125.00') },
      { qty: D('1.5'), unitCost: D('40.00'), unitPrice: D('60.00') },
    ]);
    expect(out.lines.map((l) => l.lineTotal.toFixed(2))).toEqual(['250.00', '90.00']);
    expect(out.subtotal.toFixed(2)).toBe('260.00'); // 200 + 60 at cost
    expect(out.totalAmount.toFixed(2)).toBe('340.00'); // 250 + 90 at selling price
    expect(out.marginAmount.toFixed(2)).toBe('80.00'); // total − subtotal
  });

  it('rounds half-up to 2 decimals per line: 3 x 0.335 is exactly 1.005, so 1.01', () => {
    const out = priceRevision([{ qty: D('3'), unitCost: D('0.335'), unitPrice: D('0.335') }]);
    expect(out.lines[0].lineTotal.toFixed(2)).toBe('1.01');
    expect(out.totalAmount.toFixed(2)).toBe('1.01');
    expect(out.subtotal.toFixed(2)).toBe('1.01');
  });

  it('does not drift: ten lines of 0.10 add up to exactly 1.00', () => {
    const lines = Array.from({ length: 10 }, () => ({ qty: D(1), unitCost: D('0.10'), unitPrice: D('0.10') }));
    const out = priceRevision(lines);
    expect(out.totalAmount.toFixed(2)).toBe('1.00');
    expect(out.marginAmount.toFixed(2)).toBe('0.00');
  });

  it('allows selling below cost (a negative margin is a fact the approver must see)', () => {
    const out = priceRevision([{ qty: D(10), unitCost: D('50'), unitPrice: D('45') }]);
    expect(out.marginAmount.toFixed(2)).toBe('-50.00');
  });

  it('prices an empty revision at zero', () => {
    const out = priceRevision([]);
    expect([out.subtotal, out.marginAmount, out.totalAmount].map((x) => x.toFixed(2))).toEqual([
      '0.00',
      '0.00',
      '0.00',
    ]);
  });

  it('accepts plain numbers and strings without changing the result', () => {
    const out = priceRevision([{ qty: 2, unitCost: '10.10', unitPrice: 12.35 }]);
    expect(out.totalAmount.toFixed(2)).toBe('24.70');
    expect(out.subtotal.toFixed(2)).toBe('20.20');
  });
});

describe('sellingPrice — cost plus a margin percentage', () => {
  it('applies the margin and rounds half-up', () => {
    expect(sellingPrice(D('100'), D('12.5')).toFixed(2)).toBe('112.50');
    expect(sellingPrice(D('10.01'), D('12.5')).toFixed(2)).toBe('11.26'); // 11.26125
    expect(sellingPrice(D('0.01'), D('50')).toFixed(2)).toBe('0.02'); // 0.015 -> 0.02
  });
  it('is the cost itself at a zero margin', () => {
    expect(sellingPrice(D('77.77'), D(0)).toFixed(2)).toBe('77.77');
  });
});

describe('costAge / isStale — how old is the cost, and is that too old?', () => {
  const now = new Date('2026-10-08T10:00:00Z');
  it('is whole days since the cost date, and null when there is no date', () => {
    expect(costAge(new Date('2026-09-01T00:00:00Z'), now)).toBe(37);
    expect(costAge(new Date('2026-10-08T09:00:00Z'), now)).toBe(0);
    expect(costAge(null, now)).toBeNull();
  });
  it('never goes negative for a date in the future', () => {
    expect(costAge(new Date('2026-10-20T00:00:00Z'), now)).toBe(0);
  });
  it('warns only beyond the limit, and always when the age is unknown', () => {
    expect(isStale(30, 30)).toBe(false);
    expect(isStale(31, 30)).toBe(true);
    expect(isStale(0, 30)).toBe(false);
    expect(isStale(null, 30)).toBe(true); // catalogue cost: age unknown = warned
  });
});

describe('validity dates — the whole of the valid-until day is valid (Asia/Riyadh)', () => {
  it('normalises a date or a timestamp to UTC midnight of its Riyadh calendar day', () => {
    expect(normalizeValidUntil('2026-11-07')!.toISOString()).toBe('2026-11-07T00:00:00.000Z');
    // 22:00Z on the 7th is 01:00 on the 8th in Riyadh.
    expect(normalizeValidUntil('2026-11-07T22:00:00Z')!.toISOString()).toBe('2026-11-08T00:00:00.000Z');
  });
  it('returns null for text that is not a date', () => {
    expect(normalizeValidUntil('not a date')).toBeNull();
    expect(normalizeValidUntil('')).toBeNull();
  });
  it('starts the Riyadh day at 21:00Z the day before', () => {
    expect(riyadhDayStart(new Date('2026-10-08T10:00:00Z')).toISOString()).toBe('2026-10-07T21:00:00.000Z');
    expect(riyadhDayStart(new Date('2026-10-08T22:30:00Z')).toISOString()).toBe('2026-10-08T21:00:00.000Z');
  });
  it('is expired only once the whole valid-until day has passed', () => {
    const now = new Date('2026-10-08T10:00:00Z'); // 13:00 on the 8th in Riyadh
    expect(isValidityExpired(new Date('2026-10-07T00:00:00Z'), now)).toBe(true); // yesterday
    expect(isValidityExpired(new Date('2026-10-08T00:00:00Z'), now)).toBe(false); // today: still valid
    expect(isValidityExpired(new Date('2026-10-09T00:00:00Z'), now)).toBe(false);
    // 01:00 on the 9th in Riyadh: the 8th is now over.
    expect(isValidityExpired(new Date('2026-10-08T00:00:00Z'), new Date('2026-10-08T22:00:00Z'))).toBe(true);
  });
  it('requires a future day to be strictly after today', () => {
    const now = new Date('2026-10-08T10:00:00Z');
    expect(isValidityFuture(new Date('2026-10-09T00:00:00Z'), now)).toBe(true);
    expect(isValidityFuture(new Date('2026-10-08T00:00:00Z'), now)).toBe(false); // today is not "after today"
    expect(isValidityFuture(new Date('2026-10-01T00:00:00Z'), now)).toBe(false);
  });
});
