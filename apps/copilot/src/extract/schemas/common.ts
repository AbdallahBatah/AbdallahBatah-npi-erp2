// Parsing and validation helpers shared by every extraction flow (T-23,
// T-24; spec 02 §5.5, ADR-28): turning the model's `WireField` strings into
// typed, assessed fields. Flow schemas (customer_contract, pr, po) are built
// from these — a rule that applies to more than one flow lives here, a rule
// specific to one flow stays in its own file.
//
// Everything here is pure and deterministic; none of it talks to the model
// or to NPI. Formats are copied from NPI's own validators (see the notes in
// customer_contract.ts), never from the OpenAPI document.
import { assessField, fromWire, WireFieldSchema, type AssessedField, type FieldWarning, type WireField } from './field';

/** Saudi VAT registration number as NPI validates it (packages/shared/src/vat.ts). */
export const SAUDI_VAT_RE = /^3\d{13}3$/;
/** Commercial registration numbers are 10 digits (the seed's `1010…`). */
export const SAUDI_CR_RE = /^\d{10}$/;
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** U+27E6, the opening bracket of every pseudonymizer placeholder. A value
 *  still carrying one after rehydration is a placeholder the model altered
 *  or invented — never a name to store. */
export const PLACEHOLDER_OPEN = '⟦';
const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN = '۰۱۲۳۴۵۶۷۸۹';

/** Tolerance for amount checks: 1 SAR or 0.5 %, whichever is larger. */
export const amountTolerance = (base: number) => Math.max(1, Math.abs(base) * 0.005);

/** A word-internal «ال» («للمقاوالت»): on a page whose text layer showed
 *  the reversed lam-alef ligature it may really be «لا», and a lexicon-free
 *  repair cannot tell — so the name is left for the user to check. */
export const WORD_INTERNAL_AL_RE = /[ء-ي]ال/;

export interface AssessFlags {
  ligatureSuspect: boolean;
  /** YYYY-MM-DD, «today» for relative-date checks (a date before it is in
   *  the past). Absent: no such check. */
  referenceDate?: string;
}

// Formats and enums are described, not enforced, in the model-facing
// schema: structured output drops `pattern`/`enum` constraints anyway, and
// a single off-format value must become one unconfirmed field (assessment
// below), not a rejected document.
export const wire = (description: string) => WireFieldSchema.describe(description);

/** Drops `undefined` members so an optional DTO field is absent on the wire
 *  rather than sent as `null` (class-validator's `@IsOptional` skips only
 *  `undefined`/`null`, but NPI's JSON parsing is stricter for enums). */
export function defined<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined)) as T;
}

// ─── Scalar parsers ─────────────────────────────────────────────────────────

export function asciiDigits(text: string): string {
  let out = '';
  for (const ch of text) {
    const a = ARABIC_INDIC.indexOf(ch);
    const p = PERSIAN.indexOf(ch);
    out += a !== -1 ? String(a) : p !== -1 ? String(p) : ch;
  }
  return out;
}

/**
 * «850,000», «٤٨٠٬٠٠٠ ريال», «1.150.000», «30%», «0.19» → a number, or
 * `null` when no number can be read. Thousands separators (`,` `٬` space)
 * are dropped; `٫` is the Arabic decimal mark; dots in groups of three
 * («1.150.000») are thousands separators too.
 */
export function parseNumber(text: string): number | null {
  let s = asciiDigits(text).replace(/[٬\s,]/g, '').replace(/٫/g, '.').replace(/[^\d.\-]/g, '');
  if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  if (!/\d/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Digits only, for identifiers the document may print with spaces/dashes. */
export function identifierDigits(text: string): string {
  return asciiDigits(text).replace(/[\s\-–.]/g, '');
}

export const keepText = (s: string): string => s;

export const parseEnum =
  <T extends string>(allowed: readonly T[]) =>
  (s: string): T | null => {
    const upper = s.toUpperCase().replace(/[^A-Z]/g, '');
    return allowed.find((a) => a === upper) ?? null;
  };

export const parseIsoDate = (s: string): string | null => {
  const value = asciiDigits(s).replace(/\//g, '-').replace(/\s+/g, '');
  if (!ISO_DATE_RE.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || !parsed.toISOString().startsWith(value) ? null : value;
};

/** Money rounded to two decimals (NPI's `estimatedUnitPrice` / `unitPrice`
 *  accept at most two). */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** At most three decimals — NPI's quantity precision. */
const hasAtMostThreeDecimals = (n: number): boolean => Math.abs(n * 1000 - Math.round(n * 1000)) < 1e-6;

// ─── Field assessors ────────────────────────────────────────────────────────

export function placeholderWarning(value: string | null): FieldWarning[] {
  return value !== null && value.includes(PLACEHOLDER_OPEN) ? ['extract.warn.placeholder'] : [];
}

export function textField(w: WireField, extra: (value: string) => FieldWarning[] = () => []): AssessedField<string> {
  const { field } = fromWire(w, keepText);
  return assessField(field, field.value === null ? [] : [...placeholderWarning(field.value), ...extra(field.value)]);
}

export function identifierField(w: WireField, valid: RegExp, warning: FieldWarning): AssessedField<string> {
  const { field } = fromWire(w, (s) => identifierDigits(s));
  return assessField(field, field.value === null ? [] : [...placeholderWarning(field.value), ...(valid.test(field.value) ? [] : [warning])]);
}

export function enumField<T extends string>(w: WireField, allowed: readonly T[]): AssessedField<T> {
  const { field, unreadable } = fromWire(w, parseEnum(allowed));
  // Unknown to NPI: the value is dropped and the card says so — not «missing».
  return assessField(field, unreadable ? ['extract.warn.enum'] : []);
}

export function dateField(w: WireField): AssessedField<string> {
  const { field, unreadable } = fromWire(w, parseIsoDate);
  return assessField(field, unreadable ? ['extract.warn.date_format'] : []);
}

export function percentField(w: WireField): AssessedField<number> {
  const { field, unreadable } = fromWire(w, parseNumber);
  const outOfRange = field.value !== null && (field.value < 0 || field.value > 100);
  return assessField(field, unreadable || outOfRange ? ['extract.warn.percent'] : []);
}

export function amountField(w: WireField): AssessedField<number> {
  const { field, unreadable } = fromWire(w, parseNumber);
  const negative = field.value !== null && field.value < 0;
  return assessField(field, unreadable || negative ? ['extract.warn.amount'] : []);
}

export function integerField(w: WireField): AssessedField<number> {
  const { field, unreadable } = fromWire(w, (s) => {
    const n = parseNumber(s);
    return n !== null && Number.isInteger(n) ? n : null;
  });
  return assessField(field, unreadable ? ['extract.warn.milestones_sequence'] : []);
}

export function withWarning<T>(f: AssessedField<T>, warning: FieldWarning): AssessedField<T> {
  return assessField({ value: f.value, confidence: f.confidence, evidence: f.evidence, page: f.page }, [...f.warnings, warning]);
}

/** A quantity NPI accepts: greater than zero, at most three decimals. An
 *  unreadable text warns too (it is not «missing», the user wrote something). */
export function quantityField(w: WireField): AssessedField<number> {
  const { field, unreadable } = fromWire(w, parseNumber);
  const invalid = field.value !== null && (field.value <= 0 || !hasAtMostThreeDecimals(field.value));
  return assessField(field, unreadable || invalid ? ['extract.warn.quantity'] : []);
}

/** ISO-4217-shaped code: three Latin letters, uppercased. */
export function currencyField(w: WireField): AssessedField<string> {
  const { field, unreadable } = fromWire(w, (s) => {
    const code = s.trim().toUpperCase();
    return /^[A-Z]{3}$/.test(code) ? code : null;
  });
  return assessField(field, unreadable ? ['extract.warn.currency'] : []);
}

/** A document code («PR-00012», «WBS-02»): ASCII digits, uppercased, spaces
 *  collapsed. An off-shape text is kept — the user sees what was read — and
 *  flagged. */
export function codeField(w: WireField): AssessedField<string> {
  const { field } = fromWire(w, (s) => asciiDigits(s).trim().toUpperCase().replace(/\s+/g, ' '));
  const offShape: FieldWarning[] = field.value !== null && !/^[A-Z]{1,6}-?\d+$/.test(field.value) ? ['extract.warn.code_format'] : [];
  return assessField(field, field.value === null ? [] : [...placeholderWarning(field.value), ...offShape]);
}

/** A party or place name; on a page with the reversed lam-alef ligature a
 *  word-internal «ال» is left for the user to check. */
export function nameField(w: WireField, flags: AssessFlags): AssessedField<string> {
  return textField(w, (value) => (flags.ligatureSuspect && WORD_INTERNAL_AL_RE.test(value) ? ['extract.warn.ligature'] : []));
}

/** A date that should not lie before `flags.referenceDate` (a needed-by
 *  date, an offer's validity). ISO strings compare lexicographically. */
export function dateNotPastField(w: WireField, flags: AssessFlags): AssessedField<string> {
  const field = dateField(w);
  return flags.referenceDate !== undefined && field.value !== null && field.value < flags.referenceDate
    ? withWarning(field, 'extract.warn.date_past')
    : field;
}
