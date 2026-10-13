// T-26: the preview model (src/intake/preview.ts) and its labels
// (src/intake/labels.ts) — pure functions, no database, no model.
//
// The wire outputs below are what the models return (`f()` / `none()` as in
// the extraction specs), pushed through the flow's own `assess*`; the preview
// is then built from the assessed tree exactly as `startIntake` does.
import { ar, t } from '../src/i18n/ar';
import { flattenFields } from '../src/extract/run';
import { assessCustomerContract, type CustomerContractOutput } from '../src/extract/schemas/customer_contract';
import { assessGrn, type GrnLineOutput, type GrnOutput } from '../src/extract/schemas/grn';
import { assessPo, type PoLineOutput, type PoOutput, type VendorOutput } from '../src/extract/schemas/po';
import { assessPr, type PrLineOutput, type PrOutput } from '../src/extract/schemas/pr';
import { assessVendorBill, type BillLineOutput, type VendorBillOutput } from '../src/extract/schemas/vendor_bill';
import { assessUserPermissions, type UserPermissionsOutput } from '../src/extract/schemas/user_permissions';
import type { FlowType } from '../src/agents/router';
import {
  fieldKind,
  fieldLabelKey,
  isRequired,
  LINE_ARRAY,
  normalizePath,
  REQUIRED_PATHS,
} from '../src/intake/labels';
import { buildPreview, CONFIRMABLE_WARNINGS, previewSteps, type BuildPreviewInput } from '../src/intake/preview';
import { resolutionBlockers } from '../src/intake/resolution';
import type { EntityPick, FlowResolution, PreviewField, PreviewModel } from '../src/intake/types';

// ─── wire helpers ───────────────────────────────────────────────────────────

type W = { value: string; confidence: number; evidence: string; page: number };
const f = (value: string | number | null, confidence = 1, evidence: string | null = 'q', page: number | null = 1): W => ({
  value: value === null ? '' : String(value),
  confidence,
  evidence: evidence ?? '',
  page: page ?? 0,
});
const none = (): W => ({ value: '', confidence: 0, evidence: '', page: 0 });

const FLAGS = { ligatureSuspect: false, referenceDate: '2026-10-05' };
const CUSTOMER = 'شركة النخيل للمقاولات';
const VENDOR = 'شركة الخليج للألواح الشمسية';

// ── customer_contract ──

function contractOutput(overrides: Partial<CustomerContractOutput> = {}, customer: Partial<CustomerContractOutput['customer']> = {}): CustomerContractOutput {
  return {
    customer: {
      nameAr: f(CUSTOMER),
      nameEn: f('Al Nakheel Contracting'),
      customerType: f('CI'),
      vatNumber: f('310123456700003'),
      crNumber: f('1010567890'),
      phone: f('0501234567'),
      email: f('info@nakheel.sa'),
      ...customer,
    },
    contractType: f('EPC'),
    startDate: f('2026-11-01'),
    endDate: f('2027-04-30'),
    totalValue: f(850000),
    retentionPct: f(10),
    advancePct: none(),
    milestones: [
      { sequence: f(1), descriptionAr: f('دفعة مقدمة عند التوقيع'), descriptionEn: none(), amount: f(255000), percent: f(30), dueDate: none(), triggerType: f('EVENT') },
      { sequence: f(2), descriptionAr: f('عند اكتمال التوريد'), descriptionEn: none(), amount: f(340000), percent: f(40), dueDate: none(), triggerType: f('EVENT') },
      { sequence: f(3), descriptionAr: f('عند التشغيل والتسليم'), descriptionEn: none(), amount: f(255000), percent: f(30), dueDate: none(), triggerType: f('EVENT') },
    ],
    ...overrides,
  };
}

// ── pr ──

function prLine(overrides: Partial<PrLineOutput> = {}): PrLineOutput {
  return {
    itemName: f('لوح 550 واط'),
    sku: f('MOD-550'),
    qty: f(40),
    unit: none(),
    estimatedUnitPrice: none(),
    wbsCode: none(),
    wbsName: none(),
    notes: none(),
    ...overrides,
  };
}

function prOutput(overrides: Partial<PrOutput> = {}): PrOutput {
  return {
    justification: f('استكمال أعمال التركيب في المشروع', 0.9),
    projectCode: f('PRJ-00012'),
    projectName: none(),
    departmentName: none(),
    neededBy: f('2026-10-08', 0.9),
    currency: none(),
    lines: [prLine()],
    ...overrides,
  };
}

// ── po ──

function vendorOutput(overrides: Partial<VendorOutput> = {}): VendorOutput {
  return {
    nameAr: f(VENDOR),
    nameEn: f('Gulf Solar Panels Co.'),
    vendorType: f('SUPPLIER'),
    vatNumber: f('311111111111113'),
    crNumber: f('1010111222'),
    phone: f('+966501111111'),
    email: f('sales@gulfsolar.sa'),
    ...overrides,
  };
}

function poLine(overrides: Partial<PoLineOutput> = {}): PoLineOutput {
  return {
    itemName: f('لوح شمسي 550 واط'),
    sku: f('MOD-550'),
    qty: f(40),
    unit: f('قطعة'),
    unitPrice: f(320),
    lineTotal: f(12800),
    wbsCode: none(),
    wbsName: none(),
    ...overrides,
  };
}

function poOutput(overrides: Partial<PoOutput> = {}): PoOutput {
  return {
    vendor: vendorOutput(),
    quoteRef: f('Q-2026-117'),
    quoteDate: f('2026-10-01'),
    validUntil: f('2026-10-31'),
    sourceRequisitionCode: f('PR-00012'),
    projectCode: f('PRJ-00012'),
    projectName: f('محطة الرياض الشمسية'),
    currency: none(),
    subtotal: f(21460),
    vatAmount: f(3219),
    total: f(24679),
    lines: [
      poLine(),
      poLine({ itemName: f('عاكس 50 كيلوواط'), sku: f('INV-50K'), qty: f(1), unitPrice: f(6500), lineTotal: f(6500) }),
      poLine({ itemName: f('قضيب تثبيت'), sku: f('MNT-RAIL'), qty: f(120), unit: f('متر'), unitPrice: f(18), lineTotal: f(2160) }),
    ],
    ...overrides,
  };
}

// ── grn ──

const serialList = (prefix: string, from: number, n: number): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}-${String(from + i).padStart(4, '0')}`);

function grnLine(overrides: Partial<GrnLineOutput> = {}): GrnLineOutput {
  return {
    itemName: f('لوح شمسي 550 واط'),
    sku: f('MOD-550'),
    qty: f(8),
    unit: f('قطعة'),
    serials: f(serialList('GS550-2609', 1, 8).join(';')),
    batchNo: none(),
    notes: none(),
    ...overrides,
  };
}

function grnOutput(overrides: Partial<GrnOutput> = {}): GrnOutput {
  return {
    purchaseOrderCode: f('PO-00007'),
    deliveryNoteRef: f('DN-4471'),
    deliveryDate: f('2026-10-04'),
    vendorName: f(VENDOR),
    projectCode: f('PRJ-00012'),
    locationName: f('مستودع الرياض'),
    notes: none(),
    lines: [grnLine(), grnLine({ itemName: f('قضيب تثبيت'), sku: f('MNT-RAIL'), qty: f(120), unit: f('متر'), serials: none() })],
    ...overrides,
  };
}

// ── vendor_bill ──

function billLine(overrides: Partial<BillLineOutput> = {}): BillLineOutput {
  return {
    itemName: f('لوح شمسي 550 واط'),
    sku: f('MOD-550'),
    qty: f(40),
    unit: f('قطعة'),
    unitPrice: f(320),
    lineTotal: f(12800),
    ...overrides,
  };
}

function billOutput(overrides: Partial<VendorBillOutput> = {}): VendorBillOutput {
  return {
    vendor: vendorOutput(),
    invoiceNumber: f('INV-2026-0912'),
    invoiceDate: f('2026-10-05'),
    dueDate: f('2026-11-04'),
    purchaseOrderCode: f('PO-00007'),
    goodsReceiptCode: f('GRN-00003'),
    deliveryNoteRef: f('DN-4471'),
    projectCode: f('PRJ-00012'),
    currency: none(),
    subtotal: f(21460),
    vatAmount: f(3219),
    total: f(24679),
    lines: [
      billLine(),
      billLine({ itemName: f('عاكس 50 كيلوواط'), sku: f('INV-50K'), qty: f(1), unitPrice: f(6500), lineTotal: f(6500) }),
      billLine({ itemName: f('قضيب تثبيت'), sku: f('MNT-RAIL'), qty: f(120), unit: f('متر'), unitPrice: f(18), lineTotal: f(2160) }),
    ],
    ...overrides,
  };
}

/** Every member «not stated»: the tree has all its leaves, none with a value. */
function permissionsOutput(overrides: Partial<UserPermissionsOutput> = {}): UserPermissionsOutput {
  return { userName: f('أحمد'), action: f('revoke'), permissions: [{ name: f('التقارير المالية') }], reason: f('انتقل إلى قسم آخر'), ...overrides };
}

function emptyOf<T>(full: T): T {
  const blank = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.slice(0, 1).map(blank);
    if (node !== null && typeof node === 'object') {
      const o = node as Record<string, unknown>;
      if ('value' in o && 'confidence' in o && 'evidence' in o && 'page' in o) return none();
      return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, blank(v)]));
    }
    return node;
  };
  return blank(full) as T;
}

// ─── preview helpers ────────────────────────────────────────────────────────

const allFields = (model: PreviewModel): PreviewField[] => [
  ...model.sections.flatMap((s) => s.fields),
  ...(model.lines?.rows.flatMap((r) => r.fields) ?? []),
];
const fieldAt = (model: PreviewModel, path: string): PreviewField => {
  const found = allFields(model).find((x) => x.path === path);
  if (!found) throw new Error(`no field ${path} in the preview`);
  return found;
};

const customerMatched: FlowResolution = {
  flow: 'customer_contract',
  customer: { kind: 'matched', id: 'cus-1', labelAr: CUSTOMER, by: 'vat' },
  lines: [],
  warnings: [],
  notesAr: [t('preview.customer_match', { name: CUSTOMER })],
};

function contractPreview(out: CustomerContractOutput, extra: Partial<BuildPreviewInput> = {}) {
  const { assessed, values } = assessCustomerContract(out, FLAGS);
  return buildPreview({
    flow: 'customer_contract',
    assessed,
    values,
    resolution: values ? customerMatched : null,
    choices: {},
    confirmed: [],
    hasDocument: false,
    ...extra,
  });
}

function prResolution(overrides: Partial<FlowResolution> = {}): FlowResolution {
  return { flow: 'pr', lines: [{ warnings: [] }], warnings: [], notesAr: [], ...overrides };
}

// ─── 1. labels ──────────────────────────────────────────────────────────────

describe('labels: every assessed path has an Arabic label', () => {
  const flows: [FlowType, () => { assessed: unknown }, () => { assessed: unknown }][] = [
    ['customer_contract', () => assessCustomerContract(contractOutput(), FLAGS), () => assessCustomerContract(emptyOf(contractOutput()), FLAGS)],
    ['pr', () => assessPr(prOutput(), FLAGS), () => assessPr(emptyOf(prOutput()), FLAGS)],
    ['po', () => assessPo(poOutput(), FLAGS), () => assessPo(emptyOf(poOutput()), FLAGS)],
    ['grn', () => assessGrn(grnOutput(), FLAGS), () => assessGrn(emptyOf(grnOutput()), FLAGS)],
    ['vendor_bill', () => assessVendorBill(billOutput(), FLAGS), () => assessVendorBill(emptyOf(billOutput()), FLAGS)],
    ['user_permissions', () => assessUserPermissions(permissionsOutput(), FLAGS), () => assessUserPermissions(emptyOf(permissionsOutput()), FLAGS)],
  ];

  it.each(flows)('%s: a full and an empty output expose only labelled paths', (_flow, full, empty) => {
    for (const build of [full, empty]) {
      const paths = Object.keys(flattenFields(build().assessed));
      expect(paths.length).toBeGreaterThan(3);
      for (const path of paths) {
        const key = fieldLabelKey(path);
        expect(Object.prototype.hasOwnProperty.call(ar, key)).toBe(true);
        expect(t(key).length).toBeGreaterThan(0);
      }
    }
  });

  it('normalizePath drops line indexes only', () => {
    expect(normalizePath('lines.0.qty')).toBe('lines.qty');
    expect(normalizePath('lines.12.serials')).toBe('lines.serials');
    expect(normalizePath('milestones.2.amount')).toBe('milestones.amount');
    expect(normalizePath('customer.nameAr')).toBe('customer.nameAr');
    expect(normalizePath('totalValue')).toBe('totalValue');
  });

  it('fieldLabelKey maps to the preview.f block and fails loudly for a path nobody labelled', () => {
    expect(fieldLabelKey('lines.3.qty')).toBe('preview.f.lines.qty');
    expect(fieldLabelKey('customer.vatNumber')).toBe('preview.f.customer.vatNumber');
    expect(() => fieldLabelKey('brandNewField')).toThrow();
    expect(() => fieldLabelKey('lines.0.brandNew')).toThrow();
  });

  it('every flow names its line array', () => {
    expect(LINE_ARRAY).toEqual({ customer_contract: 'milestones', pr: 'lines', po: 'lines', grn: 'lines', vendor_bill: 'lines', user_permissions: 'permissions' });
  });
});

describe('fieldKind', () => {
  it.each<[FlowType, string, string]>([
    ['grn', 'lines.0.serials', 'serials'],
    ['customer_contract', 'totalValue', 'amount'],
    ['customer_contract', 'milestones.1.amount', 'amount'],
    ['po', 'lines.2.unitPrice', 'amount'],
    ['po', 'subtotal', 'amount'],
    ['vendor_bill', 'vatAmount', 'amount'],
    ['customer_contract', 'retentionPct', 'number'],
    ['customer_contract', 'milestones.0.percent', 'number'],
    ['pr', 'lines.0.qty', 'number'],
    ['customer_contract', 'startDate', 'date'],
    ['customer_contract', 'milestones.0.dueDate', 'date'],
    ['pr', 'neededBy', 'date'],
    ['grn', 'deliveryDate', 'date'],
    ['pr', 'projectCode', 'code'],
    ['grn', 'purchaseOrderCode', 'code'],
    ['vendor_bill', 'goodsReceiptCode', 'code'],
    ['pr', 'lines.0.sku', 'code'],
    ['customer_contract', 'contractType', 'enum'],
    ['customer_contract', 'customer.customerType', 'enum'],
    ['po', 'vendor.vendorType', 'enum'],
    ['customer_contract', 'milestones.0.triggerType', 'enum'],
    ['customer_contract', 'customer.nameAr', 'text'],
    ['pr', 'justification', 'text'],
    ['grn', 'lines.0.itemName', 'text'],
  ])('%s %s is %s', (flow, path, kind) => {
    expect(fieldKind(flow, path)).toBe(kind);
  });
});

describe('isRequired (D-T26-7)', () => {
  it.each<[FlowType, string, boolean]>([
    ['customer_contract', 'customer.nameAr', true],
    ['customer_contract', 'contractType', true],
    ['customer_contract', 'totalValue', false],
    ['customer_contract', 'customer.vatNumber', false],
    ['pr', 'justification', true],
    ['pr', 'lines.0.itemName', true],
    ['pr', 'lines.4.qty', true],
    ['pr', 'lines.0.sku', false],
    ['pr', 'projectCode', false],
    ['po', 'vendor.nameAr', true],
    ['po', 'lines.1.unitPrice', true],
    ['po', 'lines.1.itemName', true],
    ['po', 'sourceRequisitionCode', false],
    ['grn', 'purchaseOrderCode', true],
    ['grn', 'lines.0.qty', true],
    ['grn', 'lines.0.serials', false],
    ['vendor_bill', 'vendor.nameAr', false],
    ['vendor_bill', 'invoiceNumber', false],
    ['vendor_bill', 'lines.0.itemName', false],
  ])('%s %s -> %s', (flow, path, expected) => {
    expect(isRequired(flow, path)).toBe(expected);
  });

  it('REQUIRED_PATHS uses * for line indexes and vendor_bill requires nothing at field level', () => {
    expect(REQUIRED_PATHS.vendor_bill).toEqual([]);
    expect(REQUIRED_PATHS.pr).toEqual(expect.arrayContaining(['justification', 'lines.*.itemName', 'lines.*.qty']));
    expect(REQUIRED_PATHS.customer_contract).toEqual(expect.arrayContaining(['customer.nameAr', 'contractType']));
  });
});

describe('CONFIRMABLE_WARNINGS (D-T26-5)', () => {
  it('holds the vouch-for-able warnings and none of the NPI-rule failures', () => {
    for (const w of ['low_confidence', 'ligature', 'derived', 'date_past', 'date_future', 'line_total', 'lines_sum', 'vat_total', 'amount', 'milestones_sum', 'milestones_sequence', 'serials_count', 'bill_total_mismatch']) {
      expect(CONFIRMABLE_WARNINGS.has(`extract.warn.${w}` as never)).toBe(true);
    }
    for (const w of ['missing', 'placeholder', 'vat_format', 'cr_format', 'date_format', 'date_order', 'percent', 'enum', 'email_format', 'quantity', 'currency', 'code_format', 'serials_duplicate', 'over_receipt', 'serials_required', 'po_not_receivable', 'grn_not_accepted', 'grn_billed']) {
      expect(CONFIRMABLE_WARNINGS.has(`extract.warn.${w}` as never)).toBe(false);
    }
  });
});

// ─── 2. a clean contract ────────────────────────────────────────────────────

describe('buildPreview — a clean customer contract', () => {
  const { assessed, values } = assessCustomerContract(contractOutput(), FLAGS);
  const leaves = Object.keys(flattenFields(assessed));

  it('lays the fields out in Arabic sections and one row per milestone', () => {
    const { model } = contractPreview(contractOutput());
    expect(model.flow).toBe('customer_contract');
    expect(model.flowLabelAr).toBe(t('flow.customer_contract'));
    expect(model.sections.map((s) => s.key)).toEqual(['customer', 'contract']);
    expect(model.sections.map((s) => s.titleAr)).toEqual([t('preview.section.customer'), t('preview.section.contract')]);
    expect(model.sections[0].fields.map((x) => x.path)).toEqual(expect.arrayContaining(['customer.nameAr', 'customer.vatNumber']));
    expect(model.sections[1].fields.map((x) => x.path)).toEqual(
      expect.arrayContaining(['contractType', 'startDate', 'endDate', 'totalValue', 'retentionPct', 'advancePct']),
    );

    expect(model.lines?.titleAr).toBe(t('preview.lines.milestones'));
    expect(model.lines?.rows).toHaveLength(3);
    expect(model.lines?.rows.map((r) => r.titleAr)).toEqual([1, 2, 3].map((n) => t('preview.milestone_title', { n })));
    expect(model.lines?.rows[1].fields.map((x) => x.path)).toEqual(expect.arrayContaining(['milestones.1.amount', 'milestones.1.percent']));
  });

  it('shows labels from the table, every stated field confirmed, the rest not stated', () => {
    const { model, fields } = contractPreview(contractOutput());
    expect(fieldAt(model, 'customer.nameAr').labelAr).toBe(t('preview.f.customer.nameAr'));
    expect(fieldAt(model, 'milestones.2.amount').labelAr).toBe(t('preview.f.milestones.amount'));
    for (const field of allFields(model)) {
      if (field.value !== null) expect(field.status).toBe('confirmed');
      else expect(field.displayAr).toBe(t('preview.empty_value'));
    }
    expect(Object.keys(fields).sort()).toEqual([...leaves].sort());
  });

  it('carries evidence and page, requiredness and editability', () => {
    const { model } = contractPreview(contractOutput());
    const total = fieldAt(model, 'totalValue');
    expect(total).toMatchObject({ value: 850000, evidence: 'q', page: 1, confidence: 1, editable: true, required: false, kind: 'amount' });
    expect(fieldAt(model, 'customer.nameAr')).toMatchObject({ required: true, kind: 'text' });
    expect(fieldAt(model, 'contractType').required).toBe(true);
  });

  it('formats for the eye: amounts to two decimals, enums in Arabic, dates ISO, nothing as «—»', () => {
    const { model } = contractPreview(contractOutput());
    expect(fieldAt(model, 'totalValue').displayAr).toBe('850,000.00');
    expect(fieldAt(model, 'milestones.0.amount').displayAr).toBe('255,000.00');
    expect(fieldAt(model, 'contractType').displayAr).toBe('تصميم وتوريد وتركيب');
    expect(fieldAt(model, 'customer.customerType').displayAr).toBe(t('preview.enum.CI'));
    expect(fieldAt(model, 'milestones.0.triggerType').displayAr).toBe(t('preview.enum.EVENT'));
    expect(fieldAt(model, 'retentionPct').displayAr).toBe('10');
    expect(fieldAt(model, 'startDate').displayAr).toBe('2026-11-01');
    expect(fieldAt(model, 'advancePct').displayAr).toBe(t('preview.empty_value'));
    expect(fieldAt(model, 'advancePct').displayAr).toBe('—');
  });

  it('offers the matched customer or a new one, defaulting to the match', () => {
    const { model } = contractPreview(contractOutput());
    expect(model.choices).toEqual([
      {
        target: 'customer',
        promptAr: t('preview.customer_match', { name: CUSTOMER }),
        options: [
          { id: 'cus-1', labelAr: CUSTOMER },
          { id: 'new', labelAr: t('preview.option_new') },
        ],
        chosen: 'cus-1',
      },
    ]);
    expect(model.notesAr).toEqual([t('preview.customer_match', { name: CUSTOMER })]);
  });

  it('describes what will run: use the customer, create the contract, activate in NPI', () => {
    const { model } = contractPreview(contractOutput());
    expect(model.steps.map((s) => s.n)).toEqual([1, 2, 3]);
    expect(model.steps[0].labelAr).toBe(t('preview.step.customer_use', { name: CUSTOMER }));
    expect(model.steps[1].labelAr).toContain('850,000');
    expect(model.steps[1].labelAr).toContain('3');
    expect(model.steps[2].labelAr).toBe(t('preview.step.contract_activate_manual'));
  });

  it('adds the attach step between create and activate only when a document exists', () => {
    const { model } = contractPreview(contractOutput(), { hasDocument: true });
    expect(model.steps).toHaveLength(4);
    expect(model.steps[2].labelAr).toBe(t('preview.step.attach'));
    expect(model.steps[3].labelAr).toBe(t('preview.step.contract_activate_manual'));
    expect(model.steps.map((s) => s.n)).toEqual([1, 2, 3, 4]);
  });

  it('can be approved, with the summary counting the leaves that carry a value or are required', () => {
    const { model } = contractPreview(contractOutput());
    expect(model.canApprove).toBe(true);
    expect(model.blockersAr).toEqual([]);
    expect(model.incompleteAr).toBeNull();
    const counted = Object.entries(flattenFields(assessed)).filter(
      ([p, f]) => f.value !== null || ['customer.nameAr', 'contractType'].includes(p),
    ).length;
    expect(counted).toBeLessThan(leaves.length);
    expect(model.summary.total).toBe(counted);
    expect(model.summary.confirmed + model.summary.unconfirmed).toBe(model.summary.total);
    expect(values).not.toBeNull();
  });
});

// ─── 3. blockers ────────────────────────────────────────────────────────────

describe('buildPreview — what blocks «اعتمد»', () => {
  it('an unconfirmed value blocks until the user vouches for it', () => {
    const low = contractOutput({ totalValue: f(850000, 0.5, 'القيمة 850,000 ريال', 2) });
    const blocked = contractPreview(low).model;
    const total = fieldAt(blocked, 'totalValue');
    expect(total.status).toBe('unconfirmed');
    expect(total.confirmable).toBe(true);
    expect(total.warningsAr).toEqual([t('extract.warn.low_confidence')]);
    expect(total.evidence).toBe('القيمة 850,000 ريال');
    expect(total.page).toBe(2);
    expect(blocked.blockersAr).toContain(t('preview.block.unconfirmed', { n: 1 }));
    expect(blocked.canApprove).toBe(false);

    const vouched = contractPreview(low, { confirmed: ['totalValue'] }).model;
    const after = fieldAt(vouched, 'totalValue');
    expect(after.status).toBe('confirmed');
    expect(after.confidence).toBe(1);
    expect(after.warningsAr).toEqual([]);
    expect(vouched.blockersAr).toEqual([]);
    expect(vouched.canApprove).toBe(true);
    expect(vouched.summary.confirmed).toBe(blocked.summary.confirmed + 1);
    expect(vouched.summary.unconfirmed).toBe(blocked.summary.unconfirmed - 1);
  });

  it('a field NPI would reject cannot be vouched for, only replaced', () => {
    const bad = contractOutput({}, { vatNumber: f('31012345670003') });
    const first = contractPreview(bad).model;
    const vat = fieldAt(first, 'customer.vatNumber');
    expect(vat.status).toBe('unconfirmed');
    expect(vat.confirmable).toBe(false);
    expect(vat.warningsAr).toEqual([t('extract.warn.vat_format')]);
    expect(first.canApprove).toBe(false);

    const forced = contractPreview(bad, { confirmed: ['customer.vatNumber'] }).model;
    expect(fieldAt(forced, 'customer.vatNumber').status).toBe('unconfirmed');
    expect(forced.canApprove).toBe(false);
  });

  it('a missing optional field does not block', () => {
    const { model } = contractPreview(contractOutput({ retentionPct: none(), startDate: none() }));
    expect(fieldAt(model, 'retentionPct').value).toBeNull();
    expect(fieldAt(model, 'retentionPct').status).toBe('unconfirmed');
    expect(model.canApprove).toBe(true);
  });

  it('no usable values: the incomplete message and the blocker, every found field still shown', () => {
    const { assessed, values } = assessCustomerContract(contractOutput({}, { nameAr: none() }), FLAGS);
    expect(values).toBeNull();
    const { model } = buildPreview({ flow: 'customer_contract', assessed, values, resolution: null, choices: {}, confirmed: [], hasDocument: false });
    expect(model.incompleteAr).toBe(t('extract.incomplete'));
    expect(model.blockersAr).toContain(t('preview.block.incomplete'));
    expect(model.canApprove).toBe(false);
    expect(fieldAt(model, 'totalValue').displayAr).toBe('850,000.00');
    expect(model.choices).toEqual([]);
  });

  it('the incomplete message is the flow’s own', () => {
    const { assessed, values } = assessGrn(grnOutput({ lines: [] }), FLAGS);
    expect(values).toBeNull();
    const { model } = buildPreview({ flow: 'grn', assessed, values, resolution: null, choices: {}, confirmed: [], hasDocument: false });
    expect(model.incompleteAr).toBe(t('extract.incomplete.grn'));
    expect(model.canApprove).toBe(false);
  });

  it('a required value that is missing names its label', () => {
    const { assessed, values } = assessPr(prOutput({ justification: none() }), FLAGS);
    expect(values).not.toBeNull();
    const { model } = buildPreview({ flow: 'pr', assessed, values, resolution: prResolution(), choices: {}, confirmed: [], hasDocument: false });
    expect(fieldAt(model, 'justification')).toMatchObject({ value: null, required: true });
    expect(model.blockersAr).toContain(t('preview.block.required', { fields: 'سبب الطلب' }));
    expect(model.incompleteAr).toBeNull();
    expect(model.canApprove).toBe(false);
  });

  it('an undecided choice blocks; deciding clears it and changes the steps', () => {
    const candidates: FlowResolution = {
      flow: 'customer_contract',
      customer: {
        kind: 'candidates',
        candidates: [
          { id: 'cus-1', labelAr: CUSTOMER, similarity: 0.62 },
          { id: 'cus-2', labelAr: 'النخيل للتجارة', similarity: 0.41 },
        ],
      },
      lines: [],
      warnings: [],
      notesAr: [],
    };
    const undecided = contractPreview(contractOutput(), { resolution: candidates }).model;
    expect(undecided.choices).toEqual([
      {
        target: 'customer',
        promptAr: t('preview.customer_choose'),
        options: [
          { id: 'cus-1', labelAr: CUSTOMER },
          { id: 'cus-2', labelAr: 'النخيل للتجارة' },
          { id: 'new', labelAr: t('preview.option_new') },
        ],
        chosen: null,
      },
    ]);
    expect(undecided.blockersAr).toContain(t('preview.block.choice'));
    expect(undecided.canApprove).toBe(false);

    const picked = contractPreview(contractOutput(), { resolution: candidates, choices: { customer: 'cus-2' } }).model;
    expect(picked.choices[0].chosen).toBe('cus-2');
    expect(picked.blockersAr).not.toContain(t('preview.block.choice'));
    expect(picked.canApprove).toBe(true);
    expect(picked.steps[0].labelAr).toBe(t('preview.step.customer_use', { name: 'النخيل للتجارة' }));

    const asNew = contractPreview(contractOutput(), { resolution: candidates, choices: { customer: 'new' } }).model;
    expect(asNew.steps[0].labelAr).toBe(t('preview.step.customer_new', { name: CUSTOMER }));
  });

  it('choosing «new» over a match makes the first step a creation', () => {
    const { model } = contractPreview(contractOutput(), { choices: { customer: 'new' } });
    expect(model.choices[0].chosen).toBe('new');
    expect(model.steps[0].labelAr).toBe(t('preview.step.customer_new', { name: CUSTOMER }));
    expect(model.canApprove).toBe(true);
  });

  it('a customer NPI does not have is simply created, with no question to answer', () => {
    const { model } = contractPreview(contractOutput(), {
      resolution: { ...customerMatched, customer: { kind: 'new' }, notesAr: [t('preview.customer_new')] },
    });
    expect(model.choices).toEqual([]);
    expect(model.notesAr).toEqual([t('preview.customer_new')]);
    expect(model.steps[0].labelAr).toBe(t('preview.step.customer_new', { name: CUSTOMER }));
    expect(model.canApprove).toBe(true);
  });

  it('notes are shown once each', () => {
    const { model } = contractPreview(contractOutput(), {
      resolution: { ...customerMatched, notesAr: ['أ', 'ب', 'أ'] },
    });
    expect(model.notesAr).toEqual(['أ', 'ب']);
  });
});

// ─── 4. resolution warnings land on the right field ─────────────────────────

describe('buildPreview — warnings from the resolution', () => {
  const poMatched = { kind: 'matched', id: 'po-7', labelAr: `PO-00007 — ${VENDOR}`, by: 'code', status: 'DRAFT', receivable: false } as const;

  it('a PO that cannot receive goods and a serialised line without serials stay unconfirmed and unvouchable', () => {
    const out = grnOutput({ lines: [grnLine({ serials: none() }), grnLine({ itemName: f('قضيب تثبيت'), sku: f('MNT-RAIL'), qty: f(120), serials: none() })] });
    const { assessed, values } = assessGrn(out, FLAGS);
    const resolution: FlowResolution = {
      flow: 'grn',
      purchaseOrder: poMatched,
      lines: [{ warnings: [{ field: 'serials', warning: 'extract.warn.serials_required' }] }, { warnings: [] }],
      warnings: [{ path: 'purchaseOrderCode', warning: 'extract.warn.po_not_receivable' }],
      notesAr: [],
    };
    const { model, fields } = buildPreview({ flow: 'grn', assessed, values, resolution, choices: {}, confirmed: [], hasDocument: false });

    const po = fieldAt(model, 'purchaseOrderCode');
    expect(po.status).toBe('unconfirmed');
    expect(po.confirmable).toBe(false);
    expect(po.warningsAr).toEqual([t('extract.warn.po_not_receivable')]);
    expect(fields.purchaseOrderCode.warnings).toEqual(['extract.warn.po_not_receivable']);

    const serials = fieldAt(model, 'lines.0.serials');
    expect(serials.status).toBe('unconfirmed');
    expect(serials.confirmable).toBe(false);
    expect(serials.warningsAr).toContain(t('extract.warn.serials_required'));
    expect(fieldAt(model, 'lines.1.serials').warningsAr).not.toContain(t('extract.warn.serials_required'));

    // Vouching for either does nothing.
    const forced = buildPreview({
      flow: 'grn', assessed, values, resolution, choices: {}, hasDocument: false,
      confirmed: ['purchaseOrderCode', 'lines.0.serials'],
    }).model;
    expect(fieldAt(forced, 'purchaseOrderCode').status).toBe('unconfirmed');
    expect(fieldAt(forced, 'lines.0.serials').status).toBe('unconfirmed');
    expect(forced.canApprove).toBe(false);
  });

  it('a dropped line stays visible with its quantity warning, and the resolution maps to the usable lines', () => {
    const out = grnOutput({
      lines: [
        grnLine({ serials: none() }),
        grnLine({ itemName: f('كابل نحاس'), sku: f('CBL-6'), qty: f(0), serials: none() }),
        grnLine({ itemName: f('قضيب تثبيت'), sku: f('MNT-RAIL'), qty: f(120), serials: none() }),
      ],
    });
    const { assessed, values } = assessGrn(out, FLAGS);
    expect(values?.lines).toHaveLength(2);

    const resolution: FlowResolution = {
      flow: 'grn',
      purchaseOrder: { ...poMatched, status: 'SENT', receivable: true },
      lines: [{ warnings: [] }, { warnings: [{ field: 'qty', warning: 'extract.warn.over_receipt' }] }],
      warnings: [],
      notesAr: [],
    };
    const { model } = buildPreview({ flow: 'grn', assessed, values, resolution, choices: {}, confirmed: [], hasDocument: false });

    expect(model.lines?.rows).toHaveLength(3);
    expect(model.lines?.titleAr).toBe(t('preview.lines.received'));
    expect(fieldAt(model, 'lines.1.qty').warningsAr).toContain(t('extract.warn.quantity'));
    expect(fieldAt(model, 'lines.1.qty').status).toBe('unconfirmed');
    // The second usable line is the third assessed one.
    expect(fieldAt(model, 'lines.2.qty').warningsAr).toEqual([t('extract.warn.over_receipt')]);
    expect(fieldAt(model, 'lines.0.qty').warningsAr).toEqual([]);
    expect(fieldAt(model, 'lines.1.qty').warningsAr).not.toContain(t('extract.warn.over_receipt'));
  });

  it('resolution blockers come back as «لا يمكن التنفيذ» entries (po missing, no receipt, no PO line)', () => {
    const grn = assessGrn(grnOutput(), FLAGS);
    const noPo: FlowResolution = {
      flow: 'grn',
      purchaseOrder: { kind: 'none' },
      lines: [{ poLine: { kind: 'none' }, warnings: [] }, { warnings: [] }],
      warnings: [],
      notesAr: [t('preview.po_none', { code: 'PO-00007' })],
    };
    const reasons = resolutionBlockers(noPo, { purchaseOrderCode: 'PO-00007', lines: grn.values?.lines });
    expect(reasons).toEqual([t('preview.po_none', { code: 'PO-00007' }), t('preview.po_line_none', { name: 'لوح شمسي 550 واط' })]);
    const { model } = buildPreview({ flow: 'grn', assessed: grn.assessed, values: grn.values, resolution: noPo, choices: {}, confirmed: [], hasDocument: false });
    for (const reason of reasons) expect(model.blockersAr).toContain(t('preview.block.resolution', { reason }));
    expect(model.canApprove).toBe(false);

    const lineOnly: FlowResolution = {
      flow: 'grn',
      purchaseOrder: { kind: 'matched', id: 'po-7', labelAr: 'PO-00007', by: 'code', status: 'SENT', receivable: true },
      lines: [{ poLine: { kind: 'none' }, warnings: [] }, { warnings: [] }],
      warnings: [],
      notesAr: [],
    };
    expect(resolutionBlockers(lineOnly)).toHaveLength(1);

    const bill: FlowResolution = { flow: 'vendor_bill', vendor: { kind: 'new' }, goodsReceipt: { kind: 'none' }, lines: [], warnings: [], notesAr: [] };
    expect(resolutionBlockers(bill)).toEqual([t('preview.grn_required')]);

    const fine: FlowResolution = {
      flow: 'vendor_bill',
      vendor: { kind: 'new' },
      goodsReceipt: { kind: 'matched', id: 'grn-3', labelAr: 'GRN-00003', by: 'code' },
      lines: [],
      warnings: [],
      notesAr: [],
    };
    expect(resolutionBlockers(fine)).toEqual([]);
  });
});

// ─── 5. choices on other flows ──────────────────────────────────────────────

describe('buildPreview — choices of the procurement flows', () => {
  it('item candidates ask per line and cannot become a new item (NPI needs an existing item); projects cannot be created either', () => {
    const { assessed, values } = assessPr(prOutput(), FLAGS);
    const resolution = prResolution({
      project: {
        kind: 'candidates',
        candidates: [
          { id: 'prj-12', labelAr: 'PRJ-00012 — محطة الرياض الشمسية', similarity: 0.7 },
          { id: 'prj-21', labelAr: 'PRJ-00021 — محطة جدة', similarity: 0.4 },
        ],
      },
      lines: [
        {
          item: {
            kind: 'candidates',
            candidates: [
              { id: 'itm-550', labelAr: 'لوح شمسي 550 واط (MOD-550)', similarity: 0.7 },
              { id: 'itm-545', labelAr: 'لوح شمسي 545 واط (MOD-545)', similarity: 0.6 },
            ],
          },
          warnings: [],
        },
      ],
    });
    const { model } = buildPreview({ flow: 'pr', assessed, values, resolution, choices: {}, confirmed: [], hasDocument: false });

    const project = model.choices.find((c) => c.target === 'project')!;
    expect(project.promptAr).toBe(t('preview.project_choose'));
    expect(project.options.map((o) => o.id)).toEqual(['prj-12', 'prj-21']);
    expect(project.chosen).toBeNull();

    const item = model.choices.find((c) => c.target === 'lines.0.item')!;
    expect(item.promptAr).toBe(t('preview.item_choose', { name: 'لوح 550 واط' }));
    expect(item.options.map((o) => o.id)).toEqual(['itm-550', 'itm-545']);
    expect(item.options.map((o) => o.id)).not.toContain('new');
    expect(model.canApprove).toBe(false);

    const decided = buildPreview({
      flow: 'pr', assessed, values, resolution, hasDocument: false, confirmed: [],
      choices: { project: 'prj-12', 'lines.0.item': 'itm-545' },
    }).model;
    expect(decided.choices.map((c) => c.chosen)).toEqual(expect.arrayContaining(['prj-12', 'itm-545']));
    expect(decided.canApprove).toBe(true);
  });

  it('a stored «new» for an item is not an option any more: the question is undecided again and blocks', () => {
    const { assessed, values } = assessPr(prOutput(), FLAGS);
    const resolution = prResolution({
      lines: [
        {
          item: {
            kind: 'candidates',
            candidates: [
              { id: 'itm-550', labelAr: 'لوح شمسي 550 واط (MOD-550)', similarity: 0.7 },
              { id: 'itm-545', labelAr: 'لوح شمسي 545 واط (MOD-545)', similarity: 0.6 },
            ],
          },
          warnings: [],
        },
      ],
    });
    const { model } = buildPreview({ flow: 'pr', assessed, values, resolution, choices: { 'lines.0.item': 'new' }, confirmed: [], hasDocument: false });
    expect(model.choices.find((c) => c.target === 'lines.0.item')!.chosen).toBeNull();
    expect(model.blockersAr).toContain(t('preview.block.choice'));
    expect(model.canApprove).toBe(false);
  });

  it('an item that matched by SKU is simply used: no question to answer', async () => {
    const { assessed, values } = assessPr(prOutput(), FLAGS);
    const resolution = prResolution({
      lines: [{ item: { kind: 'matched', id: 'itm-550', labelAr: 'لوح شمسي 550 واط (MOD-550)', by: 'sku' }, unitCost: 320, warnings: [] }],
    });
    const { model } = buildPreview({ flow: 'pr', assessed, values, resolution, choices: {}, confirmed: [], hasDocument: false });
    expect(model.choices).toEqual([]);
    expect(model.canApprove).toBe(true);
  });

  it('unreadable lists and absent projects add notes but no question and no blocker', () => {
    const { assessed, values } = assessPr(prOutput(), FLAGS);
    const note = t('preview.list_unreadable', { list: t('preview.list.departments') });
    const resolution = prResolution({
      department: { kind: 'unreadable', messageAr: note },
      project: { kind: 'none' },
      // The item exists in NPI: an order or requisition cannot be placed without one (D-T27-5).
      lines: [{ item: { kind: 'matched', id: 'itm-550', labelAr: 'لوح شمسي 550 واط (MOD-550)', by: 'sku' }, warnings: [] }],
      notesAr: [note, t('preview.project_none', { name: 'PRJ-00012' })],
    });
    const { model } = buildPreview({ flow: 'pr', assessed, values, resolution, choices: {}, confirmed: [], hasDocument: false });
    expect(model.choices).toEqual([]);
    expect(model.notesAr).toEqual([note, t('preview.project_none', { name: 'PRJ-00012' })]);
    expect(model.canApprove).toBe(true);
  });
});

describe('buildPreview — an item NPI does not have blocks the order and the requisition (D-T27-5)', () => {
  const itemRequired = (name: string) => t('preview.block.resolution', { reason: t('preview.item_required', { name }) });
  const candidatePick: EntityPick = {
    kind: 'candidates',
    candidates: [
      { id: 'itm-550', labelAr: 'لوح شمسي 550 واط (MOD-550)', similarity: 0.7 },
      { id: 'itm-545', labelAr: 'لوح شمسي 545 واط (MOD-545)', similarity: 0.6 },
    ],
  };

  function prModel(item: EntityPick | undefined, choices: Record<string, string> = {}): PreviewModel {
    const { assessed, values } = assessPr(prOutput(), FLAGS);
    return buildPreview({ flow: 'pr', assessed, values, resolution: prResolution({ lines: [{ item, warnings: [] }] }), choices, confirmed: [], hasDocument: false }).model;
  }

  it.each<[string, EntityPick | undefined]>([
    ['new', { kind: 'new' }],
    ['none', { kind: 'none' }],
    ['unreadable', { kind: 'unreadable', messageAr: t('preview.list_unreadable', { list: t('preview.list.items') }) }],
    ['not resolved at all', undefined],
  ])('a requisition line whose item is %s: «اعتمد» is blocked, naming the item', (_name, item) => {
    const model = prModel(item);
    expect(model.blockersAr).toContain(itemRequired('لوح 550 واط'));
    expect(model.canApprove).toBe(false);
    // Nothing to choose: the user fixes it in NPI, not on the card.
    expect(model.choices.some((c) => c.target === 'lines.0.item')).toBe(false);
  });

  it('candidates nobody chose ask the question (the existing blocker) and say nothing about a missing item', () => {
    const model = prModel(candidatePick);
    expect(model.blockersAr).toContain(t('preview.block.choice'));
    expect(model.blockersAr).not.toContain(itemRequired('لوح 550 واط'));
    expect(model.canApprove).toBe(false);

    const chosen = prModel(candidatePick, { 'lines.0.item': 'itm-545' });
    expect(chosen.blockersAr).toEqual([]);
    expect(chosen.canApprove).toBe(true);
  });

  it('a matched item blocks nothing', () => {
    const model = prModel({ kind: 'matched', id: 'itm-550', labelAr: 'لوح شمسي 550 واط (MOD-550)', by: 'sku' });
    expect(model.blockersAr).toEqual([]);
    expect(model.canApprove).toBe(true);
  });

  it('every offending line is named, once each, and the matched ones are not', () => {
    const out = prOutput({ lines: [prLine(), prLine({ itemName: f('كابل نحاسي 6 ملم'), sku: f('CBL-6') }), prLine({ itemName: f('قاطع حماية 63 أمبير'), sku: f('BRK-63') })] });
    const { assessed, values } = assessPr(out, FLAGS);
    const resolution = prResolution({
      lines: [
        { item: { kind: 'matched', id: 'itm-550', labelAr: 'لوح شمسي 550 واط (MOD-550)', by: 'sku' }, warnings: [] },
        { item: { kind: 'new' }, warnings: [] },
        { item: { kind: 'none' }, warnings: [] },
      ],
    });
    const { model } = buildPreview({ flow: 'pr', assessed, values, resolution, choices: {}, confirmed: [], hasDocument: false });
    expect(model.blockersAr.filter((b) => b === itemRequired('كابل نحاسي 6 ملم'))).toHaveLength(1);
    expect(model.blockersAr.filter((b) => b === itemRequired('قاطع حماية 63 أمبير'))).toHaveLength(1);
    expect(model.blockersAr).not.toContain(itemRequired('لوح 550 واط'));
    expect(model.canApprove).toBe(false);
  });

  it('the same for a purchase order: a line whose item is new blocks, naming the quote’s item', () => {
    const { assessed, values } = assessPo(poOutput(), FLAGS);
    const resolution: FlowResolution = {
      flow: 'po',
      vendor: { kind: 'matched', id: 'ven-1', labelAr: VENDOR, by: 'vat' },
      lines: [
        { item: { kind: 'matched', id: 'itm-550', labelAr: 'لوح شمسي 550 واط (MOD-550)', by: 'sku' }, warnings: [] },
        { item: { kind: 'new' }, warnings: [] },
        { item: { kind: 'matched', id: 'itm-rail', labelAr: 'قضيب تثبيت (MNT-RAIL)', by: 'sku' }, warnings: [] },
      ],
      warnings: [],
      notesAr: [],
    };
    const { model } = buildPreview({ flow: 'po', assessed, values, resolution, choices: {}, confirmed: [], hasDocument: false });
    expect(model.blockersAr).toContain(itemRequired('عاكس 50 كيلوواط'));
    expect(model.blockersAr).not.toContain(itemRequired('لوح شمسي 550 واط'));
    expect(model.canApprove).toBe(false);

    const allMatched: FlowResolution = {
      ...resolution,
      lines: resolution.lines.map((line, i) => ({ item: { kind: 'matched', id: `itm-${i}`, labelAr: `صنف ${i + 1}`, by: 'sku' }, warnings: line.warnings })),
    };
    const ok = buildPreview({ flow: 'po', assessed, values, resolution: allMatched, choices: {}, confirmed: [], hasDocument: false }).model;
    expect(ok.blockersAr).toEqual([]);
    expect(ok.canApprove).toBe(true);
  });

  it('only a purchase order and a requisition need existing items: a goods receipt and a bill carry none', () => {
    const grn = assessGrn(grnOutput(), FLAGS);
    const grnResolution: FlowResolution = {
      flow: 'grn',
      purchaseOrder: { kind: 'matched', id: 'po-7', labelAr: 'PO-00007', by: 'code', status: 'SENT', receivable: true },
      lines: [
        { item: { kind: 'new' }, poLine: { kind: 'matched', id: 'pol-1', labelAr: 'لوح شمسي 550 واط', by: 'sku' }, warnings: [] },
        { poLine: { kind: 'matched', id: 'pol-2', labelAr: 'قضيب تثبيت', by: 'sku' }, warnings: [] },
      ],
      warnings: [],
      notesAr: [],
    };
    const { model } = buildPreview({ flow: 'grn', assessed: grn.assessed, values: grn.values, resolution: grnResolution, choices: {}, confirmed: [], hasDocument: false });
    expect(model.blockersAr.some((b) => b.includes(t('preview.item_required', { name: 'لوح شمسي 550 واط' })))).toBe(false);
  });
});

// ─── 6. previewSteps ────────────────────────────────────────────────────────

describe('previewSteps', () => {
  it('pr: create with the number of lines, then submit', () => {
    const { values } = assessPr(prOutput(), FLAGS);
    const steps = previewSteps('pr', values, prResolution(), {});
    expect(steps).toEqual([
      { n: 1, labelAr: t('preview.step.pr_create', { n: 1 }) },
      { n: 2, labelAr: t('preview.step.pr_submit') },
    ]);
  });

  it('po with a matched requisition converts it (code in the step); without one creates the order', () => {
    const { values } = assessPo(poOutput(), FLAGS);
    const base: FlowResolution = {
      flow: 'po',
      vendor: { kind: 'matched', id: 'ven-1', labelAr: VENDOR, by: 'vat' },
      requisition: { kind: 'matched', id: 'pr-12', labelAr: 'PR-00012', by: 'code' },
      lines: [{ warnings: [] }, { warnings: [] }, { warnings: [] }],
      warnings: [],
      notesAr: [],
    };
    const converted = previewSteps('po', values, base, {}).map((s) => s.labelAr);
    expect(converted[0]).toBe(t('preview.step.vendor_use', { name: VENDOR }));
    expect(converted[1]).toBe(t('preview.step.po_convert', { code: 'PR-00012' }));
    expect(converted[converted.length - 1]).toBe(t('preview.step.po_matrix'));

    const created = previewSteps('po', values, { ...base, vendor: { kind: 'new' }, requisition: { kind: 'none' } }, {}).map((s) => s.labelAr);
    expect(created[0]).toBe(t('preview.step.vendor_new', { name: VENDOR }));
    expect(created[1]).toContain('3');
    expect(created[1]).toContain('24,679');
    expect(created[1]).not.toBe(converted[1]);
    expect(created[created.length - 1]).toBe(t('preview.step.po_matrix'));
  });

  it('grn: receipt on the PO with the number of lines, inspection stays in NPI', () => {
    const { values } = assessGrn(grnOutput(), FLAGS);
    const resolution: FlowResolution = {
      flow: 'grn',
      purchaseOrder: { kind: 'matched', id: 'po-7', labelAr: 'PO-00007', by: 'code', status: 'SENT', receivable: true },
      lines: [{ warnings: [] }, { warnings: [] }],
      warnings: [],
      notesAr: [],
    };
    expect(previewSteps('grn', values, resolution, {}).map((s) => s.labelAr)).toEqual([
      t('preview.step.grn_create', { code: 'PO-00007', n: 2 }),
      t('preview.step.grn_inspect_manual'),
    ]);
  });

  it('vendor_bill: record the bill against the matched receipt, the three-way match runs in NPI', () => {
    const { values } = assessVendorBill(billOutput(), FLAGS);
    const resolution: FlowResolution = {
      flow: 'vendor_bill',
      vendor: { kind: 'matched', id: 'ven-1', labelAr: VENDOR, by: 'vat' },
      purchaseOrder: { kind: 'matched', id: 'po-7', labelAr: 'PO-00007', by: 'code', status: 'PARTIALLY_RECEIVED', receivable: true },
      goodsReceipt: { kind: 'matched', id: 'grn-3', labelAr: 'GRN-00003', by: 'code' },
      lines: [],
      warnings: [],
      notesAr: [],
    };
    const labels = previewSteps('vendor_bill', values, resolution, {}).map((s) => s.labelAr);
    expect(labels).toEqual([
      t('preview.step.bill_create', { ref: 'INV-2026-0912', code: 'GRN-00003' }),
      t('preview.step.bill_match_npi'),
    ]);

    // With a document the steps are the same: NPI cannot attach a file to a bill (D-T27-4).
    const { assessed } = assessVendorBill(billOutput(), FLAGS);
    const withDoc = buildPreview({ flow: 'vendor_bill', assessed, values, resolution, choices: {}, confirmed: [], hasDocument: true }).model;
    expect(withDoc.steps.map((s) => s.labelAr)).toEqual(labels);
    expect(withDoc.sections.map((s) => s.key)).toEqual(['vendor', 'invoice', 'totals']);
  });

  it('only a contract promises to attach the document (D-T27-4: NPI has no attachment target for PO, GRN or bill)', () => {
    const attach = t('preview.step.attach');
    const poResolution: FlowResolution = { flow: 'po', vendor: { kind: 'new' }, lines: [{ warnings: [] }, { warnings: [] }, { warnings: [] }], warnings: [], notesAr: [] };
    const grnResolution: FlowResolution = {
      flow: 'grn',
      purchaseOrder: { kind: 'matched', id: 'po-7', labelAr: 'PO-00007', by: 'code', status: 'SENT', receivable: true },
      lines: [{ warnings: [] }, { warnings: [] }],
      warnings: [],
      notesAr: [],
    };
    const billResolution: FlowResolution = { flow: 'vendor_bill', goodsReceipt: { kind: 'matched', id: 'grn-3', labelAr: 'GRN-00003', by: 'code' }, lines: [], warnings: [], notesAr: [] };

    for (const hasDocument of [true, false]) {
      const labelsOf = (flow: FlowType, values: unknown, resolution: FlowResolution | null) => previewSteps(flow, values, resolution, {}, hasDocument).map((x) => x.labelAr);
      expect(labelsOf('po', assessPo(poOutput(), FLAGS).values, poResolution)).not.toContain(attach);
      expect(labelsOf('grn', assessGrn(grnOutput(), FLAGS).values, grnResolution)).not.toContain(attach);
      expect(labelsOf('vendor_bill', assessVendorBill(billOutput(), FLAGS).values, billResolution)).not.toContain(attach);
      expect(labelsOf('pr', assessPr(prOutput(), FLAGS).values, prResolution())).not.toContain(attach);
    }

    const contract = assessCustomerContract(contractOutput(), FLAGS).values;
    expect(previewSteps('customer_contract', contract, customerMatched, {}, true).map((x) => x.labelAr)).toContain(attach);
    expect(previewSteps('customer_contract', contract, customerMatched, {}, false).map((x) => x.labelAr)).not.toContain(attach);
  });

  it('po and grn steps are the same with and without a document', () => {
    const po = assessPo(poOutput(), FLAGS).values;
    const poResolution: FlowResolution = { flow: 'po', vendor: { kind: 'new' }, lines: [{ warnings: [] }, { warnings: [] }, { warnings: [] }], warnings: [], notesAr: [] };
    expect(previewSteps('po', po, poResolution, {}, true)).toEqual(previewSteps('po', po, poResolution, {}, false));

    const grn = assessGrn(grnOutput(), FLAGS).values;
    const grnResolution: FlowResolution = { flow: 'grn', lines: [{ warnings: [] }, { warnings: [] }], warnings: [], notesAr: [] };
    expect(previewSteps('grn', grn, grnResolution, {}, true)).toEqual(previewSteps('grn', grn, grnResolution, {}, false));
  });
});

// ─── 7. the other flows' layouts ────────────────────────────────────────────

describe('buildPreview — sections per flow', () => {
  it('pr: one header section and «البنود»', () => {
    const { assessed, values } = assessPr(prOutput(), FLAGS);
    const { model } = buildPreview({ flow: 'pr', assessed, values, resolution: prResolution(), choices: {}, confirmed: [], hasDocument: false });
    expect(model.sections.map((s) => s.key)).toEqual(['request']);
    expect(model.sections[0].titleAr).toBe(t('preview.section.request'));
    expect(model.lines?.titleAr).toBe(t('preview.lines.items'));
    expect(model.lines?.rows[0].titleAr).toBe(t('preview.line_title', { n: 1 }));
  });

  it('po: vendor, quote and totals sections', () => {
    const { assessed, values } = assessPo(poOutput(), FLAGS);
    const resolution: FlowResolution = { flow: 'po', vendor: { kind: 'new' }, lines: [{ warnings: [] }, { warnings: [] }, { warnings: [] }], warnings: [], notesAr: [] };
    const { model } = buildPreview({ flow: 'po', assessed, values, resolution, choices: {}, confirmed: [], hasDocument: false });
    expect(model.sections.map((s) => s.key)).toEqual(['vendor', 'quote', 'totals']);
    expect(model.sections.map((s) => s.titleAr)).toEqual([t('preview.section.vendor'), t('preview.section.quote'), t('preview.section.totals')]);
    expect(fieldAt(model, 'total').displayAr).toBe('24,679.00');
    expect(fieldAt(model, 'lines.2.unitPrice').displayAr).toBe('18.00');
  });

  it('grn: serials are joined with the Arabic comma', () => {
    const { assessed, values } = assessGrn(grnOutput(), FLAGS);
    const resolution: FlowResolution = {
      flow: 'grn',
      purchaseOrder: { kind: 'matched', id: 'po-7', labelAr: 'PO-00007', by: 'code', status: 'SENT', receivable: true },
      lines: [{ warnings: [] }, { warnings: [] }],
      warnings: [],
      notesAr: [],
    };
    const { model } = buildPreview({ flow: 'grn', assessed, values, resolution, choices: {}, confirmed: [], hasDocument: false });
    expect(model.sections.map((s) => s.key)).toEqual(['delivery']);
    const serials = fieldAt(model, 'lines.0.serials');
    expect(serials.kind).toBe('serials');
    expect(serials.value).toEqual(serialList('GS550-2609', 1, 8));
    expect(serials.displayAr).toBe(serialList('GS550-2609', 1, 8).join('، '));
  });
});
