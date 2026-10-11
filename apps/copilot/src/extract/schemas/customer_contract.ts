// Customer-contract extraction schema (T-23, F-05, spec 02 §5.5, ADR-28).
//
// The model's JSON mirrors what NPI's `POST /customers` and `POST /contracts`
// accept — `CreateCustomerDto`, `CreateContractDto`, `MilestoneInputDto`
// (apps/api/src/modules/crm/dto.ts and commercial/dto.ts) — one `WireField`
// per DTO property, plus the one thing a contract states that the DTO
// derives (`percent` on a milestone). `assessCustomerContract` parses and
// validates the wire form into typed, assessed fields; the builders at the
// bottom turn validated values into the generated DTO types from
// `src/npi/types.ts`, so a change in NPI's OpenAPI document fails `tsc` here
// instead of surfacing as a 422 at execution time.
//
// Enum values and formats are copied from NPI's own validators, not from
// the OpenAPI document (which renders enums as `{ type: object }` — see
// `CreateItemDto` in src/npi/client.ts for the same workaround):
//   contractType   ['EPC','PPA','OM','LEASE']                  commercial/dto.ts:15
//   triggerType    ['DATE','PROGRESS','EVENT']                 commercial/dto.ts:16
//   customerType   ['RESIDENTIAL','CI','UTILITY','GOVERNMENT'] crm/dto.ts:20
//   vatNumber      /^(3\d{13}3)?$/                             packages/shared/src/vat.ts
import { z } from 'zod';
import type { components } from '../../npi/types';
import { assessField, type AssessedField } from './field';
import {
  amountField,
  amountTolerance,
  asciiDigits,
  dateField,
  defined,
  EMAIL_RE,
  enumField,
  identifierField,
  integerField,
  ISO_DATE_RE,
  nameField,
  parseNumber,
  percentField,
  SAUDI_CR_RE,
  SAUDI_VAT_RE,
  textField,
  withWarning,
  wire,
  NO_FLAGS,
  type AssessFlags,
} from './common';

// Tests (and the eval) import these from here; the definitions live in ./common.
export { asciiDigits, parseNumber, ISO_DATE_RE, SAUDI_CR_RE, SAUDI_VAT_RE };
export type { AssessFlags };

export const CONTRACT_TYPES = ['EPC', 'PPA', 'OM', 'LEASE'] as const;
export const MILESTONE_TRIGGER_TYPES = ['DATE', 'PROGRESS', 'EVENT'] as const;
export const CUSTOMER_TYPES = ['RESIDENTIAL', 'CI', 'UTILITY', 'GOVERNMENT'] as const;

export type ContractType = (typeof CONTRACT_TYPES)[number];
export type MilestoneTriggerType = (typeof MILESTONE_TRIGGER_TYPES)[number];
export type CustomerType = (typeof CUSTOMER_TYPES)[number];

export const MilestoneOutputSchema = z.object({
  sequence: wire('ترتيب الدفعة، رقم يبدأ من 1'),
  descriptionAr: wire('وصف الدفعة بالعربية كما ورد'),
  descriptionEn: wire('وصف الدفعة بالإنجليزية إن ورد، وإلا «»'),
  amount: wire('المبلغ بالريال أرقاماً فقط إن ذُكر مبلغ، وإلا «»'),
  percent: wire('النسبة من قيمة العقد (0–100) أرقاماً فقط إن ذُكرت نسبة، وإلا «»'),
  dueDate: wire('تاريخ الاستحقاق الميلادي YYYY-MM-DD إن ذُكر، وإلا «»'),
  triggerType: wire(`one of ${MILESTONE_TRIGGER_TYPES.join(' | ')}`),
});

export const CustomerOutputSchema = z.object({
  nameAr: wire('اسم العميل كما ورد (غالباً عنصر نائب ⟦جهة_n⟧)'),
  nameEn: wire('اسم العميل بالإنجليزية إن ورد صراحةً، وإلا «»'),
  customerType: wire(`one of ${CUSTOMER_TYPES.join(' | ')}`),
  vatNumber: wire('الرقم الضريبي للعميل كما ورد (عنصر نائب أو أرقام)'),
  crNumber: wire('السجل التجاري للعميل كما ورد'),
  phone: wire('هاتف العميل كما ورد'),
  email: wire('بريد العميل كما ورد'),
});

/** Exactly what the model must return. */
export const CustomerContractOutputSchema = z.object({
  customer: CustomerOutputSchema,
  contractType: wire(`one of ${CONTRACT_TYPES.join(' | ')}`),
  startDate: wire('تاريخ البدء YYYY-MM-DD'),
  endDate: wire('تاريخ الانتهاء YYYY-MM-DD'),
  totalValue: wire('قيمة العقد بالريال قبل ضريبة القيمة المضافة، أرقاماً فقط'),
  retentionPct: wire('نسبة المحتجزات 0–100 أرقاماً فقط'),
  advancePct: wire('نسبة الدفعة المقدمة 0–100 أرقاماً فقط'),
  milestones: z.array(MilestoneOutputSchema),
});

export type CustomerContractOutput = z.infer<typeof CustomerContractOutputSchema>;
export type MilestoneOutput = z.infer<typeof MilestoneOutputSchema>;

// ─── Plain values (what the builders and the eval compare) ─────────────────

export interface MilestoneValues {
  sequence: number;
  descriptionAr: string;
  descriptionEn: string | null;
  amount: number | null;
  percent: number | null;
  dueDate: string | null;
  triggerType: MilestoneTriggerType | null;
}

export interface CustomerValues {
  nameAr: string;
  nameEn: string | null;
  customerType: CustomerType | null;
  vatNumber: string | null;
  crNumber: string | null;
  phone: string | null;
  email: string | null;
}

export interface CustomerContractValues {
  customer: CustomerValues;
  contractType: ContractType;
  startDate: string | null;
  endDate: string | null;
  totalValue: number | null;
  retentionPct: number | null;
  advancePct: number | null;
  milestones: MilestoneValues[];
}

// ─── NPI DTO builders (the "mirror" guarantee, ADR-28) ─────────────────────

export type CreateCustomerDto = components['schemas']['CreateCustomerDto'];
export type CreateContractDto = components['schemas']['CreateContractDto'];
export type MilestoneInputDto = components['schemas']['MilestoneInputDto'];

/**
 * `POST /customers` body for a customer the document names and NPI does not
 * have. `nameEn` is required by NPI (`@MinLength(1)`); when the contract
 * carries no English name the Arabic one is repeated, which is what NPI's
 * own form accepts and what the user can correct on the preview card.
 * Only a VAT number in NPI's format is sent (`@Matches(SAUDI_VAT_OR_EMPTY_RE)`
 * would reject the request otherwise) — an invalid one stays on the card as
 * unconfirmed and is never silently forwarded.
 */
export function customerDtoFrom(c: CustomerValues): CreateCustomerDto {
  const dto: CreateCustomerDto = {
    nameAr: c.nameAr,
    nameEn: c.nameEn ?? c.nameAr,
    vatNumber: c.vatNumber !== null && SAUDI_VAT_RE.test(c.vatNumber) ? c.vatNumber : undefined,
    crNumber: c.crNumber ?? undefined,
    phone: c.phone ?? undefined,
    email: c.email ?? undefined,
  };
  // The generated type renders NPI's enums as `Record<string, never>` (see
  // the file-top note); the wire value is the plain string.
  const body = defined(dto) as Record<string, unknown>;
  if (c.customerType !== null) body.customerType = c.customerType;
  return body as CreateCustomerDto;
}

/** `MilestoneInputDto[]` — amounts must already be resolved (a percent-only
 *  milestone is converted by the assessment before this is called). */
export function milestoneDtosFrom(milestones: MilestoneValues[]): MilestoneInputDto[] {
  return milestones.map((m) => {
    const dto: MilestoneInputDto = {
      sequence: m.sequence,
      descriptionAr: m.descriptionAr,
      descriptionEn: m.descriptionEn ?? m.descriptionAr,
      amount: m.amount ?? 0,
      dueDate: m.dueDate ?? undefined,
    };
    const body = defined(dto) as Record<string, unknown>;
    if (m.triggerType !== null) body.triggerType = m.triggerType;
    return body as MilestoneInputDto;
  });
}

/** `POST /contracts` body for a standalone contract on `customerId`
 *  (no proposal revision — the copilot never links one). */
export function contractDtoFrom(values: CustomerContractValues, customerId: string): CreateContractDto {
  const dto: CreateContractDto = {
    customerId,
    contractType: {} as CreateContractDto['contractType'],
    startDate: values.startDate ?? undefined,
    endDate: values.endDate ?? undefined,
    totalValue: values.totalValue ?? undefined,
    retentionPct: values.retentionPct ?? undefined,
    advancePct: values.advancePct ?? undefined,
    milestones: values.milestones.length > 0 ? milestoneDtosFrom(values.milestones) : undefined,
  };
  const body = defined(dto) as Record<string, unknown>;
  body.contractType = values.contractType;
  return body as CreateContractDto;
}

// ─── Server-side validation and confidence (02 §5.5) ───────────────────────

export interface AssessedCustomer {
  nameAr: AssessedField<string>;
  nameEn: AssessedField<string>;
  customerType: AssessedField<CustomerType>;
  vatNumber: AssessedField<string>;
  crNumber: AssessedField<string>;
  phone: AssessedField<string>;
  email: AssessedField<string>;
}

export interface AssessedMilestone {
  sequence: AssessedField<number>;
  descriptionAr: AssessedField<string>;
  descriptionEn: AssessedField<string>;
  amount: AssessedField<number>;
  percent: AssessedField<number>;
  dueDate: AssessedField<string>;
  triggerType: AssessedField<MilestoneTriggerType>;
}

export interface AssessedCustomerContract {
  customer: AssessedCustomer;
  contractType: AssessedField<ContractType>;
  startDate: AssessedField<string>;
  endDate: AssessedField<string>;
  totalValue: AssessedField<number>;
  retentionPct: AssessedField<number>;
  advancePct: AssessedField<number>;
  milestones: AssessedMilestone[];
}

/**
 * Turns the model's output into assessed fields and plain values:
 *  - identifiers normalized to ASCII digits; VAT must match NPI's format,
 *    CR must be 10 digits, email must look like one (02 §5.5 critical
 *    fields → «غير مؤكد» when invalid);
 *  - dates ISO and in order;
 *  - percentages within 0–100; amounts non-negative;
 *  - a milestone stated as a percentage only gets its amount computed from
 *    the contract value and marked `derived` (unconfirmed until the user
 *    looks at it); a milestone stating both must agree;
 *  - the milestones must add up to the contract value (06 §3 case 11),
 *    otherwise the total and every amount are unconfirmed;
 *  - sequences must run 1..n.
 */
export function assessCustomerContract(
  out: CustomerContractOutput,
  flags: AssessFlags = NO_FLAGS,
): {
  assessed: AssessedCustomerContract;
  values: CustomerContractValues | null;
} {
  const c = out.customer;
  const customer: AssessedCustomer = {
    nameAr: nameField(c.nameAr, flags),
    nameEn: textField(c.nameEn),
    customerType: enumField(c.customerType, CUSTOMER_TYPES),
    vatNumber: identifierField(c.vatNumber, SAUDI_VAT_RE, 'extract.warn.vat_format'),
    crNumber: identifierField(c.crNumber, SAUDI_CR_RE, 'extract.warn.cr_format'),
    phone: textField({ ...c.phone, value: asciiDigits(c.phone.value) }),
    email: textField(c.email, (value) => (EMAIL_RE.test(value) ? [] : ['extract.warn.email_format'])),
  };

  const startDate = dateField(out.startDate);
  let endDate = dateField(out.endDate);
  if (startDate.value !== null && endDate.value !== null && endDate.value < startDate.value) {
    endDate = withWarning(endDate, 'extract.warn.date_order');
  }

  let totalValue = amountField(out.totalValue);
  const total = totalValue.value;

  // Milestones: derive, cross-check, then sum.
  const milestones: AssessedMilestone[] = out.milestones.map((m) => {
    const percent = percentField(m.percent);
    let amount = amountField(m.amount);
    const percentUsable = percent.value !== null && !percent.warnings.includes('extract.warn.percent');
    if (amount.value === null && percentUsable && total !== null) {
      const derived = Math.round(total * (percent.value as number)) / 100;
      amount = assessField(
        { value: derived, confidence: Math.min(percent.confidence, totalValue.confidence), evidence: percent.evidence, page: percent.page },
        ['extract.warn.derived'],
      );
    } else if (amount.value !== null && percentUsable && total !== null) {
      const expected = (total * (percent.value as number)) / 100;
      if (Math.abs(expected - amount.value) > amountTolerance(expected)) amount = withWarning(amount, 'extract.warn.amount');
    }
    return {
      sequence: integerField(m.sequence),
      descriptionAr: textField(m.descriptionAr),
      descriptionEn: textField(m.descriptionEn),
      amount,
      percent,
      dueDate: dateField(m.dueDate),
      triggerType: enumField(m.triggerType, MILESTONE_TRIGGER_TYPES),
    };
  });

  const sequences = milestones.map((m) => m.sequence.value);
  const inOrder = sequences.every((s, i) => s === i + 1);
  if (!inOrder) {
    for (const m of milestones) m.sequence = withWarning(m.sequence, 'extract.warn.milestones_sequence');
  }

  const amounts = milestones.map((m) => m.amount.value);
  if (milestones.length > 0 && total !== null && amounts.every((a): a is number => a !== null)) {
    const sum = amounts.reduce((acc, a) => acc + a, 0);
    if (Math.abs(sum - total) > amountTolerance(total)) {
      totalValue = withWarning(totalValue, 'extract.warn.milestones_sum');
      for (const m of milestones) m.amount = withWarning(m.amount, 'extract.warn.milestones_sum');
    }
  }
  const percents = milestones.map((m) => m.percent.value);
  if (milestones.length > 0 && percents.every((p): p is number => p !== null)) {
    const sum = percents.reduce((acc, p) => acc + p, 0);
    if (Math.abs(sum - 100) > 0.5) {
      for (const m of milestones) m.percent = withWarning(m.percent, 'extract.warn.milestones_sum');
    }
  }

  const assessed: AssessedCustomerContract = {
    customer,
    contractType: enumField(out.contractType, CONTRACT_TYPES),
    startDate,
    endDate,
    totalValue,
    retentionPct: percentField(out.retentionPct),
    advancePct: percentField(out.advancePct),
    milestones,
  };

  const nameAr = customer.nameAr.value;
  const contractType = assessed.contractType.value;
  const values: CustomerContractValues | null =
    nameAr === null || contractType === null
      ? null
      : {
          customer: {
            nameAr,
            nameEn: customer.nameEn.value,
            customerType: customer.customerType.value,
            vatNumber: customer.vatNumber.value,
            crNumber: customer.crNumber.value,
            phone: customer.phone.value,
            email: customer.email.value,
          },
          contractType,
          startDate: startDate.value,
          endDate: endDate.value,
          totalValue: totalValue.value,
          retentionPct: assessed.retentionPct.value,
          advancePct: assessed.advancePct.value,
          milestones: milestones.flatMap((m): MilestoneValues[] =>
            m.sequence.value === null || m.descriptionAr.value === null
              ? []
              : [
                  {
                    sequence: m.sequence.value,
                    descriptionAr: m.descriptionAr.value,
                    descriptionEn: m.descriptionEn.value,
                    amount: m.amount.value,
                    percent: m.percent.value,
                    dueDate: m.dueDate.value,
                    triggerType: m.triggerType.value,
                  },
                ],
          ),
        };

  return { assessed, values };
}
