// Free-text answer -> StepAnswer (T-17, spec/madar/02 §7).
//
// A deterministic, no-model path is tried first (acceptance words, a named
// profile at step 1, "nothing to change" at steps 4/6): most administrators
// answer in one of a handful of fixed ways, and every deterministic match
// costs nothing and leaks nothing. Only when none applies is the economy
// model asked to turn the sentence into the step's JSON shape, and even then
// it only ever sees `pseudonymizer.redact(...)` of the (digit-normalized)
// text — never the original (F-16).
import { loadPrompt } from '../prompts/load';
import { staticPrompt, type RedactedText } from '../privacy/pseudonymizer';
import type { LlmContext } from '../llm/client';
import type { ModelResponse, RedactedRequest } from '../llm/provider';
import { normalizeArabic } from '../text/normalize';
import { hasAnyPhrase, tokenIsWord, tokenize } from '../text/tokens';
import { t } from '../i18n/ar';
import { questionKey, stepDefaults, StepAnswerSchema, type SetupState, type SetupStep, type StepAnswer } from './machine';
import type { ProfileKey, ProfilePack } from './profile.schema';

export interface ParseDeps {
  llm: { complete(req: RedactedRequest, ctx: LlmContext): Promise<ModelResponse> };
  pseudonymizer: { redact(text: string): string };
}

export interface ParseInput {
  step: SetupStep;
  text: string;
  pack: ProfilePack | null;
  current: SetupState;
}

export type ParseOutcome =
  | { kind: 'answer'; answer: StepAnswer; source: 'deterministic' | 'model' }
  | { kind: 'unclear'; messageAr: string };

const PROMPT_FILE = 'setup-parse.md';
const DEPARTMENT_CODE_RE = /^[A-Z][A-Z0-9_-]{1,19}$/;

// ─── Digit normalization (kept separate from normalizeArabic: that function
// also strips punctuation and folds letters, which would mangle the text
// actually sent to the model) ────────────────────────────────────────────

const ARABIC_INDIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

function normalizeDigitsOnly(text: string): string {
  let out = '';
  for (const ch of text) {
    const a = ARABIC_INDIC_DIGITS.indexOf(ch);
    if (a !== -1) {
      out += String(a);
      continue;
    }
    const p = PERSIAN_DIGITS.indexOf(ch);
    if (p !== -1) {
      out += String(p);
      continue;
    }
    out += ch;
  }
  return out;
}

// ─── Deterministic matches ──────────────────────────────────────────────────

// A deterministic match is only taken when the WHOLE sentence is made of
// words that carry no new information. «موافق بس أضف قسم الجودة» contains
// an acceptance word and a change request; «لا نسوي EPC، إحنا استشارات»
// contains a profile name under negation. Both must reach the model, so a
// single matching word is never enough on its own (reviewer probe, T-17).
const norm = (words: string[]) => words.map(normalizeArabic);
/** Words that accept the proposed default. */
const ACCEPT_WORDS = norm(['نعم', 'موافق', 'الافتراضي', 'افتراضي', 'تمام', 'اعتمد', 'خلاص', 'اوكي', 'ايوه', 'ايه', 'اكيد', 'طيب', 'ماشي', 'زين']);
/** Words allowed around an acceptance without changing its meaning. */
const ACCEPT_FILLER = norm(['كما', 'هو', 'هي', 'زي', 'مثل', 'ما', 'هذا', 'هذي', 'كذا', 'كذلك', 'شكرا', 'عليه', 'على', 'الاقتراح', 'المقترح', 'المقترحات', 'كله', 'الكل', 'جميعها', 'نفس', 'الشي', 'الشيء', 'خله', 'خليه']);
/** Words that say "nothing to change" (steps 4 and 6). */
const NOTHING_WORDS = norm(['لا', 'ما', 'مافي', 'بدون', 'ولا', 'ابدا', 'ليس', 'مو', 'مش']);
const NOTHING_FILLER = norm(['في', 'فيه', 'عندنا', 'عندي', 'لدينا', 'شي', 'شيء', 'خاص', 'خاصة', 'مصطلحات', 'مصطلح', 'تغيير', 'تغييرات', 'نغير', 'اضافة', 'اضافات', 'ملاحظات', 'شكرا', 'حاليا', 'الان', 'مستندات', 'اخرى', 'ثاني', 'ثانية', 'زيادة', 'نفس', 'المعتادة', 'المعتاد', 'كما', 'هي', 'هو']);
/** Negation words that can flip a named profile at step 1. */
const NEGATION_WORDS = norm(['لا', 'ما', 'مو', 'مش', 'ليس', 'غير', 'ابدا', 'لسنا']);

function isOneOf(token: string, words: readonly string[]): boolean {
  return words.some((word) => tokenIsWord(token, word));
}

/** True when every token is in `core ∪ filler` and at least one is in `core`. */
function sentenceIsOnly(tokens: readonly string[], core: readonly string[], filler: readonly string[]): boolean {
  if (tokens.length === 0 || tokens.length > 8) return false;
  let hit = false;
  for (const token of tokens) {
    if (isOneOf(token, core)) hit = true;
    else if (!isOneOf(token, filler)) return false;
  }
  return hit;
}

const PROFILE_PHRASES_RAW: [ProfileKey, string[]][] = [
  ['epc', ['epc', 'مقاول epc']],
  ['om_provider', ['تشغيل وصيانة', 'تشغيل وصيانه', 'مشغل تشغيل وصيانة']],
  ['ppa_operator', ['بيع طاقة', 'بيع الطاقة', 'تأجير الطاقة', 'ppa']],
  ['general_contracting', ['مقاولات عامة', 'مقاولات']],
  ['equipment_trading', ['تجارة معدات', 'تجارة المعدات']],
  ['engineering_consulting', ['استشارات هندسية', 'استشارات']],
];
const PROFILE_PHRASES: [ProfileKey, string[]][] = PROFILE_PHRASES_RAW.map(
  ([key, phrases]): [ProfileKey, string[]] => [key, phrases.map(normalizeArabic)],
);

/** The one profile the sentence names — `null` when none, when two are
 *  named, or when a negation word is present (the model decides then). */
function matchProfileKey(tokens: readonly string[]): ProfileKey | null {
  const named = PROFILE_PHRASES.filter(([, phrases]) => hasAnyPhrase(tokens, phrases)).map(([key]) => key);
  if (named.length !== 1) return null;
  if (tokens.some((token) => isOneOf(token, NEGATION_WORDS))) return null;
  return named[0];
}

/** The "accept the proposed default" answer for a step that has a single
 *  concrete default (every step but 1 and 7). `null` when the step has none
 *  (step 1 — accepting "the default" means nothing without naming a
 *  profile) or the pack is not yet known. */
function defaultAnswerFor(step: SetupStep, pack: ProfilePack): StepAnswer | null {
  const defaults = stepDefaults(step, pack, {});
  if (defaults === null) return null;
  switch (defaults.step) {
    case 1:
    case 7:
      return null;
    case 2:
      return {
        step: 2,
        departments: defaults.departments,
        positions: defaults.positions.map(({ npiUsers: _npiUsers, ...position }) => position),
      };
    case 3:
      return { step: 3, approvalRules: defaults.approvalRules };
    case 4:
      return { step: 4, acceptedDocTypeKeys: defaults.acceptedDocTypes.map((d) => d.key) };
    case 5:
      return { step: 5, items: defaults.items };
    case 6:
      return { step: 6, terminology: defaults.terminology };
  }
}

function tryDeterministic(step: SetupStep, pack: ProfilePack | null, tokens: readonly string[]): StepAnswer | null {
  if (step === 1) {
    const profileKey = matchProfileKey(tokens);
    if (profileKey) return { step: 1, profileKey };
  }

  if (pack === null) return null;

  if (sentenceIsOnly(tokens, ACCEPT_WORDS, ACCEPT_FILLER)) {
    const answer = defaultAnswerFor(step, pack);
    if (answer) return answer;
  }

  if ((step === 4 || step === 6) && sentenceIsOnly(tokens, NOTHING_WORDS, NOTHING_FILLER)) {
    const answer = defaultAnswerFor(step, pack);
    if (answer) return answer;
  }

  return null;
}

// ─── Model path ─────────────────────────────────────────────────────────────

function schemaHintFor(step: SetupStep): string {
  switch (step) {
    case 1:
      return '{"step":1,"profileKey":"epc","revenueLines":["..."]}';
    case 2:
      return '{"step":2,"departments":[{"code":"SALES","nameAr":"...","nameEn":"..."}],"positions":[{"roleKey":"sales","departmentCode":"SALES","titleAr":"...","personaAr":"..."}]}';
    case 3:
      return '{"step":3,"approvalRules":[{"docType":"PURCHASE_ORDER","minAmount":100000,"maxAmount":null,"steps":["pm","accountant"]}]}';
    case 4:
      return '{"step":4,"acceptedDocTypeKeys":["epc_contract","vendor_bill"]}';
    case 5:
      return '{"step":5,"items":[{"sku":"MOD-600","nameAr":"...","nameEn":"...","itemCategory":"MODULE","uom":"unit","isSerialised":true}]}';
    case 6:
      return '{"step":6,"terminology":{"vendor":"..."}}';
    case 7:
      return '{}';
  }
}

/** Strips a ```json ... ``` (or bare ```...```) fence, if present, before
 *  parsing — the same tolerant approach `extract-chat.ts` relies on the
 *  model not needing, but `setup-parse.md` cannot fully rule out. */
function tryParseJson(raw: string): unknown {
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

function validDepartmentCodes(answer: StepAnswer): boolean {
  if (answer.step !== 2) return true;
  return answer.departments.every((d) => DEPARTMENT_CODE_RE.test(d.code));
}

async function callModel(deps: ParseDeps, input: ParseInput, ctx: LlmContext, outboundText: string): Promise<ParseOutcome> {
  const { step, pack } = input;
  const defaults = pack ? stepDefaults(step, pack, {}) : null;
  const system = loadPrompt(PROMPT_FILE)
    .replace(/\{\{step\}\}/g, String(step))
    .replace(/\{\{question\}\}/g, t(questionKey(step)))
    .replace(/\{\{defaults_json\}\}/g, JSON.stringify(defaults ?? {}))
    .replace(/\{\{schema_hint\}\}/g, schemaHintFor(step));

  let response: ModelResponse;
  try {
    response = await deps.llm.complete(
      {
        tier: 'economy',
        purpose: 'setup_parse',
        system: staticPrompt(system),
        messages: [{ role: 'user', content: deps.pseudonymizer.redact(outboundText) as unknown as RedactedText }],
        maxTokens: 1024,
      },
      ctx,
    );
  } catch {
    return { kind: 'unclear', messageAr: t('setup.unclear') };
  }

  const parsedJson = tryParseJson(response.text);
  if (parsedJson === undefined) return { kind: 'unclear', messageAr: t('setup.unclear') };

  const withStep =
    typeof parsedJson === 'object' && parsedJson !== null && !Array.isArray(parsedJson)
      ? { ...(parsedJson as Record<string, unknown>), step }
      : parsedJson;
  const parsed = StepAnswerSchema.safeParse(withStep);
  if (!parsed.success) return { kind: 'unclear', messageAr: t('setup.unclear') };
  if (!validDepartmentCodes(parsed.data)) return { kind: 'unclear', messageAr: t('setup.unclear') };

  return { kind: 'answer', answer: parsed.data, source: 'model' };
}

export async function parseAnswer(deps: ParseDeps, input: ParseInput, ctx: LlmContext): Promise<ParseOutcome> {
  const { step, text, pack } = input;
  const tokens = tokenize(normalizeArabic(text));

  const deterministic = tryDeterministic(step, pack, tokens);
  if (deterministic) return { kind: 'answer', answer: deterministic, source: 'deterministic' };

  return callModel(deps, input, ctx, normalizeDigitsOnly(text));
}
