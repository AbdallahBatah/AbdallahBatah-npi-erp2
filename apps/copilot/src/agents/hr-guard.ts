// HR guard (BR-06): the assistant never evaluates, ranks or compares
// employees and never recommends a personnel decision. That stays a human
// decision. `isHrEvaluationRequest` is the predicate the router consults
// before anything else runs, so a "yes" here ends the turn with the fixed
// refusal and zero model calls.
//
// The guard has to be narrow as well as firm: it blocks the employee's
// message outright, so a false alarm on ordinary procurement talk («أفضل عرض
// فني», «تقييم المورد», «مكافأة نهاية الخدمة ضمن بنود العقد») is a defect too.
// Matching is therefore by whole word (see src/text/tokens.ts), never by
// substring, and a superlative or an evaluation that is aimed at a business
// object is left alone.
import { normalizeArabic } from '../text/normalize';
import { indicesOfPhrase, indicesOfWords, tokenIsWord, tokenize } from '../text/tokens';

function normalizeList(words: readonly string[]): string[] {
  return words.map((word) => normalizeArabic(word));
}

// ─── Arabic vocabulary (written naturally, normalized once at load) ─────────

const SUPERLATIVES = normalizeList([
  'أكفأ', 'أفضل', 'أحسن', 'أسوأ', 'أضعف', 'أكسل', 'أنشط', 'أشطر', 'أمهر', 'أقوى', 'أجدر',
]);

const PERSON_NOUNS = normalizeList([
  'موظف', 'موظفة', 'موظفين', 'موظفون', 'موظفات',
  'مهندس', 'مهندسة', 'مهندسين', 'مهندسون',
  'محاسب', 'محاسبة', 'محاسبين',
  'مندوب', 'مندوبين', 'مناديب',
  'مشرف', 'مشرفين',
  'مدير', 'مدراء', 'مديرين',
  'زميل', 'زملاء',
  'فريق',
  'عمال', 'فنيين',
  // Plural in construct before a pronoun: «موظفينا» = موظفي + نا.
  'موظفي', 'مهندسي', 'محاسبي', 'مندوبي', 'مشرفي',
]);

/** Also an adjective or a common noun («عرض فني», «عامل الأمان»): these count
 *  as a person only when the signal word sits right next to them. */
const AMBIGUOUS_PERSON_NOUNS = normalizeList(['فني', 'عامل']);

/** What a superlative or an evaluation may legitimately be aimed at. */
const BUSINESS_NOUNS = normalizeList([
  'مورد', 'موردين', 'مقاول', 'مقاولين', 'عميل', 'عملاء', 'شركة', 'مصنع', 'مؤسسة',
  'سعر', 'أسعار', 'عرض', 'عروض', 'صنف', 'أصناف', 'منتج', 'منتجات', 'مادة', 'مواد',
  'مشروع', 'مشاريع', 'عقد', 'عقود', 'فاتورة', 'فواتير', 'طلب', 'طلبات', 'أمر',
  'حل', 'خيار', 'طريقة', 'وقت', 'موعد', 'نظام', 'محطة', 'منظومة', 'معدات', 'لوح', 'ألواح',
  'عاكس', 'عواكس', 'بطارية', 'شبكة', 'موقع', 'مستودع', 'مخزون', 'ميزانية', 'تكلفة',
]);

const EVALUATE_WORDS = normalizeList([
  'قيّم', 'قيملي', 'قيّموا', 'تقييم', 'رتّب', 'رتبلي', 'ترتيب', 'قارن', 'مقارنة', 'صنّف',
]);

const PERFORMANCE_WORDS = normalizeList(['أداء', 'إنتاجية', 'كفاءة']);

/** Verbs that are about a person by their meaning. */
const PERSONNEL_VERBS = normalizeList([
  'نرقي', 'أرقي', 'نرقيه', 'نرقيها', 'يترقى', 'تترقى',
  'نفصل', 'أفصل', 'نفصله', 'نفصلها', 'نستغني', 'نطرد', 'أطرد', 'نطرده',
  'ننذر', 'ننذره',
]);

const PERSONNEL_PHRASES = normalizeList(['إنهاء خدمات', 'ننهي خدمات', 'إنهاء خدمة']);

const DECISION_NOUNS = normalizeList(['ترقية', 'علاوة', 'مكافأة', 'إنذار', 'حافز']);

const DESERVES = normalizeList(['يستحق', 'تستحق', 'يستاهل', 'تستاهل']);

/** Giving something to a person named by a pronoun: «هل نعطيه إنذار؟». */
const GIVE_TO_PERSON = normalizeList([
  'نعطيه', 'نعطيها', 'نعطيهم', 'أعطيه', 'أعطيها', 'نمنحه', 'نمنحها', 'نمنحهم', 'نوجه له', 'نوجه لها',
]);

/** Asking for an opinion or a choice. «من» is handled separately: as a bare
 *  word it is far more often the preposition "from". */
const OPINION_CUES = normalizeList(['مين', 'هل', 'تنصح', 'تنصحني', 'ترشح', 'ترشحلي', 'رأيك', 'رايكم', 'تقترح']);

const PRONOUN_SUFFIXES = ['نا', 'كم', 'هم', 'هن', 'ها', 'ه', 'ك'];

const ALA = normalizeArabic('على');
const MIN = normalizeArabic('من');

// ─── English vocabulary (users may write in English) ────────────────────────

const EN_SUPERLATIVE = /\b(best|worst|top|weakest|laziest|strongest|most (?:active|skilled|hardworking|productive))\b/;
const EN_PERSON_NOUN =
  /\b(employee|employees|engineer|engineers|accountant|accountants|rep|reps|technician|technicians|worker|workers|supervisor|supervisors|manager|managers|colleague|colleagues|staff|team)\b/;
const EN_EVALUATE = /\b(evaluate|evaluates|evaluating|assess|rank|ranks|ranking|compare|compares|comparing|rate|rates|rating)\b/;
const EN_PERFORMANCE = /\bperformance\b/;
const EN_BUSINESS_ENTITY =
  /\b(project|projects|vendor|vendors|supplier|suppliers|item|items|document|documents|offer|offers|quote|quotes|price|prices|system|plant|panel|panels)\b/;
const EN_DECISION = /\b(promote|promotion|raise|bonus|warning|fire|fired|terminate|termination|let go|layoff|dismiss)\b/;
const EN_QUESTION = /\b(who|whether|should (?:we|i))\b/;

// ─── Helpers ────────────────────────────────────────────────────────────────

function isOneOf(token: string | undefined, words: readonly string[]): boolean {
  if (token === undefined) return false;
  if (words.some((word) => tokenIsWord(token, word))) return true;
  // «موظفينا», «فريقكم»: the same word with a possessive pronoun attached.
  return PRONOUN_SUFFIXES.some(
    (suffix) =>
      token.length - suffix.length >= 3 &&
      token.endsWith(suffix) &&
      words.some((word) => tokenIsWord(token.slice(0, -suffix.length), word)),
  );
}

function indicesOf(tokens: readonly string[], words: readonly string[]): number[] {
  const found: number[] = [];
  tokens.forEach((token, index) => {
    if (isOneOf(token, words)) found.push(index);
  });
  return found;
}

/** True when a person is referred to near `index`: a plain person noun within
 *  `reach` words on either side, or an ambiguous one right next to it. */
function personNear(tokens: readonly string[], index: number, reach: number): boolean {
  for (let i = Math.max(0, index - reach); i <= Math.min(tokens.length - 1, index + reach); i += 1) {
    if (i !== index && isOneOf(tokens[i], PERSON_NOUNS)) return true;
  }
  return isOneOf(tokens[index + 1], AMBIGUOUS_PERSON_NOUNS) || isOneOf(tokens[index - 1], AMBIGUOUS_PERSON_NOUNS);
}

/** «أفضل مورد», «تقييم العروض»: the signal word is aimed at a business object. */
function aimedAtBusinessObject(tokens: readonly string[], index: number): boolean {
  return isOneOf(tokens[index + 1], BUSINESS_NOUNS);
}

function asksForOpinion(rawText: string, tokens: readonly string[]): boolean {
  if (indicesOfWords(tokens, OPINION_CUES).length > 0) return true;
  if (tokens[0] === MIN) return true; // «من يستحق…», «من الأضعف…»
  const trimmed = rawText.trim();
  return trimmed.endsWith('؟') || trimmed.endsWith('?');
}

function arabicSignals(rawText: string, tokens: readonly string[]): boolean {
  // 1. A superlative about a person: «مين أكفأ مهندس», «من الأضعف في فريق المبيعات».
  for (const index of indicesOf(tokens, SUPERLATIVES)) {
    if (aimedAtBusinessObject(tokens, index)) continue;
    if (personNear(tokens, index, 3)) return true;
  }

  // 2. Performance of a person: «أداء الموظفين», «أداء خالد» when an
  //    evaluation is asked for.
  const evaluateIndices = indicesOf(tokens, EVALUATE_WORDS);
  for (const index of indicesOf(tokens, PERFORMANCE_WORDS)) {
    const next = tokens[index + 1];
    if (isOneOf(next, PERSON_NOUNS) || isOneOf(next, AMBIGUOUS_PERSON_NOUNS)) return true;
    const evaluated = evaluateIndices.some((e) => Math.abs(e - index) <= 2);
    if (evaluated && next !== undefined && !isOneOf(next, BUSINESS_NOUNS)) return true;
  }

  // 3. Evaluating, ranking or comparing people.
  for (const index of evaluateIndices) {
    if (aimedAtBusinessObject(tokens, index)) continue;
    if (personNear(tokens, index, 4)) return true;
  }

  // 4. A personnel decision put as a question or a request for advice.
  if (asksForOpinion(rawText, tokens)) {
    for (const index of indicesOf(tokens, PERSONNEL_VERBS)) {
      if (!aimedAtBusinessObject(tokens, index)) return true;
    }
    if (PERSONNEL_PHRASES.some((phrase) => indicesOfPhrase(tokens, phrase).length > 0)) return true;

    const deserves =
      indicesOf(tokens, DESERVES).length > 0 ||
      GIVE_TO_PERSON.some((phrase) => indicesOfPhrase(tokens, phrase).length > 0);
    for (const index of indicesOf(tokens, DECISION_NOUNS)) {
      if (tokens[index + 1] === ALA) continue; // «علاوة على ذلك» = "in addition to"
      if (deserves || personNear(tokens, index, 4)) return true;
    }
  }

  return false;
}

function englishSignals(norm: string): boolean {
  const person = EN_PERSON_NOUN.test(norm);
  const business = EN_BUSINESS_ENTITY.test(norm);
  if (EN_SUPERLATIVE.test(norm) && person && !business) return true;
  if ((EN_EVALUATE.test(norm) || EN_QUESTION.test(norm)) && EN_PERFORMANCE.test(norm) && !business) return true;
  if (EN_EVALUATE.test(norm) && person && !business) return true;
  if (EN_DECISION.test(norm) && EN_QUESTION.test(norm)) return true;
  return false;
}

/**
 * True when `text` asks the assistant to evaluate, rank, compare or
 * recommend a personnel decision about an employee (BR-06).
 */
export function isHrEvaluationRequest(text: string): boolean {
  const norm = normalizeArabic(text);
  if (norm.length === 0) return false;
  return arabicSignals(text, tokenize(norm)) || englishSignals(norm);
}
