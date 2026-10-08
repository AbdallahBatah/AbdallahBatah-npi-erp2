/**
 * CRM Phase 1 · Step 5 (contract §3, §8) — the date rules of a follow-up task, as pure
 * functions of @npi/shared. `packages/shared` has no jest setup of its own, so this
 * spec lives with the API (the arrangement of arabic.spec.ts) and imports through the
 * package entry point exactly as the services do.
 *
 * The business runs on Asia/Riyadh (UTC+3, no daylight saving). A due date is a DAY:
 * stored as UTC midnight of its Riyadh date (the convention of a proposal's validUntil).
 */
import {
  daysOverdue,
  defaultRemindAt,
  isBeforeToday,
  taskDueState,
  ACTIVITY_TYPES,
  FOLLOWUP_TASK_STATUSES,
} from '@npi/shared';

/** The stored form of "10 October 2026". */
const DUE = new Date('2026-10-10T00:00:00.000Z');

describe('defaultRemindAt — the reminder instant a task gets when nobody names one', () => {
  it('1 day before at 08:00 Riyadh is 08:00 on the previous day (05:00 UTC)', () => {
    expect(defaultRemindAt(DUE, 1, 8).toISOString()).toBe('2026-10-09T05:00:00.000Z');
  });

  it('0 days before is the due day itself', () => {
    expect(defaultRemindAt(DUE, 0, 8).toISOString()).toBe('2026-10-10T05:00:00.000Z');
  });

  it('counts the hour in Riyadh time: hour 0 is midnight Riyadh (21:00 UTC the evening before)', () => {
    expect(defaultRemindAt(DUE, 0, 0).toISOString()).toBe('2026-10-09T21:00:00.000Z');
    expect(defaultRemindAt(DUE, 2, 23).toISOString()).toBe('2026-10-08T20:00:00.000Z');
  });

  it('reads the Riyadh DAY of the argument, so the Riyadh-midnight form of the same day gives the same instant', () => {
    expect(defaultRemindAt(new Date('2026-10-09T21:00:00.000Z'), 1, 8).toISOString()).toBe('2026-10-09T05:00:00.000Z');
  });
});

describe('taskDueState — which side of today (Riyadh) a due day is on', () => {
  it('23:59:59 Riyadh on the due day is still TODAY', () => {
    expect(taskDueState(DUE, new Date('2026-10-10T20:59:59.000Z'))).toBe('TODAY');
  });

  it('00:00:00 Riyadh on the next day is OVERDUE (21:00:00 UTC)', () => {
    expect(taskDueState(DUE, new Date('2026-10-10T21:00:00.000Z'))).toBe('OVERDUE');
  });

  it('00:01 Riyadh the day after the due day is OVERDUE', () => {
    expect(taskDueState(DUE, new Date('2026-10-10T21:01:00.000Z'))).toBe('OVERDUE');
  });

  it('23:59:59 Riyadh the day before is UPCOMING, and 00:00:00 that morning is TODAY', () => {
    expect(taskDueState(DUE, new Date('2026-10-09T20:59:59.000Z'))).toBe('UPCOMING');
    expect(taskDueState(DUE, new Date('2026-10-09T21:00:00.000Z'))).toBe('TODAY');
  });

  it('a far-future task is UPCOMING', () => {
    expect(taskDueState(DUE, new Date('2026-09-01T00:00:00.000Z'))).toBe('UPCOMING');
  });
});

describe('daysOverdue — whole Riyadh days past the due day', () => {
  it('is 0 on the due day and before it', () => {
    expect(daysOverdue(DUE, new Date('2026-10-10T20:59:59.000Z'))).toBe(0);
    expect(daysOverdue(DUE, new Date('2026-10-01T10:00:00.000Z'))).toBe(0);
  });

  it('is 1 from midnight Riyadh after the due day, and grows by one per Riyadh day', () => {
    expect(daysOverdue(DUE, new Date('2026-10-10T21:00:00.000Z'))).toBe(1);
    expect(daysOverdue(DUE, new Date('2026-10-11T20:59:59.000Z'))).toBe(1);
    expect(daysOverdue(DUE, new Date('2026-10-11T21:00:00.000Z'))).toBe(2);
    expect(daysOverdue(DUE, new Date('2026-10-13T10:00:00.000Z'))).toBe(3);
  });
});

describe('isBeforeToday — the "no due date in the past" rule', () => {
  it('yesterday is before today; today and tomorrow are not', () => {
    const now = new Date('2026-10-10T10:00:00.000Z'); // 13:00 on the 10th in Riyadh
    expect(isBeforeToday(new Date('2026-10-09T00:00:00.000Z'), now)).toBe(true);
    expect(isBeforeToday(new Date('2026-10-10T00:00:00.000Z'), now)).toBe(false);
    expect(isBeforeToday(new Date('2026-10-11T00:00:00.000Z'), now)).toBe(false);
  });

  it('judges by the Riyadh day: 01:00 Riyadh on the 11th (22:00 UTC on the 10th) already makes the 10th past', () => {
    const now = new Date('2026-10-10T22:00:00.000Z');
    expect(isBeforeToday(new Date('2026-10-10T00:00:00.000Z'), now)).toBe(true);
    expect(isBeforeToday(new Date('2026-10-11T00:00:00.000Z'), now)).toBe(false);
  });
});

describe('the enums /reference/enums serves', () => {
  it('ActivityType is note, call, meeting — in that order, bilingual', () => {
    expect(ACTIVITY_TYPES.map((o) => o.value)).toEqual(['NOTE', 'CALL', 'MEETING']);
    expect(ACTIVITY_TYPES.map((o) => o.labelAr)).toEqual(['ملاحظة', 'مكالمة', 'اجتماع']);
    expect(ACTIVITY_TYPES.every((o) => o.labelEn.length > 0)).toBe(true);
  });

  it('FollowUpTaskStatus is open, done, cancelled', () => {
    expect(FOLLOWUP_TASK_STATUSES.map((o) => o.value)).toEqual(['OPEN', 'DONE', 'CANCELLED']);
    expect(FOLLOWUP_TASK_STATUSES.map((o) => o.labelAr)).toEqual(['مفتوحة', 'منجزة', 'ملغاة']);
  });
});
