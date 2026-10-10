/**
 * CRM Phase 1 · Step 5 (spec 4.4) — the date rules of a follow-up task, as pure
 * functions shared by the API (which enforces them) and the web app (which shows them).
 *
 * The same two ideas as a proposal's validity (proposal-dates.ts):
 *
 *  · A task is due on a DAY, not at an instant. The day is a calendar day in Riyadh (the
 *    business runs on Asia/Riyadh, UTC+3, no daylight saving), stored as UTC midnight of
 *    that date. A task is late once a LATER Riyadh day has begun — the due day itself is
 *    still on time, down to 23:59 Riyadh.
 *
 *  · Every function here reads the Riyadh DAY of its argument, so it gives the same
 *    answer for the stored form (UTC midnight of the date) and for the Riyadh-midnight
 *    form of the same day.
 *
 * No other file computes a task's day arithmetic: the service, the scheduler, the inbox
 * and the screens all come through here.
 */
import { riyadhDateKey, riyadhDayStart } from './proposal-dates';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export type TaskDueState = 'OVERDUE' | 'TODAY' | 'UPCOMING';

/**
 * The instant a reminder goes out when nobody names one: `hourRiyadh` o'clock, Riyadh
 * time, `daysBefore` days before the due day (0 = on the due day itself).
 */
export function defaultRemindAt(dueDay: Date, daysBefore: number, hourRiyadh: number): Date {
  return new Date(riyadhDayStart(dueDay).getTime() - daysBefore * DAY_MS + hourRiyadh * HOUR_MS);
}

/** Which side of today (Riyadh) a due day is on. */
export function taskDueState(dueAt: Date, now: Date = new Date()): TaskDueState {
  const due = riyadhDateKey(dueAt);
  const today = riyadhDateKey(now);
  if (due < today) return 'OVERDUE';
  return due === today ? 'TODAY' : 'UPCOMING';
}

/** Whole Riyadh days past the due day; 0 on the due day, before it, and for a task not yet late. */
export function daysOverdue(dueAt: Date, now: Date = new Date()): number {
  const due = Date.parse(`${riyadhDateKey(dueAt)}T00:00:00.000Z`);
  const today = Date.parse(`${riyadhDateKey(now)}T00:00:00.000Z`);
  return Math.max(0, Math.round((today - due) / DAY_MS));
}

/** Is the due day strictly before today (Riyadh)? Today itself is not "before today". */
export function isBeforeToday(dueAt: Date, now: Date = new Date()): boolean {
  return taskDueState(dueAt, now) === 'OVERDUE';
}
