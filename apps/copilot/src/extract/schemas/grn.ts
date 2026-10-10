// Goods-receipt extraction schema (T-25, F-08, spec 02 §5.5, ADR-28).
//
// The input is a supplier's delivery note — most often a phone photo
// reaching the model as vision blocks under a consent event — or a sentence
// from the receiver («وصلت الشحنة من أمر الشراء PO-00007: 40 لوح»). The
// model's JSON mirrors what `POST /procurement/purchase-orders/{id}/receive`
// (`ReceiveDto`, `ReceiveLineDto`; apps/api/src/modules/procurement/*.dto.ts)
// accepts, plus what a delivery note states that the DTO does not carry (the
// supplier, the note number, the date) and that the card shows for checking.
//
// NPI facts the rules follow:
//   qty        ≥ 0.001 per receive line, at most the PO line's open quantity
//   serials    when the item is serialised, exactly one per unit, no
//              duplicates — only the resolver knows whether the item is
//              serialised, so the schema judges only what it can see: the
//              count against the quantity, duplicates, and the model's own
//              doubt about a character (06 AT-05)
//   the GRN is created DRAFT; inspection and acceptance stay in NPI
import { z } from 'zod';
import type { components } from '../../npi/types';
import {
  codeField,
  dateNotFutureField,
  defined,
  nameField,
  quantityField,
  serialsField,
  textField,
  wire,
  type AssessFlags,
} from './common';
import type { AssessedField, WireField } from './field';

export const GrnLineOutputSchema = z.object({
  itemName: wire('اسم الصنف كما ورد (بلا كمية ولا أرقام تسلسلية)'),
  sku: wire('رمز الصنف إن ورد (مثل MOD-550)، وإلا «»'),
  qty: wire('الكمية المستلَمة فعلياً أرقاماً فقط'),
  unit: wire('وحدة القياس كما وردت (قطعة، متر، طقم…) إن ذُكرت، وإلا «»'),
  serials: wire('الأرقام التسلسلية للبند كما وردت حرفاً حرفاً، مفصولة بفاصلة منقوطة «;»، وإلا «»'),
  batchNo: wire('رقم الدفعة أو التشغيلة (Batch/Lot) إن ورد، وإلا «»'),
  notes: wire('ملاحظة على البند (نقص، تلف، مرفوض) إن وردت، وإلا «»'),
});

/** Exactly what the model must return. */
export const GrnOutputSchema = z.object({
  purchaseOrderCode: wire('رقم أمر الشراء الذي تُسلَّم البضاعة على أساسه (مثل PO-00007) إن ورد، وإلا «»'),
  deliveryNoteRef: wire('رقم إشعار التسليم أو سند التسليم كما ورد، وإلا «»'),
  deliveryDate: wire('تاريخ التسليم YYYY-MM-DD'),
  vendorName: wire('اسم المورّد الذي سلّم البضاعة كما ورد، وإلا «»'),
  projectCode: wire('كود المشروع (مثل PRJ-00012) إن ورد، وإلا «»'),
  locationName: wire('المستودع أو موقع الاستلام إن ذُكر، وإلا «»'),
  notes: wire('ملاحظات عامة على التسليم (تسليم جزئي، نقص، تلف) إن وردت، وإلا «»'),
  lines: z.array(GrnLineOutputSchema),
});

export type GrnOutput = z.infer<typeof GrnOutputSchema>;
export type GrnLineOutput = z.infer<typeof GrnLineOutputSchema>;

// ─── Plain values (what the builders and the eval compare) ─────────────────

export interface GrnLineValues {
  itemName: string;
  sku: string | null;
  qty: number;
  unit: string | null;
  serials: string[];
  batchNo: string | null;
  notes: string | null;
}

export interface GrnValues {
  purchaseOrderCode: string | null;
  deliveryNoteRef: string | null;
  deliveryDate: string | null;
  vendorName: string | null;
  projectCode: string | null;
  locationName: string | null;
  notes: string | null;
  lines: GrnLineValues[];
}

export interface AssessedGrnLine {
  itemName: AssessedField<string>;
  sku: AssessedField<string>;
  qty: AssessedField<number>;
  unit: AssessedField<string>;
  serials: AssessedField<string[]>;
  batchNo: AssessedField<string>;
  notes: AssessedField<string>;
}

export interface AssessedGrn {
  purchaseOrderCode: AssessedField<string>;
  deliveryNoteRef: AssessedField<string>;
  deliveryDate: AssessedField<string>;
  vendorName: AssessedField<string>;
  projectCode: AssessedField<string>;
  locationName: AssessedField<string>;
  notes: AssessedField<string>;
  lines: AssessedGrnLine[];
}

// ─── NPI DTO builders (the "mirror" guarantee, ADR-28) ─────────────────────

export type ReceiveDto = components['schemas']['ReceiveDto'];
export type ReceiveLineDto = components['schemas']['ReceiveLineDto'];

/** What `resolve.ts` found in NPI. Lines are aligned by index with
 *  `GrnValues.lines`. */
export interface GrnResolution {
  purchaseOrderId: string;
  locationId: string | null;
  lines: { poLineId: string; isSerialised: boolean }[];
}

/**
 * `POST /procurement/purchase-orders/{id}/receive` body. NPI requires one
 * serial per unit of a serialised item, so a serialised line without a full
 * list is a programming error here — the plan builder routes such a note to
 * the receiver first. The delivery-note number rides in `notes` (NPI has no
 * field for it).
 */
export function receiveDtoFrom(values: GrnValues, resolved: GrnResolution): ReceiveDto {
  if (resolved.lines.length !== values.lines.length) throw new Error('receiveDtoFrom: resolution lines do not match the extracted lines');
  const lines: ReceiveLineDto[] = values.lines.map((line, index) => {
    const r = resolved.lines[index];
    if (r.isSerialised && line.serials.length !== line.qty) throw new Error('receiveDtoFrom: serial numbers are required by NPI');
    return defined<ReceiveLineDto>({
      poLineId: r.poLineId,
      qty: line.qty,
      serials: line.serials.length > 0 ? line.serials : undefined,
      batchNo: line.batchNo ?? undefined,
    });
  });
  const noteParts = [values.deliveryNoteRef !== null ? `إشعار تسليم ${values.deliveryNoteRef}` : null, values.notes].filter(
    (p): p is string => p !== null,
  );
  return defined<ReceiveDto>({
    lines,
    notes: noteParts.length > 0 ? noteParts.join(' — ') : undefined,
    locationId: resolved.locationId ?? undefined,
  });
}

/** A batch number as the delivery note labels it — «دفعة B-2026-09»,
 *  «Lot: 7781», «رقم التشغيلة 12» — reduced to the code alone (first live
 *  eval, grn-02: the model copied the label word into the value). The label
 *  must be followed by a colon or a space: «LOT-7781» is itself a code. */
const BATCH_LABEL_RE = /^(?:رقم\s+)?(?:ال)?(?:دفعة|تشغيلة|batch|lot)(?:\s*(?:no\.?|#|رقم))?(?:\s*[:：]\s*|\s+)/i;

export function batchNoField(w: WireField): AssessedField<string> {
  return textField({ ...w, value: w.value.trim().replace(BATCH_LABEL_RE, '').trim() });
}

// ─── Server-side validation and confidence (02 §5.5) ───────────────────────

/**
 * Turns the model's output into assessed fields and plain values:
 *  - the PO and project codes must look like codes (`code_format`);
 *  - a delivery dated after today is unconfirmed (`date_future`);
 *  - a line's serials are split, uppercased and ASCII-digited; a count that
 *    differs from the quantity, a repeated serial, or a model doubt below
 *    0.8 leaves the whole list unconfirmed (AT-05);
 *  - a line is usable when it names an item and a valid quantity > 0;
 *    `values.lines` keeps usable lines only (order preserved) and `values`
 *    is null when none is usable.
 */
export function assessGrn(out: GrnOutput, flags: AssessFlags = { ligatureSuspect: false }): { assessed: AssessedGrn; values: GrnValues | null } {
  const lines: AssessedGrnLine[] = out.lines.map((l) => {
    const qty = quantityField(l.qty);
    return {
      itemName: textField(l.itemName),
      sku: textField({ ...l.sku, value: l.sku.value.trim().toUpperCase() }),
      qty,
      unit: textField(l.unit),
      serials: serialsField(l.serials, qty.value),
      batchNo: batchNoField(l.batchNo),
      notes: textField(l.notes),
    };
  });

  const isUsable = (l: AssessedGrnLine): boolean =>
    l.itemName.value !== null && l.qty.value !== null && l.qty.value > 0 && !l.qty.warnings.includes('extract.warn.quantity');
  const usableLines = lines.filter(isUsable);

  const assessed: AssessedGrn = {
    purchaseOrderCode: codeField(out.purchaseOrderCode),
    deliveryNoteRef: textField(out.deliveryNoteRef),
    deliveryDate: dateNotFutureField(out.deliveryDate, flags),
    vendorName: nameField(out.vendorName, flags),
    projectCode: codeField(out.projectCode),
    locationName: textField(out.locationName),
    notes: textField(out.notes),
    lines,
  };

  if (usableLines.length === 0) return { assessed, values: null };

  const values: GrnValues = {
    purchaseOrderCode: assessed.purchaseOrderCode.value,
    deliveryNoteRef: assessed.deliveryNoteRef.value,
    deliveryDate: assessed.deliveryDate.value,
    vendorName: assessed.vendorName.value,
    projectCode: assessed.projectCode.value,
    locationName: assessed.locationName.value,
    notes: assessed.notes.value,
    lines: usableLines.map(
      (l): GrnLineValues => ({
        itemName: l.itemName.value as string,
        sku: l.sku.value,
        qty: l.qty.value as number,
        unit: l.unit.value,
        serials: l.serials.value ?? [],
        batchNo: l.batchNo.value,
        notes: l.notes.value,
      }),
    ),
  };
  return { assessed, values };
}
