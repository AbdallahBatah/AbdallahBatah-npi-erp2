/**
 * CRM Phase 1 · Step 2 — Arabic name normalisation, similarity and Saudi mobile
 * normalisation (contract §2, §7).
 *
 * `packages/shared` has no jest setup of its own, so this spec lives with the
 * API and imports the functions through the package entry point exactly as the
 * services do.
 */
import {
  nameSimilarity,
  normalizeArabicName,
  normalizeSaudiMobile,
  stripLegalForm,
} from '@npi/shared';

describe('normalizeArabicName', () => {
  it('removes diacritics and tatweel', () => {
    expect(normalizeArabicName('مُحَمَّد')).toBe('محمد');
    expect(normalizeArabicName('الــرياض')).toBe('رياض');
  });

  it('unifies alef, teh marbuta, alef maqsura, hamza carriers', () => {
    expect(normalizeArabicName('أحمد')).toBe('احمد');
    expect(normalizeArabicName('إبراهيم')).toBe('ابراهيم');
    expect(normalizeArabicName('آمنة')).toBe('امنه');
    expect(normalizeArabicName('العلى')).toBe('علي');
    expect(normalizeArabicName('مؤسسة')).toBe('موسسه');
    expect(normalizeArabicName('رئيس')).toBe('رييس');
  });

  it('drops the definite article at the start of every word', () => {
    expect(normalizeArabicName('الرياض الصناعية')).toBe('رياض صناعيه');
    // A bare «ال» (or a word that would be left with one letter) is kept.
    expect(normalizeArabicName('آل سعود')).toBe('ال سعود');
  });

  it('lower-cases latin, removes punctuation and collapses spaces', () => {
    expect(normalizeArabicName('  Riyadh   Industries, Co. ')).toBe('riyadh industries co');
    expect(normalizeArabicName('ش.م.م')).toBe('شمم');
    expect(normalizeArabicName('النور-للتجارة')).toBe('نور للتجاره');
  });

  it('maps Arabic-Indic digits to ASCII', () => {
    expect(normalizeArabicName('مصنع ٧٠٠')).toBe('مصنع 700');
  });

  it('is idempotent', () => {
    const once = normalizeArabicName('شركة الرياض للصناعات المحدودة');
    expect(normalizeArabicName(once)).toBe(once);
  });
});

describe('stripLegalForm', () => {
  it('removes legal-entity words but keeps activity words', () => {
    expect(stripLegalForm('شركة الرياض للصناعات')).toBe('رياض للصناعات');
    expect(stripLegalForm('مصنع الرياض للصناعات')).toBe('مصنع رياض للصناعات');
    expect(stripLegalForm('مكتب النور الهندسي')).toBe('مكتب نور هندسي');
    expect(stripLegalForm('مستودع الغد')).toBe('مستودع غد');
  });

  it('removes the English forms and the abbreviations', () => {
    expect(stripLegalForm('Riyadh Industries Co Ltd')).toBe('riyadh industries');
    expect(stripLegalForm('Gulf Solar LLC')).toBe('gulf solar');
    expect(stripLegalForm('النور ش.م.م')).toBe('نور');
    expect(stripLegalForm('النور ذ.م.م')).toBe('نور');
    expect(stripLegalForm('مؤسسة النور للتجارة المحدودة')).toBe('نور');
  });

  it('falls back to the normalised name when nothing else would be left', () => {
    expect(stripLegalForm('شركة')).toBe('شركه');
  });
});

describe('nameSimilarity', () => {
  it('treats a company and a factory with the same trade name as similar (>= 0.8)', () => {
    const s = nameSimilarity('شركة الرياض للصناعات', 'مصنع الرياض للصناعات');
    console.log('similarity «شركة الرياض للصناعات» vs «مصنع الرياض للصناعات» =', s);
    expect(s).toBeGreaterThanOrEqual(0.8);
  });

  it('is exactly 1 for names that differ only in spelling variants', () => {
    expect(nameSimilarity('أحمد العلي', 'احمد العلى')).toBe(1);
    expect(nameSimilarity('شركة الرياض للصناعات', 'الرياض للصناعات المحدودة')).toBe(1);
  });

  it('keeps «شركة النور» and «شركة النورس للمقاولات» apart (< 0.8)', () => {
    const s = nameSimilarity('شركة النور', 'شركة النورس للمقاولات');
    console.log('similarity «شركة النور» vs «شركة النورس للمقاولات» =', s);
    expect(s).toBeLessThan(0.8);
    expect(s).toBeGreaterThan(0);
  });

  it('is symmetric and bounded', () => {
    const a = 'مصنع الخليج للألواح';
    const b = 'مصنع الخليج للالواح الشمسية';
    expect(nameSimilarity(a, b)).toBe(nameSimilarity(b, a));
    expect(nameSimilarity(a, b)).toBeGreaterThan(0);
    expect(nameSimilarity(a, b)).toBeLessThanOrEqual(1);
  });

  it('returns 0 for unrelated names and for empty input', () => {
    expect(nameSimilarity('مصنع الرياض', 'Gulf Solar')).toBeLessThan(0.3);
    expect(nameSimilarity('', 'مصنع')).toBe(0);
    expect(nameSimilarity('', '')).toBe(0);
  });

  it('never matches on a raw substring', () => {
    // «نور» is a substring of «منورة», but the names are not alike.
    expect(nameSimilarity('نور', 'مؤسسة المنورة للتجارة')).toBeLessThan(0.8);
  });
});

describe('normalizeSaudiMobile', () => {
  it('accepts the local, international and bare forms', () => {
    expect(normalizeSaudiMobile('0501234567')).toBe('+966501234567');
    expect(normalizeSaudiMobile('+966501234567')).toBe('+966501234567');
    expect(normalizeSaudiMobile('966501234567')).toBe('+966501234567');
    expect(normalizeSaudiMobile('00966501234567')).toBe('+966501234567');
    expect(normalizeSaudiMobile('501234567')).toBe('+966501234567');
  });

  it('ignores spaces, dashes and parentheses and reads Arabic-Indic digits', () => {
    expect(normalizeSaudiMobile('050 123 4567')).toBe('+966501234567');
    expect(normalizeSaudiMobile('+966 (50) 123-4567')).toBe('+966501234567');
    expect(normalizeSaudiMobile('٠٥٠١٢٣٤٥٦٧')).toBe('+966501234567');
  });

  it('returns null for landlines and anything else', () => {
    expect(normalizeSaudiMobile('0112345678')).toBeNull();
    expect(normalizeSaudiMobile('+966112345678')).toBeNull();
    expect(normalizeSaudiMobile('0601234567')).toBeNull();
    expect(normalizeSaudiMobile('05012345')).toBeNull();
    expect(normalizeSaudiMobile('')).toBeNull();
    expect(normalizeSaudiMobile(undefined)).toBeNull();
    expect(normalizeSaudiMobile('abc')).toBeNull();
  });
});
