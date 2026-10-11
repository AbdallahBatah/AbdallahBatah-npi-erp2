// Vendor-bill extraction schema (T-25, F-09, spec 02 §5.5, ADR-28).
//
// The input is a supplier's tax invoice — most often a phone photo reaching
// the model as vision blocks under a consent event — or a sentence from the
// accountant («سجّل فاتورة المورد رقم INV-2026-0912 على أمر الشراء PO-00007
// والاستلام GRN-00003»). NPI's `POST /procurement/bills` (`CreateBillDto`)
// takes only `{ goodsReceiptId, vendorRef? }`: the bill's printed amounts are
// NOT sent — NPI computes subtotal, VAT and total from the accepted GRN's
// quantities × the PO prices and runs the three-way match itself. The
// extraction therefore exists to (a) find the goods receipt the bill refers
// to, (b) carry the invoice number as `vendorRef`, and (c) give the
// accountant the printed amounts to compare with NPI's before the bill is
// created (`billTotalWarnings` in resolve.ts). The line and totals checks are
// the same as for a quotation (common.ts `reconcileLine` / `reconcileTotals`).
import { z } from 'zod';
import type { components } from '../../npi/types';
import {
  amountField,
  codeField,
  currencyField,
  dateField,
  dateNotFutureField,
  defined,
  quantityField,
  reconcileLine,
  reconcileTotals,
  textField,
  wire,
  NO_FLAGS,
  type AssessFlags,
} from './common';
import type { AssessedField } from './field';
import { assessVendor, VendorOutputSchema, type AssessedVendor, type VendorValues } from './po';

export const BillLineOutputSchema = z.object({
  itemName: wire('اسم الصنف كما ورد (بلا كمية ولا سعر)'),
  sku: wire('رمز الصنف إن ورد (مثل MOD-550)، وإلا «»'),
  qty: wire('الكمية أرقاماً فقط'),
  unit: wire('وحدة القياس كما وردت إن ذُكرت، وإلا «»'),
  unitPrice: wire('سعر الوحدة قبل الضريبة أرقاماً فقط'),
  lineTotal: wire('إجمالي البند قبل الضريبة أرقاماً فقط إن ورد، وإلا «»'),
});

/** Exactly what the model must return. */
export const VendorBillOutputSchema = z.object({
  vendor: VendorOutputSchema,
  invoiceNumber: wire('رقم الفاتورة كما ورد، وإلا «»'),
  invoiceDate: wire('تاريخ الفاتورة YYYY-MM-DD'),
  dueDate: wire('تاريخ الاستحقاق YYYY-MM-DD إن ذُكر صريحاً، وإلا «»'),
  purchaseOrderCode: wire('رقم أمر الشراء المرجعي (مثل PO-00007) إن ورد، وإلا «»'),
  goodsReceiptCode: wire('رقم سند الاستلام في نظامنا (مثل GRN-00003) إن ورد، وإلا «»'),
  deliveryNoteRef: wire('رقم إشعار التسليم إن ورد، وإلا «»'),
  projectCode: wire('كود المشروع (مثل PRJ-00012) إن ورد، وإلا «»'),
  currency: wire('رمز العملة بثلاثة أحرف إن ذُكرت عملة غير الريال، وإلا «»'),
  subtotal: wire('المجموع قبل ضريبة القيمة المضافة أرقاماً فقط'),
  vatAmount: wire('مبلغ ضريبة القيمة المضافة أرقاماً فقط إن ورد'),
  total: wire('الإجمالي شامل الضريبة أرقاماً فقط إن ورد'),
  lines: z.array(BillLineOutputSchema),
});

export type VendorBillOutput = z.infer<typeof VendorBillOutputSchema>;
export type BillLineOutput = z.infer<typeof BillLineOutputSchema>;

// ─── Plain values (what the builders and the eval compare) ─────────────────

export interface BillLineValues {
  itemName: string;
  sku: string | null;
  qty: number;
  unit: string | null;
  unitPrice: number | null;
  lineTotal: number | null;
}

export interface VendorBillValues {
  vendor: VendorValues | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  purchaseOrderCode: string | null;
  goodsReceiptCode: string | null;
  deliveryNoteRef: string | null;
  projectCode: string | null;
  currency: string | null;
  subtotal: number | null;
  vatAmount: number | null;
  total: number | null;
  lines: BillLineValues[];
}

export interface AssessedBillLine {
  itemName: AssessedField<string>;
  sku: AssessedField<string>;
  qty: AssessedField<number>;
  unit: AssessedField<string>;
  unitPrice: AssessedField<number>;
  lineTotal: AssessedField<number>;
}

export interface AssessedVendorBill {
  vendor: AssessedVendor;
  invoiceNumber: AssessedField<string>;
  invoiceDate: AssessedField<string>;
  dueDate: AssessedField<string>;
  purchaseOrderCode: AssessedField<string>;
  goodsReceiptCode: AssessedField<string>;
  deliveryNoteRef: AssessedField<string>;
  projectCode: AssessedField<string>;
  currency: AssessedField<string>;
  subtotal: AssessedField<number>;
  vatAmount: AssessedField<number>;
  total: AssessedField<number>;
  lines: AssessedBillLine[];
}

// ─── NPI DTO builder (the "mirror" guarantee, ADR-28) ──────────────────────

export type CreateBillDto = components['schemas']['CreateBillDto'];

/** `POST /procurement/bills` body. The printed amounts are not sent: NPI
 *  recomputes them from the accepted receipt and runs the three-way match. */
export function billDtoFrom(values: VendorBillValues, resolved: { goodsReceiptId: string }): CreateBillDto {
  return defined<CreateBillDto>({
    goodsReceiptId: resolved.goodsReceiptId,
    vendorRef: values.invoiceNumber ?? undefined,
  });
}

// ─── Server-side validation and confidence (02 §5.5) ───────────────────────

/**
 * Turns the model's output into assessed fields and plain values, with the
 * same line and totals checks as a quotation (derived unit price,
 * `line_total`, `lines_sum`, `vat_total`), plus:
 *  - an invoice dated after today is unconfirmed (`date_future`);
 *  - a due date must be a date (a payment term in words is `date_format`);
 *  - `values.vendor` is null without a vendor name; `values` is null when
 *    there is neither a usable line nor a total (an unreadable photo) — a
 *    bill with a total and no lines is still matchable against the receipt.
 */
export function assessVendorBill(
  out: VendorBillOutput,
  flags: AssessFlags = NO_FLAGS,
): { assessed: AssessedVendorBill; values: VendorBillValues | null } {
  const { assessed: vendor, values: vendorValues } = assessVendor(out.vendor, flags);

  let subtotal = amountField(out.subtotal);
  let vatAmount = amountField(out.vatAmount);
  let total = amountField(out.total);

  const lines: AssessedBillLine[] = out.lines.map((l) => {
    const { qty, unitPrice, lineTotal } = reconcileLine({
      qty: quantityField(l.qty),
      unitPrice: amountField(l.unitPrice),
      lineTotal: amountField(l.lineTotal),
    });
    return {
      itemName: textField(l.itemName),
      sku: textField({ ...l.sku, value: l.sku.value.trim().toUpperCase() }),
      qty,
      unit: textField(l.unit),
      unitPrice,
      lineTotal,
    };
  });

  const isUsable = (l: AssessedBillLine): boolean =>
    l.itemName.value !== null && l.qty.value !== null && l.qty.value > 0 && !l.qty.warnings.includes('extract.warn.quantity');
  const usableLines = lines.filter(isUsable);

  ({ subtotal, vatAmount, total } = reconcileTotals(lines, isUsable, { subtotal, vatAmount, total }));

  const assessed: AssessedVendorBill = {
    vendor,
    invoiceNumber: textField(out.invoiceNumber),
    invoiceDate: dateNotFutureField(out.invoiceDate, flags),
    dueDate: dateField(out.dueDate),
    purchaseOrderCode: codeField(out.purchaseOrderCode),
    goodsReceiptCode: codeField(out.goodsReceiptCode),
    deliveryNoteRef: textField(out.deliveryNoteRef),
    projectCode: codeField(out.projectCode),
    currency: currencyField(out.currency),
    subtotal,
    vatAmount,
    total,
    lines,
  };

  if (usableLines.length === 0 && total.value === null) return { assessed, values: null };

  const values: VendorBillValues = {
    vendor: vendorValues,
    invoiceNumber: assessed.invoiceNumber.value,
    invoiceDate: assessed.invoiceDate.value,
    dueDate: assessed.dueDate.value,
    purchaseOrderCode: assessed.purchaseOrderCode.value,
    goodsReceiptCode: assessed.goodsReceiptCode.value,
    deliveryNoteRef: assessed.deliveryNoteRef.value,
    projectCode: assessed.projectCode.value,
    currency: assessed.currency.value,
    subtotal: subtotal.value,
    vatAmount: vatAmount.value,
    total: total.value,
    lines: usableLines.map(
      (l): BillLineValues => ({
        itemName: l.itemName.value as string,
        sku: l.sku.value,
        qty: l.qty.value as number,
        unit: l.unit.value,
        unitPrice: l.unitPrice.value,
        lineTotal: l.lineTotal.value,
      }),
    ),
  };
  return { assessed, values };
}
