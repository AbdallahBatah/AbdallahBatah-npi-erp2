import type { Locale } from './messages';

// Arabic UI keeps Arabic words (month names, currency label) but uses Western
// digits everywhere — `-u-nu-latn` pins the Latin numbering system.
// Western digits + explicit Gregorian calendar: older ICU/Safari default
// ar-SA to Umm al-Qura (Hijri) — pin it so dates never silently flip.
const AR_NUM = 'ar-SA-u-nu-latn-ca-gregory';

export function formatMoney(
  value: number | string | null | undefined,
  locale: Locale,
  currency = 'SAR',
): string {
  const n = Number(value ?? 0);
  return new Intl.NumberFormat(locale === 'ar' ? AR_NUM : 'en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(n);
}

export function formatNumber(
  value: number | string | null | undefined,
  locale: Locale,
): string {
  const n = Number(value ?? 0);
  return new Intl.NumberFormat(locale === 'ar' ? AR_NUM : 'en-US').format(n);
}

/**
 * Formats the calendar day of an ISO string with no timezone drift — the date
 * part is read literally. Use for period bounds, where `…T23:59:59Z` would
 * otherwise render as the next day east of UTC (and the previous day west).
 */
export function formatDay(
  value: string | null | undefined,
  locale: Locale,
): string {
  if (!value) return '—';
  const [y, m, d] = value.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return formatDate(value, locale);
  return formatDate(new Date(y, m - 1, d), locale);
}

export function formatDate(
  value: string | Date | null | undefined,
  locale: Locale,
): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  return new Intl.DateTimeFormat(locale === 'ar' ? AR_NUM : 'en-GB', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(d);
}
