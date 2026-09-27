// Login/session/logout endpoint. Node runtime (not edge): it needs Prisma
// (via getDb()) and the AEAD key parsing, neither of which run on the edge.
export const runtime = 'nodejs';

import { cookies, headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { parseKey } from '@/crypto/aead';
import { getDb } from '@/db';
import { createNpiClient } from '@/npi/client';
import { NpiError } from '@/npi/errors';
import { readLogin, type NpiLogin } from '@/npi/responses';
import { createSession, destroySession, readSession, type SessionDeps } from '@/auth/session';
import { isBlocked, rateLimitKey, recordAttempt, type RateLimitDb } from '@/auth/ratelimit';
import { clearedSessionCookieAttributes, sessionCookieAttributes, SESSION_COOKIE_NAME } from '@/auth/cookie';

const MAX_EMAIL_LENGTH = 254;
const MAX_PASSWORD_LENGTH = 200;

/** Every response from this route: never cached by a browser or a proxy —
 *  it always carries session-dependent, security-sensitive state. */
const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

/**
 * `getDb()`'s real `PrismaClient` return value satisfies both `SessionDb`
 * (used for `SessionDeps.db`) and `RateLimitDb` (used directly for
 * `isBlocked`/`recordAttempt`) — one connection, two narrower structural
 * views of it, cast explicitly since the two view types are unrelated to
 * each other.
 */
function buildDeps(): SessionDeps & { rateLimitDb: RateLimitDb } {
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
 * modern browser does on a POST/DELETE fetch), must match the request's own
 * `Host`. A same-origin request from this app's own login form never sends
 * a mismatched Origin; a form or script hosted elsewhere would.
 */
function originMismatch(): boolean {
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

interface LoginBody {
  email: string;
  password: string;
}

function parseLoginBody(value: unknown): LoginBody | null {
  if (typeof value !== 'object' || value === null) return null;
  const { email, password } = value as Record<string, unknown>;
  if (typeof email !== 'string' || email.length === 0 || email.length > MAX_EMAIL_LENGTH) return null;
  if (typeof password !== 'string' || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) {
    return null;
  }
  return { email, password };
}

export async function POST(request: Request): Promise<NextResponse> {
  if (originMismatch()) return json({ error: 'forbidden' }, 403);

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return json({ error: 'unsupported_media_type' }, 415);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return json({ error: 'invalid_body' }, 400);
  }

  const body = parseLoginBody(rawBody);
  if (!body) return json({ error: 'invalid_body' }, 400);

  const deps = buildDeps();
  const key = rateLimitKey(body.email);

  if (await isBlocked({ db: deps.rateLimitDb }, key)) {
    return json({ error: 'rate_limited' }, 429);
  }

  const npi = createNpiClient({ token: '' });
  let login: NpiLogin;
  try {
    login = readLogin(await npi.login({ email: body.email, password: body.password }));
  } catch (err) {
    if (!(err instanceof NpiError)) throw err;

    if (err.kind === 'unauthorized') {
      await recordAttempt({ db: deps.rateLimitDb }, key, false);
      return json({ error: 'invalid' }, 401);
    }
    if (err.status === 429) {
      // NPI's own per-IP throttle tripped — not this copilot's rate limit,
      // and NOT counted as a failed attempt for this e-mail's key.
      return json({ error: 'rate_limited' }, 429);
    }
    return json({ error: 'npi_down' }, 503);
  }

  await recordAttempt({ db: deps.rateLimitDb }, key, true);
  const { cookieValue, expiresAt, user } = await createSession(deps, login);

  cookies().set(SESSION_COOKIE_NAME, cookieValue, sessionCookieAttributes(expiresAt));

  return json(
    {
      user: {
        nameAr: user.nameAr,
        roleKey: user.roleKey,
        roleNameAr: user.roleNameAr,
        isAdmin: user.isAdmin,
        positionTitleAr: user.positionTitleAr,
      },
    },
    200,
  );
}

export async function GET(): Promise<NextResponse> {
  const deps = buildDeps();
  const cookieValue = cookies().get(SESSION_COOKIE_NAME)?.value;

  let session;
  try {
    session = await readSession(deps, cookieValue);
  } catch (err) {
    if (!(err instanceof NpiError)) throw err;
    // Network/timeout/5xx while revalidating: the session itself may still
    // be good, but NPI could not confirm it right now.
    return json({ error: 'npi_down' }, 503);
  }

  if (!session) return json({ error: 'unauthenticated' }, 401);

  return json(
    {
      user: {
        nameAr: session.user.nameAr,
        roleKey: session.user.roleKey,
        roleNameAr: session.user.roleNameAr,
        isAdmin: session.user.isAdmin,
        positionTitleAr: session.user.positionTitleAr,
      },
    },
    200,
  );
}

export async function DELETE(): Promise<NextResponse> {
  if (originMismatch()) return json({ error: 'forbidden' }, 403);

  const deps = buildDeps();
  const cookieValue = cookies().get(SESSION_COOKIE_NAME)?.value;
  await destroySession(deps, cookieValue);

  cookies().set(SESSION_COOKIE_NAME, '', clearedSessionCookieAttributes());

  return new NextResponse(null, { status: 204, headers: NO_STORE_HEADERS });
}
