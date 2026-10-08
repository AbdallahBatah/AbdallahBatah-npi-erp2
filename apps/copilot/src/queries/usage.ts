// The usage counter's readers (T-34, F-18 «عدّاد الرموز والكلفة لكل مستند
// ويوم»; spec/madar/01 §7 row ٣, 02 §10 «per-user daily token cap», 07
// G-M4-3). They fetch rows from the copilot's own database and hand them to
// the pure functions in `src/audit/cost.ts`; every breakdown comes from
// `llm_audit`, and only the cap and the per-user-per-day accumulator come
// from `daily_usage`.
//
// Rules this file enforces:
//   - Own organization only: `npiOrgId` is in the `where` of every
//     `llm_audit` / `daily_usage` read it makes — never a post-filter, never
//     an `undefined` key. (The cap read is keyed by the caller's own user id,
//     `daily_usage` being unique per user and day.)
//   - Read only. No model call, no NPI call, no write, no environment read:
//     the token cap arrives as a number argument (the caller passes
//     `dailyTokenCap(process.env)` from `src/llm/client.ts`).
import {
  aggregateUsage,
  capStatus,
  dayKeyOf,
  riyadhDay,
} from '../audit/cost';
import type {
  CapStatus,
  DailyUsageRowView,
  UsageBucket,
  UsagePeriod,
  UsageReport,
  UsageRowLike,
  UsageTotals,
} from '../audit/usage-types';

// ─── Structural db (the LlmDb / AuditQueryDb pattern) ──────────────────────

/** The columns of `llm_audit` the counter reads — exactly `UsageRowLike`. */
export const USAGE_AUDIT_SELECT = {
  ts: true,
  npiUserId: true,
  event: true,
  modelTier: true,
  modelId: true,
  tokensIn: true,
  tokensOut: true,
  costUsdMicro: true,
  documentId: true,
  error: true,
} as const;

/** The `where` shape of the `llm_audit` reads: always carries `npiOrgId`. */
export interface UsageAuditWhere {
  npiOrgId: string;
  ts?: { gte: Date; lt: Date };
  npiUserId?: string;
  documentId?: string;
}

/** The `where` shape of the `daily_usage` range read. */
export interface DailyUsageWhere {
  npiOrgId: string;
  day: { gte: Date; lt: Date };
}

export const DAILY_USAGE_SELECT = {
  npiUserId: true,
  day: true,
  messageCount: true,
  tokensIn: true,
  tokensOut: true,
  costUsdMicro: true,
} as const;

export interface DailyUsageRowLike {
  npiUserId: string;
  day: Date;
  messageCount: number;
  tokensIn: number;
  tokensOut: number;
  costUsdMicro: bigint;
}

/** Structural subset of the copilot's Prisma client (the `LlmDb` /
 *  `AuditQueryDb` pattern): the real client satisfies it, so does a fake. */
export interface UsageDb {
  llmAudit: {
    findMany(args: {
      where: UsageAuditWhere;
      orderBy: { ts: 'asc' };
      select: typeof USAGE_AUDIT_SELECT;
    }): Promise<UsageRowLike[]>;
  };
  dailyUsage: {
    findUnique(args: {
      where: { npiUserId_day: { npiUserId: string; day: Date } };
      select: { tokensIn: true; tokensOut: true };
    }): Promise<{ tokensIn: number; tokensOut: number } | null>;
    findMany(args: {
      where: DailyUsageWhere;
      orderBy: [{ day: 'asc' }, { npiUserId: 'asc' }];
      select: typeof DAILY_USAGE_SELECT;
    }): Promise<DailyUsageRowLike[]>;
  };
}

export interface UsageScope {
  npiOrgId: string;
  /** Narrows the report to one employee. */
  npiUserId?: string;
}

export interface DocumentUsage {
  documentId: string;
  totals: UsageTotals;
  byDay: UsageBucket[];
  byTier: UsageBucket[];
  byFlow: UsageBucket[];
  /** First and last model attempt on the document; null when none. */
  firstTs: Date | null;
  lastTs: Date | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ─── readers ────────────────────────────────────────────────────────────────

/** Tokens and cost of an organization (or one of its users) over a period:
 *  per day / tier / flow / document / user, with the monthly projection. */
export async function loadUsageReport(
  db: UsageDb,
  scope: UsageScope,
  period: UsagePeriod,
): Promise<UsageReport> {
  const where: UsageAuditWhere = {
    npiOrgId: scope.npiOrgId,
    ts: { gte: period.from, lt: period.to },
    ...(scope.npiUserId ? { npiUserId: scope.npiUserId } : {}),
  };
  const rows = await db.llmAudit.findMany({ where, orderBy: { ts: 'asc' }, select: USAGE_AUDIT_SELECT });
  return aggregateUsage(rows, period);
}

/** One document's counter over its whole life (no time bound). */
export async function loadDocumentUsage(
  db: UsageDb,
  scope: { npiOrgId: string; documentId: string },
): Promise<DocumentUsage> {
  const rows = await db.llmAudit.findMany({
    where: { npiOrgId: scope.npiOrgId, documentId: scope.documentId },
    orderBy: { ts: 'asc' },
    select: USAGE_AUDIT_SELECT,
  });

  const first = rows[0];
  const last = rows[rows.length - 1];
  if (first === undefined || last === undefined) {
    const empty = aggregateUsage([], { from: new Date(0), to: new Date(0) });
    return {
      documentId: scope.documentId,
      totals: empty.totals,
      byDay: empty.byDay,
      byTier: empty.byTier,
      byFlow: empty.byFlow,
      firstTs: null,
      lastTs: null,
    };
  }

  const report = aggregateUsage(rows, { from: first.ts, to: new Date(last.ts.getTime() + 1) });
  return {
    documentId: scope.documentId,
    totals: report.totals,
    byDay: report.byDay,
    byTier: report.byTier,
    byFlow: report.byFlow,
    firstTs: first.ts,
    lastTs: last.ts,
  };
}

/** One user's standing against the daily token cap on the Riyadh day of
 *  `now`. The cap is a parameter — this module never reads the environment. */
export async function loadCapStatus(
  db: UsageDb,
  input: { npiUserId: string; cap: number; now: Date },
): Promise<CapStatus> {
  const day = riyadhDay(input.now);
  const row = await db.dailyUsage.findUnique({
    where: { npiUserId_day: { npiUserId: input.npiUserId, day } },
    select: { tokensIn: true, tokensOut: true },
  });
  return capStatus(row, input.cap, day);
}

/** The per-user-per-day accumulator rows of the Riyadh calendar days the
 *  period touches. Not used for the cost breakdowns (those come from
 *  `llm_audit`); `messageCount` is read from here. */
export async function loadDailyUsage(
  db: UsageDb,
  scope: { npiOrgId: string },
  period: UsagePeriod,
): Promise<DailyUsageRowView[]> {
  const dayFrom = riyadhDay(period.from);
  const lastInstant = new Date(Math.max(period.from.getTime(), period.to.getTime() - 1));
  const dayTo = new Date(riyadhDay(lastInstant).getTime() + DAY_MS);

  const rows = await db.dailyUsage.findMany({
    where: { npiOrgId: scope.npiOrgId, day: { gte: dayFrom, lt: dayTo } },
    orderBy: [{ day: 'asc' }, { npiUserId: 'asc' }],
    select: DAILY_USAGE_SELECT,
  });

  return rows.map((row) => ({
    npiUserId: row.npiUserId,
    day: dayKeyOf(row.day),
    messageCount: row.messageCount,
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    costUsdMicro: String(row.costUsdMicro),
  }));
}
