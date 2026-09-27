import { normalizeArabic } from '../src/text/normalize';
import { hasAnyPhrase, indicesOfPhrase, indicesOfWords, particleForms, tokenIsWord, tokenize } from '../src/text/tokens';

const n = normalizeArabic;
const toks = (text: string) => tokenize(n(text));

describe('tokenize', () => {
  it('splits normalized text on spaces and drops empties', () => {
    expect(toks('  عقد   جديد ')).toEqual([n('عقد'), n('جديد')]);
    expect(tokenize('')).toEqual([]);
  });
});

describe('particleForms', () => {
  it('peels conjunction, preposition and article in that order', () => {
    expect(particleForms(n('وبالعقد'))).toEqual(expect.arrayContaining([n('وبالعقد'), n('بالعقد'), n('العقد'), n('عقد')]));
  });

  it('understands «لل» as the preposition plus the article', () => {
    expect(particleForms(n('للنخيل'))).toEqual(expect.arrayContaining([n('نخيل')]));
    expect(particleForms(n('وللمورد'))).toEqual(expect.arrayContaining([n('مورد')]));
  });

  it('never peels a word down to a single letter', () => {
    expect(particleForms(n('بل'))).toEqual([n('بل')]);
  });
});

describe('tokenIsWord', () => {
  it.each([
    ['عقد', 'عقد'],
    ['العقد', 'عقد'],
    ['بالعقد', 'عقد'],
    ['وللعقد', 'عقد'],
    ['عقد', 'العقد'],
    ['والمورد', 'المورد'],
  ])('%s is the word %s', (token, word) => {
    expect(tokenIsWord(n(token), n(word))).toBe(true);
  });

  it.each([
    ['معقد', 'عقد'],
    ['عقدة', 'عقد'],
    ['فنية', 'فني'],
    ['كتابي', 'أبي'],
    ['التعامل', 'عامل'],
    ['مديرية', 'مدير'],
    ['ضمن', 'من'],
  ])('%s is not the word %s', (token, word) => {
    expect(tokenIsWord(n(token), n(word))).toBe(false);
  });
});

describe('phrases', () => {
  it('finds a phrase as consecutive whole words, with particles attached', () => {
    expect(indicesOfPhrase(toks('أرفقت لك فاتورة المورد اليوم'), n('فاتورة مورد'))).toEqual([2]);
    expect(indicesOfPhrase(toks('بخصوص أمر الشراء الأخير'), n('أمر شراء'))).toEqual([1]);
  });

  it('does not join words that are not adjacent', () => {
    expect(indicesOfPhrase(toks('فاتورة من عند المورد'), n('فاتورة مورد'))).toEqual([]);
  });

  it('indicesOfWords and hasAnyPhrase agree on whole-word matching', () => {
    expect(indicesOfWords(toks('هذا أمر معقد'), [n('عقد')])).toEqual([]);
    expect(hasAnyPhrase(toks('هذا العقد معقد'), [n('عقد')])).toBe(true);
  });
});
