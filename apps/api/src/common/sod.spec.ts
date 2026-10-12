/**
 * ADR-02 task 7 (P1-9) — the separation-of-duties table of @npi/shared, which
 * the role editor warns with and the admin service asks to be acknowledged.
 * `packages/shared` has no jest setup of its own, so this spec lives with the
 * API (the arrangement of screens.spec.ts).
 */
import { ALL_PERMISSIONS, PERMISSIONS, SOD_CONFLICTS, sodConflicts } from '@npi/shared';

const pairOf = (c: { a: string; b: string }) => `${c.a} + ${c.b}`;

describe('SOD_CONFLICTS', () => {
  it('holds the six pairs of ADR-02 §3-1, in this order', () => {
    expect(SOD_CONFLICTS.map(pairOf)).toEqual([
      'scm.requisition.write + scm.procurement.approve',
      'scm.procurement.write + scm.procurement.approve',
      'scm.procurement.write + finance.payment.write',
      'commercial.proposal.write + commercial.proposal.approve',
      'projects.project.write + projects.project.approve',
      'finance.invoice.write + finance.period.manage',
    ]);
  });

  it('names only keys that exist, two different keys per pair, each pair once, each in both languages', () => {
    for (const c of SOD_CONFLICTS) {
      expect(ALL_PERMISSIONS).toContain(c.a);
      expect(ALL_PERMISSIONS).toContain(c.b);
      expect(c.a).not.toBe(c.b);
      expect(c.labelAr.trim()).not.toBe('');
      expect(c.labelEn.trim()).not.toBe('');
    }
    const unordered = SOD_CONFLICTS.map((c) => [c.a, c.b].sort().join(' + '));
    expect(new Set(unordered).size).toBe(SOD_CONFLICTS.length);
  });
});

describe('sodConflicts', () => {
  it('answers the pairs a set holds both keys of, in table order', () => {
    const found = sodConflicts([
      PERMISSIONS.PAYMENT_WRITE,
      PERMISSIONS.PROCUREMENT_APPROVE,
      PERMISSIONS.PROCUREMENT_WRITE,
      PERMISSIONS.CUSTOMER_READ,
    ]);
    expect(found.map(pairOf)).toEqual([
      'scm.procurement.write + scm.procurement.approve',
      'scm.procurement.write + finance.payment.write',
    ]);
    expect(found[1].labelAr).toBe('ينشئ المورد ويسدد له');
  });

  it('answers nothing for one key of a pair, an empty set, or unknown keys', () => {
    expect(sodConflicts([PERMISSIONS.PROCUREMENT_APPROVE])).toEqual([]);
    expect(sodConflicts([])).toEqual([]);
    expect(sodConflicts(['admin.everything', 'crm.lead.read'])).toEqual([]);
  });

  it('finds every pair in the full catalogue (what the seeded admin role holds)', () => {
    expect(sodConflicts(ALL_PERMISSIONS)).toEqual([...SOD_CONFLICTS]);
  });
});
