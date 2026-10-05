// Generic extraction runner (T-23, spec 02 §5.5, ADR-28): prompt → model →
// strict JSON → zod → server-side validation → per-field confidence.
//
// One flow is registered here (customer_contract); T-24/T-25 add the other
// four by adding a `FlowSpec` to `FLOWS` — nothing else in this file is
// flow-specific. The runner never talks to NPI and never writes anything:
// it turns a document into an `ExtractionResult` that the preview card
// (T-26) shows and the execution plan (T-27) consumes.
//
// Privacy (F-16, ADR-27): text pages reach the model only through
// `pseudonymizer.redact`; the model answers with the placeholders it saw and
// `rehydrateJson` puts the originals back *after* the audit row was written
// by the LLM client, so names never appear in `outboundRedactedText`. Vision
// blocks arrive already built by `src/llm/vision.ts` from a verified consent
// and are passed through untouched.
import { z } from 'zod';
import type { FlowType } from '../agents/router';
import { LlmError, type LlmContext } from '../llm/client';
import type { ModelResponse, RedactedBlock, RedactedRequest } from '../llm/provider';
import { joinRedacted, staticPrompt, type RedactedText } from '../privacy/pseudonymizer';
import { loadPrompt } from '../prompts/load';
import type { AssessedField } from './schemas/field';
import {
  assessCustomerContract,
  CustomerContractOutputSchema,
  type AssessedCustomerContract,
  type CustomerContractOutput,
  type CustomerContractValues,
} from './schemas/customer_contract';

// ─── Model-facing JSON schema ───────────────────────────────────────────────

const UNSUPPORTED_KEYWORDS = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'format', '$schema', 'id', '$id'];

/**
 * zod → the JSON schema structured output accepts (platform docs, fetched
 * through the claude-api skill on 2026-10-05): no numeric/string/array
 * constraints, `additionalProperties: false` and every property required on
 * each object, at most 16 union-typed members, and a compiled grammar small
 * enough — repeated object shapes are hoisted into `$defs` for that. Field
 * descriptions survive: the SDK's `zodOutputFormat` helper deduplicates the
 * same way but drops per-field descriptions, which is why this converter
 * exists. Unions are rejected here outright: a flow schema is built from
 * `WireField`s precisely so it never needs one.
 */
export function modelJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { target: 'draft-2020-12', unrepresentable: 'any' }) as Record<string, unknown>;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node !== 'object' || node === null) return;
    const obj = node as Record<string, unknown>;
    for (const key of UNSUPPORTED_KEYWORDS) delete obj[key];
    if ('anyOf' in obj || 'oneOf' in obj || Array.isArray(obj.type)) {
      throw new Error('modelJsonSchema: union-typed members are not allowed (structured output limit)');
    }
    if (obj.type === 'object' && typeof obj.properties === 'object' && obj.properties !== null) {
      obj.additionalProperties = false;
      obj.required = Object.keys(obj.properties as object);
    }
    Object.values(obj).forEach(walk);
  };
  walk(raw);
  hoistRepeatedObjects(raw);
  return raw;
}

/**
 * Hoists object schemas that repeat (ignoring their description) into
 * `$defs` and leaves `{ $ref, description }` in place — the per-field
 * description stays with the field. Without this the compiled grammar for
 * twenty-odd identical `WireField` objects is rejected as too large
 * (second live run, 2026-10-05: «The compiled grammar is too large»).
 */
function hoistRepeatedObjects(root: Record<string, unknown>): void {
  const canonical = (obj: Record<string, unknown>): string => {
    const { description: _description, ...rest } = obj;
    return JSON.stringify(rest);
  };
  const counts = new Map<string, number>();
  const count = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(count);
    if (typeof node !== 'object' || node === null) return;
    const obj = node as Record<string, unknown>;
    if (obj.type === 'object' && obj !== root) counts.set(canonical(obj), (counts.get(canonical(obj)) ?? 0) + 1);
    Object.values(obj).forEach(count);
  };
  count(root);
  const defs: Record<string, unknown> = {};
  const names = new Map<string, string>();
  for (const [key, n] of counts) {
    if (n >= 2) {
      const name = `shape${names.size + 1}`;
      names.set(key, name);
      defs[name] = JSON.parse(key);
    }
  }
  if (names.size === 0) return;
  const replace = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(replace);
    if (typeof node !== 'object' || node === null) return;
    const obj = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const child = value as Record<string, unknown>;
        const name = child.type === 'object' ? names.get(canonical(child)) : undefined;
        if (name !== undefined) {
          obj[key] = child.description === undefined ? { $ref: `#/$defs/${name}` } : { $ref: `#/$defs/${name}`, description: child.description };
          continue;
        }
      }
      replace(value);
    }
  };
  replace(root);
  root.$defs = defs;
}

// ─── Flow registry ──────────────────────────────────────────────────────────

export interface SourceFlags {
  /** The text layer showed the reversed lam-alef ligature at least once, so
   *  a word-internal «ال» anywhere on the page may really be «لا». */
  ligatureSuspect: boolean;
}

export interface FlowSpec<TOut, TAssessed, TValues> {
  flow: FlowType;
  /** Under `prompts/`. */
  promptFile: string;
  /** Becomes `llm_audit.event`. */
  purpose: string;
  parse(raw: unknown): { success: true; data: TOut } | { success: false; detail: string };
  jsonSchema: Record<string, unknown>;
  /** Server-side validation and confidence (02 §5.5 "critical fields"). */
  assess(out: TOut, flags: SourceFlags): { assessed: TAssessed; values: TValues | null };
}

function specOf<TOut, TAssessed, TValues>(spec: FlowSpec<TOut, TAssessed, TValues>) {
  return spec;
}

export const FLOWS = {
  customer_contract: specOf<CustomerContractOutput, AssessedCustomerContract, CustomerContractValues>({
    flow: 'customer_contract',
    promptFile: 'extract/customer_contract.md',
    purpose: 'extract_customer_contract',
    parse(raw) {
      const parsed = CustomerContractOutputSchema.safeParse(raw);
      return parsed.success
        ? { success: true, data: parsed.data }
        : { success: false, detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
    },
    jsonSchema: modelJsonSchema(CustomerContractOutputSchema),
    assess: assessCustomerContract,
  }),
} as const;

export type RegisteredFlow = keyof typeof FLOWS;
type AssessedOf<K extends RegisteredFlow> = (typeof FLOWS)[K] extends FlowSpec<unknown, infer A, unknown> ? A : never;
type ValuesOf<K extends RegisteredFlow> = (typeof FLOWS)[K] extends FlowSpec<unknown, unknown, infer V> ? V : never;

export function isRegisteredFlow(flow: FlowType): flow is RegisteredFlow {
  return Object.prototype.hasOwnProperty.call(FLOWS, flow);
}

// ─── Inputs and outputs ─────────────────────────────────────────────────────

export interface ExtractDeps {
  llm: { complete(req: RedactedRequest, ctx: LlmContext): Promise<ModelResponse> };
  pseudonymizer: { redact(text: string): RedactedText; rehydrateJson<T>(value: T): T };
}

export type ExtractSource =
  /** `pdf_text`: page texts from the intake sidecar (src/intake/pdf.ts). */
  | { kind: 'text'; pages: { num: number; text: string }[] }
  /** `image` / `pdf_scanned`: blocks built by src/llm/vision.ts under one
   *  consent event — the client refuses anything else before sending. */
  | { kind: 'vision'; blocks: RedactedBlock[] };

export interface ExtractInput {
  flow: FlowType;
  source: ExtractSource;
  /** What the user typed with the document («عقد جديد مع النخيل»). */
  userHint?: string;
  /** The firm's own name, so the model does not take it for the customer. */
  ourPartyNameAr?: string;
}

export type ExtractFailureReason =
  | 'unsupported_flow'
  | 'model_error'
  | 'refused'
  | 'truncated'
  | 'invalid_json'
  | 'schema_mismatch';

export interface ExtractUsage {
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  modelId: string;
}

export interface ExtractFailure {
  ok: false;
  flow: FlowType;
  reason: ExtractFailureReason;
  /** Key of src/i18n/ar.ts (`extract.failed.*`). */
  messageKey: `extract.failed.${Exclude<ExtractFailureReason, 'schema_mismatch'>}`;
  detail: string | null;
  usage: ExtractUsage | null;
}

export interface ExtractionResult<K extends RegisteredFlow = RegisteredFlow> {
  ok: true;
  flow: K;
  assessed: AssessedOf<K>;
  /** `null` when a value NPI cannot do without is missing (the card then
   *  shows `extract.incomplete` and every field it did find). */
  values: ValuesOf<K> | null;
  /** Every leaf by dotted path («customer.nameAr», «milestones.0.amount»). */
  fields: Record<string, AssessedField<unknown>>;
  summary: { total: number; confirmed: number; unconfirmed: number };
  usage: ExtractUsage;
}

// ─── Text preparation ───────────────────────────────────────────────────────

const LIGATURE_ARTIFACT_RE = /ا[أإآ]ل|اال/;

/**
 * Repairs the artifacts pdf.js leaves in text extracted from Word-made PDFs
 * (probed on 2026-10-05 with a Word → PDF export, T-23):
 *  - tabs between cells and around numbers → single spaces,
 *  - a date split across runs «2026 - 11 - 01» → «2026-11-01»,
 *  - the lam-alef ligature read back reversed: «األول» → «الأول» (alef +
 *    hamza-alef never occur together in Arabic, so this is safe) and
 *    «االنتهاء» → «الانتهاء» (same reasoning for a doubled alef). The
 *    word-internal case («للمقاوالت» for «للمقاولات») cannot be told apart
 *    from a genuine «ال» without a lexicon and is left to the model — the
 *    prompt names it, and `flags.ligatureSuspect` lets the assessment keep
 *    such a name unconfirmed.
 * Digits are left as written: the model reads Arabic-Indic digits and the
 * assessment normalizes identifiers.
 */
export function repairPdfTextWithFlags(text: string): { text: string; flags: SourceFlags } {
  const ligatureSuspect = LIGATURE_ARTIFACT_RE.test(text);
  const repaired = text
    .replace(/\r\n?/g, '\n')
    .replace(/\t+/g, ' ')
    .replace(/(\d{4}) - (\d{1,2}) - (\d{1,2})/g, '$1-$2-$3')
    .replace(/ا([أإآ])ل/g, 'ال$1')
    .replace(/اال/g, 'الا')
    .replace(/[  ]{2,}/g, ' ')
    .replace(/ +\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: repaired, flags: { ligatureSuspect } };
}

export function repairPdfText(text: string): string {
  return repairPdfTextWithFlags(text).text;
}

const PAGE_HEADER = (num: number) => `\n=== صفحة ${num} ===\n`;
const HINT_HEADER = 'تلميح المستخدم: ';
const VISION_NOTE = 'المستند مرفق صوراً بالترتيب؛ رقم الصفحة هو ترتيب الصورة.';

function systemFor(spec: FlowSpec<unknown, unknown, unknown>, input: ExtractInput): RedactedText {
  const hint = input.ourPartyNameAr?.trim()
    ? `اسم شركتنا في هذا النظام: «${input.ourPartyNameAr.trim()}»؛ إن ورد في العقد فهو ليس العميل.`
    : '';
  return staticPrompt(loadPrompt(spec.promptFile).replace(/\{\{our_party_hint\}\}/g, hint));
}

function userContentFor(deps: ExtractDeps, input: ExtractInput): { content: RedactedText | RedactedBlock[]; flags: SourceFlags } {
  const flags: SourceFlags = { ligatureSuspect: false };
  const hintLine: RedactedText | null = input.userHint?.trim()
    ? joinRedacted([staticPrompt(HINT_HEADER), deps.pseudonymizer.redact(input.userHint.trim()), staticPrompt('\n')])
    : null;

  if (input.source.kind === 'text') {
    const parts: RedactedText[] = [];
    if (hintLine) parts.push(hintLine);
    for (const page of input.source.pages) {
      const repaired = repairPdfTextWithFlags(page.text);
      flags.ligatureSuspect = flags.ligatureSuspect || repaired.flags.ligatureSuspect;
      parts.push(staticPrompt(PAGE_HEADER(page.num)));
      parts.push(deps.pseudonymizer.redact(repaired.text));
    }
    return { content: joinRedacted(parts), flags };
  }

  // Vision: a text block first (hint + note), then the consented blocks,
  // each image preceded by its page label (G-02: label per image when
  // several). A `document` block carries its own pages and gets no label.
  const blocks: RedactedBlock[] = [];
  blocks.push({ type: 'text', text: joinRedacted([hintLine ?? staticPrompt(''), staticPrompt(VISION_NOTE)]) });
  let imageIndex = 0;
  for (const block of input.source.blocks) {
    if (block.type === 'image') {
      imageIndex += 1;
      blocks.push({ type: 'text', text: staticPrompt(PAGE_HEADER(imageIndex).trim()) });
    }
    blocks.push(block);
  }
  return { content: blocks, flags };
}

// ─── Output handling ────────────────────────────────────────────────────────

/** Tolerates a ```json fence; returns `undefined` for anything unparsable. */
export function parseModelJson(raw: string): unknown {
  let text = raw.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '').trim();
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isAssessedLeaf(value: unknown): value is AssessedField<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    'confidence' in value &&
    'warnings' in value &&
    Array.isArray((value as { warnings: unknown }).warnings)
  );
}

/** Walks an assessed tree and returns its leaves by dotted path. */
export function flattenFields(assessed: unknown, prefix = ''): Record<string, AssessedField<unknown>> {
  const out: Record<string, AssessedField<unknown>> = {};
  const walk = (node: unknown, path: string) => {
    if (isAssessedLeaf(node)) {
      out[path] = node;
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, path === '' ? String(index) : `${path}.${index}`));
      return;
    }
    if (typeof node === 'object' && node !== null) {
      for (const [key, value] of Object.entries(node)) {
        walk(value, path === '' ? key : `${path}.${key}`);
      }
    }
  };
  walk(assessed, prefix);
  return out;
}

const MAX_OUTPUT_TOKENS = 8000;

function failure(
  flow: FlowType,
  reason: ExtractFailureReason,
  detail: string | null,
  usage: ExtractUsage | null,
): ExtractFailure {
  const messageKey = (reason === 'schema_mismatch' ? 'extract.failed.invalid_json' : `extract.failed.${reason}`) as ExtractFailure['messageKey'];
  return { ok: false, flow, reason, messageKey, detail, usage };
}

export async function runExtraction<K extends RegisteredFlow>(
  deps: ExtractDeps,
  input: ExtractInput & { flow: K },
  ctx: LlmContext,
): Promise<ExtractionResult<K> | ExtractFailure>;
export async function runExtraction(
  deps: ExtractDeps,
  input: ExtractInput,
  ctx: LlmContext,
): Promise<ExtractionResult | ExtractFailure>;
export async function runExtraction(
  deps: ExtractDeps,
  input: ExtractInput,
  ctx: LlmContext,
): Promise<ExtractionResult | ExtractFailure> {
  if (!isRegisteredFlow(input.flow)) return failure(input.flow, 'unsupported_flow', null, null);
  const spec = FLOWS[input.flow] as FlowSpec<unknown, unknown, unknown>;

  const { content, flags } = userContentFor(deps, input);
  const request: RedactedRequest = {
    tier: 'advanced',
    purpose: spec.purpose,
    system: systemFor(spec, input),
    messages: [{ role: 'user', content }],
    jsonSchema: spec.jsonSchema,
    maxTokens: MAX_OUTPUT_TOKENS,
    // `high` read a two-page contract past the 60 s advanced timeout
    // (first eval run, 2026-10-05); `medium` keeps the same fields within
    // AT-17's 25 s on the one-page documents.
    effort: 'medium',
  };

  const startedAt = Date.now();
  let response: ModelResponse;
  try {
    response = await deps.llm.complete(request, ctx);
  } catch (err) {
    if (err instanceof LlmError && err.kind === 'refused') return failure(input.flow, 'refused', null, null);
    const detail = err instanceof LlmError ? `${err.kind}: ${err.message}` : err instanceof Error ? err.message : String(err);
    return failure(input.flow, 'model_error', detail, null);
  }
  const usage: ExtractUsage = {
    tokensIn: response.tokensIn,
    tokensOut: response.tokensOut,
    latencyMs: Date.now() - startedAt,
    modelId: response.modelId,
  };

  if (response.stopReason === 'max_tokens') return failure(input.flow, 'truncated', null, usage);
  if (response.stopReason === 'refusal') return failure(input.flow, 'refused', null, usage);

  const raw = parseModelJson(response.text);
  if (raw === undefined) return failure(input.flow, 'invalid_json', null, usage);

  // Originals back in place of the placeholders the model copied — after
  // the audit row exists (the client wrote it before returning).
  const rehydrated = deps.pseudonymizer.rehydrateJson(raw);
  const parsed = spec.parse(rehydrated);
  if (!parsed.success) return failure(input.flow, 'schema_mismatch', parsed.detail, usage);

  const { assessed, values } = spec.assess(parsed.data, flags);
  const fields = flattenFields(assessed);
  const leaves = Object.values(fields);
  const confirmed = leaves.filter((f) => f.status === 'confirmed').length;

  return {
    ok: true,
    flow: input.flow,
    assessed: assessed as AssessedOf<RegisteredFlow>,
    values: values as ValuesOf<RegisteredFlow> | null,
    fields,
    summary: { total: leaves.length, confirmed, unconfirmed: leaves.length - confirmed },
    usage,
  };
}
