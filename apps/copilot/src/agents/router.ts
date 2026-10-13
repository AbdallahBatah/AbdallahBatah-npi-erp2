// Message router (T-10): decides, for one user message, whether the HR
// guard refuses it, which of the intake flows it belongs to (the five
// document flows, or the one administrative flow `user_permissions` of
// D-26), whether
// it should fall back to the economy classifier, or whether it is a plain
// read-only chat turn. See spec/madar/02-TECH-SPEC.md §6 and
// spec/madar/06-ACCEPTANCE-TESTS.md §3 for the behaviour this implements.
//
// Order, first match wins:
//   1. HR guard -> hr_refusal (nothing else runs, in particular `classify`
//      is never called).
//   2. A forced flow (the user pressed a chip).
//   3. Non-entry intents -> chat: never-execute requests (approve, reject,
//      return, delete, cancel) always — except a permission change, where
//      «احذف صلاحية…» is the request itself; questions and status lookups
//      only when there is no attachment.
//   3-bis. Without an attachment, a permission noun with a grant or revoke
//      verb is the administrative flow `user_permissions` (D-26). It wins
//      over a document phrase inside the permission's name.
//   4. Keyword rules (`matchFlowByRules`), on normalized text.
//   5. Classifier fallback, only when a classifier was injected AND
//      (there is an attachment OR the rules were ambiguous).
//   6. No classifier, or step 5's condition did not hold -> attachment
//      means `choose_flow`, otherwise `chat`.
import { normalizeArabic } from '../text/normalize';
import { hasAnyPhrase, indicesOfPhrase, indicesOfWords, tokenize } from '../text/tokens';
import { isHrEvaluationRequest } from './hr-guard';

/** The five flows that turn a document or a sentence about a document into an NPI record. */
export type DocumentFlow = 'customer_contract' | 'pr' | 'po' | 'grn' | 'vendor_bill';
/** D-26 adds one administrative flow: a sentence, no document, never offered as a chip. */
export type FlowType = DocumentFlow | 'user_permissions';
/** The economy classifier never names the administrative flow. */
export type ClassifierVerdict = DocumentFlow | 'chat' | 'unknown';

export type Route =
  | { kind: 'hr_refusal' }
  | { kind: 'flow'; flow: FlowType; by: 'rules' | 'classifier' }
  | { kind: 'flow_unavailable'; flow: FlowType } // the flow is switched off for this firm
  | { kind: 'choose_flow' } // show «لم أحدد نوع المستند — اختر:» with chips
  | { kind: 'chat' }; // read-only conversation with tools

export interface RouteInput {
  text: string;
  hasAttachment: boolean;
  forcedFlow?: FlowType;
  visibleFlows?: readonly FlowType[];
}

export interface RouteDeps {
  classify?: (text: string) => Promise<ClassifierVerdict>;
}

function normalizeList(words: readonly string[]): string[] {
  return words.map((word) => normalizeArabic(word));
}

// Every list below is matched by whole word (src/text/tokens.ts): «عقد» must
// not be found inside «معقد», nor «أبي» inside «كتابي».

// ─── Requests the assistant must never execute ──────────────────────────────
// Approving, rejecting, returning, deleting and cancelling are never done from
// the chat, with or without an attachment: these always go to the chat, where
// the assistant explains where the action is done in NPI.

const NEVER_EXECUTE_WORDS = normalizeList([
  'اعتمد', 'اعتمده', 'اعتمدها', 'اعتمدلي', 'وافق', 'وافقلي',
  'ارفض', 'ارفضه', 'ارفضها', 'رجّع', 'رجعه', 'رجعها',
  'احذف', 'احذفه', 'احذفها', 'امسح', 'امسحه', 'امسحها',
  'ألغِ', 'الغي', 'الغيه', 'الغيها',
]);

// «وافق» and «اعتمد» are also the past tense: «المدير وافق، أبي 40 لوح…» tells
// of an approval, it does not ask for one. The word counts as a request only
// when it opens the message, after any words of politeness.
const POLITE_OPENERS = normalizeList([
  'ممكن', 'لو', 'سمحت', 'رجاء', 'الرجاء', 'فضلا', 'من', 'فضلك', 'أرجو', 'ارجوك', 'يا', 'مدار', 'تكفى', 'بالله',
]);

function isNeverExecuteRequest(tokens: readonly string[]): boolean {
  let first = 0;
  while (first < tokens.length && indicesOfWords([tokens[first]], POLITE_OPENERS).length > 0) first += 1;
  return first < tokens.length && indicesOfWords([tokens[first]], NEVER_EXECUTE_WORDS).length > 0;
}

// ─── Step 3: questions and status lookups ───────────────────────────────────

const INTERROGATIVE_WORDS = normalizeList([
  'كم', 'وش', 'ايش', 'ماذا', 'ماهي', 'ماهو', 'هل', 'متى', 'وين', 'أين', 'ليش', 'لماذا', 'كيف', 'مين',
]);

// «من» (from / who) is a question only when a verb follows; «ما» (what / not)
// only when it opens the sentence.
const MAN = normalizeArabic('من');
const MA = normalizeArabic('ما');
const MAN_VERB_HINTS = normalizeList(['يوافق', 'يعتمد', 'وافق', 'اعتمد', 'يستحق', 'يقرر', 'نعتمد', 'نوافق']);

const STATUS_PHRASES = normalizeList(['حالة', 'وين وصل', 'وين وصلت']);

// The handover guide («دليل الاستلام») is a document of the copilot, not a
// goods receipt.
const HANDOVER_PHRASES = normalizeList(['دليل الاستلام', 'دليل استلام']);

// A polite request is often written as a question («ممكن طلب شراء 40 لوح؟»).
const REQUEST_CUES = normalizeList([
  'ممكن', 'لو سمحت', 'أبي', 'ابي', 'أبغى', 'ابغى', 'ابغا', 'نبي', 'أحتاج', 'نحتاج', 'محتاج', 'محتاجين',
  'سوّ', 'سو', 'سوي', 'أنشئ', 'اعمل', 'حوّل', 'أدخل', 'سجّل',
]);

// ─── Step 3-bis: the administrative flow (D-26) ─────────────────────────────

// «صلاحياتي» style pronoun suffixes are not peeled by `tokenIsWord`, so the
// suffixed forms are listed; the article and the و/ب prefixes are peeled.
const PERMISSION_NOUNS = normalizeList([
  'صلاحية', 'صلاحيات', 'الصلاحية', 'الصلاحيات', 'صلاحيته', 'صلاحياته', 'صلاحيتها', 'صلاحياتها', 'صلاحيه',
]);
const REVOKE_VERBS = normalizeList([
  'شيل', 'شيلي', 'شل', 'اسحب', 'اسحبي', 'احجب', 'احجبي', 'امنع', 'أوقف', 'وقف', 'عطّل', 'عطل', 'ألغِ', 'الغي',
  'احذف', 'انزع', 'اقطع', 'اقفل',
  // With the pronoun of the permission: «صلاحية التقارير شيلها منه».
  'شيله', 'شيلها', 'اسحبه', 'اسحبها', 'احجبه', 'احجبها', 'امنعه', 'امنعها', 'الغيه', 'الغيها', 'احذفه', 'احذفها',
  // Polite requests use the imperfect: «ممكن تشيل صلاحية…؟», «أبي أشيل صلاحية…».
  'تشيل', 'تسحب', 'تحجب', 'تمنع', 'توقف', 'تعطل', 'تلغي', 'تحذف', 'تنزع', 'اشيل', 'نشيل',
]);
const GRANT_VERBS = normalizeList([
  'أعطِ', 'اعطي', 'اعطه', 'اعطيه', 'عطه', 'عطيه', 'امنح', 'أضف', 'اضف', 'ضيف', 'فعّل', 'فعل', 'رجّع', 'رجع', 'افتح',
  'خوّل', 'خول',
  'تعطي', 'تمنح', 'تضيف', 'تفعل', 'ترجع', 'تفتح', 'تخول',
]);

/**
 * True when the text holds a permission noun and a grant or revoke verb,
 * anywhere and in any order: «شيل صلاحية التقارير المالية من أحمد». Whether it
 * is a question is decided by the caller (a question about permissions is a
 * chat turn answered by a read tool).
 */
export function isPermissionChangeRequest(text: string): boolean {
  const tokens = tokenize(normalizeArabic(text));
  if (indicesOfWords(tokens, PERMISSION_NOUNS).length === 0) return false;
  return indicesOfWords(tokens, REVOKE_VERBS).length > 0 || indicesOfWords(tokens, GRANT_VERBS).length > 0;
}

function isQuestionOrLookup(rawText: string, tokens: readonly string[]): boolean {
  if (hasAnyPhrase(tokens, HANDOVER_PHRASES)) return true;
  if (indicesOfWords(tokens, INTERROGATIVE_WORDS).length > 0) return true;
  if (tokens[0] === MA) return true;

  const manIdx = tokens.indexOf(MAN);
  if (manIdx !== -1 && indicesOfWords([tokens[manIdx + 1] ?? ''], MAN_VERB_HINTS).length > 0) return true;

  if (hasAnyPhrase(tokens, STATUS_PHRASES)) return true;

  const trimmed = rawText.trim();
  const endsAsQuestion = trimmed.endsWith('؟') || trimmed.endsWith('?');
  return endsAsQuestion && !hasAnyPhrase(tokens, REQUEST_CUES);
}

// ─── Step 4: keyword rules per flow ─────────────────────────────────────────

const VENDOR_BILL_PHRASES = normalizeList([
  'فاتورة مورد', 'فاتورة المورد', 'فاتورة من المورد', 'فاتورة توريد', 'فاتورة شراء', 'فاتورة الموردين',
]);

const GRN_PHRASES = normalizeList([
  'استلام', 'استلمنا', 'استلمت', 'إشعار تسليم', 'اشعار استلام', 'وصلت البضاعة', 'وصلت الشحنة', 'سند استلام',
]);

const PO_PHRASES = normalizeList(['أمر شراء', 'امر الشراء', 'أوامر شراء', 'عرض سعر المورد', 'عرض المورد']);
const PO_FROM_PR_REFERENCE = normalizeArabic('من الطلب');
const PR_CODE_PATTERN = /^pr-\d/;
const CREATE_VERBS = normalizeList(['سوّ', 'سو', 'سوي', 'أنشئ', 'اعمل', 'حوّل']);

const PR_PHRASES = normalizeList(['طلب شراء', 'طلب توريد', 'طلب مواد', 'طلب الشراء']);
const NEED_VERBS = normalizeList([
  'أبي', 'ابي', 'أبغى', 'ابغى', 'ابغا', 'أحتاج', 'نحتاج', 'محتاج', 'محتاجين', 'نبي', 'اطلب لي', 'وفّر', 'وفر لنا',
]);

const CONTRACT_PHRASES = normalizeList(['عقد', 'عقود', 'تعاقد', 'اتفاقية', 'عميل جديد']);

/** A need verb with a quantity somewhere after it: «أبي 40 لوح…». */
function needVerbFollowedByNumber(tokens: readonly string[]): boolean {
  for (const verb of NEED_VERBS) {
    const width = tokenize(verb).length;
    for (const start of indicesOfPhrase(tokens, verb)) {
      if (tokens.slice(start + width).some((token) => /^\d/.test(token))) return true;
    }
  }
  return false;
}

function matchedFlowsByRules(text: string): Set<DocumentFlow> {
  const tokens = tokenize(normalizeArabic(text));
  const matched = new Set<DocumentFlow>();
  if (hasAnyPhrase(tokens, HANDOVER_PHRASES)) return matched;

  if (hasAnyPhrase(tokens, VENDOR_BILL_PHRASES)) matched.add('vendor_bill');
  if (hasAnyPhrase(tokens, GRN_PHRASES)) matched.add('grn');

  const poByPhrase = hasAnyPhrase(tokens, PO_PHRASES);
  const poByPrReference =
    !poByPhrase &&
    indicesOfPhrase(tokens, PO_FROM_PR_REFERENCE).length > 0 &&
    tokens.some((token) => PR_CODE_PATTERN.test(token)) &&
    hasAnyPhrase(tokens, CREATE_VERBS);
  if (poByPhrase || poByPrReference) matched.add('po');

  const prByPhrase = hasAnyPhrase(tokens, PR_PHRASES);
  const prByNeedVerb = !prByPhrase && needVerbFollowedByNumber(tokens);
  if (prByPhrase || prByNeedVerb) matched.add('pr');

  if (hasAnyPhrase(tokens, CONTRACT_PHRASES)) matched.add('customer_contract');

  return matched;
}

/**
 * Rule-based flow match on normalized text, exported for direct testing.
 * Returns the single matching flow, or `null` when no rule matched or when
 * two or more flows matched (ambiguous — the caller falls back to the
 * classifier, see `route`).
 */
export function matchFlowByRules(text: string): DocumentFlow | null {
  const matched = matchedFlowsByRules(text);
  return matched.size === 1 ? [...matched][0] : null;
}

function applyVisibility(flow: FlowType, by: 'rules' | 'classifier', visibleFlows?: readonly FlowType[]): Route {
  if (visibleFlows && !visibleFlows.includes(flow)) {
    return { kind: 'flow_unavailable', flow };
  }
  return { kind: 'flow', flow, by };
}

export async function route(input: RouteInput, deps?: RouteDeps): Promise<Route> {
  // 1. HR guard — refuses outright, nothing else runs.
  if (isHrEvaluationRequest(input.text)) {
    return { kind: 'hr_refusal' };
  }

  // 2. Forced flow (the user pressed a chip).
  if (input.forcedFlow) {
    return applyVisibility(input.forcedFlow, 'rules', input.visibleFlows);
  }

  // 3. Non-entry intents -> chat. A request to approve, reject, return,
  //    delete or cancel goes to the chat whether or not something is
  //    attached; a question or a status lookup does so only without an
  //    attachment (a caption with a question mark does not turn an attached
  //    document into a chat).
  const tokens = tokenize(normalizeArabic(input.text));
  if (isNeverExecuteRequest(tokens) && !isPermissionChangeRequest(input.text)) {
    return { kind: 'chat' };
  }
  if (!input.hasAttachment && isQuestionOrLookup(input.text, tokens)) {
    return { kind: 'chat' };
  }

  // 3-bis. The administrative flow (D-26): a permission change typed as a
  //        sentence. Before the document rules, so a document phrase inside
  //        the permission's name («صلاحية طلب الشراء») does not turn it into
  //        a requisition; never with an attachment.
  if (!input.hasAttachment && isPermissionChangeRequest(input.text)) {
    return applyVisibility('user_permissions', 'rules', input.visibleFlows);
  }

  // 4. Rules.
  const matched = matchedFlowsByRules(input.text);
  if (matched.size === 1) {
    return applyVisibility([...matched][0], 'rules', input.visibleFlows);
  }
  const ambiguous = matched.size >= 2;

  // 5. Classifier fallback.
  if (deps?.classify && (input.hasAttachment || ambiguous)) {
    let verdict: ClassifierVerdict;
    try {
      verdict = await deps.classify(input.text);
    } catch {
      verdict = 'unknown';
    }

    if (verdict === 'chat') return { kind: 'chat' };
    if (verdict === 'unknown') {
      return input.hasAttachment ? { kind: 'choose_flow' } : { kind: 'chat' };
    }
    return applyVisibility(verdict, 'classifier', input.visibleFlows);
  }

  // 6. No classifier, or step 5's condition did not hold.
  return input.hasAttachment ? { kind: 'choose_flow' } : { kind: 'chat' };
}
