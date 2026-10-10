// T-29 (F-12, spec/madar/02 §8): facts derived from NPI's own data.
//
// No model, no pseudonymizer: every sentence below is a template filled from
// structured fields, so nothing leaves the copilot and the same data always
// gives the same sentence. The sentences are stored in `memory_facts` with
// `sourceType = 'npi'` and `scope = 'company'` and found by the same retrieval
// as the facts employees state in the chat (`retrieve.ts` → `fts.ts`).
//
// Identity: each derived fact carries `valueJson.key = '<kind>:<npi id>'`. A
// refresh replaces by that key — same text: nothing is written; new text: the
// same row is updated (its id, `useCount` and `lastUsedAt` survive); no row:
// created; a row of a refreshed kind whose key no longer derives (a closed
// project, a cancelled contract) is deleted. Chat facts are never touched.
//
// D-17 (T-29b): every derived fact carries `sourcePermission` — the NPI
// permission of its source — and retrieval filters by the caller's permissions.
// A refresh also repairs a row whose column differs from the derived value.
import type { PrismaClient } from '../generated/prisma';
import type { FlowType } from '../agents/router';
import { isHrEvaluationRequest } from '../agents/hr-guard';
import { formatNumber } from '../i18n/format';
import { buildSearchText } from './fts';
import {
  KINDS_OF_SOURCE,
  NPI_MEMORY_SOURCES,
  PERMISSION_OF_KIND,
  type DerivedFact,
  type NpiContractRow,
  type NpiCustomerRow,
  type NpiFactKind,
  type NpiMemorySnapshot,
  type NpiMemorySource,
  type NpiProjectRow,
  type NpiPurchaseOrderRow,
  type RefreshOutcome,
} from './npi-facts';
import { loadNpiMemorySnapshot, type SnapshotNpi } from './npi-snapshot';

// ─── Wording helpers ─────────────────────────────────────────────────────────

interface CountForms {
  one: string;
  two: string;
  few: string;
  many: string;
}

/** Arabic number agreement: 1 → `one`, 2 → `two`, 3–10 → `few`, 11 and above
 *  (and anything else, including 0) → `many`; `{n}` becomes the formatted
 *  number. */
function count(n: number, forms: CountForms): string {
  if (n === 1) return forms.one;
  if (n === 2) return forms.two;
  const form = n >= 3 && n <= 10 ? forms.few : forms.many;
  return form.replace('{n}', formatNumber(n));
}

const DAYS: CountForms = { one: 'يوم واحد', two: 'يومان', few: '{n} أيام', many: '{n} يوماً' };
const ORDERS: CountForms = { one: 'أمر شراء واحد', two: 'أمري شراء', few: '{n} أوامر شراء', many: '{n} أمر شراء' };
const MILESTONES: CountForms = {
  one: 'دفعة مرحلية واحدة',
  two: 'دفعتان مرحليتان',
  few: '{n} دفعات مرحلية',
  many: '{n} دفعة مرحلية',
};

const CONTRACT_TYPE_AR: Record<string, string> = {
  EPC: 'تصميم وتوريد وتركيب',
  PPA: 'بيع طاقة',
  OM: 'تشغيل وصيانة',
  LEASE: 'تأجير',
};
const CONTRACT_STATUS_AR: Record<string, string> = {
  DRAFT: 'مسودة',
  ACTIVE: 'ساري',
  SUSPENDED: 'موقوف',
  CLOSED: 'مقفل',
};
const STAGE_AR: Record<string, string> = {
  PLANNING: 'التخطيط',
  PROCUREMENT: 'التوريد',
  EXECUTION: 'التنفيذ',
  COMMISSIONING: 'التشغيل التجريبي',
};
const UOM_AR: Record<string, string> = {
  unit: 'وحدة',
  m: 'متر',
  set: 'طقم',
  kg: 'كجم',
  pcs: 'قطعة',
  l: 'لتر',
};

function lookup(table: Record<string, string>, raw: string): string {
  return Object.prototype.hasOwnProperty.call(table, raw) ? table[raw] : raw;
}

function uomAr(uom: string): string {
  const key = uom.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(UOM_AR, key) ? UOM_AR[key] : uom;
}

/** A number with its zero fraction dropped (`160`, `12.5`), Latin digits and
 *  thousands separators. Three decimals is NPI's own precision for these. */
function plain(n: number): string {
  return formatNumber(Number(n.toFixed(3)));
}

/** Money: whole riyals as they are, a fraction rounded to two decimals. */
function money(n: number): string {
  return formatNumber(Math.round(n * 100) / 100);
}

function filled(value: string): boolean {
  return value.trim().length > 0;
}

const DAY_MS = 86_400_000;

// ─── Derivation ──────────────────────────────────────────────────────────────

/** A derived fact before `deriveNpiFacts` stamps the permission of its source. */
type UnstampedFact = Omit<DerivedFact, 'sourcePermission'>;

function customerFact(customer: NpiCustomerRow): UnstampedFact | null {
  if (!(customer.creditTermsDays > 0)) return null;
  if (!filled(customer.nameAr) || !filled(customer.code)) return null;
  const key = `customer_credit_terms:${customer.id}`;
  return {
    kind: 'customer_credit_terms',
    key,
    entityType: 'customer',
    npiEntityId: customer.id,
    factAr: `أجل سداد العميل ${customer.nameAr} (${customer.code}) ${count(customer.creditTermsDays, DAYS)} من تاريخ الفاتورة.`,
    valueJson: {
      kind: 'customer_credit_terms',
      key,
      customerId: customer.id,
      code: customer.code,
      creditTermsDays: customer.creditTermsDays,
    },
    confidence: 1,
  };
}

function contractFact(contract: NpiContractRow): UnstampedFact | null {
  if (contract.status === 'CANCELLED') return null;
  if (!filled(contract.code) || !filled(contract.customer.nameAr) || !filled(contract.customer.code)) return null;
  const key = `contract_payment_terms:${contract.id}`;
  const milestones =
    contract.milestoneCount === 0 ? 'بلا دفعات مرحلية' : count(contract.milestoneCount, MILESTONES);
  const typeAr = lookup(CONTRACT_TYPE_AR, contract.contractType);
  const statusAr = lookup(CONTRACT_STATUS_AR, contract.status);
  return {
    kind: 'contract_payment_terms',
    key,
    entityType: 'customer',
    npiEntityId: contract.customer.id,
    factAr: `شروط عقد ${contract.code} مع العميل ${contract.customer.nameAr} (${contract.customer.code}): دفعة مقدمة ${plain(contract.advancePct)}%، محتجزات ${plain(contract.retentionPct)}%، ${milestones}، القيمة ${money(contract.totalValue)} ريال، النوع ${typeAr}، الحالة ${statusAr}.`,
    valueJson: {
      kind: 'contract_payment_terms',
      key,
      contractId: contract.id,
      contractCode: contract.code,
      customerId: contract.customer.id,
      customerCode: contract.customer.code,
      advancePct: contract.advancePct,
      retentionPct: contract.retentionPct,
      milestoneCount: contract.milestoneCount,
      totalValue: contract.totalValue,
      contractType: contract.contractType,
      status: contract.status,
      startDate: contract.startDate,
      endDate: contract.endDate,
    },
    confidence: contract.status === 'ACTIVE' ? 1 : contract.status === 'DRAFT' ? 0.8 : 0.9,
  };
}

/** Days from a PO's approval (its creation when never approved) to its first
 *  goods receipt; null when the PO has no receipt or its dates are unreadable. */
function leadDays(po: NpiPurchaseOrderRow): number | null {
  if (po.goodsReceipts.length === 0) return null;
  const received = po.goodsReceipts.map((r) => Date.parse(r.receivedAt)).filter((ms) => !Number.isNaN(ms));
  const start = Date.parse(po.approvedAt ?? po.createdAt);
  if (received.length === 0 || Number.isNaN(start)) return null;
  return Math.max(0, Math.round((Math.min(...received) - start) / DAY_MS));
}

function vendorLeadTimeFacts(orders: NpiPurchaseOrderRow[]): UnstampedFact[] {
  const byVendor = new Map<string, { vendor: NpiPurchaseOrderRow['vendor']; days: number[]; codes: string[] }>();
  for (const po of orders) {
    const days = leadDays(po);
    if (days === null) continue;
    const entry = byVendor.get(po.vendor.id) ?? { vendor: po.vendor, days: [], codes: [] };
    entry.days.push(days);
    entry.codes.push(po.code);
    byVendor.set(po.vendor.id, entry);
  }

  const facts: UnstampedFact[] = [];
  for (const [vendorId, { vendor, days, codes }] of byVendor) {
    if (!filled(vendor.nameAr) || !filled(vendor.code)) continue;
    const n = days.length;
    const avgDays = Math.round(days.reduce((sum, d) => sum + d, 0) / n);
    const key = `vendor_lead_time:${vendorId}`;
    facts.push({
      kind: 'vendor_lead_time',
      key,
      entityType: 'vendor',
      npiEntityId: vendorId,
      // A same-day average (0) reads «أقل من يوم», not «نحو 0 يوماً» (seen live on the demo data).
      factAr: `مدة توريد المورّد ${vendor.nameAr} (${vendor.code}) ${avgDays === 0 ? 'أقل من يوم' : `نحو ${count(avgDays, DAYS)}`} من اعتماد أمر الشراء إلى أول استلام، بحسب ${count(n, ORDERS)}.`,
      valueJson: {
        kind: 'vendor_lead_time',
        key,
        vendorId,
        vendorCode: vendor.code,
        avgDays,
        sampleSize: n,
        poCodes: [...codes].sort(),
      },
      confidence: n >= 3 ? 0.9 : n === 2 ? 0.8 : 0.6,
    });
  }
  return facts;
}

function recurringItemFacts(orders: NpiPurchaseOrderRow[]): UnstampedFact[] {
  interface Seen {
    nameAr: string;
    sku: string;
    uom: string;
    qty: number;
    poIds: Set<string>;
    vendorIds: Set<string>;
    last: NpiPurchaseOrderRow;
    lastLine: { nameAr: string; sku: string; uom: string };
  }
  const items = new Map<string, Seen>();
  for (const po of orders) {
    for (const line of po.lines) {
      const seen = items.get(line.itemId);
      if (!seen) {
        items.set(line.itemId, {
          nameAr: line.nameAr,
          sku: line.sku,
          uom: line.uom,
          qty: line.qty,
          poIds: new Set([po.id]),
          vendorIds: new Set([po.vendor.id]),
          last: po,
          lastLine: line,
        });
        continue;
      }
      seen.qty += line.qty;
      seen.poIds.add(po.id);
      seen.vendorIds.add(po.vendor.id);
      if (isLater(po, seen.last)) {
        seen.last = po;
        seen.lastLine = line;
      }
    }
  }

  const facts: UnstampedFact[] = [];
  for (const [itemId, seen] of items) {
    if (seen.poIds.size < 2) continue;
    // Name, SKU and unit are read off the line of the most recent order.
    const { nameAr, sku, uom } = seen.lastLine;
    if (!filled(nameAr) || !filled(sku) || !filled(seen.last.vendor.nameAr)) continue;
    const key = `recurring_item:${itemId}`;
    const totalQty = Number(seen.qty.toFixed(3));
    facts.push({
      kind: 'recurring_item',
      key,
      entityType: 'item',
      npiEntityId: itemId,
      factAr: `الصنف ${nameAr} (${sku}) يُطلب بانتظام: ورد في ${count(seen.poIds.size, ORDERS)} بإجمالي ${plain(totalQty)} ${uomAr(uom)}، آخرها من المورّد ${seen.last.vendor.nameAr}.`,
      valueJson: {
        kind: 'recurring_item',
        key,
        itemId,
        sku,
        poCount: seen.poIds.size,
        totalQty,
        uom,
        vendorIds: [...seen.vendorIds].sort(),
        lastVendorId: seen.last.vendor.id,
      },
      confidence: 0.9,
    });
  }
  return facts;
}

/** True when `a` was created after `b` (equal times: the greater code wins, so
 *  the choice never depends on list order). */
function isLater(a: NpiPurchaseOrderRow, b: NpiPurchaseOrderRow): boolean {
  const am = Date.parse(a.createdAt);
  const bm = Date.parse(b.createdAt);
  if (!Number.isNaN(am) && !Number.isNaN(bm) && am !== bm) return am > bm;
  return a.code > b.code;
}

function projectFact(project: NpiProjectRow): UnstampedFact | null {
  if (project.stage === 'CLOSED') return null;
  if (!filled(project.nameAr) || !filled(project.code) || !filled(project.contract.customer.nameAr)) return null;
  const key = `active_project:${project.id}`;
  const capacity =
    project.capacityKwp !== null && project.capacityKwp > 0 ? `، بقدرة ${plain(project.capacityKwp)} كيلوواط ذروة` : '';
  const end = project.plannedEnd ? `، ونهايته المخططة ${project.plannedEnd.slice(0, 10)}` : '';
  return {
    kind: 'active_project',
    key,
    entityType: 'project',
    npiEntityId: project.id,
    factAr: `المشروع ${project.nameAr} (${project.code}) للعميل ${project.contract.customer.nameAr} ضمن العقد ${project.contract.code} في مرحلة ${lookup(STAGE_AR, project.stage)}${capacity}${end}.`,
    valueJson: {
      kind: 'active_project',
      key,
      projectId: project.id,
      code: project.code,
      stage: project.stage,
      customerNameAr: project.contract.customer.nameAr,
      contractCode: project.contract.code,
      capacityKwp: project.capacityKwp,
      plannedEnd: project.plannedEnd,
    },
    confidence: 1,
  };
}

/**
 * Derives every fact the snapshot supports. Pure; sorted by `key`; never
 * throws on odd data (a PO without lines, a receipt dated before the approval,
 * a row with no name are all handled — the last is skipped). A key that
 * appears twice in the input is derived once (the first row wins).
 */
export function deriveNpiFacts(snapshot: NpiMemorySnapshot): DerivedFact[] {
  const live = snapshot.purchaseOrders.filter((po) => po.status !== 'CANCELLED');
  const all: Array<UnstampedFact | null> = [
    ...snapshot.customers.map(customerFact),
    ...snapshot.contracts.map(contractFact),
    ...vendorLeadTimeFacts(live),
    ...recurringItemFacts(live),
    ...snapshot.projects.map(projectFact),
  ];
  const byKey = new Map<string, DerivedFact>();
  for (const fact of all) {
    if (fact !== null && !byKey.has(fact.key)) {
      byKey.set(fact.key, { ...fact, sourcePermission: PERMISSION_OF_KIND[fact.kind] });
    }
  }
  return [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// ─── Policy ──────────────────────────────────────────────────────────────────

const HOUR_MS = 3_600_000;

/**
 * True when a refresh is worth attempting now: no attempt was made in this
 * process in the last hour (`lastAttemptAt`) AND no `npi` fact of the
 * organization was updated in the last 24 hours (`lastNpiFactAt`).
 */
export function shouldRefreshNpiMemory(input: {
  lastNpiFactAt: Date | null;
  lastAttemptAt: Date | null;
  now: Date;
}): boolean {
  const { lastNpiFactAt, lastAttemptAt, now } = input;
  const attemptedRecently = lastAttemptAt !== null && now.getTime() - lastAttemptAt.getTime() < HOUR_MS;
  const freshFacts = lastNpiFactAt !== null && now.getTime() - lastNpiFactAt.getTime() < 24 * HOUR_MS;
  return !attemptedRecently && !freshFacts;
}

/** When the organization's newest `npi` fact was last written. */
export async function latestNpiFactAt(db: Pick<PrismaClient, 'memoryFact'>, npiOrgId: string): Promise<Date | null> {
  const agg = await db.memoryFact.aggregate({
    where: { npiOrgId, sourceType: 'npi' },
    _max: { updatedAt: true },
  });
  return agg._max.updatedAt ?? null;
}

/** Which sources an executed flow can have changed (D-T29-3 b). */
export const SOURCES_OF_FLOW: Record<FlowType, readonly NpiMemorySource[]> = {
  customer_contract: ['customers', 'contracts'],
  pr: [],
  po: ['purchaseOrders'],
  grn: ['purchaseOrders'],
  vendor_bill: ['purchaseOrders'],
};

// ─── Refresh ─────────────────────────────────────────────────────────────────

const MAX_FACT_LENGTH = 500;

/** The same checks `saveFact` applies (store.ts), so a derived fact is held to
 *  the rules of every other fact: non-empty, at most 500 characters,
 *  confidence in [0, 1], and the BR-06 guard. */
export function isStorableFact(fact: Pick<DerivedFact, 'factAr' | 'confidence'>): boolean {
  const text = fact.factAr.trim();
  if (text.length === 0 || text.length > MAX_FACT_LENGTH) return false;
  if (!Number.isFinite(fact.confidence) || fact.confidence < 0 || fact.confidence > 1) return false;
  if (isHrEvaluationRequest(text)) return false;
  return buildSearchText(text).length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function keyOf(valueJson: unknown): string | null {
  return isRecord(valueJson) && typeof valueJson.key === 'string' ? valueJson.key : null;
}

function kindOfKey(key: string): NpiFactKind | null {
  const kind = key.split(':', 1)[0];
  for (const known of Object.values(KINDS_OF_SOURCE).flat()) {
    if (known === kind) return known;
  }
  return null;
}

/**
 * Loads a snapshot as the caller, derives the facts and brings the
 * organization's `npi` facts in line with them: create / update-in-place /
 * leave alone, then delete the rows of a refreshed kind that no longer derive.
 * A source that was not read leaves its kinds untouched.
 */
/** Structural equality of two JSON values (key order-insensitive). */
function sameJson(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

export async function refreshNpiMemory(
  deps: { db: Pick<PrismaClient, 'memoryFact'>; npi: SnapshotNpi },
  caller: { npiOrgId: string; permissions: readonly string[] },
  opts?: { only?: readonly NpiMemorySource[]; maxPurchaseOrders?: number },
): Promise<RefreshOutcome> {
  const { db } = deps;
  const { npiOrgId } = caller;
  const load = await loadNpiMemorySnapshot(deps.npi, caller, opts);
  const derived = deriveNpiFacts(load.snapshot);

  const refreshedKinds = new Set<NpiFactKind>();
  for (const source of NPI_MEMORY_SOURCES) {
    if (load.sources[source].status === 'read') {
      for (const kind of KINDS_OF_SOURCE[source]) refreshedKinds.add(kind);
    }
  }

  const rows = await db.memoryFact.findMany({
    where: { npiOrgId, sourceType: 'npi' },
    select: { id: true, factAr: true, valueJson: true, sourcePermission: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const byKey = new Map<string, Array<{ id: string; factAr: string; valueJson: unknown; sourcePermission: string | null }>>();
  for (const row of rows) {
    const key = keyOf(row.valueJson);
    if (key === null) continue; // an `npi` row this module did not write
    const list = byKey.get(key) ?? [];
    list.push({ id: row.id, factAr: row.factAr, valueJson: row.valueJson, sourcePermission: row.sourcePermission });
    byKey.set(key, list);
  }

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  const removeIds: string[] = [];
  const unchangedIds: string[] = [];

  for (const fact of derived) {
    if (!isStorableFact(fact)) continue; // counted in neither bucket
    const factAr = fact.factAr.trim();
    const searchText = buildSearchText(factAr);
    const [existing, ...extras] = byKey.get(fact.key) ?? [];
    for (const extra of extras) removeIds.push(extra.id); // a double write left two rows for one key
    if (!existing) {
      await db.memoryFact.create({
        data: {
          npiOrgId,
          scope: 'company',
          positionId: null,
          entityType: fact.entityType,
          npiEntityId: fact.npiEntityId,
          factAr,
          searchText,
          valueJson: fact.valueJson as never,
          sourceType: 'npi',
          sourcePermission: fact.sourcePermission,
          confidence: fact.confidence,
        },
        select: { id: true },
      });
      created += 1;
    } else if (
      existing.factAr === factAr &&
      existing.sourcePermission === fact.sourcePermission && // a row written before 0008 is repaired here
      sameJson(existing.valueJson, fact.valueJson)
    ) {
      unchanged += 1;
      unchangedIds.push(existing.id);
    } else {
      await db.memoryFact.update({
        where: { id: existing.id },
        data: {
          factAr,
          searchText,
          valueJson: fact.valueJson as never,
          sourcePermission: fact.sourcePermission,
          confidence: fact.confidence,
        },
        select: { id: true },
      });
      updated += 1;
    }
  }

  // Sweep: only kinds whose source was actually read; chat facts are not in
  // `byKey` at all (the query is `sourceType: 'npi'`).
  const derivedKeys = new Set(derived.map((fact) => fact.key));
  for (const [key, list] of byKey) {
    if (derivedKeys.has(key)) continue;
    const kind = kindOfKey(key);
    if (kind === null || !refreshedKinds.has(kind)) continue;
    for (const row of list) removeIds.push(row.id);
  }
  if (removeIds.length > 0) {
    await db.memoryFact.deleteMany({ where: { id: { in: removeIds } } });
  }
  // The daily gate (`latestNpiFactAt`) reads `updatedAt`; a refresh that found
  // everything unchanged must still count as today's refresh, or it would be
  // repeated every hour once the data is stable. One write for all of them.
  if (unchangedIds.length > 0) {
    await db.memoryFact.updateMany({ where: { id: { in: unchangedIds } }, data: { updatedAt: new Date() } });
  }

  return {
    sources: load.sources,
    derived: derived.length,
    created,
    updated,
    unchanged,
    removed: removeIds.length,
  };
}
