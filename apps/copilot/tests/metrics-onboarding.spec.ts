// T-20 acceptance: assumption a6 «التشكّل الذاتي» computed from
// `onboarding_sessions` rows (spec/madar/01-PRD.md §1 row ٦, §7).
import { t } from '../src/i18n/ar';
import {
  computeOnboardingMetric,
  loadOnboardingMetric,
  ONBOARDING_TARGET_MINUTES,
  sessionMinutes,
  type OnboardingMetricsDb,
  type OnboardingSessionLike,
} from '../src/metrics/onboarding';

const BASE = new Date('2026-10-04T10:00:00.000Z');

function minutesAfter(minutes: number): Date {
  return new Date(BASE.getTime() + minutes * 60000);
}

function session(
  minutesToComplete: number | null,
  overrides?: Partial<OnboardingSessionLike>,
): OnboardingSessionLike {
  return {
    npiOrgId: 'org-1',
    startedAt: BASE,
    completedAt: minutesToComplete === null ? null : minutesAfter(minutesToComplete),
    profileChosen: 'epc',
    ...overrides,
  };
}

describe('sessionMinutes', () => {
  it('is null for an open session', () => {
    expect(sessionMinutes(session(null))).toBeNull();
  });

  it('rounds to 1 decimal', () => {
    expect(sessionMinutes(session(12.53))).toBeCloseTo(12.5, 5);
  });

  it('clamps a negative duration (clock skew) to 0', () => {
    const s = session(0, { startedAt: minutesAfter(5), completedAt: BASE });
    expect(sessionMinutes(s)).toBe(0);
  });
});

describe('computeOnboardingMetric', () => {
  it('reports no_data on empty input', () => {
    const metric = computeOnboardingMetric([]);
    expect(metric.assumption).toBe('a6');
    expect(metric.labelAr).toBe(t('metrics.a6'));
    expect(metric.targetMinutes).toBe(ONBOARDING_TARGET_MINUTES);
    expect(metric.completed).toBe(0);
    expect(metric.open).toBe(0);
    expect(metric.medianMinutes).toBeNull();
    expect(metric.p90Minutes).toBeNull();
    expect(metric.maxMinutes).toBeNull();
    expect(metric.withinTargetShare).toBeNull();
    expect(metric.byProfile).toEqual({});
    expect(metric.verdict).toBe('no_data');
  });

  it('is met with a single fast completed session', () => {
    const metric = computeOnboardingMetric([session(12.5)]);
    expect(metric.completed).toBe(1);
    expect(metric.open).toBe(0);
    expect(metric.medianMinutes).toBe(12.5);
    expect(metric.p90Minutes).toBe(12.5);
    expect(metric.maxMinutes).toBe(12.5);
    expect(metric.withinTargetShare).toBe(1);
    expect(metric.verdict).toBe('met');
  });

  it('counts open sessions separately and excludes them from durations', () => {
    const metric = computeOnboardingMetric([session(10), session(null), session(20)]);
    expect(metric.completed).toBe(2);
    expect(metric.open).toBe(1);
    expect(metric.medianMinutes).not.toBeNull();
  });

  it('computes median/p90/max/share over five completed durations', () => {
    const durations = [5, 10, 20, 45, 120];
    const metric = computeOnboardingMetric(durations.map((m) => session(m)));
    expect(metric.completed).toBe(5);
    expect(metric.medianMinutes).toBe(20);
    expect(metric.p90Minutes).toBe(120);
    expect(metric.maxMinutes).toBe(120);
    expect(metric.withinTargetShare).toBe(0.6); // 3 of 5 (5,10,20) <= 30
    expect(metric.verdict).toBe('met');
  });

  it('is not_met when the median exceeds the target', () => {
    const metric = computeOnboardingMetric([session(40), session(50), session(60)]);
    expect(metric.medianMinutes).toBe(50);
    expect(metric.verdict).toBe('not_met');
  });

  it('clamps a negative duration to 0 inside the aggregate too', () => {
    const skewed = session(0, { startedAt: minutesAfter(5), completedAt: BASE });
    const metric = computeOnboardingMetric([skewed]);
    expect(metric.medianMinutes).toBe(0);
    expect(metric.withinTargetShare).toBe(1);
    expect(metric.verdict).toBe('met');
  });

  it('groups byProfile, bucketing a null profile under unknown', () => {
    const metric = computeOnboardingMetric([
      session(10, { profileChosen: 'epc' }),
      session(20, { profileChosen: 'epc' }),
      session(5, { profileChosen: null }),
      session(50, { profileChosen: 'om_provider' }),
    ]);
    // Even count: the median is the mean of the two middle values, 15.
    expect(metric.byProfile.epc).toEqual({ completed: 2, medianMinutes: 15, withinTarget: 2 });
    expect(metric.byProfile.unknown).toEqual({ completed: 1, medianMinutes: 5, withinTarget: 1 });
    expect(metric.byProfile.om_provider).toEqual({ completed: 1, medianMinutes: 50, withinTarget: 0 });
  });

  it('only counts completed sessions in byProfile', () => {
    const metric = computeOnboardingMetric([session(10, { profileChosen: 'epc' }), session(null, { profileChosen: 'epc' })]);
    expect(metric.byProfile.epc.completed).toBe(1);
  });

  it('honors a custom targetMinutes', () => {
    const metric = computeOnboardingMetric([session(10), session(20)], { targetMinutes: 15 });
    // Even count: the median is the mean of the two middle values, 15.
    expect(metric.targetMinutes).toBe(15);
    expect(metric.withinTargetShare).toBe(0.5);
    expect(metric.medianMinutes).toBe(15);
    expect(metric.verdict).toBe('met'); // median 15 <= target 15
  });
});

describe('loadOnboardingMetric', () => {
  function buildFakeDb(sessions: OnboardingSessionLike[]) {
    const calls: unknown[] = [];
    const db: OnboardingMetricsDb = {
      onboardingSession: {
        findMany: async (args) => {
          calls.push(args);
          if (args.where?.npiOrgId !== undefined) {
            return sessions.filter((s) => s.npiOrgId === args.where!.npiOrgId);
          }
          return sessions;
        },
      },
    };
    return { db, calls };
  }

  it('passes no `where` and the exact `select` when npiOrgId is omitted', async () => {
    const { db, calls } = buildFakeDb([session(10), session(50, { npiOrgId: 'org-2' })]);
    const metric = await loadOnboardingMetric(db);
    expect(calls).toEqual([
      { select: { npiOrgId: true, startedAt: true, completedAt: true, profileChosen: true } },
    ]);
    expect(metric.completed).toBe(2);
  });

  it('passes `where: { npiOrgId }` when given, and filters accordingly', async () => {
    const { db, calls } = buildFakeDb([session(10, { npiOrgId: 'org-1' }), session(50, { npiOrgId: 'org-2' })]);
    const metric = await loadOnboardingMetric(db, { npiOrgId: 'org-1' });
    expect(calls).toEqual([
      {
        where: { npiOrgId: 'org-1' },
        select: { npiOrgId: true, startedAt: true, completedAt: true, profileChosen: true },
      },
    ]);
    expect(metric.completed).toBe(1);
    expect(metric.medianMinutes).toBe(10);
  });

  it('forwards a custom targetMinutes', async () => {
    const { db } = buildFakeDb([session(10), session(20)]);
    const metric = await loadOnboardingMetric(db, { targetMinutes: 15 });
    expect(metric.targetMinutes).toBe(15);
  });
});
