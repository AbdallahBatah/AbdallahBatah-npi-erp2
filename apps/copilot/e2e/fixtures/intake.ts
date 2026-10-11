// Intake views for the preview-card specs (T-26): what `GET/POST
// /copilot/api/intake` answers, built the way the server builds it — Arabic
// text from `t()`, shapes from `src/intake/types.ts` (a type change breaks the
// compile here before it breaks a browser run). Shared by `e2e/preview.spec.ts`
// and `tests/intake-api.spec.ts`, so the client guard that parses these
// bodies is exercised on exactly what the browser tests feed it.
import { ar, t } from '../../src/i18n/ar';
import { NpiError } from '../../src/npi/errors';
import type {
  CreatedEntityKind,
  ExecutionLog,
  ExecutionStep,
  IntakeStatus,
  IntakeView,
  PreviewChoice,
  PreviewField,
  PreviewLineRow,
  PreviewModel,
  PreviewStep,
} from '../../src/intake/types';

export const CUSTOMER = 'شركة النخيل للمقاولات';
export const VAT = '300123456700003';
export const JOB_ID = 'job-1';
export const DOCUMENT_ID = 'doc-1';

type Kind = PreviewField['kind'];

function labelOf(path: string): string {
  const key = `preview.f.${path.replaceAll(/\.\d+(?=\.|$)/g, '')}`;
  const label = (ar as Record<string, string>)[key];
  if (label === undefined) throw new Error(`fixtures/intake: no label for ${path}`);
  return label;
}

interface FieldSpec {
  value: PreviewField['value'];
  displayAr: string;
  kind: Kind;
  status?: PreviewField['status'];
  confirmable?: boolean;
  warnings?: string[];
  required?: boolean;
  evidence?: string | null;
  page?: number | null;
  confidence?: number;
}

function field(path: string, spec: FieldSpec): PreviewField {
  const status = spec.status ?? 'confirmed';
  return {
    path,
    labelAr: labelOf(path),
    value: spec.value,
    displayAr: spec.displayAr,
    status,
    confidence: spec.confidence ?? (status === 'confirmed' ? 1 : spec.value === null ? 0 : 0.5),
    evidence: spec.evidence === undefined ? (spec.value === null ? null : 'نص المستند') : spec.evidence,
    page: spec.page === undefined ? (spec.value === null ? null : 1) : spec.page,
    warningsAr: spec.warnings ?? [],
    required: spec.required ?? false,
    confirmable: spec.confirmable ?? false,
    editable: true,
    kind: spec.kind,
  };
}

const missing = (path: string, kind: Kind): PreviewField =>
  field(path, {
    value: null,
    displayAr: t('preview.empty_value'),
    kind,
    status: 'unconfirmed',
    warnings: [t('extract.warn.missing')],
  });

export interface ContractOptions {
  /** The retention the model read (default 10). */
  retentionPct?: number;
  /** `confirmed` once the user vouched for it or typed it. */
  retention?: 'unconfirmed' | 'confirmed';
  totalValue?: number;
  /** Which radio is on; `null` = undecided (not offered by default). */
  customerChoice?: string;
  status?: IntakeStatus;
}

const MILESTONES = [
  { sequence: 1, description: 'دفعة مقدمة عند التوقيع', amount: 255000, percent: 30 },
  { sequence: 2, description: 'عند اكتمال التوريد وفحص المواد في الموقع', amount: 340000, percent: 40 },
  { sequence: 3, description: 'عند التشغيل والتسليم النهائي للمشروع', amount: 255000, percent: 30 },
];

const amountText = (n: number) => n.toLocaleString('ar-SA-u-nu-latn-ca-gregory', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function milestoneRow(index: number): PreviewLineRow {
  const m = MILESTONES[index];
  const p = (name: string) => `milestones.${index}.${name}`;
  return {
    index,
    titleAr: t('preview.milestone_title', { n: index + 1 }),
    fields: [
      field(p('sequence'), { value: m.sequence, displayAr: String(m.sequence), kind: 'number' }),
      field(p('descriptionAr'), { value: m.description, displayAr: m.description, kind: 'text' }),
      field(p('amount'), { value: m.amount, displayAr: amountText(m.amount), kind: 'amount' }),
      field(p('percent'), { value: m.percent, displayAr: String(m.percent), kind: 'number' }),
      missing(p('dueDate'), 'date'),
      field(p('triggerType'), { value: 'EVENT', displayAr: t('preview.enum.EVENT'), kind: 'enum' }),
    ],
  };
}

export function contractModel(options: ContractOptions = {}): PreviewModel {
  const retentionPct = options.retentionPct ?? 10;
  const vouched = options.retention === 'confirmed';
  const totalValue = options.totalValue ?? 850000;

  const retention = vouched
    ? field('retentionPct', { value: retentionPct, displayAr: String(retentionPct), kind: 'number', evidence: `المحتجزات ${retentionPct}%`, page: 2 })
    : field('retentionPct', {
        value: retentionPct,
        displayAr: String(retentionPct),
        kind: 'number',
        status: 'unconfirmed',
        confirmable: true,
        warnings: [t('extract.warn.low_confidence')],
        evidence: `المحتجزات ${retentionPct}%`,
        page: 2,
        confidence: 0.5,
      });

  const sections: PreviewModel['sections'] = [
    {
      key: 'customer',
      titleAr: t('preview.section.customer'),
      fields: [
        field('customer.nameAr', { value: CUSTOMER, displayAr: CUSTOMER, kind: 'text', required: true, evidence: `الطرف الأول: ${CUSTOMER}`, page: 1 }),
        field('customer.customerType', { value: 'CI', displayAr: t('preview.enum.CI'), kind: 'enum' }),
        field('customer.vatNumber', { value: VAT, displayAr: VAT, kind: 'code', evidence: `الرقم الضريبي ${VAT}`, page: 1 }),
      ],
    },
    {
      key: 'contract',
      titleAr: t('preview.section.contract'),
      fields: [
        field('contractType', { value: 'EPC', displayAr: t('preview.enum.EPC'), kind: 'enum', required: true }),
        field('startDate', { value: '2026-11-01', displayAr: '2026-11-01', kind: 'date' }),
        field('endDate', { value: '2027-04-30', displayAr: '2027-04-30', kind: 'date' }),
        field('totalValue', { value: totalValue, displayAr: amountText(totalValue), kind: 'amount', evidence: 'قيمة العقد الإجمالية 850,000 ريال', page: 2 }),
        retention,
        missing('advancePct', 'number'),
      ],
    },
  ];

  const rows = MILESTONES.map((_, index) => milestoneRow(index));
  const all = [...sections.flatMap((s) => s.fields), ...rows.flatMap((r) => r.fields)];
  const confirmed = all.filter((x) => x.status === 'confirmed').length;
  const unconfirmedWithValue = all.filter((x) => x.status === 'unconfirmed' && x.value !== null).length;

  const choice: PreviewChoice = {
    target: 'customer',
    promptAr: t('preview.customer_match', { name: CUSTOMER }),
    options: [
      { id: 'cus-1', labelAr: CUSTOMER },
      { id: 'new', labelAr: t('preview.option_new') },
    ],
    chosen: options.customerChoice ?? 'cus-1',
  };

  const steps: PreviewStep[] = [
    { n: 1, labelAr: choice.chosen === 'new' ? t('preview.step.customer_new', { name: CUSTOMER }) : t('preview.step.customer_use', { name: CUSTOMER }) },
    { n: 2, labelAr: t('preview.step.contract_create', { total: amountText(totalValue), n: MILESTONES.length }) },
    { n: 3, labelAr: t('preview.step.attach') },
    { n: 4, labelAr: t('preview.step.contract_activate_manual') },
  ];

  const blockersAr = unconfirmedWithValue > 0 ? [t('preview.block.unconfirmed', { n: unconfirmedWithValue })] : [];

  return {
    flow: 'customer_contract',
    flowLabelAr: t('flow.customer_contract'),
    sections,
    lines: { titleAr: t('preview.lines.milestones'), rows },
    choices: [choice],
    notesAr: [t('preview.customer_match', { name: CUSTOMER })],
    steps,
    incompleteAr: null,
    blockersAr,
    canApprove: blockersAr.length === 0,
    summary: { total: all.length, confirmed, unconfirmed: all.length - confirmed },
  };
}

/** The contract job as the card first shows it: «المحتجزات» unconfirmed, approve disabled. */
export function contractView(options: ContractOptions = {}, overrides: Partial<IntakeView> = {}): IntakeView {
  return {
    id: JOB_ID,
    flow: 'customer_contract',
    flowLabelAr: t('flow.customer_contract'),
    status: options.status ?? 'preview',
    conversationId: 'conv-1',
    document: { id: DOCUMENT_ID, fileName: 'عقد.pdf', kind: 'pdf_text', pageCount: 3 },
    preview: contractModel(options),
    failureAr: null,
    execution: null,
    createdAt: '2026-10-05T09:00:00.000Z',
    approvedAt: null,
    ...overrides,
  };
}

/** The same job with nothing left to confirm: approve enabled. */
export function readyView(options: ContractOptions = {}, overrides: Partial<IntakeView> = {}): IntakeView {
  return contractView({ ...options, retention: 'confirmed' }, overrides);
}

/** After «اعتمد»: approved, execution log pending, one pending step per plan step (D-T26-3). */
export function approvedView(options: ContractOptions = {}): IntakeView {
  const view = readyView({ ...options, status: 'approved' });
  const execution: ExecutionLog = {
    status: 'pending',
    steps: view.preview!.steps.map((s) => ({ n: s.n, labelAr: s.labelAr, state: 'pending' })),
  };
  return { ...view, status: 'approved', execution, approvedAt: '2026-10-05T09:05:00.000Z' };
}

const STARTED_AT = '2026-10-05T09:05:00.000Z';
const FINISHED_AT = '2026-10-05T09:05:03.000Z';

function created(kind: CreatedEntityKind, id: string, code: string | null, npiPath: string | null): NonNullable<ExecutionStep['entity']> {
  return { kindAr: t(`exec.kind.${kind}` as const), id, code, npiPath };
}

/** The same job after T-27's executor ran every step: customer, contract and
 *  attachment created in NPI, the last (activation) left for NPI's own screen.
 *  Labels are those of `approvedView()` with the customer created (not reused),
 *  so the first step's entity is the one it promised. */
export function executedView(options: ContractOptions = {}): IntakeView {
  const view = approvedView({ customerChoice: 'new', ...options });
  const [first, second, third, fourth] = view.preview!.steps;
  const execution: ExecutionLog = {
    status: 'done',
    startedAt: STARTED_AT,
    finishedAt: FINISHED_AT,
    steps: [
      { n: first.n, labelAr: first.labelAr, state: 'done', entity: created('customer', 'cus-1', 'CUS-00001', '/customers') },
      { n: second.n, labelAr: second.labelAr, state: 'done', entity: created('contract', 'con-1', 'CON-00012', '/contracts/con-1') },
      { n: third.n, labelAr: third.labelAr, state: 'done', entity: created('attachment', 'att-1', null, null) },
      { n: fourth.n, labelAr: fourth.labelAr, state: 'manual' },
    ],
  };
  return { ...view, status: 'done', execution };
}

/** NPI refused the contract (the user lacks the permission): the customer was
 *  created, the rest never ran. The preview stays on the job, read-only. */
export function executionFailedView(options: ContractOptions = {}): IntakeView {
  const view = approvedView({ customerChoice: 'new', ...options });
  const [first, second, third, fourth] = view.preview!.steps;
  const refusal = new NpiError({ status: 403, kind: 'forbidden', npiMessage: 'Insufficient permissions' });
  const execution: ExecutionLog = {
    status: 'failed',
    failedAt: 2,
    startedAt: STARTED_AT,
    finishedAt: FINISHED_AT,
    steps: [
      { n: first.n, labelAr: first.labelAr, state: 'done', entity: created('customer', 'cus-1', 'CUS-00001', '/customers') },
      { n: second.n, labelAr: second.labelAr, state: 'failed', errorAr: refusal.messageAr },
      { n: third.n, labelAr: third.labelAr, state: 'pending' },
      { n: fourth.n, labelAr: fourth.labelAr, state: 'pending' },
    ],
  };
  return { ...view, status: 'failed', execution };
}

export function cancelledView(): IntakeView {
  return readyView({ status: 'cancelled' }, { status: 'cancelled' });
}

export function failedView(reason: string = t('extract.failed.model_error')): IntakeView {
  return { ...contractView(), status: 'failed', preview: null, failureAr: reason };
}

// ─── T-38: the phone specs (e2e/mobile.spec.ts) ─────────────────────────────
// A vendor bill read from a photographed invoice, and a purchase requisition
// read from a dictated sentence: the two flows AT-16 drives by camera and by
// voice. Same builders as the contract above, so the card and the execution
// card render exactly what the server would send.

export const VENDOR = 'شركة الأفق للتوريدات';
export const VENDOR_VAT = '310987654300003';
export const BILL_NUMBER = 'INV-2041';
export const GRN_CODE = 'GRN-00005';
export const PROJECT_CODE = 'PRJ-00012';
export const PR_ITEM = 'لوح شمسي 550 واط';
export const PR_QTY = 40;

export interface RequestOptions {
  status?: IntakeStatus;
}

/** A vendor bill read from a photo: every value confirmed, the vendor matched, approve enabled. */
export function billView(options: RequestOptions = {}, overrides: Partial<IntakeView> = {}): IntakeView {
  const lineRow = (index: number, itemName: string, qty: number, unitPrice: number): PreviewLineRow => {
    const p = (name: string) => `lines.${index}.${name}`;
    return {
      index,
      titleAr: t('preview.line_title', { n: index + 1 }),
      fields: [
        field(p('itemName'), { value: itemName, displayAr: itemName, kind: 'text' }),
        field(p('qty'), { value: qty, displayAr: String(qty), kind: 'number' }),
        field(p('unitPrice'), { value: unitPrice, displayAr: amountText(unitPrice), kind: 'amount' }),
        field(p('lineTotal'), { value: qty * unitPrice, displayAr: amountText(qty * unitPrice), kind: 'amount' }),
      ],
    };
  };
  const rows = [lineRow(0, 'لوح شمسي 550 واط', 4, 600), lineRow(1, 'محول جهد 10 كيلو واط', 1, 600)];
  const subtotal = 3000;
  const vatAmount = 450;
  const total = 3450;

  const sections: PreviewModel['sections'] = [
    {
      key: 'vendor',
      titleAr: t('preview.section.vendor'),
      fields: [
        field('vendor.nameAr', { value: VENDOR, displayAr: VENDOR, kind: 'text', required: true, evidence: `المورد: ${VENDOR}`, page: 1 }),
        field('vendor.vatNumber', { value: VENDOR_VAT, displayAr: VENDOR_VAT, kind: 'code', evidence: `الرقم الضريبي ${VENDOR_VAT}`, page: 1 }),
      ],
    },
    {
      key: 'invoice',
      titleAr: t('preview.section.invoice'),
      fields: [
        field('invoiceNumber', { value: BILL_NUMBER, displayAr: BILL_NUMBER, kind: 'code', required: true }),
        field('invoiceDate', { value: '2026-10-03', displayAr: '2026-10-03', kind: 'date' }),
        field('goodsReceiptCode', { value: GRN_CODE, displayAr: GRN_CODE, kind: 'code', required: true }),
      ],
    },
    {
      key: 'totals',
      titleAr: t('preview.section.totals'),
      fields: [
        field('subtotal', { value: subtotal, displayAr: amountText(subtotal), kind: 'amount' }),
        field('vatAmount', { value: vatAmount, displayAr: amountText(vatAmount), kind: 'amount' }),
        field('total', { value: total, displayAr: amountText(total), kind: 'amount', required: true }),
      ],
    },
  ];

  const all = [...sections.flatMap((s) => s.fields), ...rows.flatMap((r) => r.fields)];
  const choice: PreviewChoice = {
    target: 'vendor',
    promptAr: t('preview.vendor_match', { name: VENDOR }),
    options: [
      { id: 'ven-3', labelAr: VENDOR },
      { id: 'new', labelAr: t('preview.option_new') },
    ],
    chosen: 'ven-3',
  };
  const steps: PreviewStep[] = [
    { n: 1, labelAr: t('preview.step.vendor_use', { name: VENDOR }) },
    { n: 2, labelAr: t('preview.step.bill_create', { ref: BILL_NUMBER, code: GRN_CODE }) },
    { n: 3, labelAr: t('preview.step.bill_match_npi') },
  ];
  const preview: PreviewModel = {
    flow: 'vendor_bill',
    flowLabelAr: t('flow.vendor_bill'),
    sections,
    lines: { titleAr: t('preview.lines.items'), rows },
    choices: [choice],
    notesAr: [t('preview.vendor_match', { name: VENDOR })],
    steps,
    incompleteAr: null,
    blockersAr: [],
    canApprove: true,
    summary: { total: all.length, confirmed: all.length, unconfirmed: 0 },
  };
  return {
    id: JOB_ID,
    flow: 'vendor_bill',
    flowLabelAr: t('flow.vendor_bill'),
    status: options.status ?? 'preview',
    conversationId: 'conv-1',
    document: { id: DOCUMENT_ID, fileName: 'فاتورة.jpg', kind: 'image', pageCount: 1 },
    preview,
    failureAr: null,
    execution: null,
    createdAt: '2026-10-05T09:00:00.000Z',
    approvedAt: null,
    ...overrides,
  };
}

/** The bill after «اعتمد»: the vendor reused, the bill recorded as BILL-00007, the three-way match left for NPI. */
export function billExecutedView(): IntakeView {
  const view = billView({ status: 'done' });
  const [first, second, third] = view.preview!.steps;
  const execution: ExecutionLog = {
    status: 'done',
    startedAt: STARTED_AT,
    finishedAt: FINISHED_AT,
    steps: [
      { n: first.n, labelAr: first.labelAr, state: 'done', entity: created('vendor', 'ven-3', 'VEN-00003', '/vendors') },
      { n: second.n, labelAr: second.labelAr, state: 'done', entity: created('vendor_bill', 'bill-1', 'BILL-00007', '/procurement/bills/bill-1') },
      { n: third.n, labelAr: third.labelAr, state: 'manual' },
    ],
  };
  return { ...view, status: 'done', execution, approvedAt: STARTED_AT };
}

/** A purchase requisition read from one dictated sentence: no document, the project matched, approve enabled. */
export function prView(options: RequestOptions = {}, overrides: Partial<IntakeView> = {}): IntakeView {
  const p = (name: string) => `lines.0.${name}`;
  const rows: PreviewLineRow[] = [
    {
      index: 0,
      titleAr: t('preview.line_title', { n: 1 }),
      fields: [
        field(p('itemName'), { value: PR_ITEM, displayAr: PR_ITEM, kind: 'text', evidence: null, page: null }),
        field(p('qty'), { value: PR_QTY, displayAr: String(PR_QTY), kind: 'number', evidence: null, page: null }),
        field(p('unit'), { value: 'لوح', displayAr: 'لوح', kind: 'text', evidence: null, page: null }),
        field(p('estimatedUnitPrice'), { value: 420, displayAr: amountText(420), kind: 'amount', evidence: null, page: null }),
      ],
    },
  ];
  const sections: PreviewModel['sections'] = [
    {
      key: 'request',
      titleAr: t('preview.section.request'),
      fields: [
        field('projectCode', { value: PROJECT_CODE, displayAr: PROJECT_CODE, kind: 'code', required: true, evidence: null, page: null }),
        field('projectName', { value: 'محطة الواحة الشمسية', displayAr: 'محطة الواحة الشمسية', kind: 'text', evidence: null, page: null }),
        field('neededBy', { value: '2026-10-15', displayAr: '2026-10-15', kind: 'date', evidence: null, page: null }),
        field('justification', { value: 'توريد ألواح لمحطة الواحة', displayAr: 'توريد ألواح لمحطة الواحة', kind: 'text', evidence: null, page: null }),
      ],
    },
  ];
  const all = [...sections.flatMap((s) => s.fields), ...rows.flatMap((r) => r.fields)];
  const choice: PreviewChoice = {
    target: 'project',
    promptAr: t('preview.project_choose'),
    options: [{ id: 'prj-12', labelAr: PROJECT_CODE }],
    chosen: 'prj-12',
  };
  const steps: PreviewStep[] = [
    { n: 1, labelAr: t('preview.step.pr_create', { n: 1 }) },
    { n: 2, labelAr: t('preview.step.pr_submit') },
  ];
  const preview: PreviewModel = {
    flow: 'pr',
    flowLabelAr: t('flow.pr'),
    sections,
    lines: { titleAr: t('preview.lines.items'), rows },
    choices: [choice],
    notesAr: [],
    steps,
    incompleteAr: null,
    blockersAr: [],
    canApprove: true,
    summary: { total: all.length, confirmed: all.length, unconfirmed: 0 },
  };
  return {
    id: JOB_ID,
    flow: 'pr',
    flowLabelAr: t('flow.pr'),
    status: options.status ?? 'preview',
    conversationId: 'conv-1',
    document: null,
    preview,
    failureAr: null,
    execution: null,
    createdAt: '2026-10-05T09:00:00.000Z',
    approvedAt: null,
    ...overrides,
  };
}

/** The requisition after «اعتمد»: PR-00031 created and submitted into NPI's approval matrix. */
export function prExecutedView(): IntakeView {
  const view = prView({ status: 'done' });
  const [first, second] = view.preview!.steps;
  const execution: ExecutionLog = {
    status: 'done',
    startedAt: STARTED_AT,
    finishedAt: FINISHED_AT,
    steps: [
      { n: first.n, labelAr: first.labelAr, state: 'done', entity: created('requisition', 'pr-1', 'PR-00031', '/procurement/requisitions/pr-1') },
      { n: second.n, labelAr: second.labelAr, state: 'done' },
    ],
  };
  return { ...view, status: 'done', execution, approvedAt: STARTED_AT };
}
