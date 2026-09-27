import { normalizeArabic } from '../src/text/normalize';

describe('normalizeArabic', () => {
  it('strips tashkeel from a simple word', () => {
    expect(normalizeArabic('مَدار')).toBe('مدار');
  });

  it('strips tashkeel and normalizes teh marbuta on a longer phrase', () => {
    expect(normalizeArabic('الشَّركة')).toBe('الشركه');
  });

  it('treats all alef forms (أ إ آ) as equal', () => {
    const a = normalizeArabic('أحمد');
    const b = normalizeArabic('إحمد');
    const c = normalizeArabic('آحمد');
    expect(a).toBe('احمد');
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('normalizes alef wasla (ٱ) to alef', () => {
    expect(normalizeArabic('ٱلرحمن')).toBe('الرحمن');
  });

  it('normalizes alef maksura (ى) to yeh', () => {
    expect(normalizeArabic('مصطفى')).toBe('مصطفي');
  });

  it('normalizes teh marbuta (ة) to heh', () => {
    expect(normalizeArabic('مدرسة')).toBe('مدرسه');
  });

  it('normalizes hamza-on-waw and hamza-on-yeh', () => {
    expect(normalizeArabic('مؤمن')).toBe('مومن');
    expect(normalizeArabic('بئر')).toBe('بير');
  });

  it('leaves a standalone hamza (ء) untouched', () => {
    expect(normalizeArabic('قراءة')).toBe('قراءه');
  });

  it('removes tatweel (ـ)', () => {
    expect(normalizeArabic('مـــرحبا')).toBe('مرحبا');
  });

  it('converts Arabic-Indic digits to ASCII', () => {
    expect(normalizeArabic('٠١٢٣٤٥٦٧٨٩')).toBe('0123456789');
  });

  it('converts Persian digits to ASCII', () => {
    expect(normalizeArabic('۰۱۲۳۴۵۶۷۸۹')).toBe('0123456789');
  });

  it('lowercases Latin letters', () => {
    expect(normalizeArabic('PRJ Alpha')).toBe('prj alpha');
  });

  it('keeps hyphens and underscores inside a code', () => {
    expect(normalizeArabic('PRJ-00012')).toBe('prj-00012');
    expect(normalizeArabic('ITEM_007')).toBe('item_007');
  });

  it('replaces Arabic punctuation (، ؛ ؟) with spaces and collapses whitespace', () => {
    expect(normalizeArabic('أحمد، محمد؛ هل هذا صحيح؟')).toBe('احمد محمد هل هذا صحيح');
  });

  it('replaces bracket characters ⟦ ⟧ with spaces', () => {
    expect(normalizeArabic('⟦مدار⟧')).toBe('مدار');
  });

  it('replaces Latin punctuation with spaces but keeps - and _', () => {
    expect(normalizeArabic('hello, world! (test)')).toBe('hello world test');
  });

  it('collapses multiple internal whitespace characters into one space', () => {
    expect(normalizeArabic('مدار    شركة')).toBe('مدار شركه');
  });

  it('trims leading and trailing whitespace', () => {
    expect(normalizeArabic('   مدار   ')).toBe('مدار');
  });

  it('returns an empty string for an empty input', () => {
    expect(normalizeArabic('')).toBe('');
  });

  it('returns an empty string for whitespace-only input', () => {
    expect(normalizeArabic('   \t\n  ')).toBe('');
  });

  it('is idempotent (normalizing twice gives the same result)', () => {
    const once = normalizeArabic('الشَّركة الأهلية، فرع #٢');
    const twice = normalizeArabic(once);
    expect(twice).toBe(once);
  });
});
