// T-35 part B against the real local `npi_copilot` database (not a mock): the
// metrics readers over rows seeded the way the app writes them. Like
// tests/cost-db.spec.ts these must FAIL — not silently skip — when the
// database is unreachable, so no try/catch swallows a connection error.
//
// Only rows this run creates are asserted on and deleted: two scratch
// organizations (`org_madar_metrics_<run>` and an "other" one), plus one
// `eval_runs` row of a kind the metrics ignore (`metrics_db_test_<run>`), so
// the developer's latest `memory` / `pii` / `extract:*` runs are never touched
// or shadowed.
import './helpers/load-env';
import { riyadhDay } from '../src/audit/cost';
import { getDb } from '../src/db';
import { loadMetrics, loadMetricsInput, type MetricsDb } from '../src/metrics/load';

// Part A's `src/metrics/compute.ts` may not exist yet when this file is first
// run; delegate to it when it does, so the six-card test needs no edit later.
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
      computeMetrics: (input: unknown, opts: { now: Date; npiOrgId: string }) =>
        actual !== null ? actual.computeMetrics(input, opts) : { cards: [] },
    };
  },
  { virtual: true },
);
const computeAbsent: boolean = (jest.requireMock('../src/metrics/compute') as { __computeAbsent: boolean })
  .__computeAbsent;
const itWithCompute = computeAbsent ? it.skip : it;

const prisma = getDb();

// No cast: the real Prisma client must satisfy MetricsDb as declared
// (the same pattern tests/cost-db.spec.ts proves for UsageDb). This line IS
// the compile-time test.
const db: MetricsDb = prisma;

const runId = Math.random().toString(36).slice(2, 10);
const orgId = `org_madar_metrics_${runId}`;
const otherOrgId = `org_madar_metrics_other_${runId}`;
const user1 = `test-metrics-u1-${runId}`;
const user2 = `test-metrics-u2-${runId}`;
const otherUser = `test-metrics-ox-${runId}`;
const evalKind = `metrics_db_test_${runId}`;

const now = new Date();
const today = riyadhDay(now);
const createdAt = new Date(now.getTime() - 2 * 60 * 60 * 1000);
const approvedAt = new Date(createdAt.getTime() + 5 * 60 * 1000);
const measuredAt = new Date(now.getTime() - 24 * 60 * 60 * 1000);
const sessionStart = new Date(now.getTime() - 3 * 60 * 60 * 1000);
const sessionEnd = new Date(sessionStart.getTime() + 20 * 60 * 1000);
const evalStart = new Date(now.getTime() - 60 * 1000);

let evalRunId = '';

beforeAll(async () => {
  await prisma.dailyUsage.createMany({
    data: [
      { npiOrgId: orgId, npiUserId: user1, day: today, messageCount: 7, tokensIn: 400, tokensOut: 200, costUsdMicro: 123_456_789_012n },
      { npiOrgId: orgId, npiUserId: user2, day: today, messageCount: 2, tokensIn: 10, tokensOut: 5, costUsdMicro: 4_321n },
      { npiOrgId: otherOrgId, npiUserId: otherUser, day: today, messageCount: 99, tokensIn: 1, tokensOut: 1, costUsdMicro: 1n },
    ],
  });

  await prisma.llmAudit.createMany({
    data: [
      { ts: now, npiOrgId: orgId, npiUserId: user1, event: 'chat', modelTier: 'economy', modelId: 'claude-haiku-4-5-20251001', tokensIn: 100, tokensOut: 50, costUsdMicro: 250n },
      { ts: now, npiOrgId: otherOrgId, npiUserId: otherUser, event: 'chat', modelTier: 'economy', modelId: 'claude-haiku-4-5-20251001', tokensIn: 9, tokensOut: 9, costUsdMicro: 99_999n },
    ],
  });

  await prisma.intakeJob.createMany({
    data: [
      { npiOrgId: orgId, npiUserId: user1, flowType: 'po', status: 'done', createdAt, approvedAt },
      // Not approved: never read by the time metric.
      { npiOrgId: orgId, npiUserId: user1, flowType: 'pr', status: 'preview', createdAt, approvedAt: null },
      { npiOrgId: otherOrgId, npiUserId: otherUser, flowType: 'grn', status: 'done', createdAt, approvedAt },
    ],
  });

  await prisma.manualBaseline.createMany({
    data: [
      { npiOrgId: orgId, flowType: 'po', minutes: 30, measuredAt, npiUserId: user1 },
      { npiOrgId: otherOrgId, flowType: 'po', minutes: 99, measuredAt, npiUserId: otherUser },
    ],
  });

  await prisma.onboardingSession.createMany({
    data: [
      { npiOrgId: orgId, npiUserId: user1, startedAt: sessionStart, completedAt: sessionEnd, stepsJson: {}, profileChosen: 'solar' },
      { npiOrgId: otherOrgId, npiUserId: otherUser, startedAt: sessionStart, completedAt: sessionEnd, stepsJson: {}, profileChosen: 'trading' },
    ],
  });

  const run = await prisma.evalRun.create({
    data: { kind: evalKind, startedAt: evalStart, finishedAt: evalStart, score: 0.5, passed: false, detailsJson: { marker: runId } },
  });
  evalRunId = run.id;
});

afterAll(async () => {
  for (const npiOrgId of [orgId, otherOrgId]) {
    await prisma.dailyUsage.deleteMany({ where: { npiOrgId } });
    await prisma.llmAudit.deleteMany({ where: { npiOrgId } });
    await prisma.intakeJob.deleteMany({ where: { npiOrgId } });
    await prisma.manualBaseline.deleteMany({ where: { npiOrgId } });
    await prisma.onboardingSession.deleteMany({ where: { npiOrgId } });
  }
  if (evalRunId !== '') await prisma.evalRun.deleteMany({ where: { id: evalRunId } });
  await prisma.$disconnect();
});

describe('the metrics readers against the real npi_copilot database', () => {
  it('returns exactly the seeded rows of the organization: the unapproved job and the other organization absent', async () => {
    const input = await loadMetricsInput(db, { npiOrgId: orgId }, now);

    expect(input.dailyUsage).toEqual(
      [
        { npiUserId: user1, day: today.toISOString().slice(0, 10), messageCount: 7, tokensIn: 400, tokensOut: 200, costUsdMicro: '123456789012' },
        { npiUserId: user2, day: today.toISOString().slice(0, 10), messageCount: 2, tokensIn: 10, tokensOut: 5, costUsdMicro: '4321' },
      ].sort((a, b) => (a.npiUserId < b.npiUserId ? -1 : 1)),
    );

    expect(input.usage.totals.calls).toBe(1);
    expect(input.usage.totals.costUsdMicro).toBe(250n);
    expect(input.usage.byUser.map((u) => u.key)).toEqual([user1]);

    expect(input.intakeJobs).toEqual([{ flowType: 'po', createdAt, approvedAt }]);
    expect(input.baselines).toEqual([{ flowType: 'po', minutes: 30, measuredAt }]);
    expect(input.onboardingSessions).toEqual([
      { npiOrgId: orgId, startedAt: sessionStart, completedAt: sessionEnd, profileChosen: 'solar' },
    ]);
  });

  it('carries the scratch eval run in evalRuns (the table has no organization column), as the selected columns only', async () => {
    const input = await loadMetricsInput(db, { npiOrgId: orgId }, now);
    const mine = input.evalRuns.find((r) => r.kind === evalKind);
    expect(mine).toEqual({
      kind: evalKind,
      startedAt: evalStart,
      finishedAt: evalStart,
      score: 0.5,
      passed: false,
      detailsJson: { marker: runId },
    });
    // Newest first.
    const times = input.evalRuns.map((r) => r.startedAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('reads the other organization on its own', async () => {
    const input = await loadMetricsInput(db, { npiOrgId: otherOrgId }, now);
    expect(input.dailyUsage.map((r) => r.npiUserId)).toEqual([otherUser]);
    expect(input.usage.totals.costUsdMicro).toBe(99_999n);
    expect(input.intakeJobs.map((j) => j.flowType)).toEqual(['grn']);
    expect(input.baselines.map((b) => b.minutes)).toEqual([99]);
    expect(input.onboardingSessions.map((s) => s.profileChosen)).toEqual(['trading']);
  });

  itWithCompute('loadMetrics returns six cards (needs src/metrics/compute.ts)', async () => {
    const view = await loadMetrics(db, { npiOrgId: orgId }, now);
    expect(view.cards).toHaveLength(6);
  });
});
