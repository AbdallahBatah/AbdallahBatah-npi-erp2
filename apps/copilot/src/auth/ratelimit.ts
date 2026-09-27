// DB-backed login rate limiting — 5 failed attempts per 15 minutes per key.
//
// The key is a SHA-256 hash of the trimmed, lower-cased e-mail: a stranger's
// e-mail address is never stored in clear in `login_attempts` (see
// `apps/copilot/prisma/schema.prisma`, model `LoginAttempt`).
//
// This module deliberately exposes two separate primitives (`isBlocked`,
// `recordAttempt`) rather than one combined "attempt" call: the caller
// (`src/app/api/auth/route.ts`) must check `isBlocked` BEFORE calling NPI,
// and must never call `recordAttempt` for an attempt that was already
// blocked — recording it would push the window forward on every subsequent
// try and extend the lock forever. That discipline lives in the route, not
// here, because only the route knows whether NPI was actually called.
import { createHash } from 'crypto';

const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000;
const PRUNE_AGE_MS = 24 * 60 * 60 * 1000;

/** SHA-256 hex digest of the trimmed, lower-cased e-mail. */
export function rateLimitKey(email: string): string {
  const normalized = email.trim().toLowerCase();
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

export interface LoginAttemptRow {
  attemptedAt: Date;
  succeeded: boolean;
}

/**
 * Minimal structural subset of the Prisma client's `loginAttempt` delegate.
 * Typed structurally (not imported from the generated client at runtime) so
 * a small in-memory fake can satisfy it in tests.
 */
export interface RateLimitDb {
  loginAttempt: {
    findMany(args: { where: { key: string } }): Promise<LoginAttemptRow[]>;
    create(args: { data: { key: string; succeeded: boolean; attemptedAt: Date } }): Promise<unknown>;
    deleteMany(args: { where: { key: string; attemptedAt: { lt: Date } } }): Promise<unknown>;
  };
}

export interface RateLimitDeps {
  db: RateLimitDb;
  now?: () => Date;
}

function resolveNow(deps: RateLimitDeps): Date {
  return (deps.now ?? (() => new Date()))();
}

/**
 * Blocked when the count of failures since the LATER of (window start, most
 * recent success) reaches `MAX_FAILURES`. Recomputed fresh from the raw rows
 * on every call — no separate counter to keep in sync, and a success always
 * wins over failures older than it.
 */
export async function isBlocked(deps: RateLimitDeps, key: string): Promise<boolean> {
  const now = resolveNow(deps);
  const windowStart = new Date(now.getTime() - WINDOW_MS);

  const rows = await deps.db.loginAttempt.findMany({ where: { key } });
  const sorted = [...rows].sort((a, b) => b.attemptedAt.getTime() - a.attemptedAt.getTime());

  let failures = 0;
  for (const row of sorted) {
    if (row.attemptedAt < windowStart) break; // everything older is out of the window
    if (row.succeeded) break; // the most recent success resets the count
    failures += 1;
  }
  return failures >= MAX_FAILURES;
}

/**
 * Records one attempt and prunes rows for this key older than 24 hours. The
 * caller must not invoke this for an attempt that `isBlocked` already
 * rejected (see the file-top note).
 */
export async function recordAttempt(deps: RateLimitDeps, key: string, succeeded: boolean): Promise<void> {
  const now = resolveNow(deps);
  await deps.db.loginAttempt.create({ data: { key, succeeded, attemptedAt: now } });
  const pruneBefore = new Date(now.getTime() - PRUNE_AGE_MS);
  await deps.db.loginAttempt.deleteMany({ where: { key, attemptedAt: { lt: pruneBefore } } });
}
