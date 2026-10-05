// Intake views for the preview-card specs (T-26): what `GET/POST
// /copilot/api/intake` answers, built the way the server builds it — Arabic
// text from `t()`, shapes from `src/intake/types.ts` (a type change breaks the
// compile here before it breaks a browser run). Shared by `e2e/preview.spec.ts`
// and `tests/intake-api.spec.ts`, so the client guard that parses these
// bodies is exercised on exactly what the browser tests feed it.
import { ar, t } from '../../src/i18n/ar';
import type {
  ExecutionLog,
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
  const key = `preview.f.${path.replace(/\.\d+(?=\.|$)/g, '')}`;
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

export function cancelledView(): IntakeView {
  return readyView({ status: 'cancelled' }, { status: 'cancelled' });
}

export function failedView(reason: string = t('extract.failed.model_error')): IntakeView {
  return { ...contractView(), status: 'failed', preview: null, failureAr: reason };
}
