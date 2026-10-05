// Builds the model the PreviewCard renders (T-26, 03 §2, spec 02 §5.7-5.8):
// the assessed fields of an extraction, the warnings entity resolution adds,
// what the user already confirmed or decided, and — from those — the sections,
// the rows, the choices, the steps and the one question «هل يمكن الاعتماد؟».
//
// Pure: no NPI, no database, no model. Every user-visible string comes from
// `t()`. The server recomputes the model after every operation (confirm, set,
// choose, edit), so the stored model can never drift from the stored fields.
import type { FlowType } from '../agents/router';
import { flattenFields } from '../extract/run';
import { withWarning } from '../extract/schemas/common';
import type { AssessedField, FieldWarning } from '../extract/schemas/field';
import { ar, t, type ArKey } from '../i18n/ar';
import { formatNumber } from '../i18n/format';
import {
  fieldKind,
  fieldLabelKey,
  formatAmount,
  isRequired,
  LINE_ARRAY,
  LINE_GROUP,
  SECTIONS,
} from './labels';
import { resolutionBlockers } from './resolution';
import type {
  EntityPick,
  FlowResolution,
  PreviewChoice,
  PreviewField,
  PreviewLineRow,
  PreviewModel,
  PreviewSection,
  PreviewStep,
} from './types';

/** D-T26-5: the warnings a user may simply vouch for («أكّده»). Everything
 *  else is a format NPI would reject or a rule it enforces: the user must `set`
 *  a valid value, or the blocker stands. */
export const CONFIRMABLE_WARNINGS: ReadonlySet<FieldWarning> = new Set<FieldWarning>([
  'extract.warn.low_confidence',
  'extract.warn.ligature',
  'extract.warn.derived',
  'extract.warn.date_past',
  'extract.warn.date_future',
  'extract.warn.line_total',
  'extract.warn.lines_sum',
  'extract.warn.vat_total',
  'extract.warn.amount',
  'extract.warn.milestones_sum',
  'extract.warn.milestones_sequence',
  'extract.warn.serials_count',
  'extract.warn.bill_total_mismatch',
]);

export interface BuildPreviewInput {
  flow: FlowType;
  /** The flow's `Assessed*` tree. */
  assessed: unknown;
  /** The flow's `*Values`, null when the extraction is incomplete. */
  values: unknown | null;
  resolution: FlowResolution | null;
  /** `choose` decisions by target. */
  choices: Record<string, string>;
  /** Paths the user confirmed or set by hand. */
  confirmed: string[];
  /** A document is attached to the job (adds the «attach» step). */
  hasDocument: boolean;
}

// ─── Fields ─────────────────────────────────────────────────────────────────

type FieldMap = Record<string, AssessedField<unknown>>;

interface UsableLine {
  itemName: AssessedField<unknown>;
  qty: AssessedField<unknown>;
}

/** Indexes (into `assessed.lines`) of the lines the schema kept in
 *  `values.lines`: a name, and a quantity above zero that raised no
 *  `quantity` warning — the rule of `assessPr/Po/Grn`. */
function usableLineIndexes(assessed: unknown): number[] {
  const lines = (assessed as { lines?: UsableLine[] } | null)?.lines;
  if (!Array.isArray(lines)) return [];
  const out: number[] = [];
  lines.forEach((l, index) => {
    const qty = l.qty?.value;
    if (l.itemName?.value !== null && typeof qty === 'number' && qty > 0 && !l.qty.warnings.includes('extract.warn.quantity')) out.push(index);
  });
  return out;
}

function onlyConfirmable(field: AssessedField<unknown>): boolean {
  return field.warnings.every((w) => CONFIRMABLE_WARNINGS.has(w));
}

function applyResolutionAndConfirmations(input: BuildPreviewInput): FieldMap {
  const fields: FieldMap = { ...flattenFields(input.assessed) };
  const resolution = input.resolution;

  if (resolution) {
    for (const { path, warning } of resolution.warnings) {
      const field = fields[path];
      if (field) fields[path] = withWarning(field, warning);
    }
    const usable = usableLineIndexes(input.assessed);
    resolution.lines.forEach((line, i) => {
      const assessedIndex = usable[i];
      if (assessedIndex === undefined) return;
      for (const { field: name, warning } of line.warnings) {
        const path = `lines.${assessedIndex}.${name}`;
        const field = fields[path];
        if (field) fields[path] = withWarning(field, warning);
      }
    });
  }

  for (const path of input.confirmed) {
    const field = fields[path];
    if (field && onlyConfirmable(field)) {
      fields[path] = { ...field, status: 'confirmed', confidence: 1, warnings: [] };
    }
  }
  return fields;
}

function displayOf(flow: FlowType, path: string, value: AssessedField<unknown>['value']): string {
  if (value === null) return t('preview.empty_value');
  const kind = fieldKind(flow, path);
  if (Array.isArray(value)) return value.length === 0 ? t('preview.empty_value') : value.join('، ');
  if (kind === 'amount' && typeof value === 'number') return formatAmount(value);
  if (kind === 'number' && typeof value === 'number') return formatNumber(value);
  if (kind === 'enum' && typeof value === 'string') {
    const key = `preview.enum.${value}`;
    return Object.prototype.hasOwnProperty.call(ar, key) ? t(key as ArKey) : value;
  }
  return String(value);
}

function previewField(flow: FlowType, path: string, field: AssessedField<unknown>): PreviewField {
  const kind = fieldKind(flow, path);
  const value = field.value as PreviewField['value'];
  return {
    path,
    labelAr: t(fieldLabelKey(path)),
    value,
    displayAr: displayOf(flow, path, value),
    status: field.status,
    confidence: field.confidence,
    evidence: field.evidence,
    page: field.page,
    warningsAr: field.warnings.map((w) => t(w)),
    required: isRequired(flow, path),
    confirmable: field.status === 'unconfirmed' && field.value !== null && onlyConfirmable(field),
    editable: true,
    kind,
  };
}

// ─── Choices ────────────────────────────────────────────────────────────────

interface ChoiceSpec {
  target: string;
  pick: EntityPick | undefined;
  /** Parties and items may be created; projects, receipts… may not. */
  allowNew: boolean;
  matchedKey?: 'preview.customer_match' | 'preview.vendor_match';
  chooseKey: ArKey;
  chooseVars?: Record<string, string | number>;
}

function choiceFor(spec: ChoiceSpec, choices: Record<string, string>): PreviewChoice | null {
  const { pick } = spec;
  if (pick === undefined) return null;
  const newOption = { id: 'new', labelAr: t('preview.option_new') };
  const stored = choices[spec.target];

  if (pick.kind === 'matched' && spec.matchedKey !== undefined) {
    const options = [{ id: pick.id, labelAr: pick.labelAr }, newOption];
    return {
      target: spec.target,
      promptAr: t(spec.matchedKey, { name: pick.labelAr }),
      options,
      chosen: stored !== undefined && options.some((o) => o.id === stored) ? stored : pick.id,
    };
  }
  if (pick.kind === 'candidates') {
    const options = pick.candidates.map((c) => ({ id: c.id, labelAr: c.labelAr }));
    if (spec.allowNew) options.push(newOption);
    return {
      target: spec.target,
      promptAr: t(spec.chooseKey, spec.chooseVars),
      options,
      chosen: stored !== undefined && options.some((o) => o.id === stored) ? stored : null,
    };
  }
  return null;
}

function buildChoices(values: unknown, resolution: FlowResolution | null, choices: Record<string, string>): PreviewChoice[] {
  if (resolution === null) return [];
  const specs: ChoiceSpec[] = [
    { target: 'customer', pick: resolution.customer, allowNew: true, matchedKey: 'preview.customer_match', chooseKey: 'preview.customer_choose' },
    { target: 'vendor', pick: resolution.vendor, allowNew: true, matchedKey: 'preview.vendor_match', chooseKey: 'preview.vendor_choose' },
    { target: 'project', pick: resolution.project, allowNew: false, chooseKey: 'preview.project_choose' },
    { target: 'department', pick: resolution.department, allowNew: false, chooseKey: 'preview.department_choose' },
    { target: 'goodsReceipt', pick: resolution.goodsReceipt, allowNew: false, chooseKey: 'preview.grn_choose' },
  ];
  const lines = (values as { lines?: { itemName: string }[] } | null)?.lines ?? [];
  resolution.lines.forEach((line, i) => {
    const name = lines[i]?.itemName ?? String(i + 1);
    specs.push(
      { target: `lines.${i}.item`, pick: line.item, allowNew: true, chooseKey: 'preview.item_choose', chooseVars: { name } },
      { target: `lines.${i}.poLine`, pick: line.poLine, allowNew: false, chooseKey: 'preview.po_line_choose', chooseVars: { name } },
      { target: `lines.${i}.wbs`, pick: line.wbs, allowNew: false, chooseKey: 'preview.wbs_choose' },
    );
  });
  return specs.flatMap((spec) => {
    const choice = choiceFor(spec, choices);
    return choice === null ? [] : [choice];
  });
}

// ─── Steps ──────────────────────────────────────────────────────────────────

const orDash = (v: string | null | undefined): string => (v && v.length > 0 ? v : '—');

/** The label of the entity the user ends up with: the match, the chosen
 *  candidate, or null when a new one will be created / nothing is decided. */
function chosenLabel(pick: EntityPick | undefined, chosen: string | undefined): string | null {
  if (pick?.kind === 'matched') return chosen === 'new' ? null : pick.labelAr;
  if (pick?.kind === 'candidates') {
    const hit = pick.candidates.find((c) => c.id === chosen);
    return hit?.labelAr ?? null;
  }
  return null;
}

function poTotalText(values: { total: number | null; subtotal: number | null; lines: { qty: number; unitPrice: number | null }[] }): string {
  if (values.total !== null) return formatAmount(values.total);
  if (values.subtotal !== null) return formatAmount(values.subtotal);
  if (values.lines.length > 0 && values.lines.every((l) => l.unitPrice !== null)) {
    return formatAmount(values.lines.reduce((sum, l) => sum + l.qty * (l.unitPrice as number), 0));
  }
  return '—';
}

/** «ما سيُنفَّذ بالترتيب» — descriptive only; T-27's plan performs the steps.
 *  Empty when the extraction is incomplete (`values === null`). */
export function previewSteps(
  flow: FlowType,
  values: unknown | null,
  resolution: FlowResolution | null,
  choices: Record<string, string>,
  hasDocument = false,
): PreviewStep[] {
  if (values === null) return [];
  const labels: string[] = [];
  const attach = () => {
    if (hasDocument) labels.push(t('preview.step.attach'));
  };

  switch (flow) {
    case 'customer_contract': {
      const v = values as { customer: { nameAr: string }; totalValue: number | null; milestones: unknown[] };
      const existing = chosenLabel(resolution?.customer, choices.customer);
      labels.push(existing === null ? t('preview.step.customer_new', { name: v.customer.nameAr }) : t('preview.step.customer_use', { name: existing }));
      labels.push(t('preview.step.contract_create', { total: v.totalValue === null ? '—' : formatAmount(v.totalValue), n: v.milestones.length }));
      attach();
      labels.push(t('preview.step.contract_activate_manual'));
      break;
    }
    case 'pr': {
      const v = values as { lines: unknown[] };
      labels.push(t('preview.step.pr_create', { n: v.lines.length }));
      labels.push(t('preview.step.pr_submit'));
      break;
    }
    case 'po': {
      const v = values as { vendor: { nameAr: string } | null; lines: { qty: number; unitPrice: number | null }[]; total: number | null; subtotal: number | null };
      if (v.vendor !== null) {
        const existing = chosenLabel(resolution?.vendor, choices.vendor);
        labels.push(existing === null ? t('preview.step.vendor_new', { name: v.vendor.nameAr }) : t('preview.step.vendor_use', { name: existing }));
      }
      const requisition = resolution?.requisition;
      if (requisition?.kind === 'matched') labels.push(t('preview.step.po_convert', { code: requisition.labelAr }));
      else labels.push(t('preview.step.po_create', { n: v.lines.length, total: poTotalText(v) }));
      attach();
      labels.push(t('preview.step.po_matrix'));
      break;
    }
    case 'grn': {
      const v = values as { purchaseOrderCode: string | null; lines: unknown[] };
      labels.push(t('preview.step.grn_create', { code: orDash(v.purchaseOrderCode), n: v.lines.length }));
      attach();
      labels.push(t('preview.step.grn_inspect_manual'));
      break;
    }
    case 'vendor_bill': {
      const v = values as { invoiceNumber: string | null };
      const grn = chosenLabel(resolution?.goodsReceipt, choices.goodsReceipt);
      labels.push(t('preview.step.bill_create', { ref: orDash(v.invoiceNumber), code: orDash(grn) }));
      attach();
      labels.push(t('preview.step.bill_match_npi'));
      break;
    }
  }
  return labels.map((labelAr, i) => ({ n: i + 1, labelAr }));
}

// ─── The model ──────────────────────────────────────────────────────────────

function sectionsOf(flow: FlowType, fields: FieldMap): PreviewSection[] {
  const out: PreviewSection[] = [];
  for (const spec of SECTIONS[flow]) {
    const sectionFields = spec.paths.filter((p) => fields[p] !== undefined).map((p) => previewField(flow, p, fields[p]));
    if (sectionFields.length > 0) out.push({ key: spec.key, titleAr: t(spec.titleKey), fields: sectionFields });
  }
  return out;
}

function linesOf(flow: FlowType, fields: FieldMap): PreviewModel['lines'] {
  const array = LINE_ARRAY[flow];
  const group = LINE_GROUP[flow];
  const byIndex = new Map<number, PreviewField[]>();
  const prefix = `${array}.`;
  for (const [path, field] of Object.entries(fields)) {
    if (!path.startsWith(prefix)) continue;
    const index = Number(path.slice(prefix.length).split('.')[0]);
    if (!Number.isInteger(index)) continue;
    const row = byIndex.get(index) ?? [];
    row.push(previewField(flow, path, field));
    byIndex.set(index, row);
  }
  if (byIndex.size === 0) return null;
  const rows: PreviewLineRow[] = [...byIndex.keys()]
    .sort((a, b) => a - b)
    .map((index) => ({ index, titleAr: t(group.rowKey, { n: index + 1 }), fields: byIndex.get(index) as PreviewField[] }));
  return { titleAr: t(group.titleKey), rows };
}

export function buildPreview(input: BuildPreviewInput): { model: PreviewModel; fields: Record<string, AssessedField<unknown>> } {
  const { flow, values, resolution } = input;
  const fields = applyResolutionAndConfirmations(input);

  const sections = sectionsOf(flow, fields);
  const lines = linesOf(flow, fields);
  const choices = buildChoices(values, resolution, input.choices);
  const notesAr = [...new Set(resolution?.notesAr ?? [])];
  const steps = previewSteps(flow, values, resolution, input.choices, input.hasDocument);

  const incompleteAr = values === null ? t(flow === 'customer_contract' ? 'extract.incomplete' : (`extract.incomplete.${flow}` as ArKey)) : null;

  const blockersAr: string[] = [];
  const leaves = Object.entries(fields);
  if (values === null) {
    blockersAr.push(t('preview.block.incomplete'));
  }
  const unconfirmedWithValue = leaves.filter(([, f]) => f.status === 'unconfirmed' && f.value !== null).length;
  if (unconfirmedWithValue > 0) blockersAr.push(t('preview.block.unconfirmed', { n: unconfirmedWithValue }));
  if (values !== null) {
    const missing = [...new Set(leaves.filter(([path, f]) => isRequired(flow, path) && f.value === null).map(([path]) => t(fieldLabelKey(path))))];
    if (missing.length > 0) blockersAr.push(t('preview.block.required', { fields: missing.join('، ') }));
  }
  if (choices.some((c) => c.chosen === null)) blockersAr.push(t('preview.block.choice'));
  if (resolution !== null) {
    const context = values === null ? {} : (values as { purchaseOrderCode?: string | null; lines?: { itemName: string }[] });
    for (const reason of resolutionBlockers(resolution, context)) blockersAr.push(t('preview.block.resolution', { reason }));
  }

  // A blank optional field is neither confirmed nor something to confirm;
  // the summary counts what the user actually sees a status for.
  const counted = leaves.filter(([path, f]) => f.value !== null || isRequired(flow, path));
  const confirmed = counted.filter(([, f]) => f.status === 'confirmed').length;
  const model: PreviewModel = {
    flow,
    flowLabelAr: t(`flow.${flow}` as ArKey),
    sections,
    lines,
    choices,
    notesAr,
    steps,
    incompleteAr,
    blockersAr,
    canApprove: blockersAr.length === 0,
    summary: { total: counted.length, confirmed, unconfirmed: counted.length - confirmed },
  };
  return { model, fields };
}
