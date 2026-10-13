// The readers of the metrics screen (T-35, F-19; spec/madar/01 §7 «القياس»).
// They fetch rows from the copilot's own database and hand them, unchanged, to
// the pure computation in `./compute.ts`; no arithmetic lives here.
//
// Rules this file enforces:
//   - Own organization only: `npiOrgId` is in the `where` of every read this
//     file makes except `eval_runs`, never a post-filter, never an `undefined`
//     key. `eval_runs` has no organization column: the evals run against
//     fixtures (01 §7), not against a firm's data, so the latest run of each
//     kind is the same for every organization.
//   - Read only. No model call, no NPI call, no write, no environment read.
import { riyadhTrailingPeriod } from '../audit/cost';
import { loadDailyUsage, loadUsageReport, type UsageDb } from '../queries/usage';
import type { DocumentFlow, FlowType } from '../agents/router';
import { DOCUMENT_FLOWS } from '../onboarding/profile.schema';
import { computeMetrics } from './compute';
import type { OnboardingMetricsDb } from './onboarding';
import {
  COST_WINDOW_DAYS,
  DAILY_RETURN_WINDOW_DAYS,
  type BaselineLike,
  type EvalRunLike,
  type IntakeJobLike,
  type MetricsInput,
  type MetricsView,
} from './types';

// ─── Structural db (the UsageDb / OnboardingMetricsDb pattern) ─────────────

/** The columns of `eval_runs` the metrics read — exactly `EvalRunLike`. */
export const EVAL_RUN_SELECT = {
  kind: true,
  startedAt: true,
  finishedAt: true,
  score: true,
  passed: true,
  detailsJson: true,
} as const;

/** The columns of `intake_jobs` the time metric reads (02 §5.9 row 9). */
export const INTAKE_JOB_SELECT = { flowType: true, createdAt: true, approvedAt: true } as const;

/** The columns of `manual_baselines` the time metric reads. */
export const BASELINE_SELECT = { flowType: true, minutes: true, measuredAt: true } as const;

/** The columns of `onboarding_sessions` a6 reads — `OnboardingSessionLike`. */
const ONBOARDING_SELECT = { npiOrgId: true, startedAt: true, completedAt: true, profileChosen: true } as const;

// The metrics cover the five document flows; the administrative flow (D-26) has
// no document and no manual reference time.
function isFlowType(value: string): value is DocumentFlow {
  return (DOCUMENT_FLOWS as readonly string[]).includes(value);
}

/** Structural subset of the copilot's Prisma client: the real client must
 *  satisfy it WITHOUT a cast (tests/metrics-db.spec.ts proves it), so does a
 *  fake. It extends the T-34 / T-20 shapes rather than redeclaring them. */
export interface MetricsDb extends UsageDb, OnboardingMetricsDb {
  evalRun: {
    findMany(args: { orderBy: { startedAt: 'desc' }; select: typeof EVAL_RUN_SELECT }): Promise<EvalRunLike[]>;
  };
  intakeJob: {
    findMany(args: {
      where: { npiOrgId: string; approvedAt: { not: null } };
      select: typeof INTAKE_JOB_SELECT;
    }): Promise<{ flowType: FlowType; createdAt: Date; approvedAt: Date | null }[]>;
  };
  manualBaseline: {
    findMany(args: { where: { npiOrgId: string }; select: typeof BASELINE_SELECT }): Promise<BaselineLike[]>;
  };
}

export interface MetricsScope {
  npiOrgId: string;
}

// ─── readers ────────────────────────────────────────────────────────────────

/** Everything `computeMetrics` needs, read with five parallel queries. */
export async function loadMetricsInput(db: MetricsDb, scope: MetricsScope, now: Date): Promise<MetricsInput> {
  const { npiOrgId } = scope;
  const dailyWindow = riyadhTrailingPeriod(now, DAILY_RETURN_WINDOW_DAYS);
  const costWindow = riyadhTrailingPeriod(now, COST_WINDOW_DAYS);

  const [dailyUsage, usage, evalRuns, jobRows, baselines, onboardingSessions] = await Promise.all([
    loadDailyUsage(db, { npiOrgId }, dailyWindow),
    loadUsageReport(db, { npiOrgId }, costWindow),
    // No organization column on `eval_runs` (see the header): every run, newest first.
    db.evalRun.findMany({ orderBy: { startedAt: 'desc' }, select: EVAL_RUN_SELECT }),
    db.intakeJob.findMany({
      where: { npiOrgId, approvedAt: { not: null } },
      select: INTAKE_JOB_SELECT,
    }),
    db.manualBaseline.findMany({ where: { npiOrgId }, select: BASELINE_SELECT }),
    db.onboardingSession.findMany({ where: { npiOrgId }, select: ONBOARDING_SELECT }),
  ]);

  // The `where` already excludes unapproved jobs; the guard narrows the type
  // (and drops a row a misbehaving reader would let through).
  const intakeJobs: IntakeJobLike[] = [];
  for (const row of jobRows) {
    if (row.approvedAt === null || !isFlowType(row.flowType)) continue;
    intakeJobs.push({ flowType: row.flowType, createdAt: row.createdAt, approvedAt: row.approvedAt });
  }

  return { dailyUsage, dailyWindow, usage, evalRuns, intakeJobs, baselines, onboardingSessions };
}

/** The six cards of the metrics screen for one organization at `now`. */
export async function loadMetrics(db: MetricsDb, scope: MetricsScope, now: Date): Promise<MetricsView> {
  return computeMetrics(await loadMetricsInput(db, scope, now), { now, npiOrgId: scope.npiOrgId });
}
