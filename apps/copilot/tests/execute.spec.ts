// T-27: the execution plan (src/execute/plan.ts, src/intake/resolution.ts
// `pickedId`) and the executor (src/execute/run.ts) — pure functions and an
// in-memory database, NPI and document store. No network, no real database.
//
// Every NPI write in the fake client is a `jest.fn`, so the tests can assert the
// order and the number of calls: a step's failure is final and nothing is ever
// retried (ADR-29).
import { t } from '../src/i18n/ar';
import type { CustomerContractValues } from '../src/extract/schemas/customer_contract';
import type { GrnValues } from '../src/extract/schemas/grn';
import type { PoValues, VendorValues } from '../src/extract/schemas/po';
import type { PrValues } from '../src/extract/schemas/pr';
import type { VendorBillValues } from '../src/extract/schemas/vendor_bill';
import type { LlmAuditData } from '../src/audit/log';
import { buildPlan, PlanError, type ExecutionPlan, type PlannedStep } from '../src/execute/plan';
import { executeJob, ExecutionClaimError, type ExecuteDeps, type ExecutionNpi } from '../src/execute/run';
import { previewSteps } from '../src/intake/preview';
import { pickedId } from '../src/intake/resolution';
import type { IntakeJobRow } from '../src/intake/job';
import type { CreatedEntity, EntityPick, ExecutionLog, FlowResolution, FlowType } from '../src/intake/types';
import type { DocumentRow, DocumentStorage } from '../src/intake/upload';
import { NpiError } from '../src/npi/errors';

const NOW = new Date('2026-10-05T09:00:00.000Z');
const CALLER = { npiOrgId: 'org-1', npiUserId: 'user-1' };
const CUSTOMER = 'شركة النخيل للمقاولات';
const VENDOR = 'شركة الخليج للألواح الشمسية';
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

// ─── values (what the flows' `assess*` produce) ─────────────────────────────

function contractValues(): CustomerContractValues {
  return {
    customer: { nameAr: CUSTOMER, nameEn: 'Al Nakheel Contracting', customerType: 'CI', vatNumber: '310123456700003', crNumber: '1010567890', phone: '0501234567', email: 'info@nakheel.sa' },
    contractType: 'EPC',
    startDate: '2026-11-01',
    endDate: '2027-04-30',
    totalValue: 850000,
    retentionPct: 10,
    advancePct: null,
    milestones: [
      { sequence: 1, descriptionAr: 'دفعة مقدمة عند التوقيع', descriptionEn: null, amount: 255000, percent: 30, dueDate: null, triggerType: 'EVENT' },
      { sequence: 2, descriptionAr: 'عند اكتمال التوريد', descriptionEn: null, amount: 340000, percent: 40, dueDate: null, triggerType: 'EVENT' },
      { sequence: 3, descriptionAr: 'عند التشغيل والتسليم', descriptionEn: null, amount: 255000, percent: 30, dueDate: null, triggerType: 'EVENT' },
    ],
  };
}

function prValues(): PrValues {
  return {
    justification: 'استكمال أعمال التركيب في المشروع',
    projectCode: 'PRJ-00012',
    projectName: null,
    departmentName: 'المشاريع',
    neededBy: '2026-10-08',
    currency: null,
    lines: [{ itemName: 'لوح 550 واط', sku: 'MOD-550', qty: 40, unit: null, estimatedUnitPrice: null, wbsCode: 'WBS-01', wbsName: null, notes: null }],
  };
}

function vendorValues(): VendorValues {
  return { nameAr: VENDOR, nameEn: 'Gulf Solar Panels Co.', vendorType: 'SUPPLIER', vatNumber: '311111111111113', crNumber: '1010111222', phone: null, email: 'sales@gulfsolar.sa' };
}

const PANEL_LINE = { itemName: 'لوح شمسي 550 واط', sku: 'MOD-550', qty: 40, unit: 'قطعة', unitPrice: 320, lineTotal: 12800, wbsCode: null, wbsName: null };
const INVERTER_LINE = { itemName: 'عاكس 50 كيلوواط', sku: 'INV-50K', qty: 1, unit: 'قطعة', unitPrice: 6500, lineTotal: 6500, wbsCode: null, wbsName: null };

function poValues(lines: PoValues['lines'] = [PANEL_LINE], overrides: Partial<PoValues> = {}): PoValues {
  return {
    vendor: vendorValues(),
    quoteRef: 'Q-2026-117',
    quoteDate: '2026-10-01',
    validUntil: '2026-10-31',
    sourceRequisitionCode: null,
    projectCode: 'PRJ-00012',
    projectName: null,
    currency: null,
    subtotal: null,
    vatAmount: null,
    total: null,
    lines,
    ...overrides,
  };
}

const SERIALS = Array.from({ length: 8 }, (_, i) => `GS550-2609-${String(i + 1).padStart(4, '0')}`);

function grnValues(overrides: Partial<GrnValues> = {}): GrnValues {
  return {
    purchaseOrderCode: 'PO-00007',
    deliveryNoteRef: 'DN-4471',
    deliveryDate: '2026-10-04',
    vendorName: VENDOR,
    projectCode: 'PRJ-00012',
    locationName: 'مستودع الرياض',
    notes: null,
    lines: [{ itemName: 'لوح شمسي 550 واط', sku: 'MOD-550', qty: 8, unit: 'قطعة', serials: SERIALS, batchNo: null, notes: null }],
    ...overrides,
  };
}

function billValues(): VendorBillValues {
  return {
    vendor: vendorValues(),
    invoiceNumber: 'INV-7781',
    invoiceDate: '2026-10-05',
    dueDate: '2026-11-04',
    purchaseOrderCode: 'PO-00007',
    goodsReceiptCode: 'GRN-00003',
    deliveryNoteRef: 'DN-4471',
    projectCode: 'PRJ-00012',
    currency: null,
    subtotal: 12800,
    vatAmount: 1920,
    total: 14720,
    lines: [{ itemName: 'لوح شمسي 550 واط', sku: 'MOD-550', qty: 40, unit: 'قطعة', unitPrice: 320, lineTotal: 12800 }],
  };
}

// ─── resolutions ────────────────────────────────────────────────────────────

const res = (flow: FlowType, rest: Partial<FlowResolution> = {}): FlowResolution => ({ flow, lines: [], warnings: [], notesAr: [], ...rest });

const customerMatched: EntityPick = { kind: 'matched', id: 'cus-1', labelAr: CUSTOMER, by: 'vat' };
const vendorMatched: EntityPick = { kind: 'matched', id: 'ven-1', labelAr: VENDOR, by: 'vat' };
const projectMatched: EntityPick = { kind: 'matched', id: 'prj-12', labelAr: '«PRJ-00012 — محطة الرياض الشمسية»', by: 'code' };
const panelItem: EntityPick = { kind: 'matched', id: 'itm-550', labelAr: 'لوح شمسي 550 واط (MOD-550)', by: 'sku' };
const inverterItem: EntityPick = { kind: 'matched', id: 'itm-inv', labelAr: 'عاكس 50 كيلوواط (INV-50K)', by: 'sku' };
const poMatched: FlowResolution['purchaseOrder'] = { kind: 'matched', id: 'po-7', labelAr: '«PO-00007 — شركة الخليج للألواح الشمسية»', by: 'code', status: 'SENT', receivable: true };

// ─── plan helpers ───────────────────────────────────────────────────────────

type StepOf<K extends PlannedStep['kind']> = Extract<PlannedStep, { kind: K }>;

function stepAt<K extends PlannedStep['kind']>(plan: ExecutionPlan, index: number, kind: K): StepOf<K> {
  const step = plan.steps[index];
  expect(step.kind).toBe(kind);
  return step as StepOf<K>;
}

const kindsOf = (plan: ExecutionPlan): string[] => plan.steps.map((s) => s.kind);
const labelsOf = (plan: ExecutionPlan): string[] => plan.steps.map((s) => s.labelAr);

interface PlanArgs {
  values: unknown;
  resolution: FlowResolution | null;
  choices?: Record<string, string>;
  hasDocument?: boolean;
}

function planOf(flow: FlowType, { values, resolution, choices = {}, hasDocument = false }: PlanArgs): ExecutionPlan {
  return buildPlan({ flow, values, resolution, choices, hasDocument });
}

/** The labels the preview card promised for the same inputs. */
function promised(flow: FlowType, { values, resolution, choices = {}, hasDocument = false }: PlanArgs): string[] {
  return previewSteps(flow, values, resolution, choices, hasDocument).map((s) => s.labelAr);
}

function planError(build: () => unknown): PlanError {
  let caught: unknown = null;
  try {
    build();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(PlanError);
  return caught as PlanError;
}

// ─── pickedId ───────────────────────────────────────────────────────────────

describe('pickedId (D-T27-6)', () => {
  const matched: EntityPick = { kind: 'matched', id: 'cus-1', labelAr: CUSTOMER, by: 'vat' };
  const candidates: EntityPick = {
    kind: 'candidates',
    candidates: [
      { id: 'cus-1', labelAr: CUSTOMER, similarity: 0.62 },
      { id: 'cus-2', labelAr: 'النخيل للتجارة', similarity: 0.41 },
    ],
  };

  it.each<[string, EntityPick | undefined, string | undefined, string | null]>([
    ['matched, nothing chosen: the match', matched, undefined, 'cus-1'],
    ['matched, «new» chosen: create instead', matched, 'new', null],
    ['matched, another option chosen: that one', matched, 'cus-9', 'cus-9'],
    ['matched, the match itself chosen', matched, 'cus-1', 'cus-1'],
    ['candidates, an option chosen', candidates, 'cus-2', 'cus-2'],
    ['candidates, undecided', candidates, undefined, null],
    ['candidates, «new» chosen', candidates, 'new', null],
    ['candidates, an id that is not an option', candidates, 'cus-404', null],
    ['new', { kind: 'new' }, undefined, null],
    ['new, even when something was chosen', { kind: 'new' }, 'cus-1', null],
    ['none', { kind: 'none' }, undefined, null],
    ['unreadable', { kind: 'unreadable', messageAr: t('preview.list_unreadable', { list: t('preview.list.departments') }) }, undefined, null],
    ['no pick at all', undefined, undefined, null],
    ['no pick, a stray choice', undefined, 'cus-1', null],
  ])('%s', (_name, pick, chosen, expected) => {
    expect(pickedId(pick, chosen)).toBe(expected);
  });
});

// ─── buildPlan ──────────────────────────────────────────────────────────────

describe('buildPlan — customer_contract', () => {
  it('a document and a matched customer: use, create the contract, attach, leave activation to NPI', () => {
    const args: PlanArgs = { values: contractValues(), resolution: res('customer_contract', { customer: customerMatched }), hasDocument: true };
    const plan = planOf('customer_contract', args);

    expect(plan.flow).toBe('customer_contract');
    expect(kindsOf(plan)).toEqual(['customer_use', 'contract_create', 'attach', 'manual']);
    expect(plan.steps.map((s) => s.n)).toEqual([1, 2, 3, 4]);
    expect(labelsOf(plan)).toEqual(promised('customer_contract', args));
    expect(labelsOf(plan)[0]).toBe(t('preview.step.customer_use', { name: CUSTOMER }));
    expect(labelsOf(plan)[2]).toBe(t('preview.step.attach'));
    expect(labelsOf(plan)[3]).toBe(t('preview.step.contract_activate_manual'));

    expect(stepAt(plan, 0, 'customer_use').customerId).toBe('cus-1');
    const create = stepAt(plan, 1, 'contract_create');
    expect(create.customer).toEqual({ id: 'cus-1' });
    expect(create.values).toEqual(contractValues());
    const attach = stepAt(plan, 2, 'attach');
    expect(attach.entityType).toBe('contract');
    expect(attach.target).toEqual({ fromStep: 2 });
  });

  it('no document and a customer NPI does not have: create it first, and the contract points at that step', () => {
    const args: PlanArgs = { values: contractValues(), resolution: res('customer_contract', { customer: { kind: 'new' } }) };
    const plan = planOf('customer_contract', args);

    expect(kindsOf(plan)).toEqual(['customer_create', 'contract_create', 'manual']);
    expect(labelsOf(plan)).toEqual(promised('customer_contract', args));
    expect(labelsOf(plan)[0]).toBe(t('preview.step.customer_new', { name: CUSTOMER }));
    expect(stepAt(plan, 0, 'customer_create').dto).toMatchObject({ nameAr: CUSTOMER, nameEn: 'Al Nakheel Contracting', vatNumber: '310123456700003', customerType: 'CI' });
    expect(stepAt(plan, 1, 'contract_create').customer).toEqual({ fromStep: 1 });
  });

  it('the user’s decision wins: «new» over a match creates; a chosen candidate is used', () => {
    const asNew = planOf('customer_contract', { values: contractValues(), resolution: res('customer_contract', { customer: customerMatched }), choices: { customer: 'new' } });
    expect(kindsOf(asNew)).toEqual(['customer_create', 'contract_create', 'manual']);
    expect(stepAt(asNew, 1, 'contract_create').customer).toEqual({ fromStep: 1 });

    const candidates: EntityPick = {
      kind: 'candidates',
      candidates: [
        { id: 'cus-1', labelAr: CUSTOMER, similarity: 0.62 },
        { id: 'cus-2', labelAr: 'النخيل للتجارة', similarity: 0.41 },
      ],
    };
    const chosen = planOf('customer_contract', { values: contractValues(), resolution: res('customer_contract', { customer: candidates }), choices: { customer: 'cus-2' } });
    expect(kindsOf(chosen)).toEqual(['customer_use', 'contract_create', 'manual']);
    expect(stepAt(chosen, 0, 'customer_use').customerId).toBe('cus-2');
    expect(stepAt(chosen, 1, 'contract_create').customer).toEqual({ id: 'cus-2' });
  });
});

describe('buildPlan — pr', () => {
  const resolved = (overrides: Partial<FlowResolution> = {}): FlowResolution =>
    res('pr', {
      project: projectMatched,
      department: { kind: 'unreadable', messageAr: t('preview.list_unreadable', { list: t('preview.list.departments') }) },
      lines: [{ item: panelItem, wbs: { kind: 'matched', id: 'wbs-1', labelAr: '«WBS-01 — الأعمال المدنية»', by: 'code' }, unitCost: 320, warnings: [] }],
      ...overrides,
    });

  it('create then submit; the DTO carries the ids and the item’s price from the resolution', () => {
    const args: PlanArgs = { values: prValues(), resolution: resolved() };
    const plan = planOf('pr', args);

    expect(kindsOf(plan)).toEqual(['requisition_create', 'requisition_submit']);
    expect(labelsOf(plan)).toEqual(promised('pr', args));
    expect(labelsOf(plan)).toEqual([t('preview.step.pr_create', { n: 1 }), t('preview.step.pr_submit')]);

    const dto = stepAt(plan, 0, 'requisition_create').dto;
    expect(dto).toMatchObject({
      justification: 'استكمال أعمال التركيب في المشروع',
      projectId: 'prj-12',
      neededBy: '2026-10-08',
      lines: [{ itemId: 'itm-550', qty: 40, estimatedUnitPrice: 320, wbsElementId: 'wbs-1' }],
    });
    // The department list was unreadable: no department id is invented.
    expect(dto).not.toHaveProperty('departmentId');
    expect(stepAt(plan, 1, 'requisition_submit').requisition).toEqual({ fromStep: 1 });
  });

  it('a department the user picked is sent', () => {
    const department: EntityPick = { kind: 'candidates', candidates: [{ id: 'dep-1', labelAr: 'المشاريع', similarity: 0.8 }, { id: 'dep-2', labelAr: 'المشتريات', similarity: 0.5 }] };
    const plan = planOf('pr', { values: prValues(), resolution: resolved({ department }), choices: { department: 'dep-1' } });
    expect(stepAt(plan, 0, 'requisition_create').dto).toMatchObject({ departmentId: 'dep-1' });
  });

  it.each<[string, EntityPick | undefined]>([
    ['new', { kind: 'new' }],
    ['none', { kind: 'none' }],
    ['unreadable', { kind: 'unreadable', messageAr: t('preview.list_unreadable', { list: t('preview.list.items') }) }],
    ['undefined', undefined],
    ['candidates nobody chose', { kind: 'candidates', candidates: [{ id: 'itm-550', labelAr: 'لوح شمسي 550 واط (MOD-550)', similarity: 0.7 }] }],
  ])('a line whose item is %s cannot be planned: «%s» must exist in NPI first', (_name, item) => {
    const error = planError(() => planOf('pr', { values: prValues(), resolution: res('pr', { project: projectMatched, lines: [{ item, warnings: [] }] }) }));
    expect(error.messageAr).toContain(t('preview.item_required', { name: 'لوح 550 واط' }));
    expect(error.messageAr).toBe(t('exec.error.plan', { reason: t('preview.item_required', { name: 'لوح 550 واط' }) }));
  });
});

describe('buildPlan — po', () => {
  const twoLines = [PANEL_LINE, INVERTER_LINE];

  it('a matched requisition and vendor: use the vendor, convert the requisition with the quote’s prices, leave the matrix to NPI', () => {
    const args: PlanArgs = {
      values: poValues(twoLines, { sourceRequisitionCode: 'PR-00012', currency: 'SAR' }),
      resolution: res('po', {
        vendor: vendorMatched,
        requisition: { kind: 'matched', id: 'req-12', labelAr: 'PR-00012', by: 'code' },
        project: projectMatched,
        lines: [{ item: panelItem, warnings: [] }, { item: inverterItem, warnings: [] }],
      }),
    };
    const plan = planOf('po', args);

    expect(kindsOf(plan)).toEqual(['vendor_use', 'po_convert', 'manual']);
    expect(labelsOf(plan)).toEqual(promised('po', args));
    expect(labelsOf(plan)[1]).toBe(t('preview.step.po_convert', { code: 'PR-00012' }));
    expect(labelsOf(plan)[2]).toBe(t('preview.step.po_matrix'));
    expect(stepAt(plan, 0, 'vendor_use').vendorId).toBe('ven-1');

    const convert = stepAt(plan, 1, 'po_convert');
    expect(convert.vendor).toEqual({ id: 'ven-1' });
    expect(convert.requisitionId).toBe('req-12');
    expect(convert.requisitionCode).toBe('PR-00012');
    expect(convert.currency).toBe('SAR');
    expect(convert.lines).toEqual([
      { itemId: 'itm-550', itemName: 'لوح شمسي 550 واط', unitPrice: 320 },
      { itemId: 'itm-inv', itemName: 'عاكس 50 كيلوواط', unitPrice: 6500 },
    ]);
  });

  it('a vendor NPI does not have and no requisition: create the vendor, then the order pointing at that step', () => {
    const values = poValues(twoLines);
    const args: PlanArgs = {
      values,
      resolution: res('po', {
        vendor: { kind: 'new' },
        requisition: { kind: 'none' },
        project: projectMatched,
        lines: [{ item: panelItem, warnings: [] }, { item: inverterItem, warnings: [] }],
      }),
    };
    const plan = planOf('po', args);

    expect(kindsOf(plan)).toEqual(['vendor_create', 'po_create', 'manual']);
    expect(labelsOf(plan)).toEqual(promised('po', args));
    expect(stepAt(plan, 0, 'vendor_create').dto).toMatchObject({ nameAr: VENDOR, nameEn: 'Gulf Solar Panels Co.', vatNumber: '311111111111113', vendorType: 'SUPPLIER' });

    const create = stepAt(plan, 1, 'po_create');
    expect(create.vendor).toEqual({ fromStep: 1 });
    expect(create.values).toEqual(values);
    expect(create.resolved.projectId).toBe('prj-12');
    expect(create.resolved.lines.map((l) => l.itemId)).toEqual(['itm-550', 'itm-inv']);
  });

  it('a quote that names no vendor cannot be planned', () => {
    const error = planError(() =>
      planOf('po', { values: poValues([PANEL_LINE], { vendor: null }), resolution: res('po', { lines: [{ item: panelItem, warnings: [] }] }) }),
    );
    expect(error.messageAr).toContain(t('exec.reason.entity_undecided', { entity: t('exec.kind.vendor') }));
  });

  it('a line whose item NPI does not have cannot be planned', () => {
    const error = planError(() =>
      planOf('po', { values: poValues(), resolution: res('po', { vendor: vendorMatched, lines: [{ item: { kind: 'new' }, warnings: [] }] }) }),
    );
    expect(error.messageAr).toContain(t('preview.item_required', { name: 'لوح شمسي 550 واط' }));
  });
});

describe('buildPlan — grn', () => {
  const grnResolution = (overrides: Partial<FlowResolution> = {}): FlowResolution =>
    res('grn', {
      purchaseOrder: poMatched,
      lines: [{ poLine: { kind: 'matched', id: 'pol-1', labelAr: 'لوح شمسي 550 واط (MOD-550)', by: 'sku' }, warnings: [] }],
      ...overrides,
    });

  it('one receipt on the matched PO with the PO line, the quantity and the serials; inspection stays in NPI', () => {
    const args: PlanArgs = { values: grnValues(), resolution: grnResolution() };
    const plan = planOf('grn', args);

    expect(kindsOf(plan)).toEqual(['grn_create', 'manual']);
    expect(labelsOf(plan)).toEqual(promised('grn', args));
    expect(labelsOf(plan)[1]).toBe(t('preview.step.grn_inspect_manual'));

    const step = stepAt(plan, 0, 'grn_create');
    expect(step.purchaseOrderId).toBe('po-7');
    expect(step.dto.lines).toHaveLength(1);
    expect(step.dto.lines[0]).toMatchObject({ poLineId: 'pol-1', qty: 8, serials: SERIALS });
    expect(step.dto.notes).toContain('DN-4471');
    // NPI defaults the location (D-T27-11).
    expect(step.dto).not.toHaveProperty('locationId');
  });

  it('no attach step even with a document: NPI has nowhere to attach it (D-T27-4)', () => {
    const plan = planOf('grn', { values: grnValues(), resolution: grnResolution(), hasDocument: true });
    expect(kindsOf(plan)).toEqual(['grn_create', 'manual']);
  });

  it('a PO NPI does not know cannot be planned', () => {
    const error = planError(() => planOf('grn', { values: grnValues(), resolution: grnResolution({ purchaseOrder: { kind: 'none' } }) }));
    expect(error.messageAr).toContain(t('exec.reason.entity_undecided', { entity: t('exec.kind.purchase_order') }));
  });

  it('a line with no matching PO line cannot be planned', () => {
    const error = planError(() => planOf('grn', { values: grnValues(), resolution: grnResolution({ lines: [{ poLine: { kind: 'none' }, warnings: [] }] }) }));
    expect(error.messageAr).toContain(t('preview.po_line_none', { name: 'لوح شمسي 550 واط' }));
  });
});

describe('buildPlan — vendor_bill', () => {
  const candidates: EntityPick = {
    kind: 'candidates',
    candidates: [
      { id: 'grn-1', labelAr: 'GRN-00003', similarity: 0.7 },
      { id: 'grn-2', labelAr: 'GRN-00004', similarity: 0.6 },
    ],
  };

  it('the bill goes on the receipt the user chose, carrying the invoice number; the match runs in NPI', () => {
    const args: PlanArgs = {
      values: billValues(),
      resolution: res('vendor_bill', { vendor: vendorMatched, purchaseOrder: poMatched, goodsReceipt: candidates }),
      choices: { goodsReceipt: 'grn-2' },
    };
    const plan = planOf('vendor_bill', args);

    expect(kindsOf(plan)).toEqual(['bill_create', 'manual']);
    expect(labelsOf(plan)).toEqual(promised('vendor_bill', args));
    expect(labelsOf(plan)[1]).toBe(t('preview.step.bill_match_npi'));

    const step = stepAt(plan, 0, 'bill_create');
    expect(step.dto).toEqual({ goodsReceiptId: 'grn-2', vendorRef: 'INV-7781' });
    expect(step.purchaseOrderId).toBe('po-7');
  });

  it('a matched receipt is used as it is, and a bill with no known PO has no PO to link', () => {
    const plan = planOf('vendor_bill', {
      values: billValues(),
      resolution: res('vendor_bill', { vendor: { kind: 'new' }, goodsReceipt: { kind: 'matched', id: 'grn-3', labelAr: 'GRN-00003', by: 'code' } }),
    });
    const step = stepAt(plan, 0, 'bill_create');
    expect(step.dto).toMatchObject({ goodsReceiptId: 'grn-3' });
    expect(step.purchaseOrderId).toBeNull();
  });

  it('no receipt to bill cannot be planned', () => {
    const none = planError(() => planOf('vendor_bill', { values: billValues(), resolution: res('vendor_bill', { vendor: vendorMatched, goodsReceipt: { kind: 'none' } }) }));
    expect(none.messageAr).toContain(t('exec.reason.entity_undecided', { entity: t('exec.kind.goods_receipt') }));

    const undecided = planError(() => planOf('vendor_bill', { values: billValues(), resolution: res('vendor_bill', { goodsReceipt: candidates }) }));
    expect(undecided.messageAr).toContain(t('exec.kind.goods_receipt'));
  });
});

describe('buildPlan — the attach step belongs to a contract only (D-T27-4)', () => {
  it.each<[string, FlowType, PlanArgs]>([
    ['po', 'po', { values: poValues(), resolution: res('po', { vendor: vendorMatched, lines: [{ item: panelItem, warnings: [] }] }), hasDocument: true }],
    ['vendor_bill', 'vendor_bill', { values: billValues(), resolution: res('vendor_bill', { goodsReceipt: { kind: 'matched', id: 'grn-3', labelAr: 'GRN-00003', by: 'code' } }), hasDocument: true }],
    ['pr', 'pr', { values: prValues(), resolution: res('pr', { lines: [{ item: panelItem, warnings: [] }] }), hasDocument: true }],
  ])('%s with a document plans no attach', (_name, flow, args) => {
    const plan = planOf(flow, args);
    expect(kindsOf(plan)).not.toContain('attach');
    expect(labelsOf(plan)).not.toContain(t('preview.step.attach'));
  });
});

describe('buildPlan — refusals', () => {
  it('no values at all (the extraction was incomplete): the plan does not match the card', () => {
    const error = planError(() => planOf('customer_contract', { values: null, resolution: null }));
    expect(error.messageAr).toBe(t('exec.error.plan', { reason: t('exec.reason.steps_drift') }));
    expect(error.messageAr).toContain(t('exec.reason.steps_drift'));
  });

  it('a DTO builder’s own guard (a requisition with no reason) is reported as a plan error, never thrown raw', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const error = planError(() =>
        planOf('pr', { values: { ...prValues(), justification: null }, resolution: res('pr', { lines: [{ item: panelItem, warnings: [] }] }) }),
      );
      expect(error.messageAr).toContain(t('exec.reason.steps_drift'));
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

// ─── the executor: fakes ────────────────────────────────────────────────────

type Row = Record<string, unknown> & { id: string };

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => row[key] === value);
}

function withoutUndefined(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
}

function makeDocument(overrides: Partial<DocumentRow> = {}): DocumentRow {
  return {
    id: 'doc-1',
    npiOrgId: 'org-1',
    npiUserId: 'user-1',
    fileName: 'عقد.pdf',
    mime: 'application/pdf',
    sizeBytes: PDF_BYTES.byteLength,
    sha256: 'a'.repeat(64),
    storagePath: 'org-1/contract.pdf',
    kind: 'pdf_text',
    sensitivityFlag: false,
    consentEventId: null,
    extractedTextRedactedRef: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const PREVIEW_MARKER = { marker: 'the preview the user approved' };

function createJobRow(overrides: Partial<IntakeJobRow> = {}): IntakeJobRow {
  return {
    id: 'job-1',
    npiOrgId: 'org-1',
    npiUserId: 'user-1',
    documentId: 'doc-1',
    conversationId: 'conv-1',
    flowType: 'customer_contract',
    status: 'approved',
    extractedJson: null,
    previewJson: PREVIEW_MARKER,
    executionLogJson: { status: 'pending', steps: [] },
    error: null,
    approvedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

interface RecordedUpdate {
  where: Record<string, unknown>;
  /** What the executor passed (the very object — to see it was not mutated afterwards). */
  raw: Record<string, unknown>;
  /** What it looked like at the moment of the call. */
  snapshot: Record<string, unknown>;
}

/** An in-memory database: `update` honours every key of `where` and rejects
 *  when no row matches (D-T27-7). Rows are cloned in and out, as a real
 *  database would, so nothing aliases the stored JSON. */
function createFakeDb(jobRow: IntakeJobRow, documents: DocumentRow[]) {
  const jobs = new Map<string, Row>([[jobRow.id, structuredClone(jobRow) as unknown as Row]]);
  const docs = new Map(documents.map((d) => [d.id, d]));
  const audit: LlmAuditData[] = [];
  const updates: RecordedUpdate[] = [];
  const auditFailure: { error: Error | null } = { error: null };

  const api = {
    intakeJob: {
      create: async () => {
        throw new Error('the executor never creates a job');
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const found = [...jobs.values()].find((row) => matches(row, where));
        return found ? structuredClone(found) : null;
      },
      update: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const row = [...jobs.values()].find((r) => matches(r, where));
        if (!row) throw new Error(`P2025: no job matches ${JSON.stringify(where)}`);
        updates.push({ where, raw: data, snapshot: structuredClone(data) });
        Object.assign(row, structuredClone(withoutUndefined(data)), { updatedAt: NOW });
        return structuredClone(row);
      },
    },
    document: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const found = [...docs.values()].find((row) => matches(row as unknown as Record<string, unknown>, where));
        return found ? structuredClone(found) : null;
      },
    },
    consentEvent: { findUnique: async () => null },
    llmAudit: {
      create: jest.fn(async ({ data }: { data: LlmAuditData }) => {
        if (auditFailure.error) throw auditFailure.error;
        audit.push(structuredClone(data));
        return data;
      }),
    },
  };
  return { api, jobs, audit, updates, auditFailure };
}

function createFakeStorage(files: Record<string, Uint8Array> = { 'org-1/contract.pdf': PDF_BYTES }) {
  const store = new Map(Object.entries(files));
  const storage: DocumentStorage = {
    async write(relPath, bytes) {
      store.set(relPath, bytes);
    },
    async read(relPath) {
      return store.get(relPath) ?? null;
    },
  };
  return { storage, store };
}

type NpiMethod = keyof ExecutionNpi;

/** Every method a `jest.fn`; `order` records the sequence of calls across all of them. */
function createFakeNpi() {
  const order: string[] = [];
  const make = (name: NpiMethod, result: () => unknown) =>
    jest.fn(async (..._args: unknown[]): Promise<unknown> => {
      order.push(name);
      return result();
    });
  const fns = {
    createCustomer: make('createCustomer', () => ({ id: 'cus-9', code: 'CUS-00009', nameAr: CUSTOMER })),
    createContract: make('createContract', () => ({ id: 'con-1', code: 'CON-00012' })),
    createRequisition: make('createRequisition', () => ({ id: 'req-1', code: 'PR-00031' })),
    submitRequisition: make('submitRequisition', () => ({ id: 'wf-1' })),
    createVendor: make('createVendor', () => ({ id: 'ven-9', code: 'VEN-00009' })),
    createPurchaseOrder: make('createPurchaseOrder', () => ({ id: 'po-9', code: 'PO-00009' })),
    getRequisition: make('getRequisition', () => ({ id: 'req-12', code: 'PR-00012', lines: [{ id: 'prl-1', itemId: 'itm-550' }] })),
    convertRequisition: make('convertRequisition', () => ({ id: 'po-9', code: 'PO-00009' })),
    receiveOnPurchaseOrder: make('receiveOnPurchaseOrder', () => ({ id: 'grn-5', code: 'GRN-00005' })),
    createBill: make('createBill', () => ({ id: 'bill-4', code: 'VB-00004' })),
    attachFile: make('attachFile', () => ({ id: 'att-1' })),
  };
  /** The next call of `name` rejects with `error` (and is still recorded in `order`). */
  const failNext = (name: NpiMethod, error: unknown) =>
    fns[name].mockImplementationOnce(async () => {
      order.push(name);
      throw error;
    });
  const writes = [fns.createCustomer, fns.createContract, fns.createRequisition, fns.submitRequisition, fns.createVendor, fns.createPurchaseOrder, fns.convertRequisition, fns.receiveOnPurchaseOrder, fns.createBill, fns.attachFile];
  return { ...fns, order, failNext, writes };
}

interface WorldOptions {
  job?: Partial<IntakeJobRow>;
  /** Documents in the database (default: the contract PDF). */
  documents?: DocumentRow[];
  files?: Record<string, Uint8Array>;
}

function createWorld(options: WorldOptions = {}) {
  const job = createJobRow(options.job);
  const fake = createFakeDb(job, options.documents ?? [makeDocument()]);
  const store = createFakeStorage(options.files);
  const npi = createFakeNpi();
  const deps: ExecuteDeps = {
    db: fake.api as unknown as ExecuteDeps['db'],
    npi: npi as unknown as ExecutionNpi,
    storage: store.storage,
    now: () => NOW,
  };
  const row = () => fake.jobs.get(job.id) as Row;
  const log = () => row().executionLogJson as ExecutionLog;
  const run = (plan: ExecutionPlan) => executeJob(deps, CALLER, job, plan);
  return { job, ...fake, store, npi, deps, row, log, run };
}

type World = ReturnType<typeof createWorld>;

const entity = (kind: CreatedEntity['kind'], id: string, code: string | null, npiPath: string | null): CreatedEntity => ({ kind, id, code, npiPath });
const viewOf = (e: CreatedEntity) => ({ kindAr: t(`exec.kind.${e.kind}` as const), id: e.id, code: e.code, npiPath: e.npiPath });

// Plans the executor runs, built the way approve builds them.

function contractPlan(options: { customer?: EntityPick; hasDocument?: boolean } = {}): ExecutionPlan {
  const { customer = { kind: 'new' }, hasDocument = true } = options;
  return planOf('customer_contract', { values: contractValues(), resolution: res('customer_contract', { customer }), hasDocument });
}

function prPlan(): ExecutionPlan {
  return planOf('pr', {
    values: prValues(),
    resolution: res('pr', { project: projectMatched, lines: [{ item: panelItem, unitCost: 320, warnings: [] }] }),
  });
}

function convertPlan(lines: PoValues['lines'] = [PANEL_LINE], items: EntityPick[] = [panelItem]): ExecutionPlan {
  return planOf('po', {
    values: poValues(lines, { sourceRequisitionCode: 'PR-00012' }),
    resolution: res('po', {
      vendor: vendorMatched,
      requisition: { kind: 'matched', id: 'req-12', labelAr: 'PR-00012', by: 'code' },
      lines: items.map((item) => ({ item, warnings: [] })),
    }),
  });
}

function newVendorPoPlan(): ExecutionPlan {
  return planOf('po', {
    values: poValues(),
    resolution: res('po', { vendor: { kind: 'new' }, requisition: { kind: 'none' }, project: projectMatched, lines: [{ item: panelItem, warnings: [] }] }),
  });
}

function grnPlan(): ExecutionPlan {
  return planOf('grn', {
    values: grnValues(),
    resolution: res('grn', { purchaseOrder: poMatched, lines: [{ poLine: { kind: 'matched', id: 'pol-1', labelAr: 'لوح شمسي 550 واط (MOD-550)', by: 'sku' }, warnings: [] }] }),
  });
}

function billPlan(): ExecutionPlan {
  return planOf('vendor_bill', {
    values: billValues(),
    resolution: res('vendor_bill', {
      vendor: vendorMatched,
      purchaseOrder: poMatched,
      goodsReceipt: { kind: 'candidates', candidates: [{ id: 'grn-1', labelAr: 'GRN-00003', similarity: 0.7 }, { id: 'grn-2', labelAr: 'GRN-00004', similarity: 0.6 }] },
    }),
    choices: { goodsReceipt: 'grn-1' },
  });
}

const forbidden = () => new NpiError({ status: 403, kind: 'forbidden', npiMessage: 'Insufficient permissions' });

function expectNoWrites(world: World): void {
  for (const write of world.npi.writes) expect(write).not.toHaveBeenCalled();
}

// ─── the executor ───────────────────────────────────────────────────────────

let errorSpy: jest.SpyInstance;
beforeEach(() => {
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => errorSpy.mockRestore());

describe('executeJob — a contract, every step succeeds', () => {
  it('creates the customer, the contract on that customer, attaches the document; stores the log, the references and one audit row', async () => {
    const world = createWorld();
    const plan = contractPlan();
    expect(kindsOf(plan)).toEqual(['customer_create', 'contract_create', 'attach', 'manual']);

    const result = await world.run(plan);

    expect(world.npi.order).toEqual(['createCustomer', 'createContract', 'attachFile']);
    for (const call of [world.npi.createCustomer, world.npi.createContract, world.npi.attachFile]) expect(call).toHaveBeenCalledTimes(1);

    // The contract is created on the customer the first step created.
    expect(world.npi.createContract.mock.calls[0][0]).toMatchObject({ customerId: 'cus-9', contractType: 'EPC', totalValue: 850000 });
    // The stored document goes to the new contract as it is stored.
    expect(world.npi.attachFile).toHaveBeenCalledWith('contract', 'con-1', { fileName: 'عقد.pdf', mime: 'application/pdf', bytes: PDF_BYTES });

    const customer = entity('customer', 'cus-9', 'CUS-00009', '/customers');
    const contract = entity('contract', 'con-1', 'CON-00012', '/contracts/con-1');
    const attachment = entity('attachment', 'att-1', 'عقد.pdf', null);

    expect(result.status).toBe('done');
    expect(world.row().status).toBe('done');
    const log = world.log();
    expect(log.status).toBe('done');
    expect(log.failedAt).toBeUndefined();
    expect(log.startedAt).toBe(NOW.toISOString());
    expect(log.finishedAt).toBe(NOW.toISOString());
    expect(log.steps).toEqual([
      { n: 1, labelAr: plan.steps[0].labelAr, state: 'done', entity: viewOf(customer) },
      { n: 2, labelAr: plan.steps[1].labelAr, state: 'done', entity: viewOf(contract) },
      { n: 3, labelAr: plan.steps[2].labelAr, state: 'done', entity: viewOf(attachment) },
      { n: 4, labelAr: plan.steps[3].labelAr, state: 'manual' },
    ]);
    expect(viewOf(customer).kindAr).toBe(t('exec.kind.customer'));
    expect(result.executionLogJson).toEqual(log);
    expect(world.row().npiEntityRefs).toEqual([customer, contract, attachment]);

    // The approved preview is untouched, and the extraction `error` column stays empty.
    expect(world.row().previewJson).toEqual(PREVIEW_MARKER);
    expect(world.row().error).toBeNull();

    expect(world.audit).toHaveLength(1);
    expect(world.audit[0]).toMatchObject({
      event: 'intake_executed',
      npiOrgId: 'org-1',
      npiUserId: 'user-1',
      intakeJobId: 'job-1',
      documentId: 'doc-1',
      conversationId: 'conv-1',
      tokensIn: 0,
      tokensOut: 0,
      modelId: null,
      imageSent: false,
      error: null,
    });
  });

  it('an existing customer is used, not created: the first step makes no NPI call and no reference', async () => {
    const world = createWorld();
    const plan = contractPlan({ customer: customerMatched });
    expect(kindsOf(plan)).toEqual(['customer_use', 'contract_create', 'attach', 'manual']);

    await world.run(plan);

    expect(world.npi.order).toEqual(['createContract', 'attachFile']);
    expect(world.npi.createContract.mock.calls[0][0]).toMatchObject({ customerId: 'cus-1' });
    expect(world.log().steps[0]).toEqual({ n: 1, labelAr: plan.steps[0].labelAr, state: 'done' });
    expect((world.row().npiEntityRefs as CreatedEntity[]).map((e) => e.kind)).toEqual(['contract', 'attachment']);
  });

  it('without a document there is nothing to attach and the document is never read', async () => {
    const world = createWorld({ job: { documentId: null }, documents: [] });
    const plan = contractPlan({ hasDocument: false });
    expect(kindsOf(plan)).toEqual(['customer_create', 'contract_create', 'manual']);

    const result = await world.run(plan);

    expect(result.status).toBe('done');
    expect(world.npi.attachFile).not.toHaveBeenCalled();
    expect(world.audit[0]).toMatchObject({ event: 'intake_executed', documentId: null });
  });
});

describe('executeJob — the name the file is attached under (D-T27-4)', () => {
  it.each<[string, string, string, string]>([
    ['a PDF keeps its name', 'عقد.pdf', 'application/pdf', 'عقد.pdf'],
    ['the extension is matched in lower case', 'عقد.PDF', 'application/pdf', 'عقد.PDF'],
    ['a converted HEIC photo is stored as JPEG and gets that extension', 'صورة.heic', 'image/jpeg', 'صورة.heic.jpg'],
    ['a .jpeg name stays', 'صورة العقد.jpeg', 'image/jpeg', 'صورة العقد.jpeg'],
    ['a name with no extension gets one from the type', 'مسح ضوئي', 'image/png', 'مسح ضوئي.png'],
    ['a PDF with no extension', 'عقد التوريد', 'application/pdf', 'عقد التوريد.pdf'],
  ])('%s', async (_name, fileName, mime, expected) => {
    const document = makeDocument({ fileName, mime, storagePath: 'org-1/stored.bin' });
    const world = createWorld({ documents: [document], files: { 'org-1/stored.bin': PDF_BYTES } });

    await world.run(contractPlan());

    expect(world.npi.attachFile).toHaveBeenCalledTimes(1);
    expect(world.npi.attachFile).toHaveBeenCalledWith('contract', 'con-1', { fileName: expected, mime, bytes: PDF_BYTES });
  });
});

describe('executeJob — a step fails: stop, report, never retry (ADR-29)', () => {
  it('NPI refuses the contract: it is called once, the attachment never, the customer is reported as created', async () => {
    const world = createWorld();
    const refusal = forbidden();
    world.npi.failNext('createContract', refusal);
    const plan = contractPlan();

    const result = await world.run(plan);

    expect(world.npi.order).toEqual(['createCustomer', 'createContract']);
    expect(world.npi.createCustomer).toHaveBeenCalledTimes(1);
    expect(world.npi.createContract).toHaveBeenCalledTimes(1);
    expect(world.npi.attachFile).not.toHaveBeenCalled();

    expect(result.status).toBe('failed');
    expect(world.row().status).toBe('failed');
    const log = world.log();
    expect(log.status).toBe('failed');
    expect(log.failedAt).toBe(2);
    expect(log.finishedAt).toBe(NOW.toISOString());
    expect(log.steps).toEqual([
      { n: 1, labelAr: plan.steps[0].labelAr, state: 'done', entity: viewOf(entity('customer', 'cus-9', 'CUS-00009', '/customers')) },
      { n: 2, labelAr: plan.steps[1].labelAr, state: 'failed', errorAr: refusal.messageAr },
      { n: 3, labelAr: plan.steps[2].labelAr, state: 'pending' },
      { n: 4, labelAr: plan.steps[3].labelAr, state: 'pending' },
    ]);
    expect(refusal.messageAr).toContain('NPI رفض');
    expect(world.row().npiEntityRefs).toEqual([entity('customer', 'cus-9', 'CUS-00009', '/customers')]);

    // The card stays: the preview is kept, and `error` (extraction failures) is not used.
    expect(world.row().previewJson).toEqual(PREVIEW_MARKER);
    expect(world.row().error).toBeNull();

    expect(world.audit).toHaveLength(1);
    expect(world.audit[0].event).toBe('intake_execution_failed');
    expect(world.audit[0].intakeJobId).toBe('job-1');
    expect(world.audit[0].documentId).toBe('doc-1');
    expect(world.audit[0].conversationId).toBe('conv-1');
    expect(world.audit[0].tokensIn).toBe(0);
    expect(world.audit[0].error).toContain('2:');
    expect(world.audit[0].error).toContain(plan.steps[1].labelAr);
    expect(world.audit[0].error).toContain(refusal.messageAr);
  });

  it('an error that is not NPI’s is reported in general terms, with the detail only in the server log', async () => {
    const world = createWorld();
    world.npi.failNext('createCustomer', new Error('boom'));
    const plan = contractPlan();

    const result = await world.run(plan);

    expect(result.status).toBe('failed');
    const log = world.log();
    expect(log.failedAt).toBe(1);
    expect(log.steps[0]).toEqual({ n: 1, labelAr: plan.steps[0].labelAr, state: 'failed', errorAr: t('exec.error.unexpected') });
    expect(log.steps.slice(1).map((s) => s.state)).toEqual(['pending', 'pending', 'pending']);
    expect(world.npi.createContract).not.toHaveBeenCalled();
    expect(world.row().npiEntityRefs).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();
    expect(String(errorSpy.mock.calls[0][0])).toContain('[copilot]');
    expect(JSON.stringify(log)).not.toContain('boom');
    expect(world.audit[0]).toMatchObject({ event: 'intake_execution_failed' });
    expect(world.audit[0].error).toContain(t('exec.error.unexpected'));
  });

  it('the attachment refused after the contract exists: both are reported as created, nothing is retried', async () => {
    const world = createWorld();
    const refusal = forbidden();
    world.npi.failNext('attachFile', refusal);
    const plan = contractPlan();

    const result = await world.run(plan);

    expect(result.status).toBe('failed');
    expect(world.npi.attachFile).toHaveBeenCalledTimes(1);
    const log = world.log();
    expect(log.failedAt).toBe(3);
    expect(log.steps.map((s) => s.state)).toEqual(['done', 'done', 'failed', 'pending']);
    expect(log.steps[2].errorAr).toBe(refusal.messageAr);
    expect((world.row().npiEntityRefs as CreatedEntity[]).map((e) => e.kind)).toEqual(['customer', 'contract']);
  });

  it('a document that is gone fails the attach step with the «not found» message and writes nothing', async () => {
    const world = createWorld({ documents: [] });
    const result = await world.run(contractPlan());

    expect(result.status).toBe('failed');
    expect(world.log().failedAt).toBe(3);
    expect(world.log().steps[2]).toMatchObject({ state: 'failed', errorAr: t('document.error.not_found') });
    expect(world.npi.attachFile).not.toHaveBeenCalled();
  });

  it('a stored file that cannot be read fails the attach step with the «unreadable» message', async () => {
    const world = createWorld({ files: {} });
    const result = await world.run(contractPlan());

    expect(result.status).toBe('failed');
    expect(world.log().steps[2]).toMatchObject({ state: 'failed', errorAr: t('document.error.unreadable') });
    expect(world.npi.attachFile).not.toHaveBeenCalled();
  });

  it('the first step failing leaves nothing created and says so', async () => {
    const world = createWorld();
    world.npi.failNext('createCustomer', new NpiError({ status: 409, kind: 'conflict', npiMessage: 'Customer VAT already exists' }));

    await world.run(contractPlan());

    expect(world.row().npiEntityRefs).toEqual([]);
    expect(world.log().steps[0].errorAr).toContain('Customer VAT already exists');
  });
});

describe('executeJob — the log is truthful at every moment', () => {
  it('each state change is stored before the next NPI call', async () => {
    const world = createWorld();
    const seen: { call: string; status: unknown; states: string[]; logStatus: string }[] = [];
    const snap = (call: string) => seen.push({ call, status: world.row().status, states: world.log().steps.map((s) => s.state), logStatus: world.log().status });

    world.npi.createCustomer.mockImplementationOnce(async () => {
      world.npi.order.push('createCustomer');
      snap('createCustomer');
      return { id: 'cus-9', code: 'CUS-00009' };
    });
    world.npi.createContract.mockImplementationOnce(async () => {
      world.npi.order.push('createContract');
      snap('createContract');
      return { id: 'con-1', code: 'CON-00012' };
    });
    world.npi.attachFile.mockImplementationOnce(async () => {
      world.npi.order.push('attachFile');
      snap('attachFile');
      return { id: 'att-1' };
    });

    await world.run(contractPlan());

    expect(seen).toEqual([
      { call: 'createCustomer', status: 'executing', states: ['running', 'pending', 'pending', 'pending'], logStatus: 'running' },
      { call: 'createContract', status: 'executing', states: ['done', 'running', 'pending', 'pending'], logStatus: 'running' },
      { call: 'attachFile', status: 'executing', states: ['done', 'done', 'running', 'pending'], logStatus: 'running' },
    ]);
    // The manual step is marked as soon as the step before it is done, and the job closes after it.
    expect(world.log().steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'manual']);
  });

  it('everything stored is plain JSON, and a stored log is never changed afterwards', async () => {
    const world = createWorld();
    world.npi.failNext('attachFile', forbidden());
    await world.run(contractPlan());

    expect(world.updates.length).toBeGreaterThanOrEqual(5);
    for (const update of world.updates) {
      expect(update.where).toMatchObject({ id: 'job-1' });
      expect(JSON.parse(JSON.stringify(update.snapshot))).toEqual(update.snapshot);
      // The executor handed the database an object it did not touch again.
      expect(update.raw).toStrictEqual(update.snapshot);
    }
    const stored = world.row();
    expect(JSON.parse(JSON.stringify(stored.executionLogJson))).toEqual(stored.executionLogJson);
    expect(JSON.parse(JSON.stringify(stored.npiEntityRefs))).toEqual(stored.npiEntityRefs);
  });
});

describe('executeJob — the claim (D-T27-7)', () => {
  it('a job that is not approved is not executed: no NPI call, nothing stored', async () => {
    const world = createWorld({ job: { status: 'preview' } });
    const before = JSON.stringify(world.row());

    await expect(world.run(contractPlan())).rejects.toBeInstanceOf(ExecutionClaimError);

    expectNoWrites(world);
    expect(world.npi.getRequisition).not.toHaveBeenCalled();
    expect(JSON.stringify(world.row())).toBe(before);
    expect(world.updates).toHaveLength(0);
    expect(world.audit).toHaveLength(0);
  });

  it.each(['executing', 'done', 'failed', 'cancelled'] as const)('a job already %s is not executed again', async (status) => {
    const world = createWorld({ job: { status } });
    await expect(world.run(contractPlan())).rejects.toBeInstanceOf(ExecutionClaimError);
    expectNoWrites(world);
  });

  it('running the same approved job twice executes it once', async () => {
    const world = createWorld();
    const plan = contractPlan();

    await world.run(plan);
    await expect(world.run(plan)).rejects.toBeInstanceOf(ExecutionClaimError);

    for (const write of [world.npi.createCustomer, world.npi.createContract, world.npi.attachFile]) expect(write).toHaveBeenCalledTimes(1);
    expect(world.audit).toHaveLength(1);
    expect(world.row().status).toBe('done');
  });

  it('two runs started together: exactly one claims the job', async () => {
    const world = createWorld();
    const plan = contractPlan();

    const outcomes = await Promise.allSettled([world.run(plan), world.run(plan)]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ExecutionClaimError);
    expect(world.npi.createContract).toHaveBeenCalledTimes(1);
  });
});

describe('executeJob — pr', () => {
  it('creates the requisition, then submits that one; the entity belongs to the first step only', async () => {
    const world = createWorld({ job: { flowType: 'pr', documentId: null }, documents: [] });
    const plan = prPlan();
    expect(kindsOf(plan)).toEqual(['requisition_create', 'requisition_submit']);

    const result = await world.run(plan);

    expect(world.npi.order).toEqual(['createRequisition', 'submitRequisition']);
    expect(world.npi.createRequisition.mock.calls[0][0]).toMatchObject({
      justification: 'استكمال أعمال التركيب في المشروع',
      projectId: 'prj-12',
      lines: [{ itemId: 'itm-550', qty: 40, estimatedUnitPrice: 320 }],
    });
    expect(world.npi.submitRequisition).toHaveBeenCalledTimes(1);
    expect(world.npi.submitRequisition.mock.calls[0][0]).toBe('req-1');
    // No comment: the copilot adds nothing to the approval workflow.
    expect(world.npi.submitRequisition.mock.calls[0][1]).toBeUndefined();

    expect(result.status).toBe('done');
    const log = world.log();
    expect(log.steps).toEqual([
      { n: 1, labelAr: plan.steps[0].labelAr, state: 'done', entity: viewOf(entity('requisition', 'req-1', 'PR-00031', '/requisitions/req-1')) },
      { n: 2, labelAr: plan.steps[1].labelAr, state: 'done' },
    ]);
    expect(world.row().npiEntityRefs).toEqual([entity('requisition', 'req-1', 'PR-00031', '/requisitions/req-1')]);
  });

  it('the submission refused: the requisition exists (Draft) and is reported, the submit is not retried', async () => {
    const world = createWorld({ job: { flowType: 'pr', documentId: null }, documents: [] });
    world.npi.failNext('submitRequisition', new NpiError({ status: 409, kind: 'conflict', npiMessage: 'Requisition is not in DRAFT' }));

    const result = await world.run(prPlan());

    expect(result.status).toBe('failed');
    expect(world.npi.submitRequisition).toHaveBeenCalledTimes(1);
    expect(world.log().failedAt).toBe(2);
    expect(world.row().npiEntityRefs).toEqual([entity('requisition', 'req-1', 'PR-00031', '/requisitions/req-1')]);
  });
});

describe('executeJob — po', () => {
  const poJob = { flowType: 'po' as const, documentId: null };

  it('converting a requisition: reads its lines, then converts with the quote’s price keyed by the requisition line id', async () => {
    const world = createWorld({ job: poJob, documents: [] });
    const plan = convertPlan();
    expect(kindsOf(plan)).toEqual(['vendor_use', 'po_convert', 'manual']);

    const result = await world.run(plan);

    expect(world.npi.order).toEqual(['getRequisition', 'convertRequisition']);
    expect(world.npi.getRequisition).toHaveBeenCalledWith('req-12');
    expect(world.npi.convertRequisition).toHaveBeenCalledTimes(1);
    expect(world.npi.convertRequisition).toHaveBeenCalledWith('req-12', { vendorId: 'ven-1', prices: [{ requisitionLineId: 'prl-1', unitPrice: 320 }] });
    // The quote states no currency: none is sent.
    expect(world.npi.convertRequisition.mock.calls[0][1]).not.toHaveProperty('currency');

    expect(result.status).toBe('done');
    expect(world.log().steps).toEqual([
      { n: 1, labelAr: plan.steps[0].labelAr, state: 'done' },
      { n: 2, labelAr: plan.steps[1].labelAr, state: 'done', entity: viewOf(entity('purchase_order', 'po-9', 'PO-00009', '/procurement/po-9')) },
      { n: 3, labelAr: plan.steps[2].labelAr, state: 'manual' },
    ]);
    expect(world.row().npiEntityRefs).toEqual([entity('purchase_order', 'po-9', 'PO-00009', '/procurement/po-9')]);
  });

  it('a quote line whose item is not on the requisition fails the step before anything is converted', async () => {
    const world = createWorld({ job: poJob, documents: [] });
    // The requisition holds the panels only; the quote also prices an inverter.
    const plan = convertPlan([PANEL_LINE, INVERTER_LINE], [panelItem, inverterItem]);

    const result = await world.run(plan);

    expect(result.status).toBe('failed');
    expect(world.npi.getRequisition).toHaveBeenCalledTimes(1);
    expect(world.npi.convertRequisition).not.toHaveBeenCalled();
    const log = world.log();
    expect(log.failedAt).toBe(2);
    expect(log.steps[1]).toMatchObject({ state: 'failed', errorAr: t('exec.reason.requisition_line', { name: 'عاكس 50 كيلوواط', code: 'PR-00012' }) });
    expect(log.steps[2].state).toBe('pending');
    expect(world.row().npiEntityRefs).toEqual([]);
    expect(world.audit[0].event).toBe('intake_execution_failed');
  });

  it('creating the order with a vendor NPI does not have: the vendor first, then the order on that vendor', async () => {
    const world = createWorld({ job: poJob, documents: [] });
    const plan = newVendorPoPlan();
    expect(kindsOf(plan)).toEqual(['vendor_create', 'po_create', 'manual']);

    const result = await world.run(plan);

    expect(world.npi.order).toEqual(['createVendor', 'createPurchaseOrder']);
    expect(world.npi.createVendor.mock.calls[0][0]).toMatchObject({ nameAr: VENDOR, nameEn: 'Gulf Solar Panels Co.' });
    expect(world.npi.createPurchaseOrder.mock.calls[0][0]).toMatchObject({
      vendorId: 'ven-9',
      projectId: 'prj-12',
      lines: [{ itemId: 'itm-550', qty: 40, unitPrice: 320 }],
    });
    expect(world.npi.getRequisition).not.toHaveBeenCalled();

    expect(result.status).toBe('done');
    expect(world.row().npiEntityRefs).toEqual([
      entity('vendor', 'ven-9', 'VEN-00009', '/procurement'),
      entity('purchase_order', 'po-9', 'PO-00009', '/procurement/po-9'),
    ]);
  });

  it('the order refused after the vendor was created: the vendor is reported as created', async () => {
    const world = createWorld({ job: poJob, documents: [] });
    world.npi.failNext('createPurchaseOrder', forbidden());

    const result = await world.run(newVendorPoPlan());

    expect(result.status).toBe('failed');
    expect(world.npi.createVendor).toHaveBeenCalledTimes(1);
    expect(world.npi.createPurchaseOrder).toHaveBeenCalledTimes(1);
    expect(world.log().failedAt).toBe(2);
    expect(world.row().npiEntityRefs).toEqual([entity('vendor', 'ven-9', 'VEN-00009', '/procurement')]);
  });
});

describe('executeJob — grn', () => {
  it('receives on the matched PO with the PO line, the quantity, the serials and the delivery-note reference', async () => {
    const world = createWorld({ job: { flowType: 'grn', documentId: null }, documents: [] });
    const plan = grnPlan();

    const result = await world.run(plan);

    expect(world.npi.order).toEqual(['receiveOnPurchaseOrder']);
    expect(world.npi.receiveOnPurchaseOrder).toHaveBeenCalledTimes(1);
    const [poId, dto] = world.npi.receiveOnPurchaseOrder.mock.calls[0] as [string, { lines: unknown[]; notes?: string }];
    expect(poId).toBe('po-7');
    expect(dto.lines).toHaveLength(1);
    expect(dto.lines[0]).toMatchObject({ poLineId: 'pol-1', qty: 8, serials: SERIALS });
    expect(dto.notes).toContain('DN-4471');

    expect(result.status).toBe('done');
    expect(world.log().steps).toEqual([
      { n: 1, labelAr: plan.steps[0].labelAr, state: 'done', entity: viewOf(entity('goods_receipt', 'grn-5', 'GRN-00005', '/procurement/po-7')) },
      { n: 2, labelAr: plan.steps[1].labelAr, state: 'manual' },
    ]);
    expect(world.row().npiEntityRefs).toEqual([entity('goods_receipt', 'grn-5', 'GRN-00005', '/procurement/po-7')]);
  });

  it('NPI’s own reason is reported as it came (an over-receipt, for one)', async () => {
    const world = createWorld({ job: { flowType: 'grn', documentId: null }, documents: [] });
    const refusal = new NpiError({ status: 400, kind: 'validation', npiMessage: 'Quantity exceeds the open quantity of the PO line' });
    world.npi.failNext('receiveOnPurchaseOrder', refusal);

    const result = await world.run(grnPlan());

    expect(result.status).toBe('failed');
    expect(world.log().steps[0]).toMatchObject({ state: 'failed', errorAr: refusal.messageAr });
    expect(refusal.messageAr).toContain('Quantity exceeds the open quantity of the PO line');
    expect(world.log().steps[1].state).toBe('pending');
  });
});

describe('executeJob — vendor_bill', () => {
  it('records the bill on the chosen receipt with the invoice number; the entity links to the PO', async () => {
    const world = createWorld({ job: { flowType: 'vendor_bill', documentId: null }, documents: [] });
    const plan = billPlan();

    const result = await world.run(plan);

    expect(world.npi.order).toEqual(['createBill']);
    expect(world.npi.createBill).toHaveBeenCalledTimes(1);
    expect(world.npi.createBill).toHaveBeenCalledWith({ goodsReceiptId: 'grn-1', vendorRef: 'INV-7781' });

    expect(result.status).toBe('done');
    expect(world.log().steps).toEqual([
      { n: 1, labelAr: plan.steps[0].labelAr, state: 'done', entity: viewOf(entity('vendor_bill', 'bill-4', 'VB-00004', '/procurement/po-7')) },
      { n: 2, labelAr: plan.steps[1].labelAr, state: 'manual' },
    ]);
    expect(world.row().npiEntityRefs).toEqual([entity('vendor_bill', 'bill-4', 'VB-00004', '/procurement/po-7')]);
  });

  it('a bill with no known PO has no page to link', async () => {
    const world = createWorld({ job: { flowType: 'vendor_bill', documentId: null }, documents: [] });
    const plan = planOf('vendor_bill', {
      values: billValues(),
      resolution: res('vendor_bill', { vendor: { kind: 'new' }, goodsReceipt: { kind: 'matched', id: 'grn-3', labelAr: 'GRN-00003', by: 'code' } }),
    });

    await world.run(plan);

    expect(world.log().steps[0].entity).toMatchObject({ kindAr: t('exec.kind.vendor_bill'), npiPath: null });
  });
});

describe('executeJob — the audit row never decides the outcome', () => {
  it('a failing audit write leaves the job done and is only logged', async () => {
    const world = createWorld();
    world.auditFailure.error = new Error('audit table unavailable');

    const result = await world.run(contractPlan());

    expect(result.status).toBe('done');
    expect(world.row().status).toBe('done');
    expect(world.log().status).toBe('done');
    expect(world.deps.db.llmAudit.create).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('the same for a failed execution: it stays failed and the audit failure does not replace it', async () => {
    const world = createWorld();
    world.auditFailure.error = new Error('audit table unavailable');
    world.npi.failNext('createContract', forbidden());

    const result = await world.run(contractPlan());

    expect(result.status).toBe('failed');
    expect(world.log().failedAt).toBe(2);
    expect(errorSpy).toHaveBeenCalled();
  });
});
