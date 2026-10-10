// Unit tests for src/i18n/format.ts (fix 10 of the design-critique pass).
import { formatNumber, formatDate, formatDateTime, formatUsdMicro } from '../src/i18n/format';

const EASTERN_ARABIC_DIGIT_RE = /[٠-٩]/;

describe('formatNumber', () => {
  it('formats zero', () => {
    expect(formatNumber(0)).toBe('0');
  });

  it('formats a small integer with Latin digits only', () => {
    const s = formatNumber(7);
    expect(s).toBe('7');
    expect(EASTERN_ARABIC_DIGIT_RE.test(s)).toBe(false);
  });

  it('groups thousands the way ar-SA-u-nu-latn does', () => {
    expect(formatNumber(12345)).toBe((12345).toLocaleString('ar-SA-u-nu-latn'));
  });

  it('never renders Eastern Arabic-Indic digits for a large number', () => {
    const s = formatNumber(987654);
    expect(EASTERN_ARABIC_DIGIT_RE.test(s)).toBe(false);
  });
});

describe('formatDate', () => {
  it('accepts a Date object', () => {
    const s = formatDate(new Date('2026-01-15T00:00:00Z'));
    expect(typeof s).toBe('string');
    expect(s.length).toBeGreaterThan(0);
  });

  it('accepts an ISO date string', () => {
    const s = formatDate('2026-01-15T00:00:00Z');
    expect(typeof s).toBe('string');
  });

  it('never renders in the Hijri calendar (the Gregorian year appears, not the Hijri one)', () => {
    const s = formatDate('2026-01-15T00:00:00Z');
    expect(s).toContain('2026');
    // 2026-01-15 CE falls in Hijri year 1447 — that must never appear.
    expect(s).not.toContain('1447');
  });

  it('uses Latin digits, never Eastern Arabic-Indic numerals', () => {
    const s = formatDate('2026-06-01T00:00:00Z');
    expect(EASTERN_ARABIC_DIGIT_RE.test(s)).toBe(false);
    expect(/[0-9]/.test(s)).toBe(true);
  });
});

describe('formatDateTime', () => {
  // Strip the bidi marks Intl may add around Arabic-locale numerals.
  const stripMarks = (s: string): string => s.replace(/[‎‏]/g, '');

  it('renders Latin digits, a Gregorian year and an HH:mm group, with no م/ص marker', () => {
    const out = stripMarks(formatDateTime(new Date('2026-10-06T14:35:00Z')));
    // ar-SA separates date and time with the Arabic comma U+060C, not ",".
    expect(out).toMatch(/^[0-9\/:,، ]+$/);
    expect(out).toContain('2026');
    expect(out).toMatch(/\b\d{2}:\d{2}\b/);
    expect(out).not.toMatch(/[مص]/);
  });

  it('accepts an ISO string the same way as a Date', () => {
    const iso = '2026-10-06T14:35:00.000Z';
    expect(formatDateTime(iso)).toBe(formatDateTime(new Date(iso)));
  });

  it('never renders Eastern Arabic-Indic digits or the Hijri year', () => {
    const out = formatDateTime(new Date('2026-01-15T09:05:00Z'));
    expect(EASTERN_ARABIC_DIGIT_RE.test(out)).toBe(false);
    expect(out).not.toContain('1447');
  });
});

describe('formatUsdMicro', () => {
  it('formats a bigint of micro-dollars with four decimals', () => {
    expect(formatUsdMicro(48236n)).toBe('0.0482');
    expect(formatUsdMicro(123456789n)).toBe('123.4568');
  });

  it('formats the decimal string the JSON carries', () => {
    expect(formatUsdMicro('48236')).toBe('0.0482');
  });

  it('formats numbers, including zero and one dollar', () => {
    expect(formatUsdMicro(0)).toBe('0.0000');
    expect(formatUsdMicro(1_000_000)).toBe('1.0000');
  });

  it('renders an unparsable value as 0.0000 instead of throwing', () => {
    expect(formatUsdMicro('abc')).toBe('0.0000');
  });
});
