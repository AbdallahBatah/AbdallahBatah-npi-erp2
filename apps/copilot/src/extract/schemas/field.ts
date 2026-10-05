// The one shape every extracted value takes, for every flow (T-23, spec
// 02 §5.5, ADR-28): the value itself, how sure the model is, and where in
// the document it came from.
//
// Two forms exist on purpose:
//  - `WireField` is what the model returns. Every member is a required,
//    non-null scalar — `value` is always a string («» when the document
//    does not state it), `page` is 0 when unknown. Structured output
//    (`output_config.format`) caps a schema at 16 union-typed members, and
//    one nullable per field would need sixty (first live run, 2026-10-05:
//    «Schemas contains too many parameters with union types … limit: 16»).
//  - `Field<T>` / `AssessedField<T>` is what the rest of the copilot reads:
//    typed, nullable values after the server parsed and validated them.
import { z } from 'zod';

export const WireFieldSchema = z.object({
  /** The value as written, or «» when the document does not state it. */
  value: z.string(),
  /** 0–1. 1 = stated explicitly and unambiguously; ≤ 0.3 = a guess. */
  confidence: z.number(),
  /** A short verbatim quote from the document (≤ 160 chars), or «». */
  evidence: z.string(),
  /** 1-based page the evidence sits on, 0 when unknown. */
  page: z.number().int(),
});

export type WireField = z.infer<typeof WireFieldSchema>;

export type Field<T> = {
  value: T | null;
  confidence: number;
  evidence: string | null;
  page: number | null;
};

/** The confidence at which a validated value counts as «مؤكد» (06 AT-05:
 *  below 80 % the value is shown as unconfirmed). */
export const CONFIRMED_MIN_CONFIDENCE = 0.8;

/** Keys of `src/i18n/ar.ts` that explain why a field is unconfirmed. */
export type FieldWarning =
  | 'extract.warn.missing'
  | 'extract.warn.low_confidence'
  | 'extract.warn.placeholder'
  | 'extract.warn.vat_format'
  | 'extract.warn.cr_format'
  | 'extract.warn.date_format'
  | 'extract.warn.date_order'
  | 'extract.warn.amount'
  | 'extract.warn.percent'
  | 'extract.warn.milestones_sum'
  | 'extract.warn.milestones_sequence'
  | 'extract.warn.derived'
  | 'extract.warn.enum'
  | 'extract.warn.email_format'
  | 'extract.warn.ligature';

export interface AssessedField<T> extends Field<T> {
  status: 'confirmed' | 'unconfirmed';
  warnings: FieldWarning[];
}

/**
 * Wire → typed field. `parse` turns the written text into the value or
 * `null` when it cannot be read; `unreadable` says whether the text was
 * present but unparsable (so the caller can warn instead of saying
 * «missing»). Confidence is clamped to 0–1 whatever the model wrote.
 */
export function fromWire<T>(wire: WireField, parse: (text: string) => T | null): { field: Field<T>; unreadable: boolean } {
  const text = wire.value.trim();
  const confidence = Number.isFinite(wire.confidence) ? Math.min(1, Math.max(0, wire.confidence)) : 0;
  const evidence = wire.evidence.trim().length > 0 ? wire.evidence.trim() : null;
  const page = Number.isInteger(wire.page) && wire.page >= 1 ? wire.page : null;
  if (text.length === 0) return { field: { value: null, confidence, evidence, page }, unreadable: false };
  const value = parse(text);
  return { field: { value, confidence, evidence, page }, unreadable: value === null };
}

export function assessField<T>(f: Field<T>, warnings: FieldWarning[] = []): AssessedField<T> {
  const all = [...warnings];
  if (f.value === null && all.length === 0) all.push('extract.warn.missing');
  else if (f.value !== null && f.confidence < CONFIRMED_MIN_CONFIDENCE) all.push('extract.warn.low_confidence');
  const unique = [...new Set(all)];
  return { ...f, status: unique.length === 0 ? 'confirmed' : 'unconfirmed', warnings: unique };
}

/** An absent field, for values a later step derives (e.g. a milestone
 *  amount computed from its percentage). */
export function emptyField<T>(): Field<T> {
  return { value: null, confidence: 0, evidence: null, page: null };
}
