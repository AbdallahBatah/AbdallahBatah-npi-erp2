/**
 * Arabic name normalisation, name similarity and Saudi mobile normalisation —
 * the matching vocabulary of the unified customer record (CRM Phase 1, Step 2).
 *
 * Why this exists: a duplicate customer is almost never a byte-identical row.
 * It is «احمد العلى» typed once and «أحمد العلي» typed again, or «شركة الرياض
 * للصناعات» next to «الرياض للصناعات المحدودة». The functions here reduce a
 * name to a comparable form and score two such forms from 0 to 1.
 *
 * The normalisation is mirrored, step for step, by the SQL functions
 * `npi_normalize_arabic_name` and `npi_normalize_saudi_mobile` created in
 * migration 0022 (they back-fill the stored columns). A test runs both over a
 * sample list and requires identical output — so a change here is a change
 * there, and the test says so.
 *
 * Matching is always on WHOLE normalised strings (Dice on character bigrams),
 * never on a raw substring: «نور» is inside «منورة», and the two are unrelated.
 */

// ── normalisation ───────────────────────────────────────────────────────────

/** U+064B..U+065F (tashkeel), U+0670 (superscript alef), U+0640 (tatweel). */
const DIACRITICS_RE = /[ً-ٰٟـ]/g;

/**
 * One-to-one letter folds. Alef forms → ا, teh marbuta → ه, alef maqsura → ي,
 * hamza on waw → و, hamza on yeh → ي; Arabic-Indic and extended digits → ASCII.
 */
const LETTER_FOLD: Record<string, string> = {
  'أ': 'ا', // أ
  'إ': 'ا', // إ
  'آ': 'ا', // آ
  'ٱ': 'ا', // ٱ
  'ة': 'ه', // ة
  'ى': 'ي', // ى
  'ؤ': 'و', // ؤ
  'ئ': 'ي', // ئ
};
const FOLD_RE = /[أإآٱةىؤئ٠-٩۰-۹]/g;

function fold(ch: string): string {
  const mapped = LETTER_FOLD[ch];
  if (mapped) return mapped;
  const code = ch.charCodeAt(0);
  if (code >= 0x0660 && code <= 0x0669) return String(code - 0x0660);
  if (code >= 0x06f0 && code <= 0x06f9) return String(code - 0x06f0);
  return ch;
}

/**
 * The comparable form of a name:
 *   1. ASCII upper-case → lower-case (only A–Z: deterministic across runtimes);
 *   2. diacritics and tatweel removed;
 *   3. letters folded (أإآٱ→ا، ة→ه، ى→ي، ؤ→و، ئ→ي) and Arabic digits → 0-9;
 *   4. «.» removed (so «ش.م.م» → «شمم», «Co.» → «co»);
 *   5. every other character that is not a–z, 0–9 or an Arabic letter → space;
 *   6. spaces collapsed and trimmed;
 *   7. the definite article «ال» dropped from the start of each word that
 *      keeps at least two letters after it («النور» → «نور», but «ال» and
 *      «الف» stay).
 */
export function normalizeArabicName(input: string | null | undefined): string {
  let s = (input ?? '').replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
  s = s.replace(DIACRITICS_RE, '');
  s = s.replace(FOLD_RE, fold);
  s = s.replace(/\./g, '');
  s = s.replace(/[^a-z0-9ء-ي ]/g, ' ');
  s = s.replace(/ +/g, ' ').trim();
  s = s.replace(/(^| )ال(?=[^ ]{2})/g, '$1');
  return s;
}

/**
 * Legal-entity words, as typed. They say WHAT KIND of legal person a customer
 * is, not WHICH one, so they are dropped for comparison only. Activity words
 * (مصنع، مكتب، مستودع …) are deliberately NOT here: «مصنع الرياض» and «شركة
 * الرياض» must stay distinguishable from «الرياض» alone, and the scorer is
 * what decides how close they are.
 */
const LEGAL_FORM_WORDS = [
  'شركة', 'مؤسسة', 'مجموعة', 'المحدودة', 'ش.م.م', 'ذ.م.م', 'للتجارة', 'للمقاولات',
  'Co', 'Ltd', 'LLC', 'Est', 'Company',
];
const LEGAL_FORM_SET = new Set(LEGAL_FORM_WORDS.map((w) => normalizeArabicName(w)));

/** `normalizeArabicName` with the legal-entity words removed. */
export function stripLegalForm(input: string | null | undefined): string {
  const normalized = normalizeArabicName(input);
  const kept = normalized.split(' ').filter((w) => w && !LEGAL_FORM_SET.has(w));
  // A name that is nothing BUT a legal form («شركة») keeps its normalised text:
  // an empty string would make every such name identical to every other.
  return kept.length > 0 ? kept.join(' ') : normalized;
}

/** The form two names are compared in: normalised, legal words removed. */
export const comparableName = stripLegalForm;

// ── similarity ──────────────────────────────────────────────────────────────

/**
 * Character bigrams of a comparable name, counted as a multiset. The name is
 * padded with one space at each end, so the first and last letters of a name
 * take part in a bigram of their own. Without the padding «نور» and «نورس»
 * score 0.8 (two of three bigrams shared) — too close for two different
 * names; with it they score 0.67, while a company and a factory that share a
 * longer trade name still land well above 0.8.
 */
function bigramCounts(comparable: string): Map<string, number> {
  const padded = ` ${comparable} `;
  const counts = new Map<string, number>();
  for (let i = 0; i < padded.length - 1; i += 1) {
    const g = padded.slice(i, i + 2);
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return counts;
}

/** The bigram multiset of a comparable name, kept so a caller comparing one name against thousands pays for it once. */
export interface NameProfile {
  counts: Map<string, number>;
  /** Total bigrams, counting repeats. */
  size: number;
}

export function nameProfile(comparable: string): NameProfile {
  const counts = bigramCounts(comparable);
  let size = 0;
  for (const n of counts.values()) size += n;
  return { counts, size };
}

/** Dice coefficient (2·|A∩B| / (|A|+|B|)) on two precomputed profiles, in [0, 1]. */
export function diceProfiles(a: NameProfile, b: NameProfile): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.counts.size <= b.counts.size ? [a, b] : [b, a];
  let shared = 0;
  for (const [g, n] of small.counts) shared += Math.min(n, large.counts.get(g) ?? 0);
  return (2 * shared) / (a.size + b.size);
}

/** Dice coefficient on the bigram multisets of two COMPARABLE names, in [0, 1]. */
export function diceSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  return diceProfiles(nameProfile(a), nameProfile(b));
}

/** Similarity of two raw names: normalise, drop legal words, score. 0 if either is empty. */
export function nameSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  return diceSimilarity(comparableName(a), comparableName(b));
}

// ── Saudi mobile ────────────────────────────────────────────────────────────

/**
 * `+9665xxxxxxxx`, or `null` when the input is not a Saudi mobile number.
 * Accepts `05xxxxxxxx`, `5xxxxxxxx`, `9665xxxxxxxx`, `+9665xxxxxxxx`,
 * `009665xxxxxxxx`; ignores spaces, dashes, dots and parentheses and reads
 * Arabic-Indic digits. A landline (`011…`) is not a mobile → `null`.
 */
export function normalizeSaudiMobile(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = input
    .replace(/[٠-٩۰-۹]/g, fold)
    .replace(/[ \t\r\n().-]/g, '');
  const m = /^(?:\+?966|00966|0)?(5[0-9]{8})$/.exec(s);
  return m ? `+966${m[1]}` : null;
}

/**
 * The digits to look for inside stored `+9665xxxxxxxx` mobiles when someone
 * types part of a number in a search box («0501», «50 123», «+966 50»): spaces,
 * dashes, parentheses and a leading 00966 / 966 / 0 are dropped. `null` when
 * the input is not a run of at least three digits after that.
 */
export function mobileSearchFragment(input: string | null | undefined): string | null {
  const raw = (input ?? '')
    .replace(/[٠-٩۰-۹]/g, fold)
    .replace(/[ \t\r\n().+-]/g, '');
  if (!/^[0-9]+$/.test(raw)) return null;
  const digits = raw.replace(/^(?:00966|966|0)/, '');
  return digits.length >= 3 ? digits : null;
}
