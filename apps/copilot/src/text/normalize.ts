// Pure Arabic/Latin text normalization used to build a search-friendly form
// of free text (e.g. `MemoryFact.factAr` -> `MemoryFact.searchText`) and to
// compare a user's query against it. No external dependencies: this module
// must be safe to import from both server and test code without touching a
// database or the filesystem.
//
// Normalization steps, in order:
//   1. Unicode NFKC normalization (compatibility composition).
//   2. Strip tashkeel (Arabic diacritics) and tatweel (kashida).
//   3. Fold Arabic letter variants to a single canonical form:
//        أ إ آ ٱ -> ا   |   ى -> ي   |   ة -> ه   |   ؤ -> و   |   ئ -> ي
//      (ء is left untouched: it is not a variant of another letter.)
//   4. Convert Arabic-Indic and Persian digits to ASCII digits.
//   5. Lowercase Latin letters.
//   6. Replace punctuation (Arabic and Latin) with a space, except `-` and
//      `_`, which are kept so codes like "PRJ-00012" survive intact.
//   7. Collapse consecutive whitespace into a single space and trim.

// U+064B–U+065F: Arabic combining diacritics (tashkeel), including tanwin,
// fatha/damma/kasra, shadda, sukun, etc. U+0670: superscript alef (dagger
// alef), also a diacritic.
const TASHKEEL_PATTERN = /[ً-ٰٟ]/g;

// U+0640: tatweel / kashida, a elongation character with no phonetic value.
const TATWEEL_PATTERN = /ـ/g;

const ALEF_VARIANTS_PATTERN = /[أإآٱ]/g; // أ إ آ ٱ
const ALEF_MAKSURA_PATTERN = /ى/g; // ى
const TEH_MARBUTA_PATTERN = /ة/g; // ة
const HAMZA_WAW_PATTERN = /ؤ/g; // ؤ
const HAMZA_YEH_PATTERN = /ئ/g; // ئ

const ARABIC_INDIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

function foldDigits(input: string): string {
  let out = '';
  for (const ch of input) {
    const arabicIndicIndex = ARABIC_INDIC_DIGITS.indexOf(ch);
    if (arabicIndicIndex !== -1) {
      out += String(arabicIndicIndex);
      continue;
    }
    const persianIndex = PERSIAN_DIGITS.indexOf(ch);
    if (persianIndex !== -1) {
      out += String(persianIndex);
      continue;
    }
    out += ch;
  }
  return out;
}

// Punctuation to blank out: Arabic-specific punctuation (comma، semicolon؛
// question mark؟) plus the bracket characters ⟦ ⟧, plus common Latin
// punctuation. `-` and `_` are deliberately excluded so codes like
// "PRJ-00012" or "ITEM_007" survive normalization intact.
const PUNCTUATION_PATTERN =
  /[،؛؟٬٫«»،؛؟⟦⟧.,!?;:'"()\[\]{}<>\/\\|@#$%^&*+=~`،]/g;

const WHITESPACE_PATTERN = /\s+/g;

/**
 * Normalize Arabic (and Latin) free text into a canonical, search-friendly
 * form. Pure function, no side effects, no dependencies.
 */
export function normalizeArabic(text: string): string {
  let result = text.normalize('NFKC');

  result = result.replace(TASHKEEL_PATTERN, '');
  result = result.replace(TATWEEL_PATTERN, '');

  result = result.replace(ALEF_VARIANTS_PATTERN, 'ا'); // -> ا
  result = result.replace(ALEF_MAKSURA_PATTERN, 'ي'); // -> ي
  result = result.replace(TEH_MARBUTA_PATTERN, 'ه'); // -> ه
  result = result.replace(HAMZA_WAW_PATTERN, 'و'); // -> و
  result = result.replace(HAMZA_YEH_PATTERN, 'ي'); // -> ي

  result = foldDigits(result);
  result = result.toLowerCase();

  result = result.replace(PUNCTUATION_PATTERN, ' ');
  result = result.replace(WHITESPACE_PATTERN, ' ').trim();

  return result;
}
