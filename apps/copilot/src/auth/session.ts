// Server-side session: a random cookie value maps to a `CopilotSession` row
// whose id is the cookie value's SHA-256 — a leaked table can never be
// replayed as a cookie, since the cookie value itself is never stored.
//
// The NPI access token never leaves this file's return values in the clear:
// it is stored AEAD-encrypted at rest (`src/crypto/aead.ts`) and is only
// ever handed back to a caller as `ActiveSession.npiToken`, which route
// handlers use to build an `NpiClient` for that request and then discard.
import { createHash, randomBytes } from 'crypto';
import { cookies } from 'next/headers';
import { decrypt, encrypt, parseKey } from '../crypto/aead';
import { getDb } from '../db';
import { createNpiClient, type NpiClient } from '../npi/client';
import { NpiError } from '../npi/errors';
import { readMe, type NpiLogin, type NpiMe } from '../npi/responses';
import { resolvePosition, type PositionsDb, type PositionsNpi } from '../positions/resolve';
import { SYNC_PERMISSION, syncFromNpi } from '../onboarding/sync';
import { SESSION_COOKIE_NAME } from './cookie';

/** Fallback lifetime when the JWT's `exp` claim cannot be read. */
const FALLBACK_TTL_MS = 12 * 60 * 60 * 1000;
/** How long a `me()` revalidation result is trusted before NPI is asked again. */
const REVALIDATE_CACHE_MS = 60 * 1000;
/** How long an administrator's login waits for the NPI sync before giving up on it. */
export const LOGIN_SYNC_TIMEOUT_MS = 10 * 1000;

export interface SessionUser {
  npiUserId: string;
  npiOrgId: string;
  nameAr: string;
  roleKey: string;
  roleNameAr: string;
  permissions: string[];
  /** The organization's Arabic name, or null (see `NpiMe.orgNameAr`). */
  orgNameAr: string | null;
  isAdmin: boolean;
  departmentId: string | null;
  positionId: string | null;
  positionTitleAr: string | null;
}

export interface ActiveSession {
  user: SessionUser;
  /** The caller's NPI Bearer token, decrypted for this request only — never
   *  logged, never sent back to the browser. */
  npiToken: string;
  expiresAt: Date;
}

/** The `CopilotSession` row shape this module reads and writes. */
export interface CopilotSessionRow {
  id: string;
  npiUserId: string;
  npiOrgId: string;
  roleKey: string;
  departmentId: string | null;
  tokenEncrypted: string;
  expiresAt: Date;
  lastSeenAt: Date;
}

/**
 * Minimal structural subset of the Prisma client this module needs. Typed
 * structurally (not imported from the generated client at runtime) so tests
 * can pass a small in-memory fake — see the type-level check in
 * tests/auth-session.spec.ts that the real `PrismaClient` satisfies this.
 */
export interface SessionDb {
  copilotSession: {
    create(args: {
      data: {
        id: string;
        npiUserId: string;
        npiOrgId: string;
        roleKey: string;
        departmentId: string | null;
        tokenEncrypted: string;
        expiresAt: Date;
        lastSeenAt: Date;
      };
    }): Promise<CopilotSessionRow>;
    findUnique(args: { where: { id: string } }): Promise<CopilotSessionRow | null>;
    updateMany(args: { where: { id: string }; data: { lastSeenAt: Date } }): Promise<unknown>;
    deleteMany(args: { where: { id: string } }): Promise<unknown>;
  };
}

export interface SessionDeps {
  db: SessionDb;
  key: Buffer;
  npiFor: (token: string) => Pick<NpiClient, 'me' | 'listDepartments' | 'listDepartmentDirectory'>;
  now?: () => Date;
  /** Overridable for tests; defaults to the real `resolvePosition`. Real
   *  callers never set this — production always uses the real position
   *  resolution against the same `npi_copilot` database. */
  positions?: typeof resolvePosition;
  /** Overridable for tests; defaults to the real `syncFromNpi` (T-47b). Like
   *  `positions`, it works on the same `npi_copilot` database as `db`. */
  sync?: typeof syncFromNpi;
}

function resolveNow(deps: Pick<SessionDeps, 'now'>): Date {
  return (deps.now ?? (() => new Date()))();
}

/** SHA-256 hex of the cookie value — this, not the cookie value, is the row id. */
function hashCookieValue(cookieValue: string): string {
  return createHash('sha256').update(cookieValue, 'utf8').digest('hex');
}

/**
 * Decodes a JWT's `exp` claim (seconds since epoch) without checking the
 * signature — NPI itself re-validates the token's signature on every call
 * this session makes with it (`me()`), so this is only ever used to size
 * the copilot's own session lifetime, never to authorize anything.
 */
function decodeJwtExpiry(token: string): Date | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8');
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return null;
    return new Date(payload.exp * 1000);
  } catch {
    return null;
  }
}

/**
 * In-memory cache of the last-known-good `me()` result per session id, so a
 * busy UI doesn't hit NPI on every request. Module-level on purpose: it must
 * survive across requests within this server process, and is explicitly
 * evicted by `destroySession` so a destroyed session can never serve a
 * stale cached identity if its id were ever reused.
 */
const meCache = new Map<string, { me: NpiMe; ts: number }>();

function buildSessionUser(
  me: NpiMe,
  position: { departmentId: string | null; positionId: string | null; titleAr: string | null },
): SessionUser {
  return {
    npiUserId: me.id,
    npiOrgId: me.organizationId,
    nameAr: me.nameAr,
    roleKey: me.roleKey,
    roleNameAr: me.roleNameAr,
    permissions: me.permissions,
    orgNameAr: me.orgNameAr,
    isAdmin: me.roleKey === 'admin',
    departmentId: position.departmentId,
    positionId: position.positionId,
    positionTitleAr: position.titleAr,
  };
}

/**
 * Resolves the caller's position, tolerating any `NpiError` as "position
 * unknown" — a login (or a session read) must never fail because position
 * resolution hiccuped. `deps.db` is asserted to `PositionsDb` here: in
 * production `deps.db` really is the same Prisma client (which has the
 * `position`/`positionAssignment` delegates `resolvePosition` needs), and in
 * tests `deps.positions` is expected to be overridden with a stub that
 * ignores its `db`/`npi` arguments entirely — see `SessionDeps.positions`.
 * `fallbackDepartmentId` is what a caller with an already-known departmentId
 * (a session row being re-read) wants back when resolution itself fails; a
 * brand-new login has no such fallback (`null`).
 */
async function tryResolvePosition(
  deps: SessionDeps,
  me: NpiMe,
  npi: ReturnType<SessionDeps['npiFor']>,
  fallbackDepartmentId: string | null,
): Promise<{ departmentId: string | null; positionId: string | null; titleAr: string | null }> {
  const resolve = deps.positions ?? resolvePosition;
  try {
    const position = await resolve(
      { db: deps.db as unknown as PositionsDb, npi: npi as unknown as PositionsNpi, now: deps.now },
      me,
    );
    return { departmentId: position.departmentId, positionId: position.positionId, titleAr: position.titleAr };
  } catch (err) {
    if (!(err instanceof NpiError)) throw err;
    return { departmentId: fallbackDepartmentId, positionId: null, titleAr: null };
  }
}

/**
 * T-47b: an administrator's login brings Madar's departments, positions and
 * holders in step with NPI (throttled to once per 10 minutes per organization
 * inside `syncFromNpi`). It never blocks or fails the login: every error is
 * logged and swallowed, and a sync still running after
 * `LOGIN_SYNC_TIMEOUT_MS` is abandoned (it finishes in the background; the
 * administrator's first page just may not reflect it yet).
 */
async function syncAfterAdminLogin(deps: SessionDeps, me: NpiMe, npi: ReturnType<SessionDeps['npiFor']>): Promise<void> {
  if (!me.permissions.includes(SYNC_PERMISSION)) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const sync = deps.sync ?? syncFromNpi;
    const run = sync({
      orgId: me.organizationId,
      npi: npi as unknown as Parameters<typeof syncFromNpi>[0]['npi'],
      me,
      reason: 'login',
      db: deps.db as unknown as Parameters<typeof syncFromNpi>[0]['db'],
      now: deps.now,
    });
    run.catch(() => undefined); // a late failure after the timeout is not an unhandled rejection
    await Promise.race([
      run,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`NPI sync still running after ${LOGIN_SYNC_TIMEOUT_MS} ms`)), LOGIN_SYNC_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    console.error('[copilot] NPI sync at login failed', err instanceof Error ? err.message : err);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Creates a new session for a just-completed NPI login: generates the
 * cookie value, encrypts the NPI token, resolves the caller's position
 * (never failing the login if that resolution errors), and persists the row.
 */
export async function createSession(
  deps: SessionDeps,
  login: NpiLogin,
): Promise<{ cookieValue: string; expiresAt: Date; user: SessionUser }> {
  const now = resolveNow(deps);
  const cookieValue = randomBytes(32).toString('base64url');
  const id = hashCookieValue(cookieValue);
  const expiresAt = decodeJwtExpiry(login.accessToken) ?? new Date(now.getTime() + FALLBACK_TTL_MS);
  const tokenEncrypted = encrypt(login.accessToken, deps.key);

  const npi = deps.npiFor(login.accessToken);
  const { departmentId, positionId, titleAr } = await tryResolvePosition(deps, login.user, npi, null);

  await deps.db.copilotSession.create({
    data: {
      id,
      npiUserId: login.user.id,
      npiOrgId: login.user.organizationId,
      roleKey: login.user.roleKey,
      departmentId,
      tokenEncrypted,
      expiresAt,
      lastSeenAt: now,
    },
  });

  await syncAfterAdminLogin(deps, login.user, npi);

  const user = buildSessionUser(login.user, { departmentId, positionId, titleAr });
  return { cookieValue, expiresAt, user };
}

/**
 * Reads back an active session from a cookie value, re-validating against
 * NPI (cached 60s per session id). Returns `null` for: no cookie, an
 * unknown id, an expired row (deleted), a tampered/undecryptable token
 * (deleted), or NPI answering 401 (deleted). Any other `NpiError` from NPI
 * (network, timeout, 5xx) is rethrown — the row is kept, since that failure
 * says nothing about whether the session is actually still valid.
 */
export async function readSession(
  deps: SessionDeps,
  cookieValue: string | undefined,
): Promise<ActiveSession | null> {
  if (!cookieValue) return null;
  const now = resolveNow(deps);
  const id = hashCookieValue(cookieValue);

  const row = await deps.db.copilotSession.findUnique({ where: { id } });
  if (!row) return null;

  if (row.expiresAt.getTime() <= now.getTime()) {
    await deps.db.copilotSession.deleteMany({ where: { id } });
    meCache.delete(id);
    return null;
  }

  let token: string;
  try {
    token = decrypt(row.tokenEncrypted, deps.key);
  } catch {
    await deps.db.copilotSession.deleteMany({ where: { id } });
    meCache.delete(id);
    return null;
  }

  const npi = deps.npiFor(token);

  const cached = meCache.get(id);
  let me: NpiMe;
  if (cached && now.getTime() - cached.ts < REVALIDATE_CACHE_MS) {
    me = cached.me;
  } else {
    try {
      me = readMe(await npi.me());
    } catch (err) {
      if (err instanceof NpiError && err.kind === 'unauthorized') {
        await deps.db.copilotSession.deleteMany({ where: { id } });
        meCache.delete(id);
        return null;
      }
      throw err;
    }
    meCache.set(id, { me, ts: now.getTime() });
  }

  if (now.getTime() - row.lastSeenAt.getTime() >= REVALIDATE_CACHE_MS) {
    await deps.db.copilotSession.updateMany({ where: { id }, data: { lastSeenAt: now } });
  }

  const { departmentId, positionId, titleAr } = await tryResolvePosition(deps, me, npi, row.departmentId);

  const user = buildSessionUser(me, { departmentId, positionId, titleAr });
  return { user, npiToken: token, expiresAt: row.expiresAt };
}

/** Deletes the session row and evicts its cached `me()` result, if any. */
export async function destroySession(deps: SessionDeps, cookieValue: string | undefined): Promise<void> {
  if (!cookieValue) return;
  const id = hashCookieValue(cookieValue);
  await deps.db.copilotSession.deleteMany({ where: { id } });
  meCache.delete(id);
}

/**
 * Reads the session cookie for the current request (server components and
 * route handlers only — never the edge middleware, which only checks cookie
 * presence via `src/auth/cookie.ts`) and builds the real dependencies.
 */
export async function getServerSession(): Promise<ActiveSession | null> {
  const store = cookies();
  const cookieValue = store.get(SESSION_COOKIE_NAME)?.value;
  const key = parseKey(process.env.COPILOT_SESSION_KEY);
  const deps: SessionDeps = {
    db: getDb(),
    key,
    npiFor: (token: string) => createNpiClient({ token }),
  };
  return readSession(deps, cookieValue);
}
