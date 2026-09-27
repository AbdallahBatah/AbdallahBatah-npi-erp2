// Number and date formatting, in one place (fix 10 of the design-critique
// pass) — spec/madar/03 §1: "Numbers Latin, Gregorian
// (ar-SA-u-nu-latn-ca-gregory) — NPI convention."
//
// Every place in the copilot UI that renders a count or a date must go
// through these two functions rather than calling `toLocaleString`/
// `Intl.DateTimeFormat` directly, so the locale pin lives in exactly one
// place.
const LOCALE = 'ar-SA-u-nu-latn-ca-gregory';

/** Formats an integer count with Latin digits (e.g. `1234` → `"1,234"`). */
export function formatNumber(n: number): string {
  return n.toLocaleString(LOCALE);
}

/** Formats a date with Latin digits and the Gregorian calendar — never
 *  Hijri, regardless of the runtime's default calendar for `ar-SA`. */
export function formatDate(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return new Intl.DateTimeFormat(LOCALE, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}
