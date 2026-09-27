// Unit tests for src/i18n/format.ts (fix 10 of the design-critique pass).
import { formatNumber, formatDate } from '../src/i18n/format';

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
