// T-35 part B: the metrics readers (`src/metrics/load.ts`) against an in-memory
// fake db. No network, no database. Every call the readers make is recorded,
// so the tests prove what reached each `where` (organization scoping is in the
// query, never a post-filter) and what reached `computeMetrics`. The
// real-database side is tests/metrics-db.spec.ts.
//
// `computeMetrics` (part A, `src/metrics/compute.ts`) is wrapped by a jest mock
// that delegates to the real module when it exists, so these tests assert what
// the readers PASSED to it and never depend on its arithmetic. When the module
// is absent (part B built before part A) the mock is virtual and the one test
// that needs the real six cards is skipped.
import { riyadhDay, riyadhTrailingPeriod } from '../src/audit/cost';
import type { UsageRowLike } from '../src/audit/usage-types';
import {
  DAILY_USAGE_SELECT,
  USAGE_AUDIT_SELECT,
  type DailyUsageRowLike,
  type UsageAuditWhere,
} from '../src/queries/usage';
import type { FlowType } from '../src/agents/router';
import { computeMetrics } from '../src/metrics/compute';
import {
  BASELINE_SELECT,
  EVAL_RUN_SELECT,
  INTAKE_JOB_SELECT,
  loadMetrics,
  loadMetricsInput,
  type MetricsDb,
} from '../src/metrics/load';
import {
  COST_WINDOW_DAYS,
  DAILY_RETURN_WINDOW_DAYS,
  type BaselineLike,
  type EvalRunLike,
} from '../src/metrics/types';
import type { OnboardingSessionLike } from '../src/metrics/onboarding';

jest.mock(
  '../src/metrics/compute',
  () => {
    type ComputeFn = (input: unknown, opts: { now: Date; npiOrgId: string }) => unknown;
    let actual: { computeMetrics: ComputeFn } | null = null;
    try {
      actual = jest.requireActual('../src/metrics/compute') as { computeMetrics: ComputeFn };
    } catch {
      actual = null;
    }
    return {
      __computeAbsent: actual === null,
      computeMetrics: jest.fn((input: unknown, opts: { now: Date; npiOrgId: string }) =>
        actual !== null
          ? actual.computeMetrics(input, opts)
          : { generatedAt: opts.now.toISOString(), npiOrgId: opts.npiOrgId, cards: [] },
      ),
    };
  },
  { virtual: true },
);

const computeAbsent: boolean = (jest.requireMock('../src/metrics/compute') as { __computeAbsent: boolean })
  .__computeAbsent;
const itWithCompute = computeAbsent ? it.skip : it;
const computeSpy = computeMetrics as unknown as jest.Mock;

// ─── Fakes ──────────────────────────────────────────────────────────────────

const ORG_A = 'org-a';
const ORG_B = 'org-b';

// 2026-03-10 13:00 Riyadh. Riyadh day 2026-03-10 = [2026-03-09T21:00Z, 2026-03-10T21:00Z).
const NOW = new Date('2026-03-10T10:00:00.000Z');

interface OrgRow {
  npiOrgId: string;
}
interface FakeAuditRow extends UsageRowLike, OrgRow {}
interface FakeDailyRow extends DailyUsageRowLike, OrgRow {}
interface FakeJobRow extends OrgRow {
  flowType: FlowType;
  createdAt: Date;
  approvedAt: Date | null;
}
interface FakeBaselineRow extends BaselineLike, OrgRow {}
type FakeSessionRow = OnboardingSessionLike;

interface Seed {
  audit?: FakeAuditRow[];
  daily?: FakeDailyRow[];
  evalRuns?: EvalRunLike[];
  jobs?: FakeJobRow[];
  baselines?: FakeBaselineRow[];
  sessions?: FakeSessionRow[];
  /** A misbehaving `intakeJob.findMany` that ignores `approvedAt: { not: null }`. */
  ignoreApprovedFilter?: boolean;
}

interface Recorded {
  auditFindMany: unknown[];
  dailyFindMany: unknown[];
  dailyFindUnique: unknown[];
  evalFindMany: unknown[];
  jobFindMany: unknown[];
  baselineFindMany: unknown[];
  sessionFindMany: unknown[];
}

function pick<T extends object>(row: T, select: Record<string, true>): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(select)) out[key] = (row as Record<string, unknown>)[key];
  return out as Partial<T>;
}

function buildFakeDb(seed: Seed) {
  const calls: Recorded = {
    auditFindMany: [],
    dailyFindMany: [],
    dailyFindUnique: [],
    evalFindMany: [],
    jobFindMany: [],
    baselineFindMany: [],
    sessionFindMany: [],
  };

  const matchesAudit = (r: FakeAuditRow, where: UsageAuditWhere): boolean =>
    r.npiOrgId === where.npiOrgId &&
    (where.ts === undefined || (r.ts >= where.ts.gte && r.ts < where.ts.lt));

  const db: MetricsDb = {
    llmAudit: {
      async findMany(args) {
        calls.auditFindMany.push(args);
        return (seed.audit ?? [])
          .filter((r) => matchesAudit(r, args.where))
          .sort((a, b) => a.ts.getTime() - b.ts.getTime())
          .map((r) => pick(r, args.select) as UsageRowLike);
      },
    },
    dailyUsage: {
      async findUnique(args) {
        calls.dailyFindUnique.push(args);
        return null;
      },
      async findMany(args) {
        calls.dailyFindMany.push(args);
        const { npiOrgId, day } = args.where;
        return (seed.daily ?? [])
          .filter((r) => r.npiOrgId === npiOrgId && r.day >= day.gte && r.day < day.lt)
          .sort((a, b) => a.day.getTime() - b.day.getTime() || (a.npiUserId < b.npiUserId ? -1 : 1))
          .map((r) => pick(r, args.select) as DailyUsageRowLike);
      },
    },
    evalRun: {
      async findMany(args) {
        calls.evalFindMany.push(args);
        return [...(seed.evalRuns ?? [])]
          .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
          .map((r) => pick(r, args.select) as EvalRunLike);
      },
    },
    intakeJob: {
      async findMany(args) {
        calls.jobFindMany.push(args);
        return (seed.jobs ?? [])
          .filter((r) => r.npiOrgId === args.where.npiOrgId && (seed.ignoreApprovedFilter || r.approvedAt !== null))
          .map((r) => pick(r, args.select) as { flowType: FlowType; createdAt: Date; approvedAt: Date | null });
      },
    },
    manualBaseline: {
      async findMany(args) {
        calls.baselineFindMany.push(args);
        return (seed.baselines ?? [])
          .filter((r) => r.npiOrgId === args.where.npiOrgId)
          .map((r) => pick(r, args.select) as BaselineLike);
      },
    },
    onboardingSession: {
      async findMany(args) {
        calls.sessionFindMany.push(args);
        return (seed.sessions ?? [])
          .filter((r) => args.where?.npiOrgId === undefined || r.npiOrgId === args.where.npiOrgId)
          .map((r) => pick(r, args.select) as OnboardingSessionLike);
      },
    },
  };
  return { db, calls };
}

function auditRow(overrides: Partial<FakeAuditRow> & Pick<FakeAuditRow, 'ts'>): FakeAuditRow {
  return {
    npiOrgId: ORG_A,
    npiUserId: 'u1',
    event: 'chat',
    modelTier: 'economy',
    modelId: 'claude-haiku-4-5-20251001',
    tokensIn: 10,
    tokensOut: 5,
    costUsdMicro: 100n,
    documentId: null,
    error: null,
    ...overrides,
  };
}

function dailyRow(overrides: Partial<FakeDailyRow> & Pick<FakeDailyRow, 'day'>): FakeDailyRow {
  return {
    npiOrgId: ORG_A,
    npiUserId: 'u1',
    messageCount: 3,
    tokensIn: 100,
    tokensOut: 50,
    costUsdMicro: 1_000n,
    ...overrides,
  };
}

function evalRun(overrides: Partial<EvalRunLike> & Pick<EvalRunLike, 'kind' | 'startedAt'>): EvalRunLike {
  return { finishedAt: null, score: 0.9, passed: true, detailsJson: { gate: true }, ...overrides };
}

// Deliberately not in order, org B mixed in everywhere.
const FIXTURE: Required<Omit<Seed, 'ignoreApprovedFilter'>> = {
  audit: [
    auditRow({ ts: new Date('2026-03-09T08:00:00.000Z'), npiUserId: 'u2', documentId: 'doc-1', event: 'extract_po' }),
    auditRow({ ts: new Date('2026-03-01T08:00:00.000Z') }),
    // Before the 30-day window: never read.
    auditRow({ ts: new Date('2026-02-01T08:00:00.000Z'), costUsdMicro: 777n }),
    auditRow({ ts: new Date('2026-03-05T08:00:00.000Z'), npiOrgId: ORG_B, costUsdMicro: 999_999n }),
  ],
  daily: [
    dailyRow({ day: new Date('2026-03-09T00:00:00.000Z'), npiUserId: 'u2', messageCount: 5 }),
    dailyRow({ day: new Date('2026-03-08T00:00:00.000Z'), messageCount: 2 }),
    // Before the 14-day window: never read.
    dailyRow({ day: new Date('2026-02-01T00:00:00.000Z'), messageCount: 40 }),
    dailyRow({ day: new Date('2026-03-08T00:00:00.000Z'), npiOrgId: ORG_B, npiUserId: 'ux', messageCount: 99 }),
  ],
  evalRuns: [
    evalRun({ kind: 'memory', startedAt: new Date('2026-03-01T10:00:00.000Z'), score: 0.9 }),
    evalRun({ kind: 'memory', startedAt: new Date('2026-03-05T10:00:00.000Z'), score: 0.96, finishedAt: new Date('2026-03-05T10:05:00.000Z') }),
    evalRun({ kind: 'pii', startedAt: new Date('2026-03-03T10:00:00.000Z'), score: 0.959, detailsJson: { rates: { names: 0.938, structured: 1 } } }),
    evalRun({ kind: 'setup_live', startedAt: new Date('2026-03-04T10:00:00.000Z'), score: null, passed: null, detailsJson: null }),
  ],
  jobs: [
    { npiOrgId: ORG_A, flowType: 'po', createdAt: new Date('2026-03-06T08:00:00.000Z'), approvedAt: new Date('2026-03-06T08:05:00.000Z') },
    { npiOrgId: ORG_A, flowType: 'grn', createdAt: new Date('2026-03-07T08:00:00.000Z'), approvedAt: new Date('2026-03-07T08:03:00.000Z') },
    { npiOrgId: ORG_A, flowType: 'pr', createdAt: new Date('2026-03-07T09:00:00.000Z'), approvedAt: null },
    { npiOrgId: ORG_B, flowType: 'po', createdAt: new Date('2026-03-06T08:00:00.000Z'), approvedAt: new Date('2026-03-06T09:00:00.000Z') },
  ],
  baselines: [
    { npiOrgId: ORG_A, flowType: 'po', minutes: 30, measuredAt: new Date('2026-03-02T08:00:00.000Z') },
    { npiOrgId: ORG_B, flowType: 'po', minutes: 99, measuredAt: new Date('2026-03-02T08:00:00.000Z') },
  ],
  sessions: [
    { npiOrgId: ORG_A, startedAt: new Date('2026-03-02T08:00:00.000Z'), completedAt: new Date('2026-03-02T08:20:00.000Z'), profileChosen: 'solar' },
    { npiOrgId: ORG_A, startedAt: new Date('2026-03-03T08:00:00.000Z'), completedAt: null, profileChosen: null },
    { npiOrgId: ORG_B, startedAt: new Date('2026-03-02T08:00:00.000Z'), completedAt: new Date('2026-03-02T09:00:00.000Z'), profileChosen: 'trading' },
  ],
};

beforeEach(() => {
  computeSpy.mockClear();
});

// ─── loadMetricsInput ───────────────────────────────────────────────────────

describe('loadMetricsInput: what reaches each query', () => {
  it('reads each table once, with the organization in the where of every table that has the column', async () => {
    const { db, calls } = buildFakeDb(FIXTURE);
    await loadMetricsInput(db, { npiOrgId: ORG_A }, NOW);

    const dailyWindow = riyadhTrailingPeriod(NOW, DAILY_RETURN_WINDOW_DAYS);
    const costWindow = riyadhTrailingPeriod(NOW, COST_WINDOW_DAYS);

    expect(calls.jobFindMany).toStrictEqual([
      { where: { npiOrgId: ORG_A, approvedAt: { not: null } }, select: INTAKE_JOB_SELECT },
    ]);
    expect(calls.baselineFindMany).toStrictEqual([{ where: { npiOrgId: ORG_A }, select: BASELINE_SELECT }]);
    expect(calls.sessionFindMany).toStrictEqual([
      {
        where: { npiOrgId: ORG_A },
        select: { npiOrgId: true, startedAt: true, completedAt: true, profileChosen: true },
      },
    ]);
    expect(calls.dailyFindMany).toStrictEqual([
      {
        where: {
          npiOrgId: ORG_A,
          // The Riyadh days the 14-day window touches: the first day and the day after the last.
          day: { gte: riyadhDay(dailyWindow.from), lt: new Date(riyadhDay(new Date(dailyWindow.to.getTime() - 1)).getTime() + 86_400_000) },
        },
        orderBy: [{ day: 'asc' }, { npiUserId: 'asc' }],
        select: DAILY_USAGE_SELECT,
      },
    ]);
    expect(calls.auditFindMany).toStrictEqual([
      {
        where: { npiOrgId: ORG_A, ts: { gte: costWindow.from, lt: costWindow.to } },
        orderBy: { ts: 'asc' },
        select: USAGE_AUDIT_SELECT,
      },
    ]);
    expect(calls.dailyFindUnique).toHaveLength(0);
  });

  it('reads eval_runs once, newest first, with no where (the table has no organization column)', async () => {
    const { db, calls } = buildFakeDb(FIXTURE);
    await loadMetricsInput(db, { npiOrgId: ORG_A }, NOW);
    expect(calls.evalFindMany).toStrictEqual([{ orderBy: { startedAt: 'desc' }, select: EVAL_RUN_SELECT }]);
    expect('where' in (calls.evalFindMany[0] as object)).toBe(false);
  });

  it('puts no undefined key in any where', async () => {
    const { db, calls } = buildFakeDb(FIXTURE);
    await loadMetricsInput(db, { npiOrgId: ORG_A }, NOW);
    const wheres = [
      ...calls.jobFindMany,
      ...calls.baselineFindMany,
      ...calls.sessionFindMany,
      ...calls.dailyFindMany,
      ...calls.auditFindMany,
    ].map((c) => (c as { where: Record<string, unknown> }).where);
    expect(wheres).toHaveLength(5);
    for (const where of wheres) {
      expect(where.npiOrgId).toBe(ORG_A);
      for (const value of Object.values(where)) expect(value).not.toBeUndefined();
    }
  });
});

describe('loadMetricsInput: the two windows', () => {
  it('uses the trailing 14 Riyadh days for the daily return and the trailing 30 for the cost, worked out by hand', async () => {
    const { db, calls } = buildFakeDb(FIXTURE);
    const input = await loadMetricsInput(db, { npiOrgId: ORG_A }, NOW);

    // Today (Riyadh 2026-03-10) ends at 2026-03-10T21:00Z; 13 days earlier its first day starts 2026-02-24T21:00Z.
    expect(DAILY_RETURN_WINDOW_DAYS).toBe(14);
    expect(input.dailyWindow).toEqual({
      from: new Date('2026-02-24T21:00:00.000Z'),
      to: new Date('2026-03-10T21:00:00.000Z'),
    });
    expect(input.dailyWindow).toEqual(riyadhTrailingPeriod(NOW, 14));

    // 29 days before the first instant of today: 2026-02-08T21:00Z.
    expect(COST_WINDOW_DAYS).toBe(30);
    const recorded = calls.auditFindMany[0] as { where: { ts: { gte: Date; lt: Date } } };
    expect(recorded.where.ts).toEqual({
      gte: new Date('2026-02-08T21:00:00.000Z'),
      lt: new Date('2026-03-10T21:00:00.000Z'),
    });
    expect(input.usage.period).toEqual(riyadhTrailingPeriod(NOW, 30));
  });
});

describe('loadMetricsInput: what it returns', () => {
  it('returns the rows unchanged, and never an organization-B row', async () => {
    const { db } = buildFakeDb(FIXTURE);
    const input = await loadMetricsInput(db, { npiOrgId: ORG_A }, NOW);

    // daily_usage: org A inside the window, day then user ascending; the February row and org B are absent.
    expect(input.dailyUsage).toEqual([
      { npiUserId: 'u1', day: '2026-03-08', messageCount: 2, tokensIn: 100, tokensOut: 50, costUsdMicro: '1000' },
      { npiUserId: 'u2', day: '2026-03-09', messageCount: 5, tokensIn: 100, tokensOut: 50, costUsdMicro: '1000' },
    ]);

    // llm_audit through the report: two org-A rows in the 30-day window (the February one and org B excluded).
    expect(input.usage.totals.calls).toBe(2);
    expect(input.usage.totals.costUsdMicro).toBe(200n);
    expect(input.usage.byUser.map((u) => u.key).sort()).toEqual(['u1', 'u2']);

    // eval_runs: every row, newest first, organization-free.
    expect(input.evalRuns.map((r) => [r.kind, r.startedAt.toISOString()])).toEqual([
      ['memory', '2026-03-05T10:00:00.000Z'],
      ['setup_live', '2026-03-04T10:00:00.000Z'],
      ['pii', '2026-03-03T10:00:00.000Z'],
      ['memory', '2026-03-01T10:00:00.000Z'],
    ]);
    expect(input.evalRuns[0]).toEqual(FIXTURE.evalRuns[1]);
    expect(input.evalRuns[2]?.detailsJson).toEqual({ rates: { names: 0.938, structured: 1 } });

    expect(input.intakeJobs).toEqual([
      { flowType: 'po', createdAt: new Date('2026-03-06T08:00:00.000Z'), approvedAt: new Date('2026-03-06T08:05:00.000Z') },
      { flowType: 'grn', createdAt: new Date('2026-03-07T08:00:00.000Z'), approvedAt: new Date('2026-03-07T08:03:00.000Z') },
    ]);
    expect(input.baselines).toEqual([{ flowType: 'po', minutes: 30, measuredAt: new Date('2026-03-02T08:00:00.000Z') }]);
    expect(input.onboardingSessions).toHaveLength(2);
    expect(input.onboardingSessions.every((s) => s.npiOrgId === ORG_A)).toBe(true);
  });

  it('reads organization B on its own', async () => {
    const { db } = buildFakeDb(FIXTURE);
    const input = await loadMetricsInput(db, { npiOrgId: ORG_B }, NOW);
    expect(input.dailyUsage.map((r) => r.npiUserId)).toEqual(['ux']);
    expect(input.usage.totals.costUsdMicro).toBe(999_999n);
    expect(input.intakeJobs).toHaveLength(1);
    expect(input.baselines.map((b) => b.minutes)).toEqual([99]);
    expect(input.onboardingSessions.map((s) => s.profileChosen)).toEqual(['trading']);
  });

  it('drops a row whose approvedAt is null even when the reader returns it', async () => {
    const { db } = buildFakeDb({ ...FIXTURE, ignoreApprovedFilter: true });
    const input = await loadMetricsInput(db, { npiOrgId: ORG_A }, NOW);
    expect(input.intakeJobs.map((j) => j.flowType)).toEqual(['po', 'grn']);
  });

  it('the administrative flow (D-26) has no document and no reference time: its approved jobs are not metric rows', async () => {
    const approved = new Date('2026-03-08T08:05:00.000Z');
    const { db } = buildFakeDb({
      ...FIXTURE,
      jobs: [
        ...(FIXTURE.jobs ?? []),
        { npiOrgId: ORG_A, flowType: 'user_permissions', createdAt: new Date('2026-03-08T08:00:00.000Z'), approvedAt: approved },
      ],
    });
    const input = await loadMetricsInput(db, { npiOrgId: ORG_A }, NOW);
    expect(input.intakeJobs.map((j) => j.flowType)).toEqual(['po', 'grn']);
  });

  it('returns empty collections, not errors, for an organization with nothing', async () => {
    const { db } = buildFakeDb(FIXTURE);
    const input = await loadMetricsInput(db, { npiOrgId: 'org-empty' }, NOW);
    expect(input.dailyUsage).toEqual([]);
    expect(input.usage.totals.calls).toBe(0);
    expect(input.intakeJobs).toEqual([]);
    expect(input.baselines).toEqual([]);
    expect(input.onboardingSessions).toEqual([]);
    expect(input.evalRuns).toHaveLength(FIXTURE.evalRuns.length);
  });
});

// ─── loadMetrics ────────────────────────────────────────────────────────────

describe('loadMetrics', () => {
  it('hands computeMetrics exactly the input the readers built, with now and the organization, and returns its view', async () => {
    const { db } = buildFakeDb(FIXTURE);
    const view = await loadMetrics(db, { npiOrgId: ORG_A }, NOW);

    const expectedInput = await loadMetricsInput(buildFakeDb(FIXTURE).db, { npiOrgId: ORG_A }, NOW);
    expect(computeSpy).toHaveBeenCalledTimes(1);
    expect(computeSpy.mock.calls[0]).toEqual([expectedInput, { now: NOW, npiOrgId: ORG_A }]);
    expect(view).toBe(computeSpy.mock.results[0]?.value);
  });

  itWithCompute('returns a view with six cards for the organization (needs src/metrics/compute.ts)', async () => {
    const { db } = buildFakeDb(FIXTURE);
    const view = await loadMetrics(db, { npiOrgId: ORG_A }, NOW);
    expect(view.cards).toHaveLength(6);
    expect(view.cards.map((c) => c.assumption)).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6']);
  });
});
