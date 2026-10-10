// Number and date formatting, in one place (fix 10 of the design-critique
// pass) — spec/madar/03 §1: "Numbers Latin, Gregorian
// (ar-SA-u-nu-latn-ca-gregory) — NPI convention."
//
// Every place in the copilot UI that renders a count or a date must go
// through these two functions rather than calling `toLocaleString`/
// `Intl.DateTimeFormat` directly, so the locale pin lives in exactly one
// place.
import { t, type ArKey } from './ar';

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

/** Date plus a 24-hour time (`HH:mm`), same locale pin as `formatDate` — the
 *  trust log (T-33) needs the minute, not just the day. Rendered in the
 *  caller's own time zone (the browser's, for a client component). */
export function formatDateTime(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return new Intl.DateTimeFormat(LOCALE, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

/** Formats `llm_audit.costUsdMicro` (micro-dollars, a bigint carried over
 *  JSON as a decimal string) as dollars with four decimals and Latin digits:
 *  `48236` → `"0.0482"`. An unparsable value renders as `"0.0000"` rather
 *  than throwing inside a table cell. */
export function formatUsdMicro(micro: bigint | number | string): string {
  const n = typeof micro === 'bigint' ? Number(micro) : Number(micro);
  const dollars = Number.isFinite(n) ? n / 1_000_000 : 0;
  return dollars.toLocaleString(LOCALE, { minimumFractionDigits: 4, maximumFractionDigits: 4 });
}

const AGO_PLURALS = new Intl.PluralRules('ar');

/**
 * «منذ دقيقتين» / «منذ 5 ساعات» / «منذ يوم»: how long before `now` a moment
 * was, in the Arabic number agreement (one / two / 3–10 / 11+), falling back to
 * a date past 45 days. Computed on the server and sent as text — a client
 * component that formatted it itself would differ between the server render
 * and hydration.
 */
export function formatAgo(then: Date | string, now: Date): string {
  const at = typeof then === 'string' ? new Date(then) : then;
  const seconds = Math.max(0, Math.floor((now.getTime() - at.getTime()) / 1000));
  if (seconds < 60) return t('sync.ago.now');
  const days = Math.floor(seconds / 86400);
  if (days > 45) return t('sync.ago.date', { date: formatDate(at) });
  const [unit, n] = days >= 1 ? (['day', days] as const) : seconds >= 3600 ? (['hour', Math.floor(seconds / 3600)] as const) : (['minute', Math.floor(seconds / 60)] as const);
  const category = AGO_PLURALS.select(n);
  const form = category === 'one' ? 'one' : category === 'two' ? 'two' : category === 'few' ? 'few' : 'many';
  return t(`sync.ago.${unit}.${form}` as ArKey, { n: formatNumber(n) });
}
