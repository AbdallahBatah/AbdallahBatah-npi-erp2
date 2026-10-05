// The ONLY place in the codebase allowed to produce a `RedactedText` value
// (the brand cast below appears nowhere else — a later task greps the repo
// to enforce that). Everything sent to an external model must first pass
// through redact()/redactJson(), staticPrompt(), or fromModelOutput().
//
// Token form: ⟦<label>_<n>⟧ (U+27E6 / U+27E7 brackets), n counting from 1
// per label, stable for the lifetime of one Pseudonymizer/RedactionState.
//
// Token IDENTITY is the SURFACE FORM, not the underlying entity: the key is
// `label + normalizeArabic(matchedOriginalSpan)`. Two different spellings of
// a dictionary entity ("شركة النخيل للمقاولات", "النخيل", "Al Nakheel
// Contracting") are three independent surfaces and get three independent
// tokens — each rehydrates to exactly the text first seen for it. The only
// exception: two inputs whose normalized forms are IDENTICAL (e.g. "شركة"
// vs "شركه") share one token and both rehydrate to whichever spelling was
// seen first.
import { normalizeArabic } from '../text/normalize';
import { GIVEN_NAMES_AR } from './names-ar';

declare const redactedBrand: unique symbol;
export type RedactedText = string & { readonly [redactedBrand]: true };

export type EntityKind = 'customer' | 'vendor' | 'employee' | 'project';

export interface DictionaryEntry {
  kind: EntityKind;
  npiId: string;
  names: string[];
}

export interface RedactionState {
  version: 1;
  /** token -> original text (verbatim, for exact rehydration) */
  tokens: Record<string, string>;
  /** label -> highest counter issued so far */
  counters: Record<string, number>;
}

// ─── Static (pure-function) helpers ────────────────────────────────────────

/** For text loaded from the prompts/ folder only (no user or NPI data). */
export function staticPrompt(text: string): RedactedText {
  return text as RedactedText;
}

/** For echoing the model's own previous output back to it. */
/**
 * Joins parts that are each already safe to send. Exists so that callers
 * never need a cast of their own to assemble a prompt from a static file, a
 * redacted persona and redacted facts.
 */
export function joinRedacted(parts: readonly RedactedText[]): RedactedText {
  return parts.join('') as RedactedText;
}

export function fromModelOutput(text: string): RedactedText {
  return text as RedactedText;
}

// ─── Constant vocabularies (normalized once at module load) ───────────────

const KIND_LABELS: Record<EntityKind, string> = {
  customer: 'عميل',
  vendor: 'مورد',
  employee: 'موظف',
  project: 'مشروع',
};

const ORG_LABEL = 'جهة';
const PERSON_LABEL = 'شخص';

const LEGAL_FORM_WORDS_RAW = ['شركة', 'مؤسسة', 'مصنع', 'مكتب', 'مجموعة'];
const TRAILING_LEGAL_SUFFIXES_RAW = ['المحدودة', 'ذ.م.م', 'ذ م م'];
// Trailing "activity descriptor" words/prefixes that end an organization's
// core name (rule B): anything from the first word starting with «لل»
// (للمقاولات، للتجارة، للألواح الشمسية…) or one of these fixed words onward
// is dropped from the core.
const ACTIVITY_DESCRIPTOR_WORDS_RAW = ['التجارية', 'الصناعية', 'القابضة', 'المتحدة'];

const HONORIFICS_RAW = [
  'السيد',
  'السيدة',
  'الأستاذ',
  'الأستاذة',
  'المهندس',
  'المهندسة',
  'الدكتور',
  'الدكتورة',
  'م.',
  'أ.',
  'د.',
];

// Base heuristic-scanning stop list (rule B/E/F): words that end a capture.
const STOPWORDS_RAW = [
  'في',
  'من',
  'على',
  'إلى',
  'عن',
  'مع',
  'و',
  'أو',
  'ثم',
  'بتاريخ',
  'رقم',
  'هي',
  'هو',
  'التي',
  'الذي',
  'بين',
];
// Common definite-article nouns that could otherwise be mistaken for a
// family name/organization continuation immediately after a name-shaped
// word (mitigates, but does not eliminate, false positives from rule
// F's "starts with «ال» and isn't a stop word" continuation check).
const COMMON_DEFINITE_NOUNS_RAW = [
  'الجميع',
  'الشركة',
  'المشروع',
  'الموضوع',
  'الاجتماع',
  'الفريق',
  'القسم',
  'اليوم',
  'الأمر',
  'السعر',
  'العميل',
  'المورد',
  'التقرير',
  'النظام',
  'الملف',
  'الطلب',
  'العقد',
  'الفاتورة',
];

// Particles that attach to a person's name (رule C/E): they never count
// toward a capture's word limit and a captured name can never END on one.
const PARTICLES_RAW = ['بن', 'بنت', 'ابن', 'آل', 'ال', 'أبو', 'ابو', 'عبد', 'أم'];

// Common function words (rule C) that must never become a standalone name
// "part" candidate — note على normalizes to the same string as the given
// name علي ("Ali"), which is exactly why this check is done on normalized
// forms: علي is therefore excluded as a part-candidate too.
const FUNCTION_WORDS_RAW = [
  'على',
  'من',
  'في',
  'عن',
  'الى',
  'هذا',
  'ذلك',
  'كان',
  'قال',
  'بعد',
  'قبل',
  'عند',
  'حتى',
  'كل',
  'مع',
];

const PROCLITICS_RAW = ['و', 'ب', 'ل', 'ف', 'ك'];

function normalizeWord(word: string): string {
  return normalizeArabic(word);
}

const LEGAL_FORM_WORDS = new Set(LEGAL_FORM_WORDS_RAW.map(normalizeWord));
const ACTIVITY_DESCRIPTOR_WORDS = new Set(ACTIVITY_DESCRIPTOR_WORDS_RAW.map(normalizeWord));
const HONORIFICS = new Set(HONORIFICS_RAW.map(normalizeWord));
const STOPWORDS = new Set(
  [...STOPWORDS_RAW, ...COMMON_DEFINITE_NOUNS_RAW].map(normalizeWord),
);
const PARTICLES = new Set(PARTICLES_RAW.map(normalizeWord));
const FUNCTION_WORDS = new Set(FUNCTION_WORDS_RAW.map(normalizeWord));
const PROCLITICS = new Set(PROCLITICS_RAW);
// Each suffix as its normalized word sequence, e.g. ['ذ','م','م'] or ['المحدوده'].
const TRAILING_LEGAL_SUFFIXES: string[][] = TRAILING_LEGAL_SUFFIXES_RAW.map((s) =>
  normalizeWord(s).split(' ').filter(Boolean),
);

/**
 * Rule B: an organization's "core" name — strip a leading legal-form word,
 * a trailing legal suffix, and everything from the first trailing "activity
 * descriptor" word onward. Returns null when there is nothing distinct left
 * (core would equal the full name, or is under 4 normalized letters).
 */
function deriveOrgCore(fullWords: string[]): string[] | null {
  let core = fullWords.slice();
  if (core.length > 0 && LEGAL_FORM_WORDS.has(core[0])) {
    core = core.slice(1);
  }
  for (const suffix of TRAILING_LEGAL_SUFFIXES) {
    if (
      suffix.length > 0 &&
      core.length > suffix.length &&
      suffix.every((w, i) => core[core.length - suffix.length + i] === w)
    ) {
      core = core.slice(0, core.length - suffix.length);
      break;
    }
  }
  let cutIndex = -1;
  for (let i = 0; i < core.length; i += 1) {
    if (core[i].startsWith('لل') || ACTIVITY_DESCRIPTOR_WORDS.has(core[i])) {
      cutIndex = i;
      break;
    }
  }
  if (cutIndex !== -1) core = core.slice(0, cutIndex);

  if (core.length === 0) return null;
  if (core.length === fullWords.length) return null; // nothing distinct was stripped
  if (core.join('').length < 4) return null;
  return core;
}

/**
 * Rule C: every name part (>=3 normalized letters) becomes its own
 * candidate surface, except particles and common function words.
 */
function derivePersonParts(fullWords: string[]): string[] {
  const parts: string[] = [];
  for (const w of fullWords) {
    if (PARTICLES.has(w)) continue;
    if (FUNCTION_WORDS.has(w)) continue;
    if (w.length < 3) continue;
    parts.push(w);
  }
  return parts;
}

// ─── Digit folding that preserves string length/offsets (Pass 1 helper) ───

const ARABIC_INDIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN_DIGITS_LOCAL = '۰۱۲۳۴۵۶۷۸۹';

function foldDigitsSameLength(text: string): string {
  let out = '';
  for (const ch of text) {
    const a = ARABIC_INDIC_DIGITS.indexOf(ch);
    if (a !== -1) {
      out += String(a);
      continue;
    }
    const p = PERSIAN_DIGITS_LOCAL.indexOf(ch);
    if (p !== -1) {
      out += String(p);
      continue;
    }
    out += ch;
  }
  return out;
}

// ─── Normalization with an index map back to the original text ───────────
// Mirrors normalizeArabic()'s steps one character at a time, so we can find
// a match in the normalized text and translate its span back to an offset
// range in the ORIGINAL text (which is what actually gets replaced).

interface NormalizedWithMap {
  normalized: string;
  /** map[i] = original (UTF-16) index of the source character behind normalized[i] */
  map: number[];
}

const TASHKEEL_RANGE = /^[ً-ٰٟ]$/;
const ALEF_VARIANTS = new Set(['أ', 'إ', 'آ', 'ٱ']);

function normalizeWithMap(text: string): NormalizedWithMap {
  const chars: string[] = [];
  const map: number[] = [];

  let i = 0;
  while (i < text.length) {
    const originalIndex = i;
    const codePoint = text.codePointAt(i)!;
    const rawChar = String.fromCodePoint(codePoint);
    i += rawChar.length;

    if (rawChar === 'ـ' /* tatweel */ || TASHKEEL_RANGE.test(rawChar)) {
      continue; // dropped entirely
    }

    let out = rawChar.normalize('NFKC');
    if (out.length !== 1) {
      out = out.length > 0 ? out[0] : '';
      if (out === '') continue;
    }

    if (ALEF_VARIANTS.has(out)) out = 'ا';
    else if (out === 'ى') out = 'ي';
    else if (out === 'ة') out = 'ه';
    else if (out === 'ؤ') out = 'و';
    else if (out === 'ئ') out = 'ي';
    else {
      const digitIdx = ARABIC_INDIC_DIGITS.indexOf(out);
      if (digitIdx !== -1) out = String(digitIdx);
      else {
        const persianIdx = PERSIAN_DIGITS_LOCAL.indexOf(out);
        if (persianIdx !== -1) out = String(persianIdx);
      }
    }

    out = out.toLowerCase();

    if (isPunctuation(out)) out = ' ';

    chars.push(out);
    map.push(originalIndex);
  }

  // Collapse consecutive whitespace to a single space.
  const collapsedChars: string[] = [];
  const collapsedMap: number[] = [];
  let prevWasSpace = false;
  for (let k = 0; k < chars.length; k += 1) {
    const ch = chars[k];
    const isSpace = ch === ' ' || /\s/.test(ch);
    if (isSpace) {
      if (prevWasSpace) continue;
      prevWasSpace = true;
      collapsedChars.push(' ');
      collapsedMap.push(map[k]);
    } else {
      prevWasSpace = false;
      collapsedChars.push(ch);
      collapsedMap.push(map[k]);
    }
  }

  // Trim leading/trailing whitespace.
  let start = 0;
  while (start < collapsedChars.length && collapsedChars[start] === ' ') start += 1;
  let end = collapsedChars.length;
  while (end > start && collapsedChars[end - 1] === ' ') end -= 1;

  return {
    normalized: collapsedChars.slice(start, end).join(''),
    map: collapsedMap.slice(start, end),
  };
}

const PUNCTUATION_CHARS = new Set(
  '،؛؟٬٫«»⟦⟧.,!?;:\'"()[]{}<>/\\|@#$%^&*+=~`'.split(''),
);
function isPunctuation(ch: string): boolean {
  return PUNCTUATION_CHARS.has(ch);
}

// ─── Word tokenization over normalized text, with original-text spans ────

interface Word {
  text: string; // normalized
  start: number; // normalized-text index (inclusive)
  end: number; // normalized-text index (exclusive)
}

function tokenizeWords(normalized: string): Word[] {
  const words: Word[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
   
  while ((m = re.exec(normalized))) {
    words.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return words;
}

/**
 * Tashkeel/tatweel characters are dropped entirely during normalization —
 * they have no entry in `map` at all. When they trail the last real letter
 * of a matched span (e.g. the tanwin on «جديداً»), naively ending the span
 * at the last MAPPED character leaves them dangling, unclaimed, right after
 * the token. They carry no meaning of their own and are always bound to the
 * preceding letter, so always fold them into the replaced span.
 */
function extendPastTrailingDroppedChars(text: string, end: number): number {
  let e = end;
  while (e < text.length && (text[e] === 'ـ' || TASHKEEL_RANGE.test(text[e]))) {
    e += 1;
  }
  return e;
}

/**
 * Punctuation or a line break in the ORIGINAL text between two adjacent
 * words. Normalization blanks punctuation to a space, so without this check
 * a heuristic span runs straight across «،», a colon or a newline — on a
 * contract page «شركة النخيل للمقاولات، الرقم الضريبي» was one org token
 * whose rehydrated value carried the next field's label (T-23 probe).
 */
const SPAN_BOUNDARY_RE = /[\n\r\t،,.:؛;()«»\"'|]/;

function gapHasBoundary(text: string, map: number[], prev: Word, next: Word): boolean {
  const prevEnd = map[prev.end - 1] + 1;
  const nextStart = map[next.start];
  if (nextStart <= prevEnd) return false;
  return SPAN_BOUNDARY_RE.test(text.slice(prevEnd, nextStart));
}

function originalSpanForNormalizedRange(
  text: string,
  map: number[],
  normStart: number,
  normEnd: number,
): { start: number; end: number } {
  const start = map[normStart];
  const end = extendPastTrailingDroppedChars(text, map[normEnd - 1] + 1);
  return { start, end };
}

// ─── Overlap tracking ──────────────────────────────────────────────────────

interface Range {
  start: number;
  end: number;
}

class ClaimedRanges {
  private ranges: Range[] = [];

  overlaps(start: number, end: number): boolean {
    return this.ranges.some((r) => start < r.end && end > r.start);
  }

  add(start: number, end: number): void {
    this.ranges.push({ start, end });
  }
}

// ─── Structured identifier patterns (Pass 1) ──────────────────────────────

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const IBAN_RE = /\bSA(?:[ ]?[0-9]){22}\b/gi;
const VAT_RE = /(?<!\d)3\d{13}3(?!\d)/g;
const PHONE_RE = /(?:\+966[ -]?|00966[ -]?|0)5[ -]?\d(?:[ -]?\d){7}/g;
const ID10_RE = /(?<!\d)[1247]\d{9}(?!\d)/g;

const AMOUNT_MARKER_RE = /ريال|ر\.س|SAR|%/;

function isAmountOrCodeContext(original: string, start: number, end: number): boolean {
  const before1 = original[start - 1];
  const after1 = original[end];
  if (before1 && /[\d.,]/.test(before1)) return true;
  if (after1 && /[\d.,]/.test(after1)) return true;
  const before = original.slice(Math.max(0, start - 4), start);
  const after = original.slice(end, end + 8);
  if (AMOUNT_MARKER_RE.test(before) || AMOUNT_MARKER_RE.test(after)) return true;
  return false;
}

// ─── English heuristic person detection (rule G) ──────────────────────────

const EN_HONORIFIC_RE = /\b(?:Mr|Mrs|Ms|Dr|Eng)\.?\s+/g;
const EN_CUE_RE = /\b(?:contact|attn|attention|from|to|by|signed)\b\s*:?\s*/gi;
const CAP_WORD_SRC = '[A-Z][a-zA-Z]*';
const EN_NAME_AFTER_HONORIFIC_RE = new RegExp(`^(${CAP_WORD_SRC}(?:\\s+${CAP_WORD_SRC}){0,2})`);
const EN_NAME_AFTER_CUE_RE = new RegExp(`^(${CAP_WORD_SRC}(?:\\s+${CAP_WORD_SRC}){1,2})`);
const EN_EXCLUDED_ACRONYMS = new Set(['NPI', 'CSV', 'EPC', 'PPA', 'SAR', 'VAT']);
const DOC_CODE_RE = /^[A-Z]{2,6}-[0-9]/;

function isExcludedEnglishCapture(nameText: string): boolean {
  return nameText
    .split(/\s+/)
    .some((w) => EN_EXCLUDED_ACRONYMS.has(w) || DOC_CODE_RE.test(w));
}

// ─── Candidate surfaces (dictionary + session-learned) ────────────────────

interface Candidate {
  words: string[];
  label: string;
}

function sortCandidatesLongestFirst(candidates: Candidate[]): Candidate[] {
  return [...candidates].sort((a, b) => {
    if (b.words.length !== a.words.length) return b.words.length - a.words.length;
    return b.words.join('').length - a.words.join('').length;
  });
}

/**
 * Match candidateWords[0] against the word at `words[k]`, allowing an
 * attached one-letter proclitic (و ب ل ف ك), and — when the candidate
 * starts with the definite article «ال» — the ل+ال elision that produces
 * «لل…» («ل» prefix + «النخيل» → «للنخيل»), optionally preceded by a
 * one-letter conjunction («وللنخيل», «فللنخيل»). Returns the number of
 * leading characters (in the matched word) that are the attached prefix
 * and must stay OUTSIDE the token, or null if it doesn't match at all.
 */
function matchFirstWordPrefix(wordText: string, target: string): number | null {
  if (wordText === target) return 0;
  if (wordText.length > target.length && PROCLITICS.has(wordText[0]) && wordText.slice(1) === target) {
    return 1;
  }
  if (target.startsWith('ال')) {
    const afterAl = target.slice(2);
    const elided = 'ل' + afterAl; // the "لنخيل" that combines with a prefix ل into "للنخيل"
    if (wordText.length > 1 && wordText[0] === 'ل' && wordText.slice(1) === elided) {
      return 1; // "للنخيل"
    }
    if (
      wordText.length > 2 &&
      (wordText[0] === 'و' || wordText[0] === 'ف') &&
      wordText[1] === 'ل' &&
      wordText.slice(2) === elided
    ) {
      return 2; // "وللنخيل" / "فللنخيل"
    }
  }
  return null;
}

function tryMatchCandidate(
  words: Word[],
  k: number,
  candidateWords: string[],
): { end: number; prefixLen: number } | null {
  if (k + candidateWords.length > words.length) return null;
  const prefixLen = matchFirstWordPrefix(words[k].text, candidateWords[0]);
  if (prefixLen === null) return null;
  for (let i = 1; i < candidateWords.length; i += 1) {
    if (words[k + i].text !== candidateWords[i]) return null;
  }
  return { end: k + candidateWords.length, prefixLen };
}

// ─── Heuristic person-name capture (rules E & F) ──────────────────────────

// «المهندس طلب 40 لوح», «السيد ماجد الحربي وافق على الطلب»: an honorific is
// also an ordinary noun, and a name is usually followed by what the person
// did. These verbs are never part of a name.
const COMMON_VERBS = new Set(
  [
    'طلب', 'يطلب', 'طلبوا', 'وافق', 'يوافق', 'وافقوا', 'رفض', 'يرفض', 'اعتمد', 'يعتمد', 'استلم', 'يستلم',
    'استلموا', 'أرسل', 'يرسل', 'أرسلوا', 'قال', 'يقول', 'قالوا', 'أكد', 'يؤكد', 'أكدوا', 'وقع', 'يوقع',
    'سلم', 'يسلم', 'حضر', 'يحضر', 'زار', 'يزور', 'اتصل', 'يتصل', 'كتب', 'يكتب', 'راجع', 'يراجع', 'وصل',
    'يصل', 'غادر', 'يريد', 'يبي', 'يبغى', 'يحتاج', 'احتاج', 'سأل', 'يسأل', 'رد', 'يرد', 'ذكر', 'يذكر',
    'بلغ', 'أبلغ', 'أفاد', 'أوضح', 'شرح', 'اقترح', 'يقترح', 'دفع', 'يدفع', 'سدد', 'اشترى', 'باع', 'حول',
    'أنهى', 'بدأ', 'يبدأ', 'عدل', 'ألغى', 'أجل', 'مدد', 'جهز', 'ركب', 'فحص', 'عاين', 'ينتظر', 'انتظر',
    'يعمل', 'عمل', 'مسؤول', 'موجود', 'غير', 'ليس', 'كان', 'يكون', 'صار', 'راح', 'جاء', 'يجي', 'جا',
  ].map(normalizeWord),
);

/** A part worth learning from a captured name: a known given name or a
 *  family name («ال…»). Anything else swept into a capture is not learned,
 *  so an ordinary word is never redacted later on its account. */
function isLearnablePersonPart(part: string): boolean {
  return GIVEN_NAMES_AR.has(part) || (part.startsWith('ال') && part.length >= 4 && !STOPWORDS.has(part));
}

/** «وأحمد», «فخالد»: a given name with a conjunction attached. Returns the
 *  length of the attached prefix, or null. */
function attachedGivenNamePrefix(word: string): number | null {
  if (word.length < 4) return null;
  if ((word.startsWith('و') || word.startsWith('ف')) && GIVEN_NAMES_AR.has(word.slice(1))) return 1;
  return null;
}

function isNameLikeWord(idx: number, words: Word[]): boolean {
  if (idx >= words.length) return false;
  const w = words[idx].text;
  if (GIVEN_NAMES_AR.has(w)) return true;
  return w.startsWith('ال') && w.length >= 3 && !STOPWORDS.has(w);
}

function isNameLikeContinuation(idx: number, words: Word[]): boolean {
  if (idx >= words.length) return false;
  const w = words[idx].text;
  if (isNameLikeWord(idx, words)) return true;
  if (PARTICLES.has(w)) return isNameLikeWord(idx + 1, words);
  return false;
}

interface PendingReplacement {
  start: number;
  end: number;
  token: string;
}

// ─── Pseudonymizer ──────────────────────────────────────────────────────────

export class Pseudonymizer {
  private readonly dictionary: DictionaryEntry[];
  private readonly tokens: Record<string, string>;
  private readonly counters: Record<string, number>;
  /** identity key ("label::normalizedSurface") -> already-minted token. */
  private readonly identityToToken: Map<string, string>;
  /** Static candidates derived once from the dictionary (rules B/C). */
  private readonly dictionaryCandidates: Candidate[];
  /** Session-learned candidates (rule D): grows as heuristic org/person
   *  names are detected, and is reconstructed from restored state. */
  private readonly learnedCandidates: Candidate[] = [];
  private readonly learnedCandidateKeys = new Set<string>();

  constructor(dictionary: DictionaryEntry[], state?: RedactionState) {
    this.dictionary = dictionary;
    this.tokens = { ...(state?.tokens ?? {}) };
    this.counters = { ...(state?.counters ?? {}) };
    this.identityToToken = new Map();
    this.dictionaryCandidates = this.buildDictionaryCandidates();
    this.reconstructFromTokens();
  }

  private tokenLabelAndNumber(token: string): { label: string; n: number } | null {
    // Greedy `(.+)` for the label lets it contain underscores itself (e.g.
    // the label رقم_ضريبي), backtracking only enough to satisfy the
    // trailing `_<digits>⟧`.
    const m = /^⟦(.+)_([0-9]+)⟧$/.exec(token);
    if (!m) return null;
    return { label: m[1], n: Number(m[2]) };
  }

  /**
   * Rebuild identityToToken (surface -> token) and — for heuristic labels
   * جهة/شخص — re-derive their learned sub-candidates (org core / person
   * parts) from the stored token originals, so a restored instance keeps
   * recognizing bare mentions it learned before being exported.
   */
  private reconstructFromTokens(): void {
    for (const [token, original] of Object.entries(this.tokens)) {
      const parsed = this.tokenLabelAndNumber(token);
      if (!parsed) continue;
      const { label } = parsed;
      const identityKey = `${label}::${normalizeArabic(original)}`;
      if (!this.identityToToken.has(identityKey)) {
        this.identityToToken.set(identityKey, token);
      }

      this.rememberWhole(original, label);

      if (label === ORG_LABEL) {
        const fullWords = normalizeWord(original).split(' ').filter(Boolean);
        const core = deriveOrgCore(fullWords) ?? (fullWords.length > 0 ? fullWords : null);
        if (core) this.addLearnedCandidate(core, label);
      } else if (label === PERSON_LABEL) {
        const fullWords = normalizeWord(original).split(' ').filter(Boolean);
        for (const part of derivePersonParts(fullWords)) {
          if (isLearnablePersonPart(part)) this.addLearnedCandidate([part], label);
        }
      }
    }
  }

  /**
   * Whatever was given a placeholder is a name or an identifier from then
   * on, wherever it turns up again in this conversation: in the stored
   * answer when the history is sent on the next turn, or typed back by the
   * user who just read it. Without this, a value masked as a field of a
   * tool result would leave in clear one turn later.
   */
  private rememberWhole(original: string, label: string): void {
    const words = normalizeWord(original).split(' ').filter(Boolean);
    if (words.join('').length < 3) return;
    this.addLearnedCandidate(words, label);
  }

  private addLearnedCandidate(words: string[], label: string): void {
    if (words.length === 0) return;
    const key = `${label}::${words.join(' ')}`;
    if (this.learnedCandidateKeys.has(key)) return;
    this.learnedCandidateKeys.add(key);
    this.learnedCandidates.push({ words, label });
  }

  private mintOrReuseToken(label: string, originalSpan: string): string {
    const identityKey = `${label}::${normalizeArabic(originalSpan)}`;
    const existing = this.identityToToken.get(identityKey);
    if (existing) return existing;

    const nextN = (this.counters[label] ?? 0) + 1;
    this.counters[label] = nextN;
    const token = `⟦${label}_${nextN}⟧`;
    this.tokens[token] = originalSpan;
    this.identityToToken.set(identityKey, token);
    this.rememberWhole(originalSpan, label);
    return token;
  }

  private existingTokenRanges(text: string): ClaimedRanges {
    const claimed = new ClaimedRanges();
    const re = /⟦[^\s⟦⟧]+_[0-9]+⟧/g;
    let m: RegExpExecArray | null;
     
    while ((m = re.exec(text))) {
      if (Object.prototype.hasOwnProperty.call(this.tokens, m[0])) {
        claimed.add(m.index, m.index + m[0].length);
      }
    }
    return claimed;
  }

  redact(text: string): RedactedText {
    const claimed = this.existingTokenRanges(text);
    const replacements: PendingReplacement[] = [];

    this.runStructuredPass(text, claimed, replacements);
    this.runEnglishHeuristicPass(text, claimed, replacements);

    const { normalized, map } = normalizeWithMap(text);
    const words = tokenizeWords(normalized);

    // Catch every bare mention we already know about (dictionary + anything
    // learned so far, including from a restored state).
    this.runCandidateMatchPass(text, words, map, claimed, replacements);
    // Discover NEW organizations/persons not in any dictionary, learning
    // their core/parts as we go (rule D).
    this.runHeuristicPatternPass(text, words, map, claimed, replacements);
    // A second sweep so a LATER bare mention of something just learned in
    // this same call is redacted too.
    this.runCandidateMatchPass(text, words, map, claimed, replacements);

    return this.buildOutput(text, replacements) as RedactedText;
  }

  private runStructuredPass(
    text: string,
    claimed: ClaimedRanges,
    replacements: PendingReplacement[],
  ): void {
    const folded = foldDigitsSameLength(text);

    const applyMatches = (
      re: RegExp,
      label: string,
      guard?: (start: number, end: number) => boolean,
    ) => {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
       
      while ((m = re.exec(folded))) {
        const start = m.index;
        const end = start + m[0].length;
        if (claimed.overlaps(start, end)) continue;
        if (guard && guard(start, end)) continue;
        const originalSpan = text.slice(start, end);
        const token = this.mintOrReuseToken(label, originalSpan);
        claimed.add(start, end);
        replacements.push({ start, end, token });
      }
    };

    applyMatches(EMAIL_RE, 'بريد');
    applyMatches(IBAN_RE, 'آيبان');
    applyMatches(VAT_RE, 'رقم_ضريبي', (s, e) => isAmountOrCodeContext(text, s, e));
    applyMatches(PHONE_RE, 'هاتف');
    applyMatches(ID10_RE, 'رقم_تعريفي', (s, e) => isAmountOrCodeContext(text, s, e));
  }

  private runEnglishHeuristicPass(
    text: string,
    claimed: ClaimedRanges,
    replacements: PendingReplacement[],
  ): void {
    const tryCapture = (
      triggerRe: RegExp,
      nameRe: RegExp,
    ) => {
      triggerRe.lastIndex = 0;
      let m: RegExpExecArray | null;
       
      while ((m = triggerRe.exec(text))) {
        const afterStart = m.index + m[0].length;
        const rest = text.slice(afterStart, afterStart + 80);
        const nameMatch = nameRe.exec(rest);
        if (!nameMatch) continue;
        const nameText = nameMatch[1];
        const start = afterStart;
        const end = afterStart + nameText.length;
        if (claimed.overlaps(start, end)) continue;
        if (isExcludedEnglishCapture(nameText)) continue;
        const token = this.mintOrReuseToken(PERSON_LABEL, nameText);
        claimed.add(start, end);
        replacements.push({ start, end, token });
        for (const w of nameText.split(/\s+/)) {
          if (w.length >= 2) this.addLearnedCandidate([normalizeWord(w)], PERSON_LABEL);
        }
      }
    };

    tryCapture(EN_HONORIFIC_RE, EN_NAME_AFTER_HONORIFIC_RE);
    tryCapture(EN_CUE_RE, EN_NAME_AFTER_CUE_RE);
  }

  private buildDictionaryCandidates(): Candidate[] {
    const candidates: Candidate[] = [];
    for (const entry of this.dictionary) {
      const label = KIND_LABELS[entry.kind];
      for (const name of entry.names) {
        const fullWords = normalizeWord(name).split(' ').filter(Boolean);
        if (fullWords.length === 0) continue;
        candidates.push({ words: fullWords, label });

        if (entry.kind === 'customer' || entry.kind === 'vendor') {
          const core = deriveOrgCore(fullWords);
          if (core) candidates.push({ words: core, label });
        } else if (entry.kind === 'employee') {
          for (const part of derivePersonParts(fullWords)) {
            candidates.push({ words: [part], label });
          }
        }
      }
    }
    return sortCandidatesLongestFirst(candidates);
  }

  private runCandidateMatchPass(
    text: string,
    words: Word[],
    map: number[],
    claimed: ClaimedRanges,
    replacements: PendingReplacement[],
  ): void {
    const candidates = sortCandidatesLongestFirst([
      ...this.dictionaryCandidates,
      ...this.learnedCandidates,
    ]);
    if (candidates.length === 0) return;

    let k = 0;
    while (k < words.length) {
      const wordOriginal = originalSpanForNormalizedRange(text, map, words[k].start, words[k].end);
      if (claimed.overlaps(wordOriginal.start, wordOriginal.end)) {
        k += 1;
        continue;
      }

      let matched = false;
      for (const candidate of candidates) {
        const res = tryMatchCandidate(words, k, candidate.words);
        if (!res) continue;

        const nameNormStart = words[k].start + res.prefixLen;
        const nameNormEnd = words[res.end - 1].end;
        const { start: originalStart, end: originalEnd } = originalSpanForNormalizedRange(
          text,
          map,
          nameNormStart,
          nameNormEnd,
        );
        if (claimed.overlaps(originalStart, originalEnd)) continue;

        const originalSpan = text.slice(originalStart, originalEnd);
        const token = this.mintOrReuseToken(candidate.label, originalSpan);
        claimed.add(originalStart, originalEnd);
        replacements.push({ start: originalStart, end: originalEnd, token });
        k = res.end;
        matched = true;
        break;
      }
      if (!matched) k += 1;
    }
  }

  private isBlockedForHeuristic(
    text: string,
    word: Word,
    map: number[],
    claimed: ClaimedRanges,
  ): boolean {
    if (STOPWORDS.has(word.text)) return true;
    if (/^[0-9]+$/.test(word.text)) return true;
    const span = originalSpanForNormalizedRange(text, map, word.start, word.end);
    if (claimed.overlaps(span.start, span.end)) return true;
    return false;
  }

  /**
   * Rules E & F: capture a person span starting at `startIdx`. When
   * `alreadyCounted` is 0 (honorific trigger, rule E) `startIdx` is the
   * first word to consider adding; when it is 1 (given-name trigger, rule
   * F) `startIdx` itself is the first counted word. Particles are included
   * but never counted and never left trailing (a name can't end on one).
   */
  private captureNameSpan(
    text: string,
    words: Word[],
    map: number[],
    claimed: ClaimedRanges,
    startIdx: number,
    alreadyCounted: number,
    maxCounted: number,
  ): { indices: number[]; counted: number } {
    const included: number[] = [];
    let counted = alreadyCounted;
    let j = startIdx;
    if (alreadyCounted > 0) {
      included.push(startIdx);
      j = startIdx + 1;
    }
    while (counted < maxCounted && j < words.length) {
      if (j > 0 && gapHasBoundary(text, map, words[j - 1], words[j])) break;
      if (this.isBlockedForHeuristic(text, words[j], map, claimed)) break;
      if (COMMON_VERBS.has(words[j].text)) break;
      // The first word after an honorific may be a name this module has
      // never seen; every later word has to look like part of a name.
      if (counted > 0 && !isNameLikeContinuation(j, words)) break;
      const isParticle = PARTICLES.has(words[j].text);
      included.push(j);
      if (!isParticle) counted += 1;
      j += 1;
    }
    while (included.length > 0 && PARTICLES.has(words[included[included.length - 1]].text)) {
      included.pop();
    }
    return { indices: included, counted };
  }

  private acceptPersonCapture(
    text: string,
    words: Word[],
    map: number[],
    claimed: ClaimedRanges,
    replacements: PendingReplacement[],
    indices: number[],
    /** Letters of an attached conjunction to leave outside the token. */
    skipPrefix = 0,
  ): void {
    const firstIdx = indices[0];
    const lastIdx = indices[indices.length - 1];
    const { start, end } = originalSpanForNormalizedRange(
      text,
      map,
      words[firstIdx].start + skipPrefix,
      words[lastIdx].end,
    );
    const originalSpan = text.slice(start, end);
    const token = this.mintOrReuseToken(PERSON_LABEL, originalSpan);
    claimed.add(start, end);
    replacements.push({ start, end, token });

    const fullWords = indices.map((i, n) => (n === 0 ? words[i].text.slice(skipPrefix) : words[i].text));
    for (const part of derivePersonParts(fullWords)) {
      if (isLearnablePersonPart(part)) this.addLearnedCandidate([part], PERSON_LABEL);
    }
  }

  private runHeuristicPatternPass(
    text: string,
    words: Word[],
    map: number[],
    claimed: ClaimedRanges,
    replacements: PendingReplacement[],
  ): void {
    let k = 0;
    while (k < words.length) {
      const wordSpan = originalSpanForNormalizedRange(text, map, words[k].start, words[k].end);
      if (claimed.overlaps(wordSpan.start, wordSpan.end)) {
        k += 1;
        continue;
      }
      const wtext = words[k].text;

      if (LEGAL_FORM_WORDS.has(wtext)) {
        let take = 0;
        let j = k + 1;
        while (
          take < 4 &&
          j < words.length &&
          !gapHasBoundary(text, map, words[j - 1], words[j]) &&
          !this.isBlockedForHeuristic(text, words[j], map, claimed)
        ) {
          take += 1;
          j += 1;
        }
        if (take >= 1) {
          const { start, end } = originalSpanForNormalizedRange(
            text,
            map,
            words[k].start,
            words[k + take].end,
          );
          const originalSpan = text.slice(start, end);
          const token = this.mintOrReuseToken(ORG_LABEL, originalSpan);
          claimed.add(start, end);
          replacements.push({ start, end, token });

          const fullWords = words.slice(k, k + take + 1).map((w) => w.text);
          const core = deriveOrgCore(fullWords);
          if (core) this.addLearnedCandidate(core, ORG_LABEL);

          k = k + take + 1;
          continue;
        }
        k += 1;
        continue;
      }

      if (HONORIFICS.has(wtext)) {
        const cap = this.captureNameSpan(text, words, map, claimed, k + 1, 0, 5);
        const singleKnownName =
          cap.counted === 1 && cap.indices.length === 1 && GIVEN_NAMES_AR.has(words[cap.indices[0]].text);
        if ((cap.counted >= 2 || singleKnownName) && cap.indices.length > 0) {
          this.acceptPersonCapture(text, words, map, claimed, replacements, cap.indices);
          k = cap.indices[cap.indices.length - 1] + 1;
          continue;
        }
        k += 1;
        continue;
      }

      const attached = GIVEN_NAMES_AR.has(wtext) ? 0 : attachedGivenNamePrefix(wtext);
      if (attached !== null && isNameLikeContinuation(k + 1, words)) {
        const cap = this.captureNameSpan(text, words, map, claimed, k, 1, 5);
        if (cap.counted >= 2 && cap.indices.length > 0) {
          this.acceptPersonCapture(text, words, map, claimed, replacements, cap.indices, attached);
          k = cap.indices[cap.indices.length - 1] + 1;
          continue;
        }
        k += 1;
        continue;
      }

      k += 1;
    }
  }

  private buildOutput(text: string, replacements: PendingReplacement[]): string {
    const sorted = [...replacements].sort((a, b) => a.start - b.start);
    let out = '';
    let cursor = 0;
    for (const r of sorted) {
      if (r.start < cursor) continue; // defensive: skip any accidental overlap
      out += text.slice(cursor, r.start);
      out += r.token;
      cursor = r.end;
    }
    out += text.slice(cursor);
    return out;
  }

  /**
   * `fieldLabels` names the keys whose value is known to be a name or an
   * identifier (for example `{ vendorNameAr: 'مورد' }`). Such a value is
   * replaced as a whole, whatever it looks like: a tool that knows it is
   * returning a vendor's name does not depend on the dictionary or on a
   * pattern to have it masked. Every other string goes through `redact`.
   */
  redactJson(value: unknown, fieldLabels: Readonly<Record<string, string>> = {}): RedactedText {
    const mapped = this.deepMapFields(value, fieldLabels, undefined);
    return JSON.stringify(mapped) as RedactedText;
  }

  /** Replaces the whole value with one placeholder under `label`. */
  private maskWhole(value: string, label: string): string {
    const trimmed = value.trim();
    if (trimmed.length === 0) return value;
    // Already a placeholder (a value that went out and came back).
    if (/^⟦[^s⟦⟧]+_[0-9]+⟧$/.test(trimmed)) return trimmed;
    return this.mintOrReuseToken(label, trimmed);
  }

  private deepMapFields(
    value: unknown,
    fieldLabels: Readonly<Record<string, string>>,
    key: string | undefined,
  ): unknown {
    if (typeof value === 'string') {
      const label = key === undefined ? undefined : fieldLabels[key];
      return label === undefined ? (this.redact(value) as unknown as string) : this.maskWhole(value, label);
    }
    if (Array.isArray(value)) return value.map((v) => this.deepMapFields(v, fieldLabels, key));
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = this.deepMapFields(v, fieldLabels, k);
      }
      return out;
    }
    return value;
  }

  rehydrate(text: string): string {
    const re = /⟦[^\s⟦⟧]+_[0-9]+⟧/g;
    return text.replace(re, (match) =>
      Object.prototype.hasOwnProperty.call(this.tokens, match) ? this.tokens[match] : match,
    );
  }

  rehydrateJson<T>(value: T): T {
    return this.deepMapStrings(value, (s) => this.rehydrate(s)) as T;
  }

  private deepMapStrings(value: unknown, fn: (s: string) => string): unknown {
    if (typeof value === 'string') return fn(value);
    if (Array.isArray(value)) return value.map((v) => this.deepMapStrings(v, fn));
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = this.deepMapStrings(v, fn);
      }
      return out;
    }
    return value;
  }

  exportState(): RedactionState {
    return {
      version: 1,
      tokens: { ...this.tokens },
      counters: { ...this.counters },
    };
  }
}
