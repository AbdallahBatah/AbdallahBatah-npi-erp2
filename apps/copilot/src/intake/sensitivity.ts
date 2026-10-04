// Confidentiality detection for document intake (spec/madar/02 §5.1): a file
// name, or the first SENSITIVITY_TEXT_WINDOW characters of extracted text,
// containing «سري» / «سرية» / "confidential" as a WHOLE WORD refuses the
// document — never by substring, so «سرير» (bed) or «سريع» (fast) never
// trips the filter. Pure, no I/O.
import { normalizeArabic } from '../text/normalize';
import { indicesOfWords, tokenize } from '../text/tokens';

export const SENSITIVITY_TEXT_WINDOW = 2000;

export type SensitivityReason = 'filename' | 'text';

export interface SensitivityVerdict {
  confidential: boolean;
  reason: SensitivityReason | null;
  matched: string | null;
}

const CONFIDENTIAL_WORDS = ['سري', 'سرية', 'confidential'].map((w) => normalizeArabic(w));

/**
 * Returns the matched normalized word when `text` contains a confidentiality
 * marker as a whole word, or null otherwise.
 *
 * File names glue words together with `-`/`_` ("عقد-سري.pdf"), so those are
 * turned into spaces here, after normalization (normalizeArabic() itself
 * keeps `-`/`_` intact so codes like "PRJ-00012" survive elsewhere).
 */
export function isConfidentialText(text: string): string | null {
  const normalized = normalizeArabic(text).replace(/[-_]/g, ' ');
  const tokens = tokenize(normalized);
  const indices = indicesOfWords(tokens, CONFIDENTIAL_WORDS);
  return indices.length === 0 ? null : tokens[indices[0]];
}

/** Checks the file name first, then the leading window of `text`. */
export function checkSensitivity(input: { fileName: string; text?: string | null }): SensitivityVerdict {
  const byFileName = isConfidentialText(input.fileName);
  if (byFileName) return { confidential: true, reason: 'filename', matched: byFileName };

  if (input.text) {
    const windowed = input.text.slice(0, SENSITIVITY_TEXT_WINDOW);
    const byText = isConfidentialText(windowed);
    if (byText) return { confidential: true, reason: 'text', matched: byText };
  }

  return { confidential: false, reason: null, matched: null };
}
