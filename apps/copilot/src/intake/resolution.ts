// Entity resolution for an intake job (T-26, 02 §5.6, BR-09): reads the NPI
// lists a document's names refer to, runs the pure resolvers of
// `src/extract/resolve.ts`, and returns the `FlowResolution` the preview card
// is built from. Reads only — nothing here writes to NPI.
//
// Items and projects are matched against NPI's pick lists
// (`GET /reference/lookups/{items,projects}`, ADR-02 §3-3), which a form's
// working key opens without the owning screen: an engineer who may raise a
// requisition matches its items without `commercial.item.read`. Customers
// and vendors stay on their full lists, because BR-09 matches a party by its
// VAT number first and the pick lists carry names only; a project's WBS
// elements stay on the project record (`GET /projects/:id`).
//
// A list NPI refuses or cannot serve (a site engineer cannot read the
// department directory, for one) never fails the job: the pick becomes
// `unreadable`, a note says so once, and the value stays as the document
// wrote it. Anything that is not an `NpiError` is a bug and propagates.
import type { FlowType } from '../agents/router';
import { t } from '../i18n/ar';
import { NpiError } from '../npi/errors';
import type { NpiClient } from '../npi/client';
import {
  billTotalWarnings,
  departmentsFromNpi,
  expectedBillAmounts,
  goodsReceiptBlockers,
  itemsFromNpi,
  partiesFromNpi,
  projectsFromNpi,
  purchaseOrderDetailFromNpi,
  purchaseOrderReceivable,
  purchaseOrdersFromNpi,
  receiptLineWarnings,
  requisitionsFromNpi,
  resolveCustomer,
  resolveDepartment,
  resolveGoodsReceipt,
  resolveItem,
  resolvePoLine,
  resolveProject,
  resolvePurchaseOrder,
  resolveRequisition,
  resolveVendor,
  resolveWbs,
  wbsFromProject,
  type PurchaseOrderDetail,
  type WbsRef,
} from '../extract/resolve';
import type { CustomerContractValues } from '../extract/schemas/customer_contract';
import type { GrnValues } from '../extract/schemas/grn';
import type { PoValues, VendorValues } from '../extract/schemas/po';
import type { PrValues } from '../extract/schemas/pr';
import type { VendorBillValues } from '../extract/schemas/vendor_bill';
import { formatAmount } from './labels';
import type { EntityPick, FlowResolution, LineResolution } from './types';

export type ResolutionNpi = Pick<
  NpiClient,
  | 'listCustomers'
  | 'listVendors'
  | 'lookupProjects'
  | 'getProject'
  | 'listDepartments'
  | 'listRequisitions'
  | 'listPurchaseOrders'
  | 'getPurchaseOrder'
  | 'lookupItems'
>;

type Unreadable = Extract<EntityPick, { kind: 'unreadable' }>;
type ListName =
  | 'customers'
  | 'vendors'
  | 'projects'
  | 'project_wbs'
  | 'departments'
  | 'items'
  | 'requisitions'
  | 'purchase_orders'
  | 'purchase_order_detail';

interface Ctx {
  npi: ResolutionNpi;
  notes: string[];
  unreadable: Map<ListName, Unreadable>;
}

/** Runs one NPI read; an `NpiError` becomes an `unreadable` pick and one note per list. */
async function readOnce<T>(ctx: Ctx, list: ListName, call: () => Promise<unknown>, parse: (body: unknown) => T): Promise<{ ok: true; value: T } | { ok: false; pick: Unreadable }> {
  const known = ctx.unreadable.get(list);
  if (known) return { ok: false, pick: known };
  try {
    return { ok: true, value: parse(await call()) };
  } catch (err) {
    if (!(err instanceof NpiError)) throw err;
    const messageAr = t('preview.list_unreadable', { list: t(`preview.list.${list}` as const) });
    const pick: Unreadable = { kind: 'unreadable', messageAr };
    ctx.unreadable.set(list, pick);
    ctx.notes.push(messageAr);
    return { ok: false, pick };
  }
}

// ─── Labels ─────────────────────────────────────────────────────────────────

const partyLabel = (p: { nameAr: string; nameEn: string | null; code: string | null }): string => p.nameAr ?? p.nameEn ?? p.code ?? '';
const codeLabel = (code: string, name: string | null | undefined): string => (name ? `«${code} — ${name}»` : code);
const itemLabel = (i: { nameAr: string; sku: string | null }): string => (i.sku ? `${i.nameAr} (${i.sku})` : i.nameAr);

// ─── Parties ────────────────────────────────────────────────────────────────

async function pickParty(
  ctx: Ctx,
  list: 'customers' | 'vendors',
  query: { nameAr: string; nameEn: string | null; vatNumber: string | null },
  noteKeys: { match: 'preview.customer_match' | 'preview.vendor_match'; fresh: 'preview.customer_new' | 'preview.vendor_new' },
): Promise<EntityPick> {
  const read = await readOnce(ctx, list, () => (list === 'customers' ? ctx.npi.listCustomers() : ctx.npi.listVendors()), partiesFromNpi);
  if (!read.ok) return read.pick;
  const found = list === 'customers' ? resolveCustomer(query, read.value) : resolveVendor(query, read.value);
  if (found.kind === 'matched') {
    const labelAr = partyLabel(found.party);
    ctx.notes.push(t(noteKeys.match, { name: labelAr }));
    return { kind: 'matched', id: found.party.id, labelAr, by: found.by };
  }
  if (found.kind === 'candidates') {
    return {
      kind: 'candidates',
      candidates: found.candidates.map((c) => ({ id: c.entity.id, labelAr: partyLabel(c.entity), similarity: c.similarity })),
    };
  }
  ctx.notes.push(t(noteKeys.fresh));
  return { kind: 'new' };
}

const pickCustomer = (ctx: Ctx, c: CustomerContractValues['customer']) =>
  pickParty(ctx, 'customers', c, { match: 'preview.customer_match', fresh: 'preview.customer_new' });
const pickVendor = (ctx: Ctx, v: VendorValues) => pickParty(ctx, 'vendors', v, { match: 'preview.vendor_match', fresh: 'preview.vendor_new' });

// ─── Project, department, requisition, WBS ──────────────────────────────────

async function pickProject(ctx: Ctx, query: { code: string | null; name: string | null }): Promise<EntityPick | undefined> {
  if (query.code === null && query.name === null) return undefined;
  const read = await readOnce(ctx, 'projects', () => ctx.npi.lookupProjects(), projectsFromNpi);
  if (!read.ok) return read.pick;
  const found = resolveProject(query, read.value);
  if (found.kind === 'matched') {
    return { kind: 'matched', id: found.project.id, labelAr: codeLabel(found.project.code, found.project.nameAr), by: found.by };
  }
  if (found.kind === 'candidates') {
    return {
      kind: 'candidates',
      candidates: found.candidates.map((c) => ({ id: c.entity.id, labelAr: codeLabel(c.entity.code, c.entity.nameAr), similarity: c.similarity })),
    };
  }
  // A project NPI does not know is a note, not a blocker: a requisition
  // without a project is accepted.
  ctx.notes.push(t('preview.project_none', { name: query.code ?? query.name ?? '' }));
  return { kind: 'none' };
}

async function pickDepartment(ctx: Ctx, name: string | null): Promise<EntityPick | undefined> {
  if (name === null) return undefined;
  const read = await readOnce(ctx, 'departments', () => ctx.npi.listDepartments(), departmentsFromNpi);
  if (!read.ok) return read.pick;
  const found = resolveDepartment({ name }, read.value);
  if (found.kind === 'matched') {
    return { kind: 'matched', id: found.department.id, labelAr: found.department.code ? codeLabel(found.department.code, found.department.nameAr) : found.department.nameAr, by: found.by };
  }
  if (found.kind === 'candidates') {
    return {
      kind: 'candidates',
      candidates: found.candidates.map((c) => ({ id: c.entity.id, labelAr: c.entity.nameAr, similarity: c.similarity })),
    };
  }
  ctx.notes.push(t('preview.department_none', { name }));
  return { kind: 'none' };
}

async function pickRequisition(ctx: Ctx, code: string | null): Promise<EntityPick | undefined> {
  if (code === null) return undefined;
  const read = await readOnce(ctx, 'requisitions', () => ctx.npi.listRequisitions(), requisitionsFromNpi);
  if (!read.ok) return read.pick;
  const found = resolveRequisition(code, read.value);
  if (found.kind === 'matched') return { kind: 'matched', id: found.requisition.id, labelAr: found.requisition.code, by: 'code' };
  ctx.notes.push(t('preview.requisition_none', { code }));
  return { kind: 'none' };
}

/** The WBS elements of the matched project (NPI has no WBS list). `null`
 *  when there is no matched project or its record cannot be read. The record
 *  has its own note: the pick list that matched the project is open to more
 *  keys than the record itself (`projects.project.read`). */
async function projectWbs(ctx: Ctx, project: EntityPick | undefined): Promise<WbsRef[] | null> {
  if (project?.kind !== 'matched') return null;
  const read = await readOnce(ctx, 'project_wbs', () => ctx.npi.getProject(project.id), wbsFromProject);
  return read.ok ? read.value : null;
}

// ─── Lines of a requisition or an order ─────────────────────────────────────

interface ItemLine {
  itemName: string;
  sku: string | null;
  wbsCode: string | null;
  wbsName: string | null;
}

async function resolveItemLines(ctx: Ctx, lines: ItemLine[], project: EntityPick | undefined): Promise<LineResolution[]> {
  if (lines.length === 0) return [];
  const items = await readOnce(ctx, 'items', () => ctx.npi.lookupItems(), itemsFromNpi);
  const wbs = lines.some((l) => l.wbsCode !== null || l.wbsName !== null) ? await projectWbs(ctx, project) : null;

  return lines.map((line): LineResolution => {
    const out: LineResolution = { warnings: [] };
    if (!items.ok) {
      out.item = items.pick;
    } else {
      const found = resolveItem({ sku: line.sku, name: line.itemName }, items.value);
      if (found.kind === 'matched') {
        out.item = { kind: 'matched', id: found.item.id, labelAr: itemLabel(found.item), by: found.by };
        out.unitCost = found.item.unitCost;
      } else if (found.kind === 'candidates') {
        out.item = {
          kind: 'candidates',
          candidates: found.candidates.map((c) => ({ id: c.entity.id, labelAr: itemLabel(c.entity), similarity: c.similarity })),
        };
      } else {
        out.item = { kind: 'new' };
        ctx.notes.push(t('preview.item_new_named', { name: line.itemName }));
      }
    }
    if (wbs !== null && (line.wbsCode !== null || line.wbsName !== null)) {
      const found = resolveWbs({ code: line.wbsCode, name: line.wbsName }, wbs);
      if (found.kind === 'matched') {
        out.wbs = { kind: 'matched', id: found.wbs.id, labelAr: codeLabel(found.wbs.code, found.wbs.nameAr), by: found.by };
      } else if (found.kind === 'candidates') {
        out.wbs = {
          kind: 'candidates',
          candidates: found.candidates.map((c) => ({ id: c.entity.id, labelAr: codeLabel(c.entity.code, c.entity.nameAr), similarity: c.similarity })),
        };
      }
    }
    return out;
  });
}

// ─── Per-flow resolution ────────────────────────────────────────────────────

async function resolveContract(ctx: Ctx, values: CustomerContractValues): Promise<FlowResolution> {
  const customer = await pickCustomer(ctx, values.customer);
  return { flow: 'customer_contract', customer, lines: [], warnings: [], notesAr: ctx.notes };
}

async function resolvePr(ctx: Ctx, values: PrValues): Promise<FlowResolution> {
  const project = await pickProject(ctx, { code: values.projectCode, name: values.projectName });
  const department = await pickDepartment(ctx, values.departmentName);
  const lines = await resolveItemLines(ctx, values.lines, project);
  return { flow: 'pr', project, department, lines, warnings: [], notesAr: ctx.notes };
}

async function resolvePo(ctx: Ctx, values: PoValues): Promise<FlowResolution> {
  const vendor = values.vendor === null ? undefined : await pickVendor(ctx, values.vendor);
  const requisition = await pickRequisition(ctx, values.sourceRequisitionCode);
  const project = await pickProject(ctx, { code: values.projectCode, name: values.projectName });
  const lines = await resolveItemLines(ctx, values.lines, project);
  return { flow: 'po', vendor, requisition, project, lines, warnings: [], notesAr: ctx.notes };
}

/** The purchase order a code names, with its detail when NPI serves it. */
async function lookupPurchaseOrder(
  ctx: Ctx,
  code: string,
): Promise<{ pick: FlowResolution['purchaseOrder']; detail: PurchaseOrderDetail | null }> {
  const list = await readOnce(ctx, 'purchase_orders', () => ctx.npi.listPurchaseOrders(), purchaseOrdersFromNpi);
  if (!list.ok) return { pick: list.pick, detail: null };
  const found = resolvePurchaseOrder(code, list.value);
  if (found.kind === 'none') {
    ctx.notes.push(t('preview.po_none', { code }));
    return { pick: { kind: 'none' }, detail: null };
  }
  const po = found.purchaseOrder;
  const read = await readOnce(ctx, 'purchase_order_detail', () => ctx.npi.getPurchaseOrder(po.id), purchaseOrderDetailFromNpi);
  if (!read.ok) return { pick: read.pick, detail: null };
  if (read.value === null) {
    // A body without id and code is as good as an unreadable one.
    const messageAr = t('preview.list_unreadable', { list: t('preview.list.purchase_order_detail') });
    ctx.notes.push(messageAr);
    return { pick: { kind: 'unreadable', messageAr }, detail: null };
  }
  const detail = read.value;
  return {
    pick: {
      kind: 'matched',
      id: po.id,
      labelAr: codeLabel(po.code, po.vendorNameAr),
      by: 'code',
      status: detail.status ?? po.status,
      receivable: purchaseOrderReceivable({ status: detail.status ?? po.status }),
    },
    detail,
  };
}

async function resolveGrn(ctx: Ctx, values: GrnValues): Promise<FlowResolution> {
  const warnings: FlowResolution['warnings'] = [];
  let purchaseOrder: FlowResolution['purchaseOrder'];
  let detail: PurchaseOrderDetail | null = null;

  if (values.purchaseOrderCode === null) {
    purchaseOrder = { kind: 'none' };
    ctx.notes.push(t('preview.po_required'));
  } else {
    ({ pick: purchaseOrder, detail } = await lookupPurchaseOrder(ctx, values.purchaseOrderCode));
    if (purchaseOrder?.kind === 'matched' && purchaseOrder.receivable === false) {
      warnings.push({ path: 'purchaseOrderCode', warning: 'extract.warn.po_not_receivable' });
    }
  }

  const lines = values.lines.map((line): LineResolution => {
    const out: LineResolution = { warnings: [] };
    if (detail === null) return out;
    const found = resolvePoLine({ sku: line.sku, name: line.itemName }, detail.lines);
    if (found.kind === 'matched') {
      out.poLine = {
        kind: 'matched',
        id: found.line.id,
        labelAr: found.line.nameAr ? itemLabel({ nameAr: found.line.nameAr, sku: found.line.sku }) : (found.line.sku ?? found.line.id),
        by: found.by,
      };
      for (const warning of receiptLineWarnings({ qty: line.qty, serials: line.serials }, found.line)) {
        out.warnings.push({ field: warning === 'extract.warn.over_receipt' ? 'qty' : 'serials', warning });
      }
    } else if (found.kind === 'candidates') {
      out.poLine = {
        kind: 'candidates',
        candidates: found.candidates.map((c) => ({
          id: c.entity.id,
          labelAr: c.entity.nameAr ? itemLabel({ nameAr: c.entity.nameAr, sku: c.entity.sku }) : (c.entity.sku ?? c.entity.id),
          similarity: c.similarity,
        })),
      };
    } else {
      out.poLine = { kind: 'none' };
      ctx.notes.push(t('preview.po_line_none', { name: line.itemName }));
    }
    return out;
  });

  return { flow: 'grn', purchaseOrder, lines, warnings, notesAr: ctx.notes };
}

async function resolveBill(ctx: Ctx, values: VendorBillValues): Promise<FlowResolution> {
  const warnings: FlowResolution['warnings'] = [];
  const vendor = values.vendor === null ? undefined : await pickVendor(ctx, values.vendor);

  let purchaseOrder: FlowResolution['purchaseOrder'];
  let detail: PurchaseOrderDetail | null = null;
  if (values.purchaseOrderCode !== null) {
    ({ pick: purchaseOrder, detail } = await lookupPurchaseOrder(ctx, values.purchaseOrderCode));
  }

  let goodsReceipt: EntityPick | undefined;
  let expected: FlowResolution['expectedBillAmounts'] = null;
  if (detail !== null) {
    const found = resolveGoodsReceipt({ code: values.goodsReceiptCode }, detail.goodsReceipts);
    if (found.kind === 'matched') {
      const receipt = found.receipt;
      goodsReceipt = { kind: 'matched', id: receipt.id, labelAr: receipt.code, by: found.by };
      for (const warning of goodsReceiptBlockers(receipt)) warnings.push({ path: 'goodsReceiptCode', warning });
      expected = expectedBillAmounts(receipt, detail);
      if (billTotalWarnings(values, expected).length > 0) {
        if (values.total !== null) warnings.push({ path: 'total', warning: 'extract.warn.bill_total_mismatch' });
        if (values.subtotal !== null) warnings.push({ path: 'subtotal', warning: 'extract.warn.bill_total_mismatch' });
        ctx.notes.push(
          t('preview.expected_amounts', {
            subtotal: formatAmount(expected.subtotal),
            vat: formatAmount(expected.vatAmount),
            total: formatAmount(expected.total),
          }),
        );
      }
    } else if (found.kind === 'candidates') {
      goodsReceipt = {
        kind: 'candidates',
        candidates: found.candidates.map((c) => ({ id: c.entity.id, labelAr: c.entity.code, similarity: c.similarity })),
      };
    } else {
      goodsReceipt = { kind: 'none' };
      ctx.notes.push(t('preview.grn_none', { code: detail.code }));
    }
  } else if (values.purchaseOrderCode === null) {
    ctx.notes.push(t('preview.grn_required'));
  }

  return { flow: 'vendor_bill', vendor, purchaseOrder, goodsReceipt, lines: [], expectedBillAmounts: expected, warnings, notesAr: ctx.notes };
}

/**
 * Reads what NPI knows about the names in `values` (the flow's `*Values`) and
 * decides, per BR-09, what is matched, what is a choice and what is new.
 * `notesAr` is deduplicated. Throws only for a bug (a non-`NpiError`).
 */
export async function resolveFlow(npi: ResolutionNpi, flow: FlowType, values: unknown): Promise<FlowResolution> {
  const ctx: Ctx = { npi, notes: [], unreadable: new Map() };
  let resolution: FlowResolution;
  switch (flow) {
    case 'customer_contract':
      resolution = await resolveContract(ctx, values as CustomerContractValues);
      break;
    case 'pr':
      resolution = await resolvePr(ctx, values as PrValues);
      break;
    case 'po':
      resolution = await resolvePo(ctx, values as PoValues);
      break;
    case 'grn':
      resolution = await resolveGrn(ctx, values as GrnValues);
      break;
    case 'vendor_bill':
      resolution = await resolveBill(ctx, values as VendorBillValues);
      break;
  }
  resolution.notesAr = [...new Set(resolution.notesAr)];
  return resolution;
}

// ─── The decision the user ended up with ────────────────────────────────────

/**
 * D-T27-6: the NPI id the user ended up with for a pick, or null (create /
 * undecided / none). `chosen` is the stored `choose` decision for the pick's
 * target: an option id or `'new'`.
 *  - matched    → the match, unless the user chose «new» (or another option id);
 *  - candidates → the chosen candidate, or null while undecided / «new»;
 *  - new / none / unreadable / undefined → null.
 */
export function pickedId(pick: EntityPick | undefined, chosen: string | undefined): string | null {
  if (pick === undefined) return null;
  switch (pick.kind) {
    case 'matched':
      return chosen === 'new' ? null : (chosen ?? pick.id);
    case 'candidates':
      return chosen !== undefined && pick.candidates.some((c) => c.id === chosen) ? chosen : null;
    default:
      return null;
  }
}

// ─── Hard blockers ──────────────────────────────────────────────────────────

/** What `resolutionBlockers` reads from the flow's values, all optional. */
export interface BlockerContext {
  purchaseOrderCode?: string | null;
  lines?: { itemName: string }[];
}

/**
 * The reasons NPI could not carry out this job whatever the user decides on
 * the card, recomputed from the picks (so a stored resolution can be checked
 * again without any NPI read):
 *  - grn: no purchase order (or one NPI would not serve), or a line with no
 *    matching line on it;
 *  - vendor_bill: no accepted, unbilled goods receipt to bill.
 * `context` supplies the words for the message (the PO code, the line's item
 * name); without it a generic form is used.
 */
export function resolutionBlockers(r: FlowResolution, context: BlockerContext = {}): string[] {
  const out: string[] = [];
  if (r.flow === 'grn') {
    const po = r.purchaseOrder;
    if (po === undefined || po.kind === 'none') {
      const code = context.purchaseOrderCode ?? null;
      out.push(code === null ? t('preview.po_required') : t('preview.po_none', { code }));
    } else if (po.kind === 'unreadable') {
      out.push(po.messageAr);
    }
    r.lines.forEach((line, index) => {
      if (line.poLine?.kind === 'none') out.push(t('preview.po_line_none', { name: context.lines?.[index]?.itemName ?? String(index + 1) }));
    });
  }
  if (r.flow === 'vendor_bill') {
    const grn = r.goodsReceipt;
    if (grn === undefined || grn.kind === 'none' || grn.kind === 'unreadable') out.push(t('preview.grn_required'));
  }
  return out;
}
