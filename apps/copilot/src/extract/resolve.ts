// Entity resolution for extracted documents (T-23, spec 02 §5.6, BR-09):
// the model names a customer, a project, a purchase order or an item; this
// file decides whether NPI already has it. Pure functions over lists the
// caller reads through `src/npi/client.ts` (cached 5 min per org, 02 §4):
// no I/O here, so the rules are testable without NPI.
//
// Rules (02 §5.6):
//   customer/vendor  VAT number exact → normalized name exact → partial
//                    (shown for choice, never auto-picked) → new
//   project          code exact → normalized name exact → partial → none
//   purchase order   code exact (digits compared numerically, «PO-12» finds
//                    PO-00012) → none
//   department       code exact → normalized name exact (a leading «قسم»
//                    is dropped) → partial → none
//   requisition      code exact, digits compared numerically → none
//   WBS element      code exact → normalized name exact → partial → none
//                    (read off a project record — NPI has no WBS list)
//   item             SKU exact → name trigram similarity ≥ 0.85 → partial
//                    → «صنف جديد؟»
// Trigram similarity follows pg_trgm (02 §5.6 names the ≥ 0.85 threshold
// in those terms): words padded with two leading and one trailing space,
// similarity = |shared trigrams| / |union|.
import { normalizeArabic } from '../text/normalize';
import { readList } from '../npi/responses';

// ─── Text keys ──────────────────────────────────────────────────────────────

/** Legal-form words that do not distinguish one party from another. */
const LEGAL_FORM_WORDS = new Set(
  ['شركة', 'مؤسسة', 'مصنع', 'مكتب', 'مجموعة', 'co', 'company', 'est', 'llc', 'ltd', 'inc', 'corp', 'corporation', 'establishment'].map(
    normalizeArabic,
  ),
);

/** Normalized text with legal-form words removed — «شركة النخيل للمقاولات»
 *  and «النخيل للمقاولات» are the same party on a document. */
export function nameKey(name: string): string {
  return normalizeArabic(name)
    .split(' ')
    .filter((w) => w.length > 0 && !LEGAL_FORM_WORDS.has(w))
    .join(' ');
}

function trigrams(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of normalizeArabic(text).split(' ')) {
    if (word.length === 0) continue;
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i += 1) out.add(padded.slice(i, i + 3));
  }
  return out;
}

export function trigramSimilarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  const union = ta.size + tb.size - shared;
  return union === 0 ? 0 : shared / union;
}

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN = '۰۱۲۳۴۵۶۷۸۹';

function asciiDigits(text: string): string {
  let out = '';
  for (const ch of text) {
    const a = ARABIC_INDIC.indexOf(ch);
    const p = PERSIAN.indexOf(ch);
    out += a !== -1 ? String(a) : p !== -1 ? String(p) : ch;
  }
  return out;
}

function digitsOnly(text: string): string {
  return asciiDigits(text).replace(/\D/g, '');
}

/** «po-12», «PO 00012», «PO-00012» → `{ prefix: 'PO', number: 12 }`. */
export function codeKey(code: string): { prefix: string; number: number | null } {
  const cleaned = asciiDigits(code).trim().toUpperCase().replace(/\s+/g, '');
  const m = /^([A-Z]+)[-_]?(\d+)$/.exec(cleaned);
  if (!m) return { prefix: cleaned, number: null };
  return { prefix: m[1], number: Number(m[2]) };
}

function sameCode(a: string, b: string): boolean {
  const ka = codeKey(a);
  const kb = codeKey(b);
  if (ka.number === null || kb.number === null) return ka.prefix === kb.prefix && ka.prefix.length > 0;
  return ka.prefix === kb.prefix && ka.number === kb.number;
}

// ─── Readers for NPI list bodies ────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export interface PartyRef {
  id: string;
  code: string | null;
  nameAr: string;
  nameEn: string | null;
  vatNumber: string | null;
}

/** Rows of `GET /customers` or `GET /procurement/vendors` (both are bare
 *  arrays of the Prisma record — see src/npi/responses.ts `readList`). */
export function partiesFromNpi(body: unknown): PartyRef[] {
  const out: PartyRef[] = [];
  for (const row of readList(body)) {
    if (!isRecord(row)) continue;
    const id = str(row.id);
    const nameAr = str(row.nameAr) ?? str(row.nameEn);
    if (id === null || nameAr === null) continue;
    out.push({ id, code: str(row.code), nameAr, nameEn: str(row.nameEn), vatNumber: str(row.vatNumber) });
  }
  return out;
}

export interface ProjectRef {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
}

export function projectsFromNpi(body: unknown): ProjectRef[] {
  const out: ProjectRef[] = [];
  for (const row of readList(body)) {
    if (!isRecord(row)) continue;
    const id = str(row.id);
    const code = str(row.code);
    const nameAr = str(row.nameAr) ?? str(row.nameEn);
    if (id === null || code === null || nameAr === null) continue;
    out.push({ id, code, nameAr, nameEn: str(row.nameEn) });
  }
  return out;
}

export interface PurchaseOrderRef {
  id: string;
  code: string;
  vendorId: string | null;
}

export function purchaseOrdersFromNpi(body: unknown): PurchaseOrderRef[] {
  const out: PurchaseOrderRef[] = [];
  for (const row of readList(body)) {
    if (!isRecord(row)) continue;
    const id = str(row.id);
    const code = str(row.code);
    if (id === null || code === null) continue;
    out.push({ id, code, vendorId: str(row.vendorId) });
  }
  return out;
}

export interface ItemRef {
  id: string;
  sku: string;
  nameAr: string;
  nameEn: string | null;
  /** The item's standard cost; NPI uses it as a requisition line's
   *  estimated price when none is given. */
  unitCost: number | null;
}

function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim().length > 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function itemsFromNpi(body: unknown): ItemRef[] {
  const out: ItemRef[] = [];
  for (const row of readList(body)) {
    if (!isRecord(row)) continue;
    const id = str(row.id);
    const sku = str(row.sku);
    const nameAr = str(row.nameAr) ?? str(row.nameEn);
    if (id === null || sku === null || nameAr === null) continue;
    out.push({ id, sku, nameAr, nameEn: str(row.nameEn), unitCost: num(row.unitCost) });
  }
  return out;
}

export interface DepartmentRef {
  id: string;
  code: string | null;
  nameAr: string;
  nameEn: string | null;
}

export function departmentsFromNpi(body: unknown): DepartmentRef[] {
  const out: DepartmentRef[] = [];
  for (const row of readList(body)) {
    if (!isRecord(row)) continue;
    const id = str(row.id);
    const nameAr = str(row.nameAr) ?? str(row.nameEn);
    if (id === null || nameAr === null) continue;
    out.push({ id, code: str(row.code), nameAr, nameEn: str(row.nameEn) });
  }
  return out;
}

export interface RequisitionRef {
  id: string;
  code: string;
  status: string | null;
}

export function requisitionsFromNpi(body: unknown): RequisitionRef[] {
  const out: RequisitionRef[] = [];
  for (const row of readList(body)) {
    if (!isRecord(row)) continue;
    const id = str(row.id);
    const code = str(row.code);
    if (id === null || code === null) continue;
    out.push({ id, code, status: str(row.status) });
  }
  return out;
}

export interface WbsRef {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
}

/** The `wbsElements` array of one project record (`GET /projects/{id}`);
 *  `[]` when the record carries none. */
export function wbsFromProject(projectBody: unknown): WbsRef[] {
  if (!isRecord(projectBody) || !Array.isArray(projectBody.wbsElements)) return [];
  const out: WbsRef[] = [];
  for (const row of projectBody.wbsElements) {
    if (!isRecord(row)) continue;
    const id = str(row.id);
    const code = str(row.code);
    const nameAr = str(row.nameAr) ?? str(row.nameEn);
    if (id === null || code === null || nameAr === null) continue;
    out.push({ id, code, nameAr, nameEn: str(row.nameEn) });
  }
  return out;
}

// ─── Resolution ─────────────────────────────────────────────────────────────

export interface Candidate<T> {
  entity: T;
  similarity: number;
}

export type PartyResolution =
  | { kind: 'matched'; by: 'vat' | 'name'; party: PartyRef }
  | { kind: 'candidates'; candidates: Candidate<PartyRef>[] }
  | { kind: 'new' };

export interface PartyQuery {
  nameAr?: string | null;
  nameEn?: string | null;
  vatNumber?: string | null;
}

/** Below this similarity a party is not even offered as a candidate. Low on
 *  purpose: BR-09 wants a partial match *shown for choice* — «النخيل
 *  للتجارة» against «النخيل للمقاولات» scores ≈ 0.36 and must appear. */
export const PARTY_CANDIDATE_MIN = 0.3;
export const MAX_CANDIDATES = 3;
/** 02 §5.6: items match by name at ≥ 0.85 trigram similarity. */
export const ITEM_MATCH_MIN = 0.85;
export const ITEM_CANDIDATE_MIN = 0.5;

function topCandidates<T>(
  entities: readonly T[],
  score: (entity: T) => number,
  min: number,
): Candidate<T>[] {
  return entities
    .map((entity) => ({ entity, similarity: score(entity) }))
    .filter((c) => c.similarity >= min)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, MAX_CANDIDATES);
}

function bestNameSimilarity(names: readonly (string | null)[], query: readonly (string | null)[]): number {
  let best = 0;
  for (const n of names) {
    if (n === null) continue;
    for (const q of query) {
      if (q === null) continue;
      best = Math.max(best, trigramSimilarity(nameKey(n), nameKey(q)));
    }
  }
  return best;
}

/** Customers and vendors resolve the same way (BR-09). */
export function resolveParty(query: PartyQuery, parties: readonly PartyRef[]): PartyResolution {
  const vat = query.vatNumber ? digitsOnly(query.vatNumber) : '';
  if (vat.length > 0) {
    const byVat = parties.find((p) => p.vatNumber !== null && digitsOnly(p.vatNumber) === vat);
    if (byVat) return { kind: 'matched', by: 'vat', party: byVat };
  }

  const queryNames = [query.nameAr ?? null, query.nameEn ?? null];
  const queryKeys = queryNames.filter((n): n is string => n !== null && n.trim().length > 0).map(nameKey).filter((k) => k.length > 0);
  if (queryKeys.length === 0) return { kind: 'new' };

  const byName = parties.find((p) => [p.nameAr, p.nameEn].some((n) => n !== null && queryKeys.includes(nameKey(n))));
  if (byName) return { kind: 'matched', by: 'name', party: byName };

  const candidates = topCandidates(parties, (p) => bestNameSimilarity([p.nameAr, p.nameEn], queryNames), PARTY_CANDIDATE_MIN);
  return candidates.length > 0 ? { kind: 'candidates', candidates } : { kind: 'new' };
}

export const resolveCustomer = resolveParty;
export const resolveVendor = resolveParty;

export type ProjectResolution =
  | { kind: 'matched'; by: 'code' | 'name'; project: ProjectRef }
  | { kind: 'candidates'; candidates: Candidate<ProjectRef>[] }
  | { kind: 'none' };

export function resolveProject(query: { code?: string | null; name?: string | null }, projects: readonly ProjectRef[]): ProjectResolution {
  if (query.code && query.code.trim().length > 0) {
    const byCode = projects.find((p) => sameCode(p.code, query.code as string));
    if (byCode) return { kind: 'matched', by: 'code', project: byCode };
  }
  const name = query.name?.trim() ?? '';
  if (name.length === 0) return { kind: 'none' };
  const key = nameKey(name);
  const byName = projects.find((p) => [p.nameAr, p.nameEn].some((n) => n !== null && nameKey(n) === key));
  if (byName) return { kind: 'matched', by: 'name', project: byName };
  const candidates = topCandidates(projects, (p) => bestNameSimilarity([p.nameAr, p.nameEn], [name]), PARTY_CANDIDATE_MIN);
  return candidates.length > 0 ? { kind: 'candidates', candidates } : { kind: 'none' };
}

export type DepartmentResolution =
  | { kind: 'matched'; by: 'code' | 'name'; department: DepartmentRef }
  | { kind: 'candidates'; candidates: Candidate<DepartmentRef>[] }
  | { kind: 'none' };

/** «قسم التنفيذ» on a request is the department «التنفيذ». */
const DEPARTMENT_WORD_RE = /^قسم\s+/;

export function resolveDepartment(query: { code?: string | null; name?: string | null }, departments: readonly DepartmentRef[]): DepartmentResolution {
  if (query.code && query.code.trim().length > 0) {
    const byCode = departments.find((d) => d.code !== null && sameCode(d.code, query.code as string));
    if (byCode) return { kind: 'matched', by: 'code', department: byCode };
  }
  const name = query.name?.trim() ?? '';
  if (name.length === 0) return { kind: 'none' };
  const bare = name.replace(DEPARTMENT_WORD_RE, '');
  const keys = [nameKey(name), nameKey(bare)].filter((k) => k.length > 0);
  const byName = departments.find((d) => [d.nameAr, d.nameEn].some((n) => n !== null && keys.includes(nameKey(n))));
  if (byName) return { kind: 'matched', by: 'name', department: byName };
  const candidates = topCandidates(departments, (d) => bestNameSimilarity([d.nameAr, d.nameEn], [bare.length > 0 ? bare : name]), PARTY_CANDIDATE_MIN);
  return candidates.length > 0 ? { kind: 'candidates', candidates } : { kind: 'none' };
}

export type RequisitionResolution = { kind: 'matched'; requisition: RequisitionRef } | { kind: 'none' };

export function resolveRequisition(code: string | null | undefined, requisitions: readonly RequisitionRef[]): RequisitionResolution {
  if (!code || code.trim().length === 0) return { kind: 'none' };
  const hit = requisitions.find((r) => sameCode(r.code, code));
  return hit ? { kind: 'matched', requisition: hit } : { kind: 'none' };
}

export type WbsResolution =
  | { kind: 'matched'; by: 'code' | 'name'; wbs: WbsRef }
  | { kind: 'candidates'; candidates: Candidate<WbsRef>[] }
  | { kind: 'none' };

export function resolveWbs(query: { code?: string | null; name?: string | null }, wbs: readonly WbsRef[]): WbsResolution {
  if (query.code && query.code.trim().length > 0) {
    const byCode = wbs.find((w) => sameCode(w.code, query.code as string));
    if (byCode) return { kind: 'matched', by: 'code', wbs: byCode };
  }
  const name = query.name?.trim() ?? '';
  if (name.length === 0) return { kind: 'none' };
  const key = nameKey(name);
  const byName = wbs.find((w) => [w.nameAr, w.nameEn].some((n) => n !== null && nameKey(n) === key));
  if (byName) return { kind: 'matched', by: 'name', wbs: byName };
  const candidates = topCandidates(wbs, (w) => bestNameSimilarity([w.nameAr, w.nameEn], [name]), PARTY_CANDIDATE_MIN);
  return candidates.length > 0 ? { kind: 'candidates', candidates } : { kind: 'none' };
}

export type PurchaseOrderResolution = { kind: 'matched'; purchaseOrder: PurchaseOrderRef } | { kind: 'none' };

export function resolvePurchaseOrder(code: string | null | undefined, purchaseOrders: readonly PurchaseOrderRef[]): PurchaseOrderResolution {
  if (!code || code.trim().length === 0) return { kind: 'none' };
  const hit = purchaseOrders.find((po) => sameCode(po.code, code));
  return hit ? { kind: 'matched', purchaseOrder: hit } : { kind: 'none' };
}

export type ItemResolution =
  | { kind: 'matched'; by: 'sku' | 'name'; item: ItemRef; similarity: number }
  | { kind: 'candidates'; candidates: Candidate<ItemRef>[] }
  /** 02 §5.6: «صنف جديد؟» — the card offers to create it. */
  | { kind: 'new' };

export function resolveItem(query: { sku?: string | null; name?: string | null }, items: readonly ItemRef[]): ItemResolution {
  if (query.sku && query.sku.trim().length > 0) {
    const sku = normalizeArabic(query.sku).replace(/\s+/g, '');
    const bySku = items.find((i) => normalizeArabic(i.sku).replace(/\s+/g, '') === sku);
    if (bySku) return { kind: 'matched', by: 'sku', item: bySku, similarity: 1 };
  }
  const name = query.name?.trim() ?? '';
  if (name.length === 0) return { kind: 'new' };
  const scored = topCandidates(items, (i) => bestNameSimilarity([i.nameAr, i.nameEn], [name]), ITEM_CANDIDATE_MIN);
  if (scored.length > 0 && scored[0].similarity >= ITEM_MATCH_MIN) {
    // Two items above the threshold with the same score is a choice, not a match.
    if (scored.length > 1 && scored[1].similarity === scored[0].similarity) return { kind: 'candidates', candidates: scored };
    return { kind: 'matched', by: 'name', item: scored[0].entity, similarity: scored[0].similarity };
  }
  return scored.length > 0 ? { kind: 'candidates', candidates: scored } : { kind: 'new' };
}
