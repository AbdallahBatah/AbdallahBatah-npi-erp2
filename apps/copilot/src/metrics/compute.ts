// The pure computation of the metrics screen (T-35, F-19; spec/madar/01 §1
// «الافتراضات الستة» and §7 «القياس», 06 AT-13, 07 G-M4-4). No I/O and no
// clock: every function takes the rows already read and `now`, so the page,
// the CSV route and the tests share one arithmetic. The shapes live in
// `./types`; a6 is `./onboarding`'s `computeOnboardingMetric`, reused as is.
import { dayKeyOf, riyadhDay } from '../audit/cost';
import type { DailyUsageRowView, UsagePeriod, UsageReport } from '../audit/usage-types';
import type { FlowType } from '../agents/router';
import { t, type ArKey } from '../i18n/ar';
import { formatNumber, formatUsdMicro } from '../i18n/format';
import { computeOnboardingMetric, type OnboardingSessionLike } from './onboarding';
import {
  COST_WINDOW_DAYS,
  DAILY_RETURN_TARGET,
  DAILY_RETURN_WINDOW_DAYS,
  FIELDS_CORRECT_TARGET,
  MEMORY_ACCURACY_TARGET,
  PII_NAMES_TARGET,
  PII_STRUCTURED_TARGET,
  TIME_RATIO_TARGET,
  WORKING_WEEKDAYS,
  type BaselineLike,
  type EvalRunLike,
  type IntakeJobLike,
  type MetricCardView,
  type MetricSecondaryView,
  type MetricVerdict,
  type MetricsInput,
  type MetricsView,
} from './types';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The FlowType union order (src/agents/router.ts). */
const FLOWS: readonly FlowType[] = ['customer_contract', 'pr', 'po', 'grn', 'vendor_bill'];

// ─── helpers ────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** `0.9871` → `"98.7%"` (Latin digits, one decimal at most). */
function percentValue(raw: number): string {
  return `${formatNumber(Math.round(raw * 1000) / 10)}%`;
}

/** The conventional median of an unsorted list: the middle value, or the mean
 *  of the two middle values when the count is even. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** `finishedAt ?? startedAt` as ISO; `now` when both are unusable dates. */
function runTimeIso(run: EvalRunLike, now: Date): string {
  for (const candidate of [run.finishedAt, run.startedAt]) {
    if (candidate instanceof Date && Number.isFinite(candidate.getTime())) return candidate.toISOString();
  }
  return now.toISOString();
}

function verdictOf(raw: number, target: number): MetricVerdict {
  return raw >= target ? 'met' : 'not_met';
}

// ─── a1 · the daily return ──────────────────────────────────────────────────

/** UTC-midnight milliseconds of every Riyadh calendar day the half-open window
 *  touches, ascending. An empty or inverted window touches none. */
function windowDayStarts(window: UsagePeriod): number[] {
  const fromMs = window.from.getTime();
  const toMs = window.to.getTime();
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return [];
  const first = riyadhDay(window.from).getTime();
  const last = riyadhDay(new Date(toMs - 1)).getTime();
  const days: number[] = [];
  for (let d = first; d <= last; d += DAY_MS) days.push(d);
  return days;
}

/** The `YYYY-MM-DD` keys of the Riyadh working days (Sunday to Thursday) the
 *  window touches, ascending. */
export function workingDayKeys(window: UsagePeriod): string[] {
  return windowDayStarts(window)
    .filter((dayMs) => WORKING_WEEKDAYS.includes(new Date(dayMs).getUTCDay()))
    .map((dayMs) => dayKeyOf(new Date(dayMs)));
}

export function computeDailyReturn(rows: DailyUsageRowView[], window: UsagePeriod, now: Date): MetricCardView {
  const windowKeys = new Set(windowDayStarts(window).map((dayMs) => dayKeyOf(new Date(dayMs))));
  const working = workingDayKeys(window);
  const workingSet = new Set(working);

  // user → the days (any day of the window) with at least one message
  const activeDays = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!windowKeys.has(row.day) || !(row.messageCount > 0)) continue;
    const days = activeDays.get(row.npiUserId) ?? new Set<string>();
    days.add(row.day);
    activeDays.set(row.npiUserId, days);
  }

  const users = activeDays.size;
  const base = {
    assumption: 'a1' as const,
    labelAr: t('metrics.a1'),
    unit: 'percent' as const,
    targetAr: t('metrics.target.daily_return'),
    target: '>=0.70',
    secondary: null,
  };

  if (users === 0 || working.length === 0) {
    return {
      ...base,
      value: null,
      rawValue: null,
      verdict: 'no_data',
      measuredAt: null,
      detailsAr: [t('metrics.a1.no_users')],
      details: `window_days=${DAILY_RETURN_WINDOW_DAYS};working_days=${working.length};active_users=0`,
    };
  }

  let workedDays = 0;
  for (const days of activeDays.values()) {
    for (const day of days) if (workingSet.has(day)) workedDays += 1;
  }
  const raw = round4(workedDays / (users * working.length));

  return {
    ...base,
    value: percentValue(raw),
    rawValue: raw,
    verdict: verdictOf(raw, DAILY_RETURN_TARGET),
    measuredAt: now.toISOString(),
    detailsAr: [
      t('metrics.window_days', { n: DAILY_RETURN_WINDOW_DAYS }),
      t('metrics.a1.users', { n: users }),
      t('metrics.a1.working_days', { n: working.length }),
    ],
    details: `window_days=${DAILY_RETURN_WINDOW_DAYS};working_days=${working.length};active_users=${users}`,
  };
}

// ─── the eval runs ──────────────────────────────────────────────────────────

/** The run of exactly `kind` with the highest `startedAt` (ties: the first
 *  encountered). Never trusts the order of `runs`. */
export function latestRunOfKind(runs: EvalRunLike[], kind: string): EvalRunLike | null {
  let best: EvalRunLike | null = null;
  for (const run of runs) {
    if (run.kind !== kind) continue;
    if (best === null || run.startedAt.getTime() > best.startedAt.getTime()) best = run;
  }
  return best;
}

// ─── a2 · the memory accuracy ───────────────────────────────────────────────

export function computeMemoryAccuracy(runs: EvalRunLike[], now: Date): MetricCardView {
  const run = latestRunOfKind(runs, 'memory');
  const base = {
    assumption: 'a2' as const,
    labelAr: t('metrics.a2'),
    unit: 'percent' as const,
    targetAr: t('metrics.target.memory'),
    target: '>=0.85',
    secondary: null,
  };

  if (run === null || !isFiniteNumber(run.score)) {
    return {
      ...base,
      value: null,
      rawValue: null,
      verdict: 'no_data',
      measuredAt: null,
      detailsAr: [t('metrics.a2.no_run')],
      details: 'run=none',
    };
  }

  const raw = round4(run.score);
  const json = isRecord(run.detailsJson) ? run.detailsJson : {};
  const retrieval = isRecord(json.retrieval) ? json.retrieval : {};
  const derivation = isRecord(json.derivation) ? json.derivation : {};
  const answered = isFiniteNumber(retrieval.answered) ? retrieval.answered : null;
  const derived = isFiniteNumber(derivation.derived) ? derivation.derived : null;
  const expected = isFiniteNumber(derivation.expected) ? derivation.expected : null;

  const detailsAr: string[] = [];
  if (answered !== null && derived !== null && expected !== null) {
    // The eval asks one question per expected fact, so `expected` is the question count.
    detailsAr.push(
      t('metrics.a2.answered', { answered, total: expected }),
      t('metrics.a2.derived', { derived, expected }),
    );
  }

  const pairs = ['run=memory', `score=${raw.toFixed(4)}`];
  if (answered !== null) pairs.push(`answered=${answered}`);
  if (expected !== null) pairs.push(`expected=${expected}`);

  return {
    ...base,
    value: percentValue(raw),
    rawValue: raw,
    verdict: verdictOf(raw, MEMORY_ACCURACY_TARGET),
    measuredAt: runTimeIso(run, now),
    detailsAr,
    details: pairs.join(';'),
  };
}

// ─── a3 · the inference cost ────────────────────────────────────────────────

export function computeInferenceCost(report: UsageReport, now: Date): MetricCardView {
  const { totals, byDocument, projection } = report;
  const base = {
    assumption: 'a3' as const,
    labelAr: t('metrics.a3'),
    unit: 'usd' as const,
    targetAr: t('metrics.target.cost'),
    target: 'measured',
  };

  if (totals.calls === 0) {
    return {
      ...base,
      value: null,
      rawValue: null,
      verdict: 'no_data',
      measuredAt: null,
      secondary: null,
      detailsAr: [t('metrics.a3.no_calls')],
      details: `window_days=${COST_WINDOW_DAYS};calls=0`,
    };
  }

  const perDocument = byDocument.length > 0;
  const perDocumentMicro = perDocument ? totals.costUsdMicro / BigInt(byDocument.length) : null;
  const rawValue = Number(perDocumentMicro ?? projection.dailyAverageUsdMicro);
  const usd = t('metrics.unit.usd');

  const secondary: MetricSecondaryView = {
    labelAr: t('metrics.a3.per_day'),
    value: `${formatUsdMicro(projection.dailyAverageUsdMicro)} ${usd}`,
    rawValue: Number(projection.dailyAverageUsdMicro),
    unit: 'usd',
    targetAr: t('metrics.target.cost'),
    verdict: 'measured',
  };

  return {
    ...base,
    value: `${formatUsdMicro(rawValue)} ${usd}`,
    rawValue,
    verdict: 'measured',
    measuredAt: now.toISOString(),
    secondary,
    detailsAr: [
      // The headline's meaning: per document, or per day when no call carried a document.
      perDocument ? t('metrics.a3.per_document') : t('metrics.a3.per_day'),
      t('metrics.window_days', { n: COST_WINDOW_DAYS }),
      t('metrics.a3.total', {
        value: formatUsdMicro(totals.costUsdMicro),
        calls: formatNumber(totals.calls),
        documents: formatNumber(byDocument.length),
      }),
      t('metrics.a3.projection', { value: formatUsdMicro(projection.monthlyUsdMicro) }),
    ],
    details: [
      `window_days=${COST_WINDOW_DAYS}`,
      `calls=${totals.calls}`,
      `documents=${byDocument.length}`,
      `total_usd_micro=${totals.costUsdMicro.toString()}`,
      `per_document_usd_micro=${perDocumentMicro === null ? 'none' : perDocumentMicro.toString()}`,
      `per_day_usd_micro=${projection.dailyAverageUsdMicro.toString()}`,
      `monthly_usd_micro=${projection.monthlyUsdMicro.toString()}`,
      `headline=${perDocument ? 'per_document' : 'per_day'}`,
    ].join(';'),
  };
}

// ─── a4 · the PII effectiveness ─────────────────────────────────────────────

function readRate(value: unknown): number | null {
  return isFiniteNumber(value) && value >= 0 && value <= 1 ? round4(value) : null;
}

export function computePiiEffectiveness(runs: EvalRunLike[], now: Date): MetricCardView {
  const run = latestRunOfKind(runs, 'pii');
  const base = {
    assumption: 'a4' as const,
    labelAr: t('metrics.a4'),
    unit: 'percent' as const,
    targetAr: t('metrics.target.pii_names'),
    target: '>=0.90;>=0.95',
  };

  const json = run !== null && isRecord(run.detailsJson) ? run.detailsJson : {};
  const rates = isRecord(json.rates) ? json.rates : {};
  // Rates unreadable: names fall back to the run's score, structured stays unknown.
  const names = run === null ? null : (readRate(rates.names) ?? readRate(run.score));
  const structured = run === null ? null : readRate(rates.structured);

  if (run === null || names === null) {
    return {
      ...base,
      value: null,
      rawValue: null,
      verdict: 'no_data',
      measuredAt: null,
      secondary: null,
      detailsAr: [t('metrics.a4.no_run')],
      details: run === null ? 'run=none' : 'run=pii;names=none;structured=none',
    };
  }

  const secondary: MetricSecondaryView = {
    labelAr: t('metrics.a4.structured'),
    value: structured === null ? null : percentValue(structured),
    rawValue: structured,
    unit: 'percent',
    targetAr: t('metrics.target.pii_structured'),
    verdict: structured === null ? 'no_data' : verdictOf(structured, PII_STRUCTURED_TARGET),
  };

  const counts = isRecord(json.counts) ? json.counts : {};
  const sentences = isFiniteNumber(counts.sentences) ? counts.sentences : null;
  const leaks = Array.isArray(json.leaks) ? json.leaks.length : null;

  const detailsAr: string[] = [];
  if (sentences !== null) detailsAr.push(t('metrics.a4.sentences', { n: sentences }));
  if (leaks !== null) detailsAr.push(t('metrics.a4.leaks', { n: leaks }));

  const pairs = ['run=pii', `names=${names.toFixed(4)}`, `structured=${structured === null ? 'none' : structured.toFixed(4)}`];
  if (sentences !== null) pairs.push(`sentences=${sentences}`);
  if (leaks !== null) pairs.push(`leaks=${leaks}`);

  const met = names >= PII_NAMES_TARGET && structured !== null && structured >= PII_STRUCTURED_TARGET;

  return {
    ...base,
    value: percentValue(names),
    rawValue: names,
    verdict: met ? 'met' : 'not_met',
    measuredAt: runTimeIso(run, now),
    secondary,
    detailsAr,
    details: pairs.join(';'),
  };
}

// ─── a5 · the chat entry ────────────────────────────────────────────────────

interface FlowFields {
  flow: FlowType;
  correct: number;
  total: number;
  run: EvalRunLike;
}

/** Σ correct / Σ total over the `docs` of the flow's latest extract run; `null`
 *  when there is no run or no readable document. */
function fieldsOfFlow(runs: EvalRunLike[], flow: FlowType): FlowFields | null {
  const run = latestRunOfKind(runs, `extract:${flow}`);
  if (run === null || !isRecord(run.detailsJson) || !Array.isArray(run.detailsJson.docs)) return null;
  let correct = 0;
  let total = 0;
  let readable = 0;
  for (const doc of run.detailsJson.docs as unknown[]) {
    if (!isRecord(doc) || !isFiniteNumber(doc.correct) || !isFiniteNumber(doc.total)) continue;
    correct += doc.correct;
    total += doc.total;
    readable += 1;
  }
  return readable > 0 && total > 0 ? { flow, correct, total, run } : null;
}

interface FlowTime {
  flow: FlowType;
  medianMinutes: number;
  baselineMinutes: number;
  jobs: number;
}

/** The flow's latest valid baseline (minutes > 0), by `measuredAt`. */
function baselineOfFlow(baselines: BaselineLike[], flow: FlowType): number | null {
  let best: BaselineLike | null = null;
  for (const b of baselines) {
    if (b.flowType !== flow || !isFiniteNumber(b.minutes) || b.minutes <= 0) continue;
    if (best === null || b.measuredAt.getTime() > best.measuredAt.getTime()) best = b;
  }
  return best === null ? null : best.minutes;
}

function timeOfFlow(jobs: IntakeJobLike[], baselines: BaselineLike[], flow: FlowType): FlowTime | null {
  const baselineMinutes = baselineOfFlow(baselines, flow);
  if (baselineMinutes === null) return null;
  const durations = jobs
    .filter((job) => job.flowType === flow)
    .map((job) => Math.max(0, job.approvedAt.getTime() - job.createdAt.getTime()) / 60000)
    .filter((minutes) => Number.isFinite(minutes));
  if (durations.length === 0) return null;
  return { flow, medianMinutes: median(durations), baselineMinutes, jobs: durations.length };
}

function flowLabel(flow: FlowType): string {
  return t(`flow.${flow}` as ArKey);
}

export function computeChatEntry(
  runs: EvalRunLike[],
  jobs: IntakeJobLike[],
  baselines: BaselineLike[],
  now: Date,
): MetricCardView {
  const evaluated = FLOWS.flatMap((flow) => {
    const fields = fieldsOfFlow(runs, flow);
    return fields === null ? [] : [fields];
  });
  const sumCorrect = evaluated.reduce((sum, f) => sum + f.correct, 0);
  const sumTotal = evaluated.reduce((sum, f) => sum + f.total, 0);
  const fieldsRaw = sumTotal > 0 ? round4(sumCorrect / sumTotal) : null;

  const timed = FLOWS.flatMap((flow) => {
    const time = timeOfFlow(jobs, baselines, flow);
    return time === null ? [] : [time];
  });
  const sumMedians = timed.reduce((sum, f) => sum + f.medianMinutes, 0);
  const sumBaselines = timed.reduce((sum, f) => sum + f.baselineMinutes, 0);
  const ratioRaw = timed.length > 0 ? round4(sumMedians / sumBaselines) : null;

  const secondary: MetricSecondaryView = {
    labelAr: t('metrics.a5.time_ratio'),
    value: ratioRaw === null ? null : percentValue(ratioRaw),
    rawValue: ratioRaw,
    unit: 'ratio',
    targetAr: t('metrics.target.time_ratio'),
    verdict: ratioRaw === null ? 'no_data' : ratioRaw <= TIME_RATIO_TARGET ? 'met' : 'not_met',
  };

  const detailsAr: string[] = [t('metrics.a5.flows', { n: evaluated.length })];
  if (evaluated.length === 0) {
    detailsAr.push(t('metrics.a5.no_eval'));
  } else {
    for (const f of evaluated) {
      detailsAr.push(t('metrics.a5.flow_line', { flow: flowLabel(f.flow), correct: f.correct, total: f.total }));
    }
  }
  for (const f of timed) {
    detailsAr.push(
      t('metrics.a5.time_line', {
        flow: flowLabel(f.flow),
        minutes: formatNumber(round1(f.medianMinutes)),
        baseline: f.baselineMinutes,
        n: f.jobs,
      }),
    );
  }
  if (jobs.length === 0) detailsAr.push(t('metrics.a5.no_jobs'));
  else if (ratioRaw === null) detailsAr.push(t('metrics.a5.no_baseline'));

  const details = [
    `flows_evaluated=${evaluated.length}`,
    `fields_correct=${sumCorrect}`,
    `fields_total=${sumTotal}`,
    `fields=${fieldsRaw === null ? 'none' : fieldsRaw.toFixed(4)}`,
    `time_ratio=${ratioRaw === null ? 'none' : ratioRaw.toFixed(4)}`,
    `time_flows=${
      timed.length === 0
        ? 'none'
        : timed.map((f) => `${f.flow}:${f.medianMinutes.toFixed(1)}/${f.baselineMinutes}`).join('+')
    }`,
  ].join(';');

  const base = {
    assumption: 'a5' as const,
    labelAr: t('metrics.a5'),
    unit: 'percent' as const,
    targetAr: t('metrics.target.fields'),
    target: '>=0.90;<=0.3333',
    secondary,
    detailsAr,
    details,
  };

  if (fieldsRaw === null) {
    return { ...base, value: null, rawValue: null, verdict: 'no_data', measuredAt: null };
  }

  const latest = evaluated.map((f) => runTimeIso(f.run, now)).sort().at(-1) ?? now.toISOString();
  const met = fieldsRaw >= FIELDS_CORRECT_TARGET && ratioRaw !== null && ratioRaw <= TIME_RATIO_TARGET;

  return {
    ...base,
    value: percentValue(fieldsRaw),
    rawValue: fieldsRaw,
    verdict: met ? 'met' : 'not_met',
    measuredAt: latest,
  };
}

// ─── a6 · the onboarding ────────────────────────────────────────────────────

export function computeOnboardingCard(sessions: OnboardingSessionLike[], now: Date): MetricCardView {
  const metric = computeOnboardingMetric(sessions);
  const base = {
    assumption: 'a6' as const,
    labelAr: metric.labelAr,
    unit: 'minutes' as const,
    targetAr: t('metrics.target.onboarding'),
    target: '<=30',
    secondary: null,
  };

  if (metric.medianMinutes === null || metric.p90Minutes === null || metric.withinTargetShare === null) {
    return {
      ...base,
      value: null,
      rawValue: null,
      verdict: 'no_data',
      measuredAt: null,
      detailsAr: [t('metrics.a6.no_sessions')],
      details: `completed=0;open=${metric.open};median_minutes=none;p90_minutes=none;within_target=0`,
    };
  }

  const within = Math.round(metric.withinTargetShare * metric.completed);
  return {
    ...base,
    value: `${formatNumber(metric.medianMinutes)} ${t('metrics.unit.minutes')}`,
    rawValue: metric.medianMinutes,
    verdict: metric.verdict,
    measuredAt: now.toISOString(),
    detailsAr: [
      t('metrics.a6.completed', { n: metric.completed, open: metric.open }),
      t('metrics.a6.within', { n: within }),
      t('metrics.a6.p90', { value: metric.p90Minutes }),
    ],
    details: [
      `completed=${metric.completed}`,
      `open=${metric.open}`,
      `median_minutes=${metric.medianMinutes}`,
      `p90_minutes=${metric.p90Minutes}`,
      `within_target=${within}`,
    ].join(';'),
  };
}

// ─── the six cards ──────────────────────────────────────────────────────────

export function computeMetrics(input: MetricsInput, opts: { now: Date; npiOrgId: string }): MetricsView {
  const { now, npiOrgId } = opts;
  return {
    generatedAt: now.toISOString(),
    npiOrgId,
    cards: [
      computeDailyReturn(input.dailyUsage, input.dailyWindow, now),
      computeMemoryAccuracy(input.evalRuns, now),
      computeInferenceCost(input.usage, now),
      computePiiEffectiveness(input.evalRuns, now),
      computeChatEntry(input.evalRuns, input.intakeJobs, input.baselines, now),
      computeOnboardingCard(input.onboardingSessions, now),
    ],
  };
}
