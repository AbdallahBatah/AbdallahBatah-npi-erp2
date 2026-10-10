// Whole-word matching for normalized Arabic text.
//
// Arabic attaches conjunctions, prepositions and the article to the word
// («وبالعقد» = و + ب + ال + عقد), so matching by substring finds «عقد» inside
// «معقد» and «فني» inside «فنية», while matching by exact token misses
// «بالعقد». The helpers here match a word against a token only after peeling
// the attached particles off the front of the token.
//
// Every function expects text that already went through `normalizeArabic`.

const CONJUNCTIONS = ['و', 'ف'];
const PREPOSITIONS = ['ب', 'ل', 'ك'];
const ARTICLE = 'ال';

/** Shortest remainder worth keeping after peeling a particle. */
const MIN_REMAINDER = 2;

export function tokenize(normalized: string): string[] {
  return normalized.length === 0 ? [] : normalized.split(' ').filter((token) => token.length > 0);
}

/**
 * The token itself plus every form left after peeling attached particles, in
 * the only order Arabic allows: conjunction, then preposition, then article.
 * «لل…» is the preposition ل followed by the article with its alef dropped.
 */
export function particleForms(token: string): string[] {
  const forms = new Set<string>([token]);

  const afterConjunction = [token];
  for (const c of CONJUNCTIONS) {
    if (token.startsWith(c) && token.length - c.length >= MIN_REMAINDER) {
      afterConjunction.push(token.slice(c.length));
    }
  }

  const afterPreposition = [...afterConjunction];
  for (const form of afterConjunction) {
    for (const p of PREPOSITIONS) {
      if (form.startsWith(p) && form.length - p.length >= MIN_REMAINDER) {
        afterPreposition.push(form.slice(p.length));
      }
    }
    // «للعقد»: ل + (ا)ل + عقد
    if (form.startsWith('لل') && form.length - 2 >= MIN_REMAINDER) {
      afterPreposition.push(form.slice(2));
    }
  }

  for (const form of afterPreposition) {
    forms.add(form);
    if (form.startsWith(ARTICLE) && form.length - ARTICLE.length >= MIN_REMAINDER) {
      forms.add(form.slice(ARTICLE.length));
    }
  }
  return [...forms];
}

/** A word matches a token when one of the token's forms equals the word, or
 *  equals the word without its own article. */
export function tokenIsWord(token: string, word: string): boolean {
  const bare = word.startsWith(ARTICLE) && word.length > ARTICLE.length + 1 ? word.slice(ARTICLE.length) : word;
  return particleForms(token).some((form) => form === word || form === bare);
}

/** Index of every token that is one of `words`. */
export function indicesOfWords(tokens: readonly string[], words: readonly string[]): number[] {
  const found: number[] = [];
  tokens.forEach((token, index) => {
    if (words.some((word) => tokenIsWord(token, word))) found.push(index);
  });
  return found;
}

/**
 * Index of the first token of each place where `phrase` (one or more words,
 * space separated, already normalized) occurs as consecutive whole words.
 */
export function indicesOfPhrase(tokens: readonly string[], phrase: string): number[] {
  const words = tokenize(phrase);
  if (words.length === 0) return [];
  const found: number[] = [];
  for (let start = 0; start + words.length <= tokens.length; start += 1) {
    if (words.every((word, offset) => tokenIsWord(tokens[start + offset], word))) found.push(start);
  }
  return found;
}

export function hasAnyPhrase(tokens: readonly string[], phrases: readonly string[]): boolean {
  return phrases.some((phrase) => indicesOfPhrase(tokens, phrase).length > 0);
}
