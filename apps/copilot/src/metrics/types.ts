// Shared shapes of the metrics screen (T-35, F-19, spec/madar/01 §1 «الافتراضات
// الستة» and §7 «مؤشرات النجاح — القياس», 05 row T-35, 06 AT-13, 07 G-M4-4).
// TYPES AND CONSTANTS ONLY — no imports of server code — so the server page,
// the pure computation, the readers, the CSV export and the e2e gate all
// `import type` from one place.
//
// What the screen shows: one card per assumption a1–a6 with the headline
// figure, the target of 01 §1, a verdict, when it was measured and a few
// detail lines; and one CSV (`copilot-metrics.csv`, 02 §8) with exactly six
// assumption rows under the header fixed by 07 G-M4-4.
//
// Where each figure comes from (01 §7):
//   a1  `daily_usage` — the share of WORKING days (Riyadh calendar, Sunday to
//       Thursday) on which an employee sent at least one chat message, over
//       the trailing 14 Riyadh days, averaged over the employees who sent at
//       least one message in that window.                    target ≥ 70 %
//   a2  the latest `eval_runs` row of kind `memory` (score = answered / 50).
//                                                              target ≥ 85 %
//   a3  `llm_audit` through `loadUsageReport` over the trailing 30 Riyadh
//       days: cost per document and per day, with the monthly projection.
//                                                              «يُقاس» (no target)
//   a4  the latest `eval_runs` row of kind `pii`: `detailsJson.rates.names`
//       and `.structured`.                         targets ≥ 90 % / ≥ 95 %
//   a5  the latest `eval_runs` row of each kind `extract:<flow>`: correct
//       fields / expected fields summed over the five flows' latest runs
//       (`detailsJson.docs[].correct|total`); and the time ratio = the median
//       minutes from `intake_jobs.createdAt` to `approvedAt` per flow against
//       the manual baseline of that flow (`manual_baselines.minutes`, entered
//       once in /settings), combined over the flows that have both.
//                                           targets ≥ 90 % fields, ≤ 1/3 time
//   a6  `onboarding_sessions` through `computeOnboardingMetric` (median
//       minutes from the first question to a configured system).
//                                                              target ≤ 30 min
import type { OnboardingSessionLike } from './onboarding';
import type { DailyUsageRowView, UsagePeriod, UsageReport } from '../audit/usage-types';
import type { DocumentFlow } from '../agents/router';

export type AssumptionId = 'a1' | 'a2' | 'a3' | 'a4' | 'a5' | 'a6';

export const ASSUMPTION_IDS: readonly AssumptionId[] = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'];

/** `met` / `not_met` against the target of 01 §1; `no_data` when nothing has
 *  been measured yet; `measured` for a3, which has a figure and no target. */
export type MetricVerdict = 'met' | 'not_met' | 'no_data' | 'measured';

export type MetricUnit = 'percent' | 'minutes' | 'usd' | 'ratio';

// ─── the targets (01 §1) ───────────────────────────────────────────────────

export const DAILY_RETURN_TARGET = 0.7;
export const DAILY_RETURN_WINDOW_DAYS = 14;
export const MEMORY_ACCURACY_TARGET = 0.85;
export const COST_WINDOW_DAYS = 30;
export const PII_NAMES_TARGET = 0.9;
export const PII_STRUCTURED_TARGET = 0.95;
export const FIELDS_CORRECT_TARGET = 0.9;
/** «≤ ثلث الزمن اليدوي». */
export const TIME_RATIO_TARGET = 1 / 3;
// a6's target lives in `./onboarding` (`ONBOARDING_TARGET_MINUTES`).

/** Riyadh working week: Sunday (0) to Thursday (4). Friday and Saturday are
 *  not working days and never count against a1. */
export const WORKING_WEEKDAYS: readonly number[] = [0, 1, 2, 3, 4];

// ─── raw rows the computation reads (structural, never Prisma types) ──────

/** One `eval_runs` row as the metric reads it. `detailsJson` is whatever the
 *  eval script wrote — the computation narrows it with guards and treats a
 *  malformed one as `no_data`, never as a crash. */
export interface EvalRunLike {
  kind: string;
  startedAt: Date;
  finishedAt: Date | null;
  score: number | null;
  passed: boolean | null;
  detailsJson: unknown;
}

/** One approved `intake_jobs` row: the time metric of 02 §5.9 row 9 is
 *  `createdAt → approvedAt`. Rows without `approvedAt` are not read. */
export interface IntakeJobLike {
  flowType: DocumentFlow;
  createdAt: Date;
  approvedAt: Date;
}

/** One `manual_baselines` row (T-19): whole minutes the owner measured once
 *  with a stopwatch on NPI's own screen, per flow. */
export interface BaselineLike {
  flowType: string;
  minutes: number;
  measuredAt: Date;
}

/** Everything `computeMetrics` needs, already read. The readers in
 *  `./load.ts` fill it; the tests build it by hand. */
export interface MetricsInput {
  /** `loadDailyUsage` over `dailyWindow` (the organization's accumulator rows). */
  dailyUsage: DailyUsageRowView[];
  /** `riyadhTrailingPeriod(now, DAILY_RETURN_WINDOW_DAYS)`. */
  dailyWindow: UsagePeriod;
  /** `loadUsageReport` over `riyadhTrailingPeriod(now, COST_WINDOW_DAYS)`. */
  usage: UsageReport;
  /** Every `eval_runs` row (or at least the latest of each kind). The
   *  computation picks the latest by `startedAt` per kind; the table has no
   *  organization column (the evals run against fixtures, not a firm's data). */
  evalRuns: EvalRunLike[];
  /** The organization's approved intake jobs (`approvedAt` set). */
  intakeJobs: IntakeJobLike[];
  /** The organization's manual baselines. */
  baselines: BaselineLike[];
  /** The organization's onboarding sessions. */
  onboardingSessions: OnboardingSessionLike[];
}

// ─── what the screen and the CSV show ──────────────────────────────────────

/** A secondary figure on the same card (a5's time ratio beside its fields
 *  share; a4's structured rate beside its names rate). */
export interface MetricSecondaryView {
  labelAr: string;
  /** Formatted for display (Arabic digits are not used: `formatNumber`). */
  value: string | null;
  rawValue: number | null;
  unit: MetricUnit;
  targetAr: string;
  verdict: MetricVerdict;
}

export interface MetricCardView {
  assumption: AssumptionId;
  /** `t('metrics.a1')` … `t('metrics.a6')`. */
  labelAr: string;
  /** The headline figure formatted for display; `null` when `no_data`. */
  value: string | null;
  /** The machine figure for the CSV: a share as a decimal 0…1 (4 places), minutes
   *  to one decimal, USD micro as an integer; `null` when `no_data`. */
  rawValue: number | null;
  unit: MetricUnit;
  /** `t('metrics.target.*')` rendered — «≥ 70%», «≤ 30 دقيقة», «يُقاس». */
  targetAr: string;
  /** The CSV target: `>=0.70`, `>=0.85`, `measured`, `>=0.90;>=0.95`,
   *  `>=0.90;<=0.3333`, `<=30`. */
  target: string;
  verdict: MetricVerdict;
  /** ISO timestamp of the measurement: the eval run's `finishedAt ?? startedAt`,
   *  else the computation's `now`; `null` when `no_data`. */
  measuredAt: string | null;
  secondary: MetricSecondaryView | null;
  /** Short Arabic lines rendered under the headline (counts, windows, per-flow
   *  figures). */
  detailsAr: string[];
  /** The CSV `details` cell: the same facts as `key=value` pairs joined by
   *  `;` — ASCII keys, no comma, no newline, so the cell never needs quoting
   *  (the writer quotes anyway when it must). */
  details: string;
}

export interface MetricsView {
  /** ISO timestamp of the computation. */
  generatedAt: string;
  npiOrgId: string;
  /** Exactly six, in `ASSUMPTION_IDS` order. */
  cards: MetricCardView[];
}

// ─── the CSV (07 G-M4-4) ───────────────────────────────────────────────────

export const METRICS_CSV_HEADER = 'assumption,metric,value,target,measured_at,details';
export const METRICS_CSV_FILENAME = 'copilot-metrics.csv';

/** The permission the screen and the export route guard with — the same one
 *  `/trust` and `/settings` use (01 §5: trust, metrics and settings are the
 *  administrator's screens). */
export const METRICS_PERMISSION = 'admin.user.manage';
