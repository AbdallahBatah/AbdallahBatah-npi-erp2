// Helpers shared by the session endpoints (`./route.ts`: login / session /
// legacy logout; `./logout/route.ts`: the logout the browser calls). Not a
// route file itself — Next only treats `route.ts` as one.
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { parseKey } from '@/crypto/aead';
import { getDb } from '@/db';
import { createNpiClient } from '@/npi/client';
import type { SessionDeps } from '@/auth/session';
import type { RateLimitDb } from '@/auth/ratelimit';

/** Every response from these routes: never cached by a browser or a proxy —
 *  it always carries session-dependent, security-sensitive state. */
export const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };

export function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

/**
 * `getDb()`'s real `PrismaClient` return value satisfies both `SessionDb`
 * (used for `SessionDeps.db`) and `RateLimitDb` (used directly for
 * `isBlocked`/`recordAttempt`) — one connection, two narrower structural
 * views of it, cast explicitly since the two view types are unrelated to
 * each other.
 */
export function buildDeps(): SessionDeps & { rateLimitDb: RateLimitDb } {
  const db = getDb();
  return {
    db,
    key: parseKey(process.env.COPILOT_SESSION_KEY),
    npiFor: (token: string) => createNpiClient({ token }),
    rateLimitDb: db as unknown as RateLimitDb,
  };
}

/**
 * Rejects a cross-origin write: `Origin`, when the browser sends one (every
 * modern browser does on a POST fetch), must match the request's own `Host`.
 * A same-origin request from this app's own login form never sends a
 * mismatched Origin; a form or script hosted elsewhere would.
 */
export function originMismatch(): boolean {
  const h = headers();
  const origin = h.get('origin');
  if (!origin) return false;
  const host = h.get('host');
  try {
    return new URL(origin).host !== host;
  } catch {
    return true; // an unparsable Origin header is treated as a mismatch
  }
}
