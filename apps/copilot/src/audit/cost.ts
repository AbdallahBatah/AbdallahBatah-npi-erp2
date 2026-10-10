// The usage counter (T-34, F-18): tokens and cost per document / flow /
// Riyadh day / tier / user over `llm_audit` rows, the monthly projection
// (spec/madar/01 §7 row ٣), and the daily token cap's arithmetic
// (02 §10 `COPILOT_DAILY_TOKEN_CAP`). Everything here is pure — no I/O, no
// clock, no environment — so `src/llm/client.ts` (the gate), the readers in
// `src/queries/usage.ts` and the tests share one definition of "a day", "a
// flow" and "reached".
//
// Money is a `bigint` of micro-USD throughout (`src/llm/pricing.ts`); the
// `*View` shapes carry decimal strings for JSON.
import { t } from '../i18n/ar';
import {
  USAGE_FLOWS,
  USAGE_TIERS,
  type CapStatus,
  type UsageBucket,
  type UsageBucketView,
  type UsageFlow,
  type UsagePeriod,
  type UsageProjection,
  type UsageReport,
  type UsageReportView,
  type UsageRowLike,
  type UsageTier,
  type UsageTotals,
} from './usage-types';

export type { UsageFlow, UsageTier } from './usage-types';

// ─── the day ────────────────────────────────────────────────────────────────

/** Asia/Riyadh is UTC+3 with no daylight saving, so a fixed offset is exact. */
export const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The Riyadh calendar day of `now` as a date-only value: UTC midnight of
 *  that day, which is how `daily_usage.day` (`@db.Date`) is keyed. */
export function riyadhDay(now: Date): Date {
  const shifted = new Date(now.getTime() + RIYADH_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
}

/** `YYYY-MM-DD` of the Riyadh calendar day of `now`. */
export function riyadhDayKey(now: Date): string {
  return riyadhDay(now).toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` of a date-only value as `daily_usage.day` comes back from
 *  Prisma (UTC midnight) — no offset is applied, the value already IS the day. */
export function dayKeyOf(day: Date): string {
  return day.toISOString().slice(0, 10);
}

/** The absolute bounds of the Riyadh calendar day containing `now`:
 *  `[21:00Z of the previous UTC day, 21:00Z of this one)`. */
export function riyadhDayPeriod(now: Date): UsagePeriod {
  const from = riyadhDay(now).getTime() - RIYADH_OFFSET_MS;
  return { from: new Date(from), to: new Date(from + DAY_MS) };
}

/** The last `days` Riyadh calendar days ending with today (inclusive):
 *  `days = 1` is `riyadhDayPeriod(now)`, `days = 7` starts six days earlier.
 *  `days` below 1 is treated as 1. */
export function riyadhTrailingPeriod(now: Date, days: number): UsagePeriod {
  const today = riyadhDayPeriod(now);
  const count = Math.max(1, Math.trunc(days));
  return { from: new Date(today.from.getTime() - (count - 1) * DAY_MS), to: today.to };
}

/** The number of Riyadh calendar days a half-open period touches, at least 1
 *  (an empty or inverted period still counts as one day, so a projection
 *  never divides by zero). */
export function riyadhDayCount(period: UsagePeriod): number {
  const lastInstant = new Date(Math.max(period.from.getTime(), period.to.getTime() - 1));
  const first = riyadhDay(period.from).getTime();
  const last = riyadhDay(lastInstant).getTime();
  return Math.max(1, Math.round((last - first) / DAY_MS) + 1);
}

// ─── the flow ───────────────────────────────────────────────────────────────

const EXTRACT_EVENT = /^extract_(customer_contract|pr|po|grn|vendor_bill)(?:_edit)?$/;

/** Maps `llm_audit.event` to a `UsageFlow`; an event the mapping does not
 *  know lands in `other`, never dropped. */
export function flowOfEvent(event: string): UsageFlow {
  const extract = EXTRACT_EVENT.exec(event);
  if (extract) return extract[1] as UsageFlow;
  switch (event) {
    case 'chat':
      return 'chat';
    case 'setup_parse':
      return 'setup';
    case 'memory_extract':
      return 'memory';
    case 'handover_narrative':
      return 'handover';
    default:
      return 'other';
  }
}

/** The Arabic label of a flow: the five document flows reuse `flow.*`
 *  (03 §4), the rest come from the «T-34 additions» block. */
export function usageFlowLabelAr(flow: UsageFlow): string {
  switch (flow) {
    case 'customer_contract':
      return t('flow.customer_contract');
    case 'pr':
      return t('flow.pr');
    case 'po':
      return t('flow.po');
    case 'grn':
      return t('flow.grn');
    case 'vendor_bill':
      return t('flow.vendor_bill');
    case 'chat':
      return t('usage.flow.chat');
    case 'setup':
      return t('usage.flow.setup');
    case 'memory':
      return t('usage.flow.memory');
    case 'handover':
      return t('usage.flow.handover');
    case 'other':
      return t('usage.flow.other');
  }
}

export function isUsageTier(value: string | null): value is UsageTier {
  return value === 'economy' || value === 'advanced';
}

// ─── aggregation ────────────────────────────────────────────────────────────

export const PROJECTION_MONTH_DAYS = 30;

function emptyBucket(key: string): UsageBucket {
  return { key, calls: 0, tokensIn: 0, tokensOut: 0, costUsdMicro: 0n };
}

function addTo(map: Map<string, UsageBucket>, key: string, row: UsageRowLike): void {
  const bucket = map.get(key) ?? emptyBucket(key);
  bucket.calls += 1;
  bucket.tokensIn += row.tokensIn;
  bucket.tokensOut += row.tokensOut;
  bucket.costUsdMicro += row.costUsdMicro;
  map.set(key, bucket);
}

function byKeyAsc(a: UsageBucket, b: UsageBucket): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function byCostDescThenKey(a: UsageBucket, b: UsageBucket): number {
  if (a.costUsdMicro !== b.costUsdMicro) return a.costUsdMicro > b.costUsdMicro ? -1 : 1;
  return byKeyAsc(a, b);
}

/**
 * Folds `llm_audit` rows into one report. Rows outside `period` (half-open
 * `[from, to)`) are ignored, so a caller may hand over more than it asked
 * for. A row with a `modelId` is a model call and lands in every breakdown
 * it has a key for; a system row (`cap_reached`, `refused_confidential`,
 * `intake_executed`, …) carries no tokens and no cost and is counted in
 * `totals.capReached` / `totals.errors` only.
 */
export function aggregateUsage(rows: Iterable<UsageRowLike>, period: UsagePeriod): UsageReport {
  const totals: UsageTotals = { calls: 0, errors: 0, capReached: 0, tokensIn: 0, tokensOut: 0, costUsdMicro: 0n };
  const days = new Map<string, UsageBucket>();
  const tiers = new Map<string, UsageBucket>(USAGE_TIERS.map((tier) => [tier, emptyBucket(tier)]));
  const flows = new Map<string, UsageBucket>();
  const documents = new Map<string, UsageBucket>();
  const users = new Map<string, UsageBucket>();

  const fromMs = period.from.getTime();
  const toMs = period.to.getTime();

  for (const row of rows) {
    const ts = row.ts.getTime();
    if (ts < fromMs || ts >= toMs) continue;

    if (row.error !== null) totals.errors += 1;
    if (row.event === 'cap_reached') totals.capReached += 1;
    if (row.modelId === null) continue;

    totals.calls += 1;
    totals.tokensIn += row.tokensIn;
    totals.tokensOut += row.tokensOut;
    totals.costUsdMicro += row.costUsdMicro;

    addTo(days, riyadhDayKey(row.ts), row);
    if (isUsageTier(row.modelTier)) addTo(tiers, row.modelTier, row);
    addTo(flows, flowOfEvent(row.event), row);
    if (row.documentId !== null) addTo(documents, row.documentId, row);
    addTo(users, row.npiUserId, row);
  }

  const windowDays = riyadhDayCount(period);
  const projection: UsageProjection = {
    windowDays,
    dailyAverageUsdMicro: totals.costUsdMicro / BigInt(windowDays),
    monthlyUsdMicro: (totals.costUsdMicro * BigInt(PROJECTION_MONTH_DAYS)) / BigInt(windowDays),
  };

  return {
    period: { from: new Date(fromMs), to: new Date(toMs) },
    totals,
    byDay: [...days.values()].sort(byKeyAsc),
    byTier: USAGE_TIERS.map((tier) => tiers.get(tier) ?? emptyBucket(tier)),
    byFlow: USAGE_FLOWS.flatMap((flow) => {
      const bucket = flows.get(flow);
      return bucket ? [bucket] : [];
    }),
    byDocument: [...documents.values()].sort(byCostDescThenKey),
    byUser: [...users.values()].sort(byCostDescThenKey),
    projection,
  };
}

function bucketView(bucket: UsageBucket): UsageBucketView {
  return { ...bucket, costUsdMicro: bucket.costUsdMicro.toString() };
}

/** JSON-safe copy: every bigint a decimal string, every Date an ISO string. */
export function serializeUsageReport(report: UsageReport): UsageReportView {
  return {
    period: { from: report.period.from.toISOString(), to: report.period.to.toISOString() },
    totals: { ...report.totals, costUsdMicro: report.totals.costUsdMicro.toString() },
    byDay: report.byDay.map(bucketView),
    byTier: report.byTier.map(bucketView),
    byFlow: report.byFlow.map(bucketView),
    byDocument: report.byDocument.map(bucketView),
    byUser: report.byUser.map(bucketView),
    projection: {
      windowDays: report.projection.windowDays,
      dailyAverageUsdMicro: report.projection.dailyAverageUsdMicro.toString(),
      monthlyUsdMicro: report.projection.monthlyUsdMicro.toString(),
    },
  };
}

// ─── the cap ────────────────────────────────────────────────────────────────

/** The message the gate returns when the cap is reached
 *  (`LlmError('cap_reached').messageAr`) — one string, defined once. */
export const CAP_REACHED_MESSAGE_AR = t('usage.cap.reached');

/**
 * One user's standing against the daily cap. `usage` is the day's
 * `daily_usage` row (`null` without one). The comparison is the gate's own:
 * `used >= cap` blocks the next call, so a user who lands exactly on the cap
 * is reported as reached — which is what the next attempt will find.
 */
export function capStatus(
  usage: { tokensIn: number; tokensOut: number } | null,
  cap: number,
  day: Date,
): CapStatus {
  const used = usage ? usage.tokensIn + usage.tokensOut : 0;
  const reached = used >= cap;
  return {
    day: dayKeyOf(day),
    cap,
    used,
    remaining: Math.max(0, cap - used),
    share: cap > 0 ? Math.min(1, used / cap) : 1,
    reached,
    messageAr: reached ? CAP_REACHED_MESSAGE_AR : null,
  };
}
