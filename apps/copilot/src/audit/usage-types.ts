// Shared shapes of the usage counter (T-34, F-18 «عدّاد الرموز والكلفة لكل
// مستند ويوم», spec/madar/01 §7 row ٣ «سجل التدقيق: رموز وكلفة لكل
// مستند/تدفق/يوم؛ إسقاط شهري», 02 §10 «per-user daily token cap
// COPILOT_DAILY_TOKEN_CAP», 05 §M4 row T-34, 07 G-M4-3). TYPES ONLY — no
// server imports — so a client component can `import type` from here the
// way `src/components/trust/api.ts` imports from `@/audit/types`.
//
// Source of truth: `llm_audit` holds one row per model attempt (tokens, cost
// in micro-USD, tier, event, document) and one row per event that never
// called a model (`cap_reached` among them); `daily_usage` is the per-user,
// per-Riyadh-day accumulator the cap is checked against. The counter reads
// the former for every breakdown and the latter for the cap, so what the
// screen says about the cap is exactly what the gate in `src/llm/client.ts`
// decided.

/** The two tiers of `RedactedRequest.tier` (`src/llm/provider.ts`). */
export type UsageTier = 'economy' | 'advanced';

export const USAGE_TIERS: readonly UsageTier[] = ['economy', 'advanced'];

/**
 * The flows a model call belongs to, derived from `llm_audit.event`:
 * the five document flows (`extract_<flow>` and `extract_<flow>_edit`,
 * written by `src/extract/run.ts`), `chat` (the assistant turn and its tool
 * rounds), `setup` (`setup_parse`), `memory` (`memory_extract`), `handover`
 * (`handover_narrative`), and `other` for any event the mapping does not
 * know — never dropped. Order = display order.
 */
export const USAGE_FLOWS = [
  'customer_contract',
  'pr',
  'po',
  'grn',
  'vendor_bill',
  'chat',
  'setup',
  'memory',
  'handover',
  'other',
] as const;

export type UsageFlow = (typeof USAGE_FLOWS)[number];

/** The columns of `llm_audit` the counter reads. A structural subset so the
 *  pure functions take Prisma rows, test fixtures and fake-db rows alike. */
export interface UsageRowLike {
  ts: Date;
  npiUserId: string;
  event: string;
  modelTier: string | null;
  modelId: string | null;
  tokensIn: number;
  tokensOut: number;
  costUsdMicro: bigint;
  documentId: string | null;
  error: string | null;
}

/** One cell of a breakdown: the model calls of one day / tier / flow /
 *  document / user and what they cost. `calls` counts rows with a `modelId`
 *  (a provider was asked, whether or not it answered); system rows carry no
 *  tokens and no cost and are counted in `UsageTotals` only. */
export interface UsageBucket {
  key: string;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costUsdMicro: bigint;
}

export interface UsageTotals {
  /** Rows with a `modelId` (model attempts). */
  calls: number;
  /** Rows with `error` set — failed model attempts and failed executions alike. */
  errors: number;
  /** `cap_reached` rows: attempts the gate refused before anything was sent. */
  capReached: number;
  tokensIn: number;
  tokensOut: number;
  costUsdMicro: bigint;
}

/**
 * The monthly projection of `01` §7 row ٣: the window's average cost per
 * Riyadh calendar day, times a fixed 30-day month. `windowDays` is the number
 * of Riyadh calendar days the period touches (at least 1), not the number of
 * days with traffic — an idle week lowers the projection, as it should.
 */
export interface UsageProjection {
  windowDays: number;
  dailyAverageUsdMicro: bigint;
  monthlyUsdMicro: bigint;
}

/** Half-open period `[from, to)` in absolute time. */
export interface UsagePeriod {
  from: Date;
  to: Date;
}

export interface UsageReport {
  period: UsagePeriod;
  totals: UsageTotals;
  /** Key `YYYY-MM-DD` of the Riyadh calendar day, ascending; days without
   *  traffic are absent. */
  byDay: UsageBucket[];
  /** Always both tiers, in `USAGE_TIERS` order, zeros when none. A model row
   *  whose `modelTier` is neither (cannot be written today) counts in
   *  `totals` only. */
  byTier: UsageBucket[];
  /** Non-empty flows only, in `USAGE_FLOWS` order. */
  byFlow: UsageBucket[];
  /** Key = `documentId`; rows without a document are not here. Cost
   *  descending, then key ascending. */
  byDocument: UsageBucket[];
  /** Key = `npiUserId`. Cost descending, then key ascending. */
  byUser: UsageBucket[];
  projection: UsageProjection;
}

// ─── JSON-safe views (bigint → decimal string, Date → ISO) ──────────────────

export interface UsageBucketView {
  key: string;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costUsdMicro: string;
}

export interface UsageTotalsView {
  calls: number;
  errors: number;
  capReached: number;
  tokensIn: number;
  tokensOut: number;
  costUsdMicro: string;
}

export interface UsageProjectionView {
  windowDays: number;
  dailyAverageUsdMicro: string;
  monthlyUsdMicro: string;
}

export interface UsageReportView {
  period: { from: string; to: string };
  totals: UsageTotalsView;
  byDay: UsageBucketView[];
  byTier: UsageBucketView[];
  byFlow: UsageBucketView[];
  byDocument: UsageBucketView[];
  byUser: UsageBucketView[];
  projection: UsageProjectionView;
}

// ─── the cap ────────────────────────────────────────────────────────────────

/** One user's standing against the daily token cap on one Riyadh day. The
 *  arithmetic is the gate's own (`used >= cap` blocks), so the counter and
 *  the refusal can never disagree. */
export interface CapStatus {
  /** `YYYY-MM-DD`, the Riyadh calendar day the figures belong to. */
  day: string;
  /** The cap in tokens (`COPILOT_DAILY_TOKEN_CAP`, default 600,000). */
  cap: number;
  /** `tokensIn + tokensOut` of the day's `daily_usage` row, 0 without one. */
  used: number;
  /** `max(0, cap - used)`. */
  remaining: number;
  /** 0…1, `used / cap` clamped. */
  share: number;
  reached: boolean;
  /** `t('usage.cap.reached')` when reached, else `null`. */
  messageAr: string | null;
}

/** One `daily_usage` row as read back: per user per Riyadh day. */
export interface DailyUsageRowView {
  npiUserId: string;
  /** `YYYY-MM-DD`. */
  day: string;
  messageCount: number;
  tokensIn: number;
  tokensOut: number;
  costUsdMicro: string;
}
