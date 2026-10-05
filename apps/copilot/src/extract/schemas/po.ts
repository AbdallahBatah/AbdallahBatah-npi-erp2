// Purchase-order extraction schema (T-24, F-07, spec 02 §5.5, ADR-28).
//
// The input is a vendor quotation (a price offer, usually a PDF) or a
// sentence that names an approved requisition («سوّ أمر شراء من الطلب
// PR-00012 على شركة الخليج»). The model's JSON mirrors what NPI's
// `POST /procurement/purchase-orders` (`CreatePoDto`, `PoLineDto`),
// `POST /procurement/vendors` (`CreateVendorDto`) and
// `POST /requisitions/{id}/convert` (`ConvertToPoDto`) accept
// (apps/api/src/modules/procurement/*.dto.ts), plus what a quote states
// that those DTOs do not carry but the server checks: line totals, the
// subtotal, the VAT and the grand total. Those checks catch the commonest
// quote error — a printed total that is not quantity × price — before the
// user approves a purchase order on it.
//
// NPI facts the rules follow:
//   unitPrice   REQUIRED on a PO line, ≥ 0 (a requisition's estimate is
//               optional, a PO's price is not)
//   currency    defaults to SAR on NPI's side when omitted
//   vendorType  ['SUPPLIER','SUBCONTRACTOR','OEM','SERVICE']   procurement/dto.ts
//   vatNumber   /^(3\d{13}3)?$/                                 packages/shared/src/vat.ts
import { z } from 'zod';
import type { components } from '../../npi/types';
import { assessField, type AssessedField } from './field';
import {
  amountField,
  amountTolerance,
  asciiDigits,
  codeField,
  currencyField,
  dateField,
  dateNotPastField,
  defined,
  EMAIL_RE,
  enumField,
  identifierField,
  nameField,
  quantityField,
  round2,
  SAUDI_CR_RE,
  SAUDI_VAT_RE,
  textField,
  withWarning,
  wire,
  type AssessFlags,
} from './common';

export const VENDOR_TYPES = ['SUPPLIER', 'SUBCONTRACTOR', 'OEM', 'SERVICE'] as const;
export type VendorType = (typeof VENDOR_TYPES)[number];

export const VendorOutputSchema = z.object({
  nameAr: wire('اسم المورّد كما ورد (غالباً عنصر نائب ⟦جهة_n⟧)'),
  nameEn: wire('اسم المورّد بالإنجليزية إن ورد صراحةً، وإلا «»'),
  vendorType: wire(`one of ${VENDOR_TYPES.join(' | ')}`),
  vatNumber: wire('الرقم الضريبي للمورّد كما ورد'),
  crNumber: wire('السجل التجاري للمورّد كما ورد'),
  phone: wire('هاتف المورّد كما ورد'),
  email: wire('بريد المورّد كما ورد'),
});

export const PoLineOutputSchema = z.object({
  itemName: wire('اسم الصنف كما ورد (بلا كمية ولا سعر)'),
  sku: wire('رمز الصنف إن ورد (مثل MOD-550)، وإلا «»'),
  qty: wire('الكمية أرقاماً فقط'),
  unit: wire('وحدة القياس كما وردت (قطعة، متر، طقم…) إن ذُكرت، وإلا «»'),
  unitPrice: wire('سعر الوحدة قبل الضريبة أرقاماً فقط'),
  lineTotal: wire('إجمالي البند قبل الضريبة أرقاماً فقط إن ورد، وإلا «»'),
  wbsCode: wire('كود بند العمل (WBS) إن ورد، وإلا «»'),
  wbsName: wire('اسم بند العمل إن ورد، وإلا «»'),
});

/** Exactly what the model must return. */
export const PoOutputSchema = z.object({
  vendor: VendorOutputSchema,
  quoteRef: wire('رقم عرض السعر كما ورد، وإلا «»'),
  quoteDate: wire('تاريخ العرض YYYY-MM-DD'),
  validUntil: wire('تاريخ انتهاء صلاحية العرض YYYY-MM-DD إن ذُكر صريحاً، وإلا «»'),
  sourceRequisitionCode: wire('رقم طلب الشراء المعتمد الذي يُبنى عليه الأمر (مثل PR-00012) إن ورد، وإلا «»'),
  projectCode: wire('كود المشروع كما ورد (مثل PRJ-00012)، وإلا «»'),
  projectName: wire('اسم المشروع إن ورد بالاسم، وإلا «»'),
  currency: wire('رمز العملة بثلاثة أحرف إن ذُكرت عملة غير الريال، وإلا «»'),
  subtotal: wire('المجموع قبل ضريبة القيمة المضافة أرقاماً فقط'),
  vatAmount: wire('مبلغ ضريبة القيمة المضافة أرقاماً فقط إن ورد'),
  total: wire('الإجمالي شامل الضريبة أرقاماً فقط إن ورد'),
  lines: z.array(PoLineOutputSchema),
});

export type PoOutput = z.infer<typeof PoOutputSchema>;
export type VendorOutput = z.infer<typeof VendorOutputSchema>;
export type PoLineOutput = z.infer<typeof PoLineOutputSchema>;

// ─── Plain values (what the builders and the eval compare) ─────────────────

export interface VendorValues {
  nameAr: string;
  nameEn: string | null;
  vendorType: VendorType | null;
  vatNumber: string | null;
  crNumber: string | null;
  phone: string | null;
  email: string | null;
}

export interface PoLineValues {
  itemName: string;
  sku: string | null;
  qty: number;
  unit: string | null;
  unitPrice: number | null;
  lineTotal: number | null;
  wbsCode: string | null;
  wbsName: string | null;
}

export interface PoValues {
  vendor: VendorValues | null;
  quoteRef: string | null;
  quoteDate: string | null;
  validUntil: string | null;
  sourceRequisitionCode: string | null;
  projectCode: string | null;
  projectName: string | null;
  currency: string | null;
  subtotal: number | null;
  vatAmount: number | null;
  total: number | null;
  lines: PoLineValues[];
}

export interface AssessedVendor {
  nameAr: AssessedField<string>;
  nameEn: AssessedField<string>;
  vendorType: AssessedField<VendorType>;
  vatNumber: AssessedField<string>;
  crNumber: AssessedField<string>;
  phone: AssessedField<string>;
  email: AssessedField<string>;
}

export interface AssessedPoLine {
  itemName: AssessedField<string>;
  sku: AssessedField<string>;
  qty: AssessedField<number>;
  unit: AssessedField<string>;
  unitPrice: AssessedField<number>;
  lineTotal: AssessedField<number>;
  wbsCode: AssessedField<string>;
  wbsName: AssessedField<string>;
}

export interface AssessedPo {
  vendor: AssessedVendor;
  quoteRef: AssessedField<string>;
  quoteDate: AssessedField<string>;
  validUntil: AssessedField<string>;
  sourceRequisitionCode: AssessedField<string>;
  projectCode: AssessedField<string>;
  projectName: AssessedField<string>;
  currency: AssessedField<string>;
  subtotal: AssessedField<number>;
  vatAmount: AssessedField<number>;
  total: AssessedField<number>;
  lines: AssessedPoLine[];
}

// ─── NPI DTO builders (the "mirror" guarantee, ADR-28) ─────────────────────

export type CreatePoDto = components['schemas']['CreatePoDto'];
export type PoLineDto = components['schemas']['PoLineDto'];
export type CreateVendorDto = components['schemas']['CreateVendorDto'];
export type ConvertToPoDto = components['schemas']['ConvertToPoDto'];

/** What `resolve.ts` found in NPI. Lines are aligned by index with
 *  `PoValues.lines`. */
export interface PoResolution {
  vendorId: string;
  projectId: string | null;
  lines: { itemId: string; wbsElementId: string | null }[];
}

/**
 * `POST /procurement/purchase-orders` body. NPI requires a price on every
 * line, so a line without one is a programming error here — the plan
 * builder routes such a quote to the user first. NPI defaults the currency
 * to SAR, so it is sent only when the quote states another.
 */
export function poDtoFrom(values: PoValues, resolved: PoResolution): CreatePoDto {
  if (resolved.lines.length !== values.lines.length) throw new Error('poDtoFrom: resolution lines do not match the extracted lines');
  const lines: PoLineDto[] = values.lines.map((line, index) => {
    if (line.unitPrice === null) throw new Error('poDtoFrom: unit price is required by NPI');
    const r = resolved.lines[index];
    return defined<PoLineDto>({
      itemId: r.itemId,
      qty: line.qty,
      unitPrice: round2(line.unitPrice),
      wbsElementId: r.wbsElementId ?? undefined,
    });
  });
  return defined<CreatePoDto>({
    vendorId: resolved.vendorId,
    lines,
    currency: values.currency === null ? undefined : values.currency.toUpperCase(),
    projectId: resolved.projectId ?? undefined,
  });
}

/**
 * `POST /procurement/vendors` body for a vendor the quote names and NPI does
 * not have. `nameEn` is required by NPI, so the Arabic name is repeated when
 * the quote carries no English one (same as customers). Only a VAT number in
 * NPI's format is sent; an invalid one stays on the card as unconfirmed.
 */
export function vendorDtoFrom(v: VendorValues): CreateVendorDto {
  const dto: CreateVendorDto = {
    nameAr: v.nameAr,
    nameEn: v.nameEn ?? v.nameAr,
    vatNumber: v.vatNumber !== null && SAUDI_VAT_RE.test(v.vatNumber) ? v.vatNumber : undefined,
    crNumber: v.crNumber ?? undefined,
    phone: v.phone ?? undefined,
    email: v.email ?? undefined,
  };
  // The generated type renders NPI's enums as `Record<string, never>`
  // (see customer_contract.ts); the wire value is the plain string.
  const body = defined(dto) as Record<string, unknown>;
  if (v.vendorType !== null) body.vendorType = v.vendorType;
  return body as CreateVendorDto;
}

/** `POST /requisitions/{id}/convert` body — an approved PR
 *  becomes a PO. `prices` carries only what differs from the estimates. */
export function convertToPoDtoFrom(
  vendorId: string,
  prices: { requisitionLineId: string; unitPrice: number }[],
  currency: string | null = null,
): ConvertToPoDto {
  return defined<ConvertToPoDto>({
    vendorId,
    currency: currency === null ? undefined : currency.toUpperCase(),
    prices: prices.length > 0 ? prices.map((p) => ({ requisitionLineId: p.requisitionLineId, unitPrice: round2(p.unitPrice) })) : undefined,
  });
}

// ─── Server-side validation and confidence (02 §5.5) ───────────────────────

/** Saudi VAT rate, for the «subtotal + VAT = total» check. */
const VAT_RATE = 0.15;

/**
 * Turns the model's output into assessed fields and plain values:
 *  - the vendor's identifiers as in the customer flow (VAT in NPI's format,
 *    CR of 10 digits, a plausible e-mail, an enum type);
 *  - a line stating a total but no unit price gets `unitPrice = total / qty`,
 *    marked `derived`; a line stating both must agree (`line_total` on both
 *    when it does not);
 *  - when every line has a price and the quote states a subtotal, the lines
 *    must add up to it (`lines_sum` on the subtotal and every price);
 *  - the grand total must be the subtotal plus the stated VAT, or plus 15 %
 *    of the subtotal when none is stated (`vat_total`);
 *  - `values.vendor` is null without a vendor name; `values` is null when
 *    there is neither a usable line nor a source requisition code (a
 *    sentence naming an approved PR has no lines and is still actionable).
 */
export function assessPo(out: PoOutput, flags: AssessFlags = { ligatureSuspect: false }): { assessed: AssessedPo; values: PoValues | null } {
  const v = out.vendor;
  const vendor: AssessedVendor = {
    nameAr: nameField(v.nameAr, flags),
    nameEn: textField(v.nameEn),
    vendorType: enumField(v.vendorType, VENDOR_TYPES),
    vatNumber: identifierField(v.vatNumber, SAUDI_VAT_RE, 'extract.warn.vat_format'),
    crNumber: identifierField(v.crNumber, SAUDI_CR_RE, 'extract.warn.cr_format'),
    phone: textField({ ...v.phone, value: asciiDigits(v.phone.value) }),
    email: textField(v.email, (value) => (EMAIL_RE.test(value) ? [] : ['extract.warn.email_format'])),
  };

  let subtotal = amountField(out.subtotal);
  let vatAmount = amountField(out.vatAmount);
  let total = amountField(out.total);

  const lines: AssessedPoLine[] = out.lines.map((l) => {
    const qty = quantityField(l.qty);
    let unitPrice = amountField(l.unitPrice);
    let lineTotal = amountField(l.lineTotal);
    if (unitPrice.value === null && lineTotal.value !== null && qty.value !== null && qty.value > 0) {
      unitPrice = assessField(
        {
          value: round2(lineTotal.value / qty.value),
          confidence: Math.min(lineTotal.confidence, qty.confidence),
          evidence: lineTotal.evidence,
          page: lineTotal.page,
        },
        ['extract.warn.derived'],
      );
    } else if (unitPrice.value !== null && lineTotal.value !== null && qty.value !== null) {
      if (Math.abs(qty.value * unitPrice.value - lineTotal.value) > amountTolerance(lineTotal.value)) {
        lineTotal = withWarning(lineTotal, 'extract.warn.line_total');
        unitPrice = withWarning(unitPrice, 'extract.warn.line_total');
      }
    }
    return {
      itemName: textField(l.itemName),
      sku: textField({ ...l.sku, value: l.sku.value.trim().toUpperCase() }),
      qty,
      unit: textField(l.unit),
      unitPrice,
      lineTotal,
      wbsCode: codeField(l.wbsCode),
      wbsName: textField(l.wbsName),
    };
  });

  const isUsable = (l: AssessedPoLine): boolean =>
    l.itemName.value !== null && l.qty.value !== null && l.qty.value > 0 && !l.qty.warnings.includes('extract.warn.quantity');
  const usableLines = lines.filter(isUsable);

  if (subtotal.value !== null && usableLines.length > 0 && usableLines.every((l) => l.unitPrice.value !== null)) {
    const sum = usableLines.reduce((acc, l) => acc + (l.qty.value as number) * (l.unitPrice.value as number), 0);
    if (Math.abs(sum - subtotal.value) > amountTolerance(subtotal.value)) {
      subtotal = withWarning(subtotal, 'extract.warn.lines_sum');
      for (const l of usableLines) l.unitPrice = withWarning(l.unitPrice, 'extract.warn.lines_sum');
    }
  }

  if (subtotal.value !== null && total.value !== null) {
    const expected = subtotal.value + (vatAmount.value ?? round2(subtotal.value * VAT_RATE));
    if (Math.abs(expected - total.value) > amountTolerance(total.value)) {
      total = withWarning(total, 'extract.warn.vat_total');
      if (vatAmount.value !== null) vatAmount = withWarning(vatAmount, 'extract.warn.vat_total');
    }
  }

  const assessed: AssessedPo = {
    vendor,
    quoteRef: textField(out.quoteRef),
    quoteDate: dateField(out.quoteDate),
    validUntil: dateNotPastField(out.validUntil, flags),
    sourceRequisitionCode: codeField(out.sourceRequisitionCode),
    projectCode: codeField(out.projectCode),
    projectName: textField(out.projectName),
    currency: currencyField(out.currency),
    subtotal,
    vatAmount,
    total,
    lines,
  };

  const nameAr = vendor.nameAr.value;
  const vendorValues: VendorValues | null =
    nameAr === null
      ? null
      : {
          nameAr,
          nameEn: vendor.nameEn.value,
          vendorType: vendor.vendorType.value,
          vatNumber: vendor.vatNumber.value,
          crNumber: vendor.crNumber.value,
          phone: vendor.phone.value,
          email: vendor.email.value,
        };

  const lineValues = usableLines.map(
    (l): PoLineValues => ({
      itemName: l.itemName.value as string,
      sku: l.sku.value,
      qty: l.qty.value as number,
      unit: l.unit.value,
      unitPrice: l.unitPrice.value,
      lineTotal: l.lineTotal.value,
      wbsCode: l.wbsCode.value,
      wbsName: l.wbsName.value,
    }),
  );

  const values: PoValues | null =
    lineValues.length === 0 && assessed.sourceRequisitionCode.value === null
      ? null
      : {
          vendor: vendorValues,
          quoteRef: assessed.quoteRef.value,
          quoteDate: assessed.quoteDate.value,
          validUntil: assessed.validUntil.value,
          sourceRequisitionCode: assessed.sourceRequisitionCode.value,
          projectCode: assessed.projectCode.value,
          projectName: assessed.projectName.value,
          currency: assessed.currency.value,
          subtotal: subtotal.value,
          vatAmount: vatAmount.value,
          total: total.value,
          lines: lineValues,
        };

  return { assessed, values };
}
