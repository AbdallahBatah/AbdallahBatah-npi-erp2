/**
 * CRM Phase 1 · Step 4 (spec 4.3) — the date rules of a proposal, as pure functions
 * shared by the API (which enforces them) and the web app (which shows them).
 *
 * Two ideas:
 *
 *  · A proposal revision is valid THROUGH its valid-until day. The day is a calendar
 *    day in Riyadh (the business runs on Asia/Riyadh, UTC+3, no daylight saving),
 *    stored as UTC midnight of that date. It expires when the whole day is over —
 *    i.e. once `now` is on a later Riyadh day.
 *
 *  · A cost is as old as the purchase it came from. A catalogue cost has no
 *    purchase date, so its age is unknown — and an unknown age is warned about
 *    exactly like an old one: nobody can vouch that it is current.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const RIYADH_OFFSET_MS = 3 * HOUR_MS;

/** The Riyadh calendar day containing `at`, as YYYY-MM-DD. */
export function riyadhDateKey(at: Date): string {
  return new Date(at.getTime() + RIYADH_OFFSET_MS).toISOString().slice(0, 10);
}

/** The instant the Riyadh day containing `at` began. */
export function riyadhDayStart(at: Date): Date {
  return new Date(Date.parse(`${riyadhDateKey(at)}T00:00:00.000Z`) - RIYADH_OFFSET_MS);
}

/**
 * What the database stores for a valid-until date typed or sent by a client: UTC
 * midnight of the Riyadh calendar day the input falls on. Null for anything that is
 * not a date (the caller turns that into a 400).
 */
export function normalizeValidUntil(input: string | Date | null | undefined): Date | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'string' && input.trim() === '') return null;
  const at = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(at.getTime())) return null;
  return new Date(`${riyadhDateKey(at)}T00:00:00.000Z`);
}

/** Has the whole valid-until day passed? The valid-until day itself is still valid. */
export function isValidityExpired(validUntil: Date, now: Date = new Date()): boolean {
  return validUntil.getTime() < riyadhDayStart(now).getTime();
}

/** Is the valid-until day strictly after today (Riyadh)? Today itself is not "after today". */
export function isValidityFuture(validUntil: Date, now: Date = new Date()): boolean {
  return validUntil.getTime() > Date.parse(`${riyadhDateKey(now)}T00:00:00.000Z`);
}

/** Whole days since the cost was incurred; null when the cost carries no date. Never negative. */
export function costAge(costDate: Date | null | undefined, now: Date = new Date()): number | null {
  if (!costDate) return null;
  return Math.max(0, Math.floor((now.getTime() - costDate.getTime()) / DAY_MS));
}

/** Older than the limit — or of unknown age — and so to be warned about. */
export function isStale(ageDays: number | null | undefined, warnDays: number): boolean {
  return ageDays === null || ageDays === undefined || ageDays > warnDays;
}
