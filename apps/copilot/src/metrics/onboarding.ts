// Computes assumption a6 «التشكّل الذاتي» — from the first setup question to
// a configured system, in ≤ 30 minutes (spec/madar/01-PRD.md §1 row ٦,
// measured from the `onboarding_sessions` table per 01 §7). T-20 needs this
// for its own acceptance check; T-35 reuses it as one of the six a1–a6 cards
// on `/metrics` and in the CSV export (spec/madar/05-IMPLEMENTATION-PLAN.md).
//
// `computeOnboardingMetric` is pure — no I/O, no clock — so T-20's e2e test
// and T-35's screen can both feed it rows read however they read them.
// `loadOnboardingMetric` is the one place that touches the database, through
// a structural subset of the copilot's own Prisma client (never NPI's —
// onboarding sessions live in the copilot's database, not NPI's).
import { t } from '../i18n/ar';

export const ONBOARDING_TARGET_MINUTES = 30;

/** The columns of `onboarding_sessions` the metric reads. */
export interface OnboardingSessionLike {
  npiOrgId: string;
  startedAt: Date;
  completedAt: Date | null;
  profileChosen: string | null;
}

export interface OnboardingProfileMetric {
  completed: number;
  medianMinutes: number | null;
  withinTarget: number; // count of completed sessions <= target
}

export interface OnboardingMetric {
  assumption: 'a6';
  labelAr: string; // t('metrics.a6')
  targetMinutes: number;
  completed: number; // sessions with completedAt
  open: number; // sessions without completedAt
  medianMinutes: number | null; // over completed; null when none
  p90Minutes: number | null;
  maxMinutes: number | null;
  withinTargetShare: number | null; // 0..1 over completed; null when none
  byProfile: Record<string, OnboardingProfileMetric>; // key = profileChosen ?? 'unknown'
  verdict: 'met' | 'not_met' | 'no_data';
}

/**
 * Minutes from `startedAt` to `completedAt`, rounded to 1 decimal. `null`
 * when the session has not completed. A negative span (clock skew between
 * the two timestamps) is clamped to 0 rather than reported as a negative
 * duration.
 */
export function sessionMinutes(s: OnboardingSessionLike): number | null {
  if (s.completedAt === null) return null;
  const rawMs = s.completedAt.getTime() - s.startedAt.getTime();
  const minutes = Math.max(0, rawMs) / 60000;
  return Math.round(minutes * 10) / 10;
}

/** Nearest-rank percentile over an already-sorted ascending array (p90). */
function percentile(sorted: readonly number[], p: number): number {
  const index = Math.ceil(p * sorted.length) - 1;
  const clamped = Math.min(sorted.length - 1, Math.max(0, index));
  return sorted[clamped];
}

/** The conventional median: the middle value, or the mean of the two middle
 *  values when the count is even — never the lower one, so two sessions of
 *  25 and 45 minutes read as 35 (not met), not 25. */
function median(sorted: readonly number[]): number {
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function summarize(durations: readonly number[]): {
  medianMinutes: number | null;
  p90Minutes: number | null;
  maxMinutes: number | null;
} {
  if (durations.length === 0) {
    return { medianMinutes: null, p90Minutes: null, maxMinutes: null };
  }
  const sorted = [...durations].sort((a, b) => a - b);
  return {
    medianMinutes: round1(median(sorted)),
    p90Minutes: round1(percentile(sorted, 0.9)),
    maxMinutes: round1(sorted[sorted.length - 1]),
  };
}

export function computeOnboardingMetric(
  sessions: readonly OnboardingSessionLike[],
  options?: { targetMinutes?: number },
): OnboardingMetric {
  const targetMinutes = options?.targetMinutes ?? ONBOARDING_TARGET_MINUTES;

  const completedDurations: number[] = [];
  let openCount = 0;
  const byProfileDurations = new Map<string, number[]>();

  for (const s of sessions) {
    const minutes = sessionMinutes(s);
    if (minutes === null) {
      openCount += 1;
      continue;
    }
    completedDurations.push(minutes);
    const profileKey = s.profileChosen ?? 'unknown';
    const bucket = byProfileDurations.get(profileKey) ?? [];
    bucket.push(minutes);
    byProfileDurations.set(profileKey, bucket);
  }

  const { medianMinutes, p90Minutes, maxMinutes } = summarize(completedDurations);
  const withinTargetCount = completedDurations.filter((m) => m <= targetMinutes).length;
  const withinTargetShare =
    completedDurations.length === 0 ? null : withinTargetCount / completedDurations.length;

  const byProfile: Record<string, OnboardingProfileMetric> = {};
  for (const [profileKey, durations] of byProfileDurations) {
    const profileSummary = summarize(durations);
    byProfile[profileKey] = {
      completed: durations.length,
      medianMinutes: profileSummary.medianMinutes,
      withinTarget: durations.filter((m) => m <= targetMinutes).length,
    };
  }

  // The median is the headline figure: one admin who leaves the setup tab
  // open overnight (a multi-hour outlier) must not single-handedly flip
  // this assumption from met to not-met. `maxMinutes` and
  // `withinTargetShare` stay on the metric so the /metrics screen (T-35)
  // can still show that spread even though the verdict ignores it.
  const verdict: OnboardingMetric['verdict'] =
    completedDurations.length === 0 ? 'no_data' : medianMinutes! <= targetMinutes ? 'met' : 'not_met';

  return {
    assumption: 'a6',
    labelAr: t('metrics.a6'),
    targetMinutes,
    completed: completedDurations.length,
    open: openCount,
    medianMinutes,
    p90Minutes,
    maxMinutes,
    withinTargetShare,
    byProfile,
    verdict,
  };
}

/** Structural subset of the copilot Prisma client (never NPI's). */
export interface OnboardingMetricsDb {
  onboardingSession: {
    findMany(args: {
      where?: { npiOrgId?: string };
      select: { npiOrgId: true; startedAt: true; completedAt: true; profileChosen: true };
    }): Promise<OnboardingSessionLike[]>;
  };
}

export async function loadOnboardingMetric(
  db: OnboardingMetricsDb,
  options?: { npiOrgId?: string; targetMinutes?: number },
): Promise<OnboardingMetric> {
  const sessions = await db.onboardingSession.findMany({
    ...(options?.npiOrgId !== undefined ? { where: { npiOrgId: options.npiOrgId } } : {}),
    select: { npiOrgId: true, startedAt: true, completedAt: true, profileChosen: true },
  });
  return computeOnboardingMetric(sessions, { targetMinutes: options?.targetMinutes });
}
