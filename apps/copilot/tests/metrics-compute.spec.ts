// T-35 (F-19, 01 §1 + §7, 06 AT-13): the pure computation of the six metric
// cards a1-a6 - working days on the Riyadh calendar, the daily return, the
// latest-run pickers, memory / PII / chat-entry / cost / onboarding cards and
// the assembled view. Fixtures are built by hand; every expected string comes
// from t(). No database, no clock, no network, no environment reads.
import { aggregateUsage, riyadhTrailingPeriod } from '../src/audit/cost';
import type { DailyUsageRowView, UsageBucket, UsagePeriod, UsageReport } from '../src/audit/usage-types';
import { t } from '../src/i18n/ar';
import { formatNumber, formatUsdMicro } from '../src/i18n/format';
import {
  computeChatEntry,
  computeDailyReturn,
  computeInferenceCost,
  computeMemoryAccuracy,
  computeMetrics,
  computeOnboardingCard,
  computePiiEffectiveness,
  latestRunOfKind,
  workingDayKeys,
} from '../src/metrics/compute';
import type { OnboardingSessionLike } from '../src/metrics/onboarding';
import {
  ASSUMPTION_IDS,
  COST_WINDOW_DAYS,
  DAILY_RETURN_WINDOW_DAYS,
  type BaselineLike,
  type EvalRunLike,
  type IntakeJobLike,
  type MetricsInput,
} from '../src/metrics/types';
import type { DocumentFlow } from '../src/agents/router';

// 2026-10-08 is a Thursday. Riyadh is UTC+3, so 09:00Z is noon there.
const NOW = new Date('2026-10-08T09:00:00.000Z');
const WINDOW: UsagePeriod = riyadhTrailingPeriod(NOW, DAILY_RETURN_WINDOW_DAYS);
const MINUTE_MS = 60 * 1000;

// ─── fixtures ───────────────────────────────────────────────────────────────

/** The ten Sunday-Thursday keys of the 14-day window ending Thursday 2026-10-08. */
const WORKING = [
  '2026-09-27',
  '2026-09-28',
  '2026-09-29',
  '2026-09-30',
  '2026-10-01',
  '2026-10-04',
  '2026-10-05',
  '2026-10-06',
  '2026-10-07',
  '2026-10-08',
];
/** Fridays and Saturdays of the same window. */
const WEEKEND = ['2026-09-25', '2026-09-26', '2026-10-02', '2026-10-03'];

function run(kind: string, overrides: Partial<EvalRunLike> = {}): EvalRunLike {
  return {
    kind,
    startedAt: new Date('2026-10-05T10:00:00.000Z'),
    finishedAt: new Date('2026-10-05T10:30:00.000Z'),
    score: 0.9,
    passed: true,
    detailsJson: {},
    ...overrides,
  };
}

function job(flowType: DocumentFlow, minutes: number, overrides: Partial<IntakeJobLike> = {}): IntakeJobLike {
  const createdAt = new Date('2026-10-06T08:00:00.000Z');
  return { flowType, createdAt, approvedAt: new Date(createdAt.getTime() + minutes * MINUTE_MS), ...overrides };
}

function baseline(flowType: string, minutes: number, overrides: Partial<BaselineLike> = {}): BaselineLike {
  return { flowType, minutes, measuredAt: new Date('2026-10-01T08:00:00.000Z'), ...overrides };
}

function dailyRow(npiUserId: string, day: string, messageCount = 3): DailyUsageRowView {
  return { npiUserId, day, messageCount, tokensIn: 100, tokensOut: 50, costUsdMicro: '1000' };
}

function bucket(key: string, costUsdMicro: bigint, calls = 1): UsageBucket {
  return { key, calls, tokensIn: 100, tokensOut: 50, costUsdMicro };
}

/** A report with the given totals and documents; the rest is the empty report. */
function usageReport(opts: {
  calls: number;
  costUsdMicro: bigint;
  documents: UsageBucket[];
  dailyAverage: bigint;
  monthly: bigint;
}): UsageReport {
  const empty = aggregateUsage([], riyadhTrailingPeriod(NOW, COST_WINDOW_DAYS));
  return {
    ...empty,
    totals: { ...empty.totals, calls: opts.calls, costUsdMicro: opts.costUsdMicro },
    byDocument: opts.documents,
    projection: {
      windowDays: COST_WINDOW_DAYS,
      dailyAverageUsdMicro: opts.dailyAverage,
      monthlyUsdMicro: opts.monthly,
    },
  };
}

function docs(...pairs: Array<[number, number]>): { docs: Array<{ correct: number; total: number }> } {
  return { docs: pairs.map(([correct, total]) => ({ correct, total })) };
}

/** Five extract runs summing to 307 correct of 311 fields. */
function extractRuns(): EvalRunLike[] {
  return [
    run('extract:customer_contract', { detailsJson: docs([60, 61]) }),
    run('extract:pr', { detailsJson: docs([70, 71]) }),
    run('extract:po', { detailsJson: docs([88, 89]) }),
    run('extract:grn', { detailsJson: docs([40, 40]) }),
    run('extract:vendor_bill', { detailsJson: docs([49, 50]) }),
  ];
}

const FLOW_CC = t('flow.customer_contract');

// ─── workingDayKeys ─────────────────────────────────────────────────────────

describe('workingDayKeys', () => {
  it('yields 10 Sunday-Thursday keys for a 14-day window ending on a Thursday', () => {
    const keys = workingDayKeys(WINDOW);
    expect(keys).toEqual(WORKING);
    for (const key of keys) {
      const weekday = new Date(`${key}T00:00:00.000Z`).getUTCDay();
      expect([5, 6]).not.toContain(weekday);
    }
  });

  it('yields 10 keys for a 14-day window ending on any weekday', () => {
    for (let offset = 0; offset < 7; offset += 1) {
      const now = new Date(NOW.getTime() + offset * 24 * 60 * MINUTE_MS);
      expect(workingDayKeys(riyadhTrailingPeriod(now, 14))).toHaveLength(10);
    }
  });

  it('puts the Riyadh midnight (21:00Z) between two keys', () => {
    // 20:59Z = 23:59 Riyadh on Wednesday the 7th; 21:00Z = 00:00 on Thursday the 8th.
    expect(workingDayKeys({ from: new Date('2026-10-07T20:59:00.000Z'), to: new Date('2026-10-07T21:00:00.000Z') })).toEqual([
      '2026-10-07',
    ]);
    expect(workingDayKeys({ from: new Date('2026-10-07T21:00:00.000Z'), to: new Date('2026-10-07T21:01:00.000Z') })).toEqual([
      '2026-10-08',
    ]);
  });

  it('is half-open: a window ending exactly at midnight does not touch the next day', () => {
    expect(workingDayKeys({ from: new Date('2026-10-06T21:00:00.000Z'), to: new Date('2026-10-07T21:00:00.000Z') })).toEqual([
      '2026-10-07',
    ]);
  });

  it('skips Friday and Saturday and an empty window', () => {
    // 21:00Z on Thursday the 8th is Friday 00:00 in Riyadh.
    expect(workingDayKeys({ from: new Date('2026-10-08T21:00:00.000Z'), to: new Date('2026-10-09T20:59:00.000Z') })).toEqual([]);
    expect(workingDayKeys({ from: new Date('2026-10-08T20:59:00.000Z'), to: new Date('2026-10-08T21:00:00.000Z') })).toEqual([
      '2026-10-08',
    ]);
    expect(workingDayKeys({ from: NOW, to: NOW })).toEqual([]);
  });
});

// ─── a1 ─────────────────────────────────────────────────────────────────────

describe('computeDailyReturn (a1)', () => {
  it('is met exactly at the target: one user on 7 of 10 working days', () => {
    const rows = WORKING.slice(0, 7).map((day) => dailyRow('u1', day));
    const card = computeDailyReturn(rows, WINDOW, NOW);
    expect(card.assumption).toBe('a1');
    expect(card.labelAr).toBe(t('metrics.a1'));
    expect(card.rawValue).toBe(0.7);
    expect(card.value).toBe('70%');
    expect(card.unit).toBe('percent');
    expect(card.targetAr).toBe(t('metrics.target.daily_return'));
    expect(card.target).toBe('>=0.70');
    expect(card.verdict).toBe('met');
    expect(card.measuredAt).toBe(NOW.toISOString());
    expect(card.secondary).toBeNull();
  });

  it('has the exact detail lines and string', () => {
    const rows = WORKING.slice(0, 7).map((day) => dailyRow('u1', day));
    const card = computeDailyReturn(rows, WINDOW, NOW);
    expect(card.detailsAr).toEqual([
      t('metrics.window_days', { n: 14 }),
      t('metrics.a1.users', { n: 1 }),
      t('metrics.a1.working_days', { n: 10 }),
    ]);
    expect(card.details).toBe('window_days=14;working_days=10;active_users=1');
  });

  it('is not met just below the target', () => {
    const rows = WORKING.slice(0, 6).map((day) => dailyRow('u1', day));
    const card = computeDailyReturn(rows, WINDOW, NOW);
    expect(card.rawValue).toBe(0.6);
    expect(card.value).toBe('60%');
    expect(card.verdict).toBe('not_met');
  });

  it('does not count weekend messages toward the share but makes the user active', () => {
    const rows = [
      ...WORKING.slice(0, 7).map((day) => dailyRow('u1', day)),
      ...WEEKEND.map((day) => dailyRow('u1', day)),
      ...WEEKEND.map((day) => dailyRow('u2', day)),
    ];
    const card = computeDailyReturn(rows, WINDOW, NOW);
    // u1 = 0.7, u2 = 0 (active on Fridays/Saturdays only)
    expect(card.rawValue).toBe(0.35);
    expect(card.verdict).toBe('not_met');
    expect(card.detailsAr[1]).toBe(t('metrics.a1.users', { n: 2 }));
    expect(card.details).toBe('window_days=14;working_days=10;active_users=2');
  });

  it('does not count a user whose rows all have messageCount 0', () => {
    const rows = [...WORKING.map((day) => dailyRow('u1', day, 0)), dailyRow('u2', WORKING[0])];
    const card = computeDailyReturn(rows, WINDOW, NOW);
    expect(card.detailsAr[1]).toBe(t('metrics.a1.users', { n: 1 }));
    expect(card.rawValue).toBe(0.1);
  });

  it('averages the shares of two users: 1.0 and 0.4 give 0.7', () => {
    const rows = [...WORKING.map((day) => dailyRow('u1', day)), ...WORKING.slice(0, 4).map((day) => dailyRow('u2', day))];
    const card = computeDailyReturn(rows, WINDOW, NOW);
    expect(card.rawValue).toBe(0.7);
    expect(card.verdict).toBe('met');
  });

  it('rounds the headline to 4 decimals', () => {
    const rows = [
      ...WORKING.slice(0, 4).map((day) => dailyRow('u1', day)),
      ...WORKING.slice(0, 3).map((day) => dailyRow('u2', day)),
      ...WORKING.slice(0, 3).map((day) => dailyRow('u3', day)),
    ];
    const card = computeDailyReturn(rows, WINDOW, NOW);
    expect(card.rawValue).toBe(0.3333);
    expect(card.value).toBe('33.3%');
  });

  it('ignores rows outside the window and duplicate rows of one day', () => {
    const rows = [
      dailyRow('u1', '2026-09-24'),
      dailyRow('u1', '2026-10-09'),
      dailyRow('u1', WORKING[0]),
      dailyRow('u1', WORKING[0]),
    ];
    const card = computeDailyReturn(rows, WINDOW, NOW);
    expect(card.rawValue).toBe(0.1);
  });

  it('is no_data without rows, with the no-users line', () => {
    const card = computeDailyReturn([], WINDOW, NOW);
    expect(card.verdict).toBe('no_data');
    expect(card.value).toBeNull();
    expect(card.rawValue).toBeNull();
    expect(card.measuredAt).toBeNull();
    expect(card.detailsAr).toEqual([t('metrics.a1.no_users')]);
    expect(card.details).toBe('window_days=14;working_days=10;active_users=0');
  });
});

// ─── latestRunOfKind ────────────────────────────────────────────────────────

describe('latestRunOfKind', () => {
  const older = run('memory', { startedAt: new Date('2026-10-01T00:00:00.000Z'), score: 0.5 });
  const newer = run('memory', { startedAt: new Date('2026-10-03T00:00:00.000Z'), score: 0.9 });

  it('picks the highest startedAt whatever the input order', () => {
    expect(latestRunOfKind([older, newer], 'memory')).toBe(newer);
    expect(latestRunOfKind([newer, older], 'memory')).toBe(newer);
  });

  it('matches the exact kind only', () => {
    const po = run('extract:po');
    const pr = run('extract:pr');
    expect(latestRunOfKind([po, pr], 'extract:p')).toBeNull();
    expect(latestRunOfKind([po, pr], 'extract:po')).toBe(po);
    expect(latestRunOfKind([po], 'extract:pr')).toBeNull();
  });

  it('keeps the first of equal startedAt and returns null for no rows', () => {
    const a = run('pii', { score: 0.1 });
    const b = run('pii', { score: 0.2 });
    expect(latestRunOfKind([a, b], 'pii')).toBe(a);
    expect(latestRunOfKind([], 'pii')).toBeNull();
  });
});

// ─── a2 ─────────────────────────────────────────────────────────────────────

describe('computeMemoryAccuracy (a2)', () => {
  const details = { gate: true, derivation: { expected: 50, derived: 48, misses: [] }, retrieval: { answered: 48, top1: 40, misses: [] } };

  it('is met at 0.96 with the answered and derived lines', () => {
    const card = computeMemoryAccuracy([run('memory', { score: 0.96, detailsJson: details })], NOW);
    expect(card.assumption).toBe('a2');
    expect(card.labelAr).toBe(t('metrics.a2'));
    expect(card.rawValue).toBe(0.96);
    expect(card.value).toBe('96%');
    expect(card.unit).toBe('percent');
    expect(card.targetAr).toBe(t('metrics.target.memory'));
    expect(card.target).toBe('>=0.85');
    expect(card.verdict).toBe('met');
    expect(card.secondary).toBeNull();
    expect(card.detailsAr).toEqual([
      t('metrics.a2.answered', { answered: 48, total: 50 }),
      t('metrics.a2.derived', { derived: 48, expected: 50 }),
    ]);
    expect(card.details).toBe('run=memory;score=0.9600;answered=48;expected=50');
  });

  it('is not met at 0.80', () => {
    const card = computeMemoryAccuracy([run('memory', { score: 0.8, detailsJson: details })], NOW);
    expect(card.verdict).toBe('not_met');
    expect(card.value).toBe('80%');
  });

  it('is met exactly at 0.85', () => {
    expect(computeMemoryAccuracy([run('memory', { score: 0.85 })], NOW).verdict).toBe('met');
  });

  it('is no_data without a run or without a score', () => {
    const none = computeMemoryAccuracy([run('pii')], NOW);
    expect(none.verdict).toBe('no_data');
    expect(none.value).toBeNull();
    expect(none.rawValue).toBeNull();
    expect(none.measuredAt).toBeNull();
    expect(none.detailsAr).toEqual([t('metrics.a2.no_run')]);
    expect(none.details).toBe('run=none');
    expect(computeMemoryAccuracy([run('memory', { score: null })], NOW).verdict).toBe('no_data');
  });

  it('still shows the headline when detailsJson is malformed', () => {
    for (const detailsJson of [null, 'garbage', 42, [], { retrieval: 'x', derivation: [] }, { retrieval: { answered: 'a' } }]) {
      const card = computeMemoryAccuracy([run('memory', { score: 0.96, detailsJson })], NOW);
      expect(card.value).toBe('96%');
      expect(card.verdict).toBe('met');
      expect(card.detailsAr).toEqual([]);
      expect(card.details).toBe('run=memory;score=0.9600');
    }
  });

  it('measuredAt is finishedAt, falling back to startedAt', () => {
    const finished = new Date('2026-10-05T10:30:00.000Z');
    const started = new Date('2026-10-05T10:00:00.000Z');
    expect(computeMemoryAccuracy([run('memory', { startedAt: started, finishedAt: finished })], NOW).measuredAt).toBe(
      finished.toISOString(),
    );
    expect(computeMemoryAccuracy([run('memory', { startedAt: started, finishedAt: null })], NOW).measuredAt).toBe(
      started.toISOString(),
    );
  });

  it('reads the latest memory run only', () => {
    const old = run('memory', { startedAt: new Date('2026-09-01T00:00:00.000Z'), score: 0.1 });
    const latest = run('memory', { startedAt: new Date('2026-10-01T00:00:00.000Z'), score: 0.9 });
    expect(computeMemoryAccuracy([latest, old], NOW).rawValue).toBe(0.9);
  });
});

// ─── a3 ─────────────────────────────────────────────────────────────────────

describe('computeInferenceCost (a3)', () => {
  const usd = t('metrics.unit.usd');

  it('is no_data with zero calls', () => {
    const report = aggregateUsage([], riyadhTrailingPeriod(NOW, COST_WINDOW_DAYS));
    const card = computeInferenceCost(report, NOW);
    expect(card.assumption).toBe('a3');
    expect(card.labelAr).toBe(t('metrics.a3'));
    expect(card.verdict).toBe('no_data');
    expect(card.value).toBeNull();
    expect(card.rawValue).toBeNull();
    expect(card.measuredAt).toBeNull();
    expect(card.secondary).toBeNull();
    expect(card.target).toBe('measured');
    expect(card.targetAr).toBe(t('metrics.target.cost'));
    expect(card.detailsAr).toEqual([t('metrics.a3.no_calls')]);
    expect(card.details).toBe('window_days=30;calls=0');
  });

  it('headlines the cost per document with the per-day secondary', () => {
    const report = usageReport({
      calls: 51,
      costUsdMicro: 957_944n,
      documents: ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'].map((key) => bucket(key, 159_657n)),
      dailyAverage: 31_931n,
      monthly: 957_944n,
    });
    const card = computeInferenceCost(report, NOW);
    expect(card.verdict).toBe('measured');
    expect(card.unit).toBe('usd');
    expect(card.target).toBe('measured');
    expect(card.rawValue).toBe(159_657);
    expect(card.value).toBe(`${formatUsdMicro(159_657)} ${usd}`);
    expect(card.measuredAt).toBe(NOW.toISOString());
    expect(card.secondary).toEqual({
      labelAr: t('metrics.a3.per_day'),
      value: `${formatUsdMicro(31_931n)} ${usd}`,
      rawValue: 31_931,
      unit: 'usd',
      targetAr: t('metrics.target.cost'),
      verdict: 'measured',
    });
    expect(card.detailsAr).toEqual([
      t('metrics.a3.per_document'),
      t('metrics.window_days', { n: 30 }),
      t('metrics.a3.total', { value: formatUsdMicro(957_944n), calls: formatNumber(51), documents: formatNumber(6) }),
      t('metrics.a3.projection', { value: formatUsdMicro(957_944n) }),
    ]);
    expect(card.details).toBe(
      'window_days=30;calls=51;documents=6;total_usd_micro=957944;per_document_usd_micro=159657;per_day_usd_micro=31931;monthly_usd_micro=957944;headline=per_document',
    );
  });

  it('divides the total by 3 documents (integer micro-USD)', () => {
    const report = usageReport({
      calls: 9,
      costUsdMicro: 300_001n,
      documents: [bucket('d1', 150_000n), bucket('d2', 100_000n), bucket('d3', 50_001n)],
      dailyAverage: 10_000n,
      monthly: 300_000n,
    });
    const card = computeInferenceCost(report, NOW);
    expect(card.rawValue).toBe(100_000);
    expect(card.secondary?.rawValue).toBe(10_000);
    expect(card.details).toContain('per_document_usd_micro=100000');
    expect(card.details).toContain('headline=per_document');
  });

  it('falls back to the per-day headline when no call carried a document', () => {
    const report = usageReport({ calls: 4, costUsdMicro: 60_000n, documents: [], dailyAverage: 2_000n, monthly: 60_000n });
    const card = computeInferenceCost(report, NOW);
    expect(card.rawValue).toBe(2_000);
    expect(card.value).toBe(`${formatUsdMicro(2_000)} ${usd}`);
    expect(card.detailsAr[0]).toBe(t('metrics.a3.per_day'));
    expect(card.details).toBe(
      'window_days=30;calls=4;documents=0;total_usd_micro=60000;per_document_usd_micro=none;per_day_usd_micro=2000;monthly_usd_micro=60000;headline=per_day',
    );
  });
});

// ─── a4 ─────────────────────────────────────────────────────────────────────

describe('computePiiEffectiveness (a4)', () => {
  function piiRun(names: number, structured: number, overrides: Partial<EvalRunLike> = {}): EvalRunLike {
    return run('pii', {
      score: names,
      detailsJson: {
        gates: { names: false, structured: true },
        rates: { names, structured },
        counts: { sentences: 100 },
        leaks: [1, 2, 3, 4, 5],
      },
      ...overrides,
    });
  }

  it('is met at names 0.938 / structured 1.0, with the secondary and counts', () => {
    const card = computePiiEffectiveness([piiRun(0.9383, 1)], NOW);
    expect(card.assumption).toBe('a4');
    expect(card.labelAr).toBe(t('metrics.a4'));
    expect(card.rawValue).toBe(0.9383);
    expect(card.value).toBe('93.8%');
    expect(card.unit).toBe('percent');
    expect(card.targetAr).toBe(t('metrics.target.pii_names'));
    expect(card.target).toBe('>=0.90;>=0.95');
    expect(card.verdict).toBe('met');
    expect(card.secondary).toEqual({
      labelAr: t('metrics.a4.structured'),
      value: '100%',
      rawValue: 1,
      unit: 'percent',
      targetAr: t('metrics.target.pii_structured'),
      verdict: 'met',
    });
    expect(card.detailsAr).toEqual([t('metrics.a4.sentences', { n: 100 }), t('metrics.a4.leaks', { n: 5 })]);
    expect(card.details).toBe('run=pii;names=0.9383;structured=1.0000;sentences=100;leaks=5');
    expect(card.measuredAt).toBe('2026-10-05T10:30:00.000Z');
  });

  it('is not met when structured is below 0.95 even with names at 0.95', () => {
    const card = computePiiEffectiveness([piiRun(0.95, 0.9)], NOW);
    expect(card.verdict).toBe('not_met');
    expect(card.secondary?.verdict).toBe('not_met');
    expect(card.secondary?.value).toBe('90%');
  });

  it('is not met when names are below 0.90 even with structured at 1.0', () => {
    const card = computePiiEffectiveness([piiRun(0.89, 1)], NOW);
    expect(card.verdict).toBe('not_met');
    expect(card.secondary?.verdict).toBe('met');
  });

  it('is met exactly at both targets', () => {
    expect(computePiiEffectiveness([piiRun(0.9, 0.95)], NOW).verdict).toBe('met');
  });

  it('falls back to the score for names when rates are unreadable; structured unknown means not_met', () => {
    const card = computePiiEffectiveness([run('pii', { score: 0.93, detailsJson: null })], NOW);
    expect(card.rawValue).toBe(0.93);
    expect(card.value).toBe('93%');
    expect(card.verdict).toBe('not_met');
    expect(card.secondary).toEqual({
      labelAr: t('metrics.a4.structured'),
      value: null,
      rawValue: null,
      unit: 'percent',
      targetAr: t('metrics.target.pii_structured'),
      verdict: 'no_data',
    });
    expect(card.detailsAr).toEqual([]);
    expect(card.details).toBe('run=pii;names=0.9300;structured=none');
  });

  it('treats out-of-range or non-numeric rates as unreadable', () => {
    const card = computePiiEffectiveness(
      [run('pii', { score: 0.92, detailsJson: { rates: { names: 1.5, structured: 'x' } } })],
      NOW,
    );
    expect(card.rawValue).toBe(0.92);
    expect(card.secondary?.rawValue).toBeNull();
  });

  it('is no_data without a pii run', () => {
    const card = computePiiEffectiveness([run('memory')], NOW);
    expect(card.verdict).toBe('no_data');
    expect(card.value).toBeNull();
    expect(card.rawValue).toBeNull();
    expect(card.measuredAt).toBeNull();
    expect(card.secondary).toBeNull();
    expect(card.detailsAr).toEqual([t('metrics.a4.no_run')]);
    expect(card.details).toBe('run=none');
  });

  it('reads the latest pii run only', () => {
    const old = piiRun(0.5, 0.5, { startedAt: new Date('2026-09-01T00:00:00.000Z') });
    const latest = piiRun(0.95, 1, { startedAt: new Date('2026-10-02T00:00:00.000Z') });
    expect(computePiiEffectiveness([latest, old], NOW).rawValue).toBe(0.95);
  });
});

// ─── a5 ─────────────────────────────────────────────────────────────────────

describe('computeChatEntry (a5)', () => {
  it('is met: five runs 307/311, one flow with jobs and a baseline', () => {
    const card = computeChatEntry(extractRuns(), [job('customer_contract', 1)], [baseline('customer_contract', 25)], NOW);
    expect(card.assumption).toBe('a5');
    expect(card.labelAr).toBe(t('metrics.a5'));
    expect(card.rawValue).toBe(0.9871);
    expect(card.value).toBe('98.7%');
    expect(card.unit).toBe('percent');
    expect(card.targetAr).toBe(t('metrics.target.fields'));
    expect(card.target).toBe('>=0.90;<=0.3333');
    expect(card.verdict).toBe('met');
    expect(card.measuredAt).toBe('2026-10-05T10:30:00.000Z');
    expect(card.secondary).toEqual({
      labelAr: t('metrics.a5.time_ratio'),
      value: '4%',
      rawValue: 0.04,
      unit: 'ratio',
      targetAr: t('metrics.target.time_ratio'),
      verdict: 'met',
    });
    expect(card.detailsAr).toEqual([
      t('metrics.a5.flows', { n: 5 }),
      t('metrics.a5.flow_line', { flow: FLOW_CC, correct: 60, total: 61 }),
      t('metrics.a5.flow_line', { flow: t('flow.pr'), correct: 70, total: 71 }),
      t('metrics.a5.flow_line', { flow: t('flow.po'), correct: 88, total: 89 }),
      t('metrics.a5.flow_line', { flow: t('flow.grn'), correct: 40, total: 40 }),
      t('metrics.a5.flow_line', { flow: t('flow.vendor_bill'), correct: 49, total: 50 }),
      t('metrics.a5.time_line', { flow: FLOW_CC, minutes: '1', baseline: 25, n: 1 }),
    ]);
    expect(card.details).toBe(
      'flows_evaluated=5;fields_correct=307;fields_total=311;fields=0.9871;time_ratio=0.0400;time_flows=customer_contract:1.0/25',
    );
  });

  it('ignores the older run of a flow, whatever the input order', () => {
    const olderWorse = run('extract:customer_contract', {
      startedAt: new Date('2026-09-01T00:00:00.000Z'),
      detailsJson: docs([0, 61]),
    });
    const card = computeChatEntry([olderWorse, ...extractRuns()], [], [], NOW);
    expect(card.rawValue).toBe(0.9871);
    const reversed = computeChatEntry([...extractRuns().reverse(), olderWorse], [], [], NOW);
    expect(reversed.rawValue).toBe(0.9871);
  });

  it('sums the documents of one run', () => {
    const runs = [run('extract:pr', { detailsJson: docs([9, 10], [8, 10]) })];
    const card = computeChatEntry(runs, [], [], NOW);
    expect(card.rawValue).toBe(0.85);
    expect(card.detailsAr[1]).toBe(t('metrics.a5.flow_line', { flow: t('flow.pr'), correct: 17, total: 20 }));
  });

  it('does not count a flow without a run or with unreadable docs', () => {
    const runs = extractRuns().filter((r) => r.kind !== 'extract:po');
    runs.push(run('extract:po', { startedAt: new Date('2026-09-01T00:00:00.000Z'), detailsJson: { docs: 'x' } }));
    const card = computeChatEntry(runs, [], [], NOW);
    expect(card.detailsAr[0]).toBe(t('metrics.a5.flows', { n: 4 }));
    expect(card.details).toContain('flows_evaluated=4;fields_correct=219;fields_total=222;');
    const bad = computeChatEntry([run('extract:pr', { detailsJson: { docs: [{ correct: 'a', total: 3 }, null] } })], [], [], NOW);
    expect(bad.verdict).toBe('no_data');
  });

  it('is not met without a baseline: secondary no_data and the no-baseline line', () => {
    const card = computeChatEntry(extractRuns(), [job('customer_contract', 1)], [], NOW);
    expect(card.verdict).toBe('not_met');
    expect(card.secondary?.verdict).toBe('no_data');
    expect(card.secondary?.value).toBeNull();
    expect(card.secondary?.rawValue).toBeNull();
    expect(card.detailsAr).toContain(t('metrics.a5.no_baseline'));
    expect(card.detailsAr).not.toContain(t('metrics.a5.no_jobs'));
    expect(card.details).toContain('time_ratio=none;time_flows=none');
  });

  it('is not met without jobs: the no-jobs line', () => {
    const card = computeChatEntry(extractRuns(), [], [baseline('customer_contract', 25)], NOW);
    expect(card.verdict).toBe('not_met');
    expect(card.secondary?.verdict).toBe('no_data');
    expect(card.detailsAr).toContain(t('metrics.a5.no_jobs'));
    expect(card.detailsAr).not.toContain(t('metrics.a5.no_baseline'));
  });

  it('is no_data without any extract run, with the no-eval line instead of flow lines', () => {
    const card = computeChatEntry([run('memory'), run('pii')], [job('pr', 5)], [baseline('pr', 30)], NOW);
    expect(card.verdict).toBe('no_data');
    expect(card.value).toBeNull();
    expect(card.rawValue).toBeNull();
    expect(card.measuredAt).toBeNull();
    expect(card.detailsAr).toEqual([
      t('metrics.a5.flows', { n: 0 }),
      t('metrics.a5.no_eval'),
      t('metrics.a5.time_line', { flow: t('flow.pr'), minutes: '5', baseline: 30, n: 1 }),
    ]);
    expect(card.details).toBe(
      'flows_evaluated=0;fields_correct=0;fields_total=0;fields=none;time_ratio=0.1667;time_flows=pr:5.0/30',
    );
  });

  it('uses the conventional median: odd count takes the middle, even count the mean of the two', () => {
    const odd = computeChatEntry(
      extractRuns(),
      [job('customer_contract', 10), job('customer_contract', 40), job('customer_contract', 20)],
      [baseline('customer_contract', 100)],
      NOW,
    );
    expect(odd.secondary?.rawValue).toBe(0.2);
    const even = computeChatEntry(
      extractRuns(),
      [job('customer_contract', 10), job('customer_contract', 50), job('customer_contract', 20), job('customer_contract', 30)],
      [baseline('customer_contract', 100)],
      NOW,
    );
    expect(even.secondary?.rawValue).toBe(0.25);
    expect(even.details).toContain('time_flows=customer_contract:25.0/100');
    expect(even.detailsAr).toContain(t('metrics.a5.time_line', { flow: FLOW_CC, minutes: '25', baseline: 100, n: 4 }));
  });

  it('clamps a negative approval span to 0 minutes', () => {
    const createdAt = new Date('2026-10-06T08:00:00.000Z');
    const skewed: IntakeJobLike = { flowType: 'customer_contract', createdAt, approvedAt: new Date(createdAt.getTime() - 5 * MINUTE_MS) };
    const card = computeChatEntry(extractRuns(), [skewed, job('customer_contract', 10)], [baseline('customer_contract', 100)], NOW);
    // durations [0, 10] -> median 5
    expect(card.secondary?.rawValue).toBe(0.05);
    expect(card.details).toContain('time_flows=customer_contract:5.0/100');
  });

  it('combines flows as sum of medians over sum of baselines, joined with +', () => {
    const card = computeChatEntry(
      extractRuns(),
      [job('customer_contract', 10), job('pr', 20), job('grn', 99)],
      [baseline('customer_contract', 30), baseline('pr', 30), baseline('po', 30)],
      NOW,
    );
    // grn has jobs but no baseline, po has a baseline but no jobs: neither counts
    expect(card.secondary?.rawValue).toBe(0.5);
    expect(card.secondary?.value).toBe('50%');
    expect(card.secondary?.verdict).toBe('not_met');
    expect(card.verdict).toBe('not_met');
    expect(card.details).toContain('time_ratio=0.5000;time_flows=customer_contract:10.0/30+pr:20.0/30');
  });

  it('is met exactly at one third of the manual time', () => {
    const card = computeChatEntry(extractRuns(), [job('customer_contract', 10)], [baseline('customer_contract', 30)], NOW);
    expect(card.secondary?.rawValue).toBe(0.3333);
    expect(card.secondary?.verdict).toBe('met');
    expect(card.verdict).toBe('met');
  });

  it('is not met when fields are below 90% even with a good time ratio', () => {
    const runs = [run('extract:customer_contract', { detailsJson: docs([8, 10]) })];
    const card = computeChatEntry(runs, [job('customer_contract', 1)], [baseline('customer_contract', 25)], NOW);
    expect(card.rawValue).toBe(0.8);
    expect(card.secondary?.verdict).toBe('met');
    expect(card.verdict).toBe('not_met');
  });

  it('takes the latest baseline of a flow and skips a non-positive one', () => {
    const card = computeChatEntry(
      extractRuns(),
      [job('customer_contract', 10)],
      [
        baseline('customer_contract', 20, { measuredAt: new Date('2026-09-01T00:00:00.000Z') }),
        baseline('customer_contract', 50, { measuredAt: new Date('2026-10-01T00:00:00.000Z') }),
        baseline('customer_contract', 0, { measuredAt: new Date('2026-10-02T00:00:00.000Z') }),
      ],
      NOW,
    );
    expect(card.secondary?.rawValue).toBe(0.2);
  });

  it('measuredAt is the latest finishedAt (else startedAt) over the evaluated runs', () => {
    const runs = [
      run('extract:pr', { detailsJson: docs([1, 1]), finishedAt: new Date('2026-10-02T00:00:00.000Z') }),
      run('extract:po', { detailsJson: docs([1, 1]), finishedAt: null, startedAt: new Date('2026-10-04T00:00:00.000Z') }),
      run('extract:grn', { detailsJson: docs([1, 1]), finishedAt: new Date('2026-10-03T00:00:00.000Z') }),
    ];
    expect(computeChatEntry(runs, [], [], NOW).measuredAt).toBe('2026-10-04T00:00:00.000Z');
  });
});

// ─── a6 ─────────────────────────────────────────────────────────────────────

describe('computeOnboardingCard (a6)', () => {
  const START = new Date('2026-10-04T10:00:00.000Z');

  function session(minutes: number | null): OnboardingSessionLike {
    return {
      npiOrgId: 'org-1',
      startedAt: START,
      completedAt: minutes === null ? null : new Date(START.getTime() + minutes * MINUTE_MS),
      profileChosen: 'epc',
    };
  }

  it('reports the median with the completed / within / p90 lines', () => {
    const card = computeOnboardingCard([session(5), session(10), session(15), session(20), session(null), session(null)], NOW);
    expect(card.assumption).toBe('a6');
    expect(card.labelAr).toBe(t('metrics.a6'));
    expect(card.rawValue).toBe(12.5);
    expect(card.value).toBe(`${formatNumber(12.5)} ${t('metrics.unit.minutes')}`);
    expect(card.unit).toBe('minutes');
    expect(card.targetAr).toBe(t('metrics.target.onboarding'));
    expect(card.target).toBe('<=30');
    expect(card.verdict).toBe('met');
    expect(card.measuredAt).toBe(NOW.toISOString());
    expect(card.secondary).toBeNull();
    expect(card.detailsAr).toEqual([
      t('metrics.a6.completed', { n: 4, open: 2 }),
      t('metrics.a6.within', { n: 4 }),
      t('metrics.a6.p90', { value: 20 }),
    ]);
    expect(card.details).toBe('completed=4;open=2;median_minutes=12.5;p90_minutes=20;within_target=4');
  });

  it('is not met above the target and counts only sessions within it', () => {
    const card = computeOnboardingCard([session(25), session(45)], NOW);
    expect(card.rawValue).toBe(35);
    expect(card.verdict).toBe('not_met');
    expect(card.detailsAr[1]).toBe(t('metrics.a6.within', { n: 1 }));
  });

  it('is no_data without completed sessions', () => {
    for (const sessions of [[], [session(null)]]) {
      const card = computeOnboardingCard(sessions, NOW);
      expect(card.verdict).toBe('no_data');
      expect(card.value).toBeNull();
      expect(card.rawValue).toBeNull();
      expect(card.measuredAt).toBeNull();
      expect(card.detailsAr).toEqual([t('metrics.a6.no_sessions')]);
    }
    expect(computeOnboardingCard([session(null)], NOW).details).toBe(
      'completed=0;open=1;median_minutes=none;p90_minutes=none;within_target=0',
    );
  });
});

// ─── computeMetrics ─────────────────────────────────────────────────────────

describe('computeMetrics', () => {
  const input: MetricsInput = {
    dailyUsage: WORKING.map((day) => dailyRow('u1', day)),
    dailyWindow: WINDOW,
    usage: aggregateUsage([], riyadhTrailingPeriod(NOW, COST_WINDOW_DAYS)),
    evalRuns: [
      run('memory', { score: 0.96 }),
      run('pii', { detailsJson: { rates: { names: 0.95, structured: 1 } } }),
      ...extractRuns(),
    ],
    intakeJobs: [job('customer_contract', 1)],
    baselines: [baseline('customer_contract', 25)],
    onboardingSessions: [],
  };

  it('returns exactly six cards in ASSUMPTION_IDS order with their labels', () => {
    const view = computeMetrics(input, { now: NOW, npiOrgId: 'org_npi_root' });
    expect(view.generatedAt).toBe(NOW.toISOString());
    expect(view.npiOrgId).toBe('org_npi_root');
    expect(view.cards).toHaveLength(6);
    expect(view.cards.map((c) => c.assumption)).toEqual([...ASSUMPTION_IDS]);
    expect(view.cards.map((c) => c.labelAr)).toEqual([
      t('metrics.a1'),
      t('metrics.a2'),
      t('metrics.a3'),
      t('metrics.a4'),
      t('metrics.a5'),
      t('metrics.a6'),
    ]);
  });

  it('wires each card to its source', () => {
    const [a1, a2, a3, a4, a5, a6] = computeMetrics(input, { now: NOW, npiOrgId: 'org_npi_root' }).cards;
    expect(a1.verdict).toBe('met');
    expect(a1.rawValue).toBe(1);
    expect(a2.rawValue).toBe(0.96);
    expect(a3.verdict).toBe('no_data');
    expect(a4.rawValue).toBe(0.95);
    expect(a4.verdict).toBe('met');
    expect(a5.rawValue).toBe(0.9871);
    expect(a5.verdict).toBe('met');
    expect(a6.verdict).toBe('no_data');
  });

  it('gives six no_data cards (a3 and a6 included) on an empty input', () => {
    const empty: MetricsInput = {
      dailyUsage: [],
      dailyWindow: WINDOW,
      usage: aggregateUsage([], riyadhTrailingPeriod(NOW, COST_WINDOW_DAYS)),
      evalRuns: [],
      intakeJobs: [],
      baselines: [],
      onboardingSessions: [],
    };
    const view = computeMetrics(empty, { now: NOW, npiOrgId: 'org-x' });
    expect(view.cards.map((c) => c.verdict)).toEqual(['no_data', 'no_data', 'no_data', 'no_data', 'no_data', 'no_data']);
    for (const card of view.cards) {
      expect(card.value).toBeNull();
      expect(card.rawValue).toBeNull();
      expect(card.measuredAt).toBeNull();
    }
  });
});
