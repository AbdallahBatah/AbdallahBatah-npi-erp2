// The data behind `npm run eval:memory` (T-29): the snapshot, the 50 expected
// facts and the 50 questions. No database; nothing here is a model call.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { deriveNpiFacts } from '../src/memory/extract-npi';
import { NPI_FACT_KINDS, type NpiFactKind, type NpiMemorySnapshot } from '../src/memory/npi-facts';
import { normalizeArabic } from '../src/text/normalize';

interface ExpectedFact {
  key: string;
  kind: NpiFactKind;
  entityType: string;
  npiEntityId: string;
  titleAr: string;
  mustContain: string[];
}

interface Question {
  id: string;
  questionAr: string;
  expectKey: string;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(path.join(__dirname, '..', 'eval', file), 'utf8')) as T;
}

const snapshot = readJson<NpiMemorySnapshot>('memory-npi-snapshot.json');
const facts = readJson<ExpectedFact[]>('memory-facts.json');
const questions = readJson<Question[]>('memory-questions.json');

const live = snapshot.purchaseOrders.filter((po) => po.status !== 'CANCELLED');

describe('eval/memory-facts.json', () => {
  it('holds 50 facts with unique keys, split 9 + 14 + 6 + 9 + 12 over the five kinds', () => {
    expect(facts).toHaveLength(50);
    expect(new Set(facts.map((f) => f.key)).size).toBe(50);
    const perKind = Object.fromEntries(NPI_FACT_KINDS.map((k) => [k, facts.filter((f) => f.kind === k).length]));
    expect(perKind).toEqual({
      customer_credit_terms: 9,
      contract_payment_terms: 14,
      vendor_lead_time: 6,
      recurring_item: 9,
      active_project: 12,
    });
  });

  it('keys every fact as <kind>:<id> and gives each 2-4 non-empty mustContain values', () => {
    for (const f of facts) {
      expect(f.key.startsWith(`${f.kind}:`)).toBe(true);
      expect(f.mustContain.length).toBeGreaterThanOrEqual(2);
      expect(f.mustContain.length).toBeLessThanOrEqual(4);
      for (const value of f.mustContain) expect(value.trim().length).toBeGreaterThan(0);
    }
  });

  it('carries the six hand-computed lead times (vendor, days, purchase orders)', () => {
    const hand: Record<string, [string, string]> = {
      'vendor_lead_time:ven_00001': ['نحو 15 يوماً', 'بحسب 4 أوامر شراء'],
      'vendor_lead_time:ven_00002': ['نحو 11 يوماً', 'بحسب أمري شراء'],
      'vendor_lead_time:ven_00003': ['نحو 32 يوماً', 'بحسب 3 أوامر شراء'],
      'vendor_lead_time:ven_00004': ['نحو 5 أيام', 'بحسب أمر شراء واحد'],
      'vendor_lead_time:ven_00005': ['نحو 17 يوماً', 'بحسب أمري شراء'],
      'vendor_lead_time:ven_00006': ['نحو 5 أيام', 'بحسب أمري شراء'],
    };
    for (const [key, [days, orders]] of Object.entries(hand)) {
      const fact = facts.find((f) => f.key === key);
      expect(fact?.mustContain).toEqual(expect.arrayContaining([days, orders]));
    }
  });
});

describe('eval/memory-questions.json', () => {
  it('holds 50 questions q01-q50, one per fact key', () => {
    expect(questions).toHaveLength(50);
    expect(questions.map((q) => q.id)).toEqual(Array.from({ length: 50 }, (_, i) => `q${String(i + 1).padStart(2, '0')}`));
    const keys = new Set(facts.map((f) => f.key));
    for (const q of questions) expect(keys.has(q.expectKey)).toBe(true);
    expect(new Set(questions.map((q) => q.expectKey)).size).toBe(50);
  });

  it('keeps every question short and spread over the kinds as planned', () => {
    for (const q of questions) {
      expect(q.questionAr.length).toBeGreaterThan(0);
      expect(q.questionAr.length).toBeLessThanOrEqual(200);
    }
    const kindOf = new Map(facts.map((f) => [f.key, f.kind]));
    const perKind: Record<string, number> = {};
    for (const q of questions) {
      const kind = kindOf.get(q.expectKey) as string;
      perKind[kind] = (perKind[kind] ?? 0) + 1;
    }
    expect(perKind).toEqual({ customer_credit_terms: 9, contract_payment_terms: 14, vendor_lead_time: 6, recurring_item: 9, active_project: 12 });
  });
});

describe('eval/memory-npi-snapshot.json', () => {
  it('holds 11 customers, 9 with credit terms and 2 without', () => {
    expect(snapshot.customers).toHaveLength(11);
    expect(snapshot.customers.filter((c) => c.creditTermsDays > 0)).toHaveLength(9);
    expect(snapshot.customers.filter((c) => c.creditTermsDays === 0)).toHaveLength(2);
    const first = snapshot.customers[0];
    expect(first).toMatchObject({ code: 'CUS-00001', nameAr: 'مصنع الرياض للصناعات', creditTermsDays: 30 });
    expect(new Set(snapshot.customers.filter((c) => c.creditTermsDays > 0).map((c) => c.creditTermsDays))).toEqual(new Set([15, 30, 45, 60, 90]));
  });

  it('holds 15 contracts, one CANCELLED, spread over types and statuses', () => {
    expect(snapshot.contracts).toHaveLength(15);
    expect(snapshot.contracts.filter((c) => c.status === 'CANCELLED')).toHaveLength(1);
    expect(new Set(snapshot.contracts.map((c) => c.contractType))).toEqual(new Set(['EPC', 'PPA', 'OM', 'LEASE']));
    expect(new Set(snapshot.contracts.map((c) => c.status))).toEqual(new Set(['ACTIVE', 'DRAFT', 'SUSPENDED', 'CLOSED', 'CANCELLED']));
    expect(snapshot.contracts.some((c) => c.retentionPct === 12.5)).toBe(true);
    expect(snapshot.contracts.some((c) => c.milestoneCount === 0)).toBe(true);
    const customerIds = new Set(snapshot.customers.map((c) => c.id));
    for (const c of snapshot.contracts) expect(customerIds.has(c.customer.id)).toBe(true);
  });

  it('holds 13 projects, one CLOSED, each under a contract of the snapshot', () => {
    expect(snapshot.projects).toHaveLength(13);
    expect(snapshot.projects.filter((p) => p.stage === 'CLOSED')).toHaveLength(1);
    expect(new Set(snapshot.projects.filter((p) => p.stage !== 'CLOSED').map((p) => p.stage))).toEqual(new Set(['PLANNING', 'PROCUREMENT', 'EXECUTION', 'COMMISSIONING']));
    expect(snapshot.projects.filter((p) => p.capacityKwp === null)).toHaveLength(1);
    expect(snapshot.projects.filter((p) => p.plannedEnd === null)).toHaveLength(1);
    const contractCodes = new Map(snapshot.contracts.map((c) => [c.code, c.customer.nameAr]));
    for (const p of snapshot.projects) expect(contractCodes.get(p.contract.code)).toBe(p.contract.customer.nameAr);
  });

  it('holds 18 purchase orders: 2 CANCELLED, 1 without lines, 6 vendors with receipts, 1 vendor with none', () => {
    expect(snapshot.purchaseOrders).toHaveLength(18);
    expect(snapshot.purchaseOrders.filter((po) => po.status === 'CANCELLED')).toHaveLength(2);
    expect(snapshot.purchaseOrders.filter((po) => po.lines.length === 0)).toHaveLength(1);
    expect(snapshot.purchaseOrders.filter((po) => po.approvedAt === null && po.status !== 'CANCELLED')).toHaveLength(1);

    const withReceipt = new Map<string, number>();
    for (const po of live) if (po.goodsReceipts.length > 0) withReceipt.set(po.vendor.id, (withReceipt.get(po.vendor.id) ?? 0) + 1);
    expect(withReceipt.size).toBe(6);
    expect([...withReceipt.values()].filter((n) => n === 1)).toHaveLength(1);
    expect([...withReceipt.values()].filter((n) => n >= 3).length).toBeGreaterThanOrEqual(1);
    expect([...withReceipt.values()].every((n) => n >= 1)).toBe(true);
    const vendorIds = new Set(snapshot.purchaseOrders.map((po) => po.vendor.id));
    expect(vendorIds.size).toBe(7);
    expect([...vendorIds].filter((id) => !withReceipt.has(id))).toHaveLength(1);
    // a cancelled order with a receipt is in the data and must not count
    expect(snapshot.purchaseOrders.some((po) => po.status === 'CANCELLED' && po.goodsReceipts.length > 0)).toBe(true);
  });

  it('holds receipts 5-40 days after approval, one before it, plus the order lists newest first', () => {
    let before = 0;
    for (const po of live) {
      if (po.goodsReceipts.length === 0) continue;
      const base = Date.parse(po.approvedAt ?? po.createdAt);
      const first = Math.min(...po.goodsReceipts.map((g) => Date.parse(g.receivedAt)));
      const days = (first - base) / 86_400_000;
      if (days < 0) before += 1;
      else {
        expect(days).toBeGreaterThanOrEqual(5);
        expect(days).toBeLessThanOrEqual(41);
      }
    }
    expect(before).toBe(1);
    const created = snapshot.purchaseOrders.map((po) => po.createdAt);
    expect([...created].sort().reverse()).toEqual(created);
  });

  it('holds exactly 9 items on two or more live orders and at least 3 on exactly one', () => {
    const orders = new Map<string, Set<string>>();
    for (const po of live) for (const line of po.lines) orders.set(line.itemId, (orders.get(line.itemId) ?? new Set()).add(po.id));
    expect([...orders.values()].filter((s) => s.size >= 2)).toHaveLength(9);
    expect([...orders.values()].filter((s) => s.size === 1).length).toBeGreaterThanOrEqual(3);
    const sku = new Map<string, { nameAr: string; uom: string }>();
    for (const po of snapshot.purchaseOrders) for (const line of po.lines) sku.set(line.sku, { nameAr: line.nameAr, uom: line.uom });
    expect(sku.get('MOD-550')).toEqual({ nameAr: 'لوح شمسي 550 واط', uom: 'unit' });
    expect(sku.get('INV-50K')).toEqual({ nameAr: 'عاكس 50 كيلوواط', uom: 'unit' });
    expect(sku.get('MNT-RAIL')).toEqual({ nameAr: 'قضيب تثبيت', uom: 'm' });
    expect(sku.get('CAB-DC6')).toEqual({ nameAr: 'كابل DC 6مم', uom: 'm' });
    expect(sku.get('BOS-KIT')).toEqual({ nameAr: 'طقم مكونات مساعدة', uom: 'set' });
  });

  it('uses ISO dates and numbers (the snapshot is what the readers hand to the derivation)', () => {
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    for (const po of snapshot.purchaseOrders) {
      expect(po.createdAt).toMatch(iso);
      if (po.approvedAt !== null) expect(po.approvedAt).toMatch(iso);
      for (const g of po.goodsReceipts) expect(g.receivedAt).toMatch(iso);
      for (const l of po.lines) expect(typeof l.qty).toBe('number');
    }
    for (const c of snapshot.contracts) {
      expect(typeof c.totalValue).toBe('number');
      expect(typeof c.advancePct).toBe('number');
      expect(typeof c.retentionPct).toBe('number');
    }
    for (const p of snapshot.projects) if (p.plannedEnd !== null) expect(p.plannedEnd).toMatch(iso);
  });
});

describe('deriveNpiFacts on the eval snapshot', () => {
  const derived = deriveNpiFacts(snapshot);
  const byKey = new Map(derived.map((d) => [d.key, d]));

  it('derives exactly the 50 expected keys', () => {
    expect(derived).toHaveLength(50);
    expect(new Set(derived.map((d) => d.key))).toEqual(new Set(facts.map((f) => f.key)));
  });

  it('puts every mustContain value inside its sentence (after normalization)', () => {
    for (const f of facts) {
      const text = normalizeArabic(byKey.get(f.key)?.factAr ?? '');
      for (const value of f.mustContain) {
        expect({ key: f.key, value, found: text.includes(normalizeArabic(value)) }).toEqual({ key: f.key, value, found: true });
      }
    }
  });

  it('files every fact under the expected entity', () => {
    for (const f of facts) {
      const got = byKey.get(f.key);
      expect({ key: f.key, entityType: got?.entityType, npiEntityId: got?.npiEntityId }).toEqual({ key: f.key, entityType: f.entityType, npiEntityId: f.npiEntityId });
      expect(got?.kind).toBe(f.kind);
    }
  });

  it('never lets a question carry a whole fact sentence', () => {
    const sentences = derived.map((d) => normalizeArabic(d.factAr));
    for (const q of questions) {
      const asked = normalizeArabic(q.questionAr);
      for (const sentence of sentences) expect(asked.includes(sentence)).toBe(false);
    }
  });
});
