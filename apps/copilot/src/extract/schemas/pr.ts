// Purchase-requisition extraction schema (T-24, F-06, spec 02 §5.5, ADR-28).
//
// An employee writes one sentence («أبي 40 لوح 550 واط للمشروع PRJ-00012
// قبل الخميس») or attaches a materials-request memo; the model's JSON mirrors
// what NPI's `POST /requisitions` accepts — `CreateRequisitionDto`
// and `RequisitionLineDto` (apps/api/src/modules/procurement/requisitions.dto.ts)
// — one `WireField` per DTO property, plus the names the DTO takes as ids
// (project, department, item, WBS) that `resolve.ts` turns into ids.
// `assessPr` parses and validates the wire form; `requisitionDtoFrom` turns
// validated values plus the resolution into the generated DTO type from
// `src/npi/types.ts`, so a change in NPI's OpenAPI document fails `tsc` here.
//
// NPI facts the rules follow (apps/api/src/modules/procurement/*.dto.ts):
//   justification        REQUIRED, 3..1000 characters
//   lines                non-empty; qty > 0 with ≤ 3 decimals
//   estimatedUnitPrice   ≥ 0, ≤ 2 decimals; when absent NPI fills the
//                        item's `unitCost`
//   notes                ≤ 500 characters
import { z } from 'zod';
import type { components } from '../../npi/types';
import { assessField, type AssessedField } from './field';
import { amountField, codeField, currencyField, dateNotPastField, defined, quantityField, round2, textField, wire, type AssessFlags } from './common';

export const PrLineOutputSchema = z.object({
  itemName: wire('اسم الصنف كما ورد (بلا كمية ولا سعر)'),
  sku: wire('رمز الصنف إن ورد (مثل MOD-550)، وإلا «»'),
  qty: wire('الكمية أرقاماً فقط'),
  unit: wire('وحدة القياس كما وردت (قطعة، متر، طقم…) إن ذُكرت، وإلا «»'),
  estimatedUnitPrice: wire('السعر التقديري للوحدة أرقاماً فقط إن ذُكر، وإلا «»'),
  wbsCode: wire('كود بند العمل (WBS) إن ورد، وإلا «»'),
  wbsName: wire('اسم بند العمل إن ورد، وإلا «»'),
  notes: wire('ملاحظة خاصة بالبند إن وردت (مواصفة، لون، ماركة)، وإلا «»'),
});

/** Exactly what the model must return. */
export const PrOutputSchema = z.object({
  justification: wire('سبب الطلب كما ورد؛ إن لم يُذكر سبب فجملة واحدة تلخّص الحاجة بثقة 0.6'),
  projectCode: wire('كود المشروع كما ورد (مثل PRJ-00012)، وإلا «»'),
  projectName: wire('اسم المشروع إن ورد بالاسم، وإلا «»'),
  departmentName: wire('اسم القسم الطالب بلا كلمة «قسم» إن ذُكر، وإلا «»'),
  neededBy: wire('تاريخ الحاجة YYYY-MM-DD (التواريخ النسبية تُحسب من تاريخ اليوم المذكور في التعليمات)'),
  currency: wire('رمز العملة بثلاثة أحرف إن ذُكرت عملة غير الريال، وإلا «»'),
  lines: z.array(PrLineOutputSchema),
});

export type PrOutput = z.infer<typeof PrOutputSchema>;
export type PrLineOutput = z.infer<typeof PrLineOutputSchema>;

// ─── Plain values (what the builders and the eval compare) ─────────────────

export interface PrLineValues {
  itemName: string;
  sku: string | null;
  qty: number;
  unit: string | null;
  estimatedUnitPrice: number | null;
  wbsCode: string | null;
  wbsName: string | null;
  notes: string | null;
}

export interface PrValues {
  justification: string | null;
  projectCode: string | null;
  projectName: string | null;
  departmentName: string | null;
  neededBy: string | null;
  currency: string | null;
  lines: PrLineValues[];
}

export interface AssessedPrLine {
  itemName: AssessedField<string>;
  sku: AssessedField<string>;
  qty: AssessedField<number>;
  unit: AssessedField<string>;
  estimatedUnitPrice: AssessedField<number>;
  wbsCode: AssessedField<string>;
  wbsName: AssessedField<string>;
  notes: AssessedField<string>;
}

export interface AssessedPr {
  justification: AssessedField<string>;
  projectCode: AssessedField<string>;
  projectName: AssessedField<string>;
  departmentName: AssessedField<string>;
  neededBy: AssessedField<string>;
  currency: AssessedField<string>;
  lines: AssessedPrLine[];
}

// ─── NPI DTO builders (the "mirror" guarantee, ADR-28) ─────────────────────

export type CreateRequisitionDto = components['schemas']['CreateRequisitionDto'];
export type RequisitionLineDto = components['schemas']['RequisitionLineDto'];

/** What `resolve.ts` found in NPI for the names in the request. Lines are
 *  aligned by index with `PrValues.lines`. */
export interface PrResolution {
  projectId: string | null;
  departmentId: string | null;
  lines: { itemId: string; wbsElementId: string | null; estimatedUnitPrice: number | null }[];
}

const JUSTIFICATION_MIN = 3;
const JUSTIFICATION_MAX = 1000;
const NOTES_MAX = 500;

/**
 * `POST /requisitions` body. `justification` is a parameter
 * (defaulting to the extracted one) because the preview card lets the user
 * type one when the model had to compose it. NPI requires it, so a missing
 * one is a programming error here — the plan builder must not get this far.
 * A price from the resolution (the item's `unitCost`, shown on the card)
 * wins over the one the sentence stated.
 */
export function requisitionDtoFrom(values: PrValues, resolved: PrResolution, justification: string | null = values.justification): CreateRequisitionDto {
  const why = justification?.trim() ?? '';
  if (why.length < JUSTIFICATION_MIN) throw new Error('requisitionDtoFrom: justification is required by NPI');
  if (resolved.lines.length !== values.lines.length) throw new Error('requisitionDtoFrom: resolution lines do not match the extracted lines');

  const lines: RequisitionLineDto[] = values.lines.map((line, index) => {
    const r = resolved.lines[index];
    const price = r.estimatedUnitPrice ?? line.estimatedUnitPrice;
    return defined<RequisitionLineDto>({
      itemId: r.itemId,
      qty: line.qty,
      estimatedUnitPrice: price === null ? undefined : round2(price),
      notes: line.notes === null ? undefined : line.notes.slice(0, NOTES_MAX),
      wbsElementId: r.wbsElementId ?? undefined,
    });
  });

  return defined<CreateRequisitionDto>({
    justification: why.slice(0, JUSTIFICATION_MAX),
    lines,
    projectId: resolved.projectId ?? undefined,
    departmentId: resolved.departmentId ?? undefined,
    neededBy: values.neededBy ?? undefined,
    currency: values.currency === null ? undefined : values.currency.toUpperCase(),
  });
}

// ─── Server-side validation and confidence (02 §5.5) ───────────────────────

/**
 * Turns the model's output into assessed fields and plain values:
 *  - the justification must be at least 3 characters (NPI's floor), shorter
 *    counts as absent; a justification the model composed carries the
 *    model's 0.6 and so shows as unconfirmed;
 *  - quantities > 0 with ≤ 3 decimals; prices non-negative;
 *  - `neededBy` an ISO date, flagged when before the reference date;
 *  - project and WBS codes in document-code shape (kept when off-shape);
 *  - `values.lines` keeps only usable lines (a name and a valid quantity);
 *    `assessed.lines` keeps all, so the card can show the one that failed.
 */
export function assessPr(out: PrOutput, flags: AssessFlags = { ligatureSuspect: false }): { assessed: AssessedPr; values: PrValues | null } {
  let justification = textField(out.justification);
  if (justification.value !== null && justification.value.trim().length < JUSTIFICATION_MIN) {
    justification = assessField<string>({ value: null, confidence: justification.confidence, evidence: justification.evidence, page: justification.page });
  }

  const lines: AssessedPrLine[] = out.lines.map((l) => {
    const sku = textField({ ...l.sku, value: l.sku.value.trim().toUpperCase() });
    return {
      itemName: textField(l.itemName),
      sku,
      qty: quantityField(l.qty),
      unit: textField(l.unit),
      estimatedUnitPrice: amountField(l.estimatedUnitPrice),
      wbsCode: codeField(l.wbsCode),
      wbsName: textField(l.wbsName),
      notes: textField(l.notes),
    };
  });

  const assessed: AssessedPr = {
    justification,
    projectCode: codeField(out.projectCode),
    projectName: textField(out.projectName),
    departmentName: textField(out.departmentName),
    neededBy: dateNotPastField(out.neededBy, flags),
    currency: currencyField(out.currency),
    lines,
  };

  const usable = lines.flatMap((l): PrLineValues[] =>
    l.itemName.value === null || l.qty.value === null || l.qty.value <= 0 || l.qty.warnings.includes('extract.warn.quantity')
      ? []
      : [
          {
            itemName: l.itemName.value,
            sku: l.sku.value,
            qty: l.qty.value,
            unit: l.unit.value,
            estimatedUnitPrice: l.estimatedUnitPrice.value,
            wbsCode: l.wbsCode.value,
            wbsName: l.wbsName.value,
            notes: l.notes.value,
          },
        ],
  );

  const values: PrValues | null =
    usable.length === 0
      ? null
      : {
          justification: justification.value,
          projectCode: assessed.projectCode.value,
          projectName: assessed.projectName.value,
          departmentName: assessed.departmentName.value,
          neededBy: assessed.neededBy.value,
          currency: assessed.currency.value,
          lines: usable,
        };

  return { assessed, values };
}
