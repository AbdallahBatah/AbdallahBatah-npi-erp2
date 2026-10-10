// Database fixture for e2e/metrics.spec.ts (T-35, F-19): seeds the rows the
// metrics screen reads, with known figures, and removes exactly those rows
// afterwards. Copilot rows only — never NPI's database (08 §E.10).
//
// Uses the copilot's own Prisma client and the same `.env` loading
// `tests/helpers/load-env.ts` already does for Jest. Never logs the
// connection URL.
//
// What it seeds, and why those figures:
//   - three `eval_runs` rows (memory 0.92, pii 0.95 with names 0.9375 /
//     structured 1, extract:po 35/36) with `startedAt = finishedAt = now`.
//     The table has NO organization column, so these are the LATEST rows of
//     their kind for every organization until they are removed; the spec's
//     `afterEach` removes them by id even when a test fails.
//   - two approved `po` intake jobs taking 3.0 and 5.0 minutes (median 4.0)
//     and a 30-minute `po` manual baseline: the time ratio of a5.
//   - ten `daily_usage` rows, one per Riyadh working day (Sunday to Thursday)
//     of the trailing 14 Riyadh days, for one scratch user: a1.
//   - one completed `onboarding_sessions` row of 12.5 minutes: a6.
// The organization may already hold rows of its own (the demo data), so the
// fixture records how many `po` jobs and completed sessions were there before
// it seeded; the spec asserts the exact median / the exact 12.5 only when
// that count is zero, and asserts shape otherwise.
//
// Cleanup deletes only the ids this fixture created, and restores the `po`
// baseline row it may have overwritten (the `settings-db.ts` save-and-restore
// shape). Nothing of the demo data is ever touched.
import '../../tests/helpers/load-env';
import { PrismaClient, type ManualBaseline } from '../../src/generated/prisma';
import { riyadhDay } from '../../src/audit/cost';

let client: PrismaClient | undefined;

function getClient(): PrismaClient {
  if (!client) client = new PrismaClient();
  return client;
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export interface MetricsFixtureInput {
  npiOrgId: string;
  adminUserId: string;
}

export interface MetricsFixture {
  run: string;
  npiOrgId: string;
  adminUserId: string;
  /** "Now" at seed time: the `startedAt`/`finishedAt` of the eval runs. */
  base: Date;
  evalRunIds: { memory: string; pii: string; extractPo: string };
  jobIds: string[];
  dailyUsageIds: string[];
  /** The scratch user the `daily_usage` rows belong to. */
  scratchUserId: string;
  /** Riyadh working days (Sunday to Thursday) seeded: 10. */
  workingDaysSeeded: number;
  sessionId: string;
  /** Approved `po` jobs of the organization BEFORE the seed (0 on the demo DB). */
  otherPoJobs: number;
  /** Completed onboarding sessions of the organization BEFORE the seed. */
  otherCompletedSessions: number;
  /** The organization's `po` baseline row before the seed, if there was one. */
  previousPoBaseline: ManualBaseline | null;
}

/**
 * Seeds the figures described in the header under the administrator's real
 * organization (the page reads the signed-in administrator's organization).
 */
export async function seedMetricsFixture(input: MetricsFixtureInput): Promise<MetricsFixture> {
  const db = getClient();
  const { npiOrgId, adminUserId } = input;
  const run = Math.random().toString(36).slice(2, 10);
  const base = new Date();
  const ago = (minutes: number): Date => new Date(base.getTime() - minutes * MINUTE_MS);
  const reportPath = `e2e-metrics-${run}`;
  const scratchUserId = `e2e-metrics-${run}`;

  // What the organization already holds, before anything is written.
  const otherPoJobs = await db.intakeJob.count({
    where: { npiOrgId, flowType: 'po', approvedAt: { not: null } },
  });
  const otherCompletedSessions = await db.onboardingSession.count({
    where: { npiOrgId, completedAt: { not: null } },
  });
  const previousPoBaseline = await db.manualBaseline.findUnique({
    where: { npiOrgId_flowType: { npiOrgId, flowType: 'po' } },
  });

  const memory = await db.evalRun.create({
    data: {
      kind: 'memory',
      startedAt: base,
      finishedAt: base,
      score: 0.92,
      passed: true,
      detailsJson: {
        gate: 0.85,
        derivation: { expected: 50, derived: 50, misses: [] },
        retrieval: { answered: 46, top1: 40, misses: [] },
        reportPath,
      },
    },
  });

  const pii = await db.evalRun.create({
    data: {
      kind: 'pii',
      startedAt: base,
      finishedAt: base,
      score: 0.95,
      passed: true,
      detailsJson: {
        gates: { names: 0.9, structured: 0.95 },
        rates: { names: 0.9375, structured: 1 },
        counts: {
          sentences: 100,
          totalNames: 80,
          redactedNames: 75,
          totalStructured: 40,
          redactedStructured: 40,
        },
        leaks: [],
        overRedactions: [],
        roundTripFailures: [],
        reportPath,
      },
    },
  });

  const extractPo = await db.evalRun.create({
    data: {
      kind: 'extract:po',
      startedAt: base,
      finishedAt: base,
      score: 35 / 36,
      passed: true,
      detailsJson: {
        gate: 0.9,
        confirmedWrong: 0,
        docs: [
          {
            file: `e2e-po-${run}`,
            input: 'text',
            ok: true,
            correct: 35,
            total: 36,
            confirmedWrong: 0,
            statusMismatches: 0,
            usage: null,
            failure: null,
          },
        ],
        reportPath,
      },
    },
  });

  // Two approved `po` jobs: 3.0 and 5.0 minutes from creation to approval.
  const job1 = await db.intakeJob.create({
    data: {
      npiOrgId,
      npiUserId: adminUserId,
      flowType: 'po',
      status: 'done',
      extractedJson: {},
      createdAt: ago(10),
      approvedAt: ago(7),
    },
  });
  const job2 = await db.intakeJob.create({
    data: {
      npiOrgId,
      npiUserId: adminUserId,
      flowType: 'po',
      status: 'done',
      extractedJson: {},
      createdAt: ago(20),
      approvedAt: ago(15),
    },
  });

  await db.manualBaseline.upsert({
    where: { npiOrgId_flowType: { npiOrgId, flowType: 'po' } },
    create: { npiOrgId, flowType: 'po', minutes: 30, measuredAt: base, npiUserId: adminUserId },
    update: { minutes: 30, measuredAt: base, npiUserId: adminUserId },
  });

  // One row per Riyadh working day of the trailing 14 Riyadh days (today
  // included). `riyadhDay` is UTC midnight of the Riyadh calendar day, which is
  // how `daily_usage.day` (`@db.Date`) is keyed.
  const today = riyadhDay(new Date(base.getTime()));
  const dailyUsageIds: string[] = [];
  for (let back = 0; back < 14; back += 1) {
    const day = new Date(today.getTime() - back * DAY_MS);
    if (day.getUTCDay() > 4) continue; // Friday (5) and Saturday (6) are not working days
    const row = await db.dailyUsage.create({
      data: { npiOrgId, npiUserId: scratchUserId, day, messageCount: 1 },
    });
    dailyUsageIds.push(row.id);
  }

  const session = await db.onboardingSession.create({
    data: {
      npiOrgId,
      npiUserId: adminUserId,
      startedAt: ago(30),
      completedAt: ago(17.5),
      stepsJson: {},
      profileChosen: 'epc',
    },
  });

  return {
    run,
    npiOrgId,
    adminUserId,
    base,
    evalRunIds: { memory: memory.id, pii: pii.id, extractPo: extractPo.id },
    jobIds: [job1.id, job2.id],
    dailyUsageIds,
    scratchUserId,
    workingDaysSeeded: dailyUsageIds.length,
    sessionId: session.id,
    otherPoJobs,
    otherCompletedSessions,
    previousPoBaseline,
  };
}

/** Removes exactly the rows `seedMetricsFixture` created and puts the `po`
 *  baseline back the way it was (or deletes the one the seed created). */
export async function cleanupMetricsFixture(fixture: MetricsFixture): Promise<void> {
  const db = getClient();
  await db.evalRun.deleteMany({ where: { id: { in: Object.values(fixture.evalRunIds) } } });
  await db.intakeJob.deleteMany({ where: { id: { in: fixture.jobIds } } });
  await db.dailyUsage.deleteMany({ where: { id: { in: fixture.dailyUsageIds } } });
  await db.onboardingSession.deleteMany({ where: { id: fixture.sessionId } });

  const { npiOrgId, previousPoBaseline } = fixture;
  if (previousPoBaseline) {
    await db.manualBaseline.upsert({
      where: { npiOrgId_flowType: { npiOrgId, flowType: 'po' } },
      create: {
        npiOrgId,
        flowType: 'po',
        minutes: previousPoBaseline.minutes,
        measuredAt: previousPoBaseline.measuredAt,
        npiUserId: previousPoBaseline.npiUserId,
      },
      update: {
        minutes: previousPoBaseline.minutes,
        measuredAt: previousPoBaseline.measuredAt,
        npiUserId: previousPoBaseline.npiUserId,
      },
    });
  } else {
    await db.manualBaseline.deleteMany({ where: { npiOrgId, flowType: 'po' } });
  }
}

/** Closes the fixture's own Prisma connection — call once, from `afterAll`. */
export async function disconnectMetricsDb(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}
