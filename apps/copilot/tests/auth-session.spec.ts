// Fakes only — no real database, no real NPI. `deps.positions` is overridden
// in every case below with a stub so these tests never need a working
// PositionsDb fake; see src/auth/session.ts for why that override exists.
import { createHash } from 'crypto';
import {
  createSession,
  readSession,
  destroySession,
  type SessionDb,
  type SessionDeps,
  type CopilotSessionRow,
} from '../src/auth/session';
import { encrypt, parseKey } from '../src/crypto/aead';
import { NpiError } from '../src/npi/errors';
import type { NpiLogin, NpiMe } from '../src/npi/responses';
import type { ResolvedPosition } from '../src/positions/resolve';
import type { PrismaClient } from '../src/generated/prisma';

const KEY = parseKey('11'.repeat(32));

function makeMe(overrides: Partial<NpiMe> = {}): NpiMe {
  return {
    id: 'user-1',
    organizationId: 'org-1',
    nameAr: 'محمد',
    roleKey: 'sales',
    roleNameAr: 'المبيعات',
    permissions: [],
    ...overrides,
  };
}

function jwtWithExp(exp: number | undefined): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payloadObj: Record<string, unknown> = { sub: 'user-1', org: 'org-1' };
  if (exp !== undefined) payloadObj.exp = exp;
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  return `${header}.${payload}.sig`;
}

function makeLogin(me: NpiMe, exp?: number): NpiLogin {
  const expClaim = exp ?? Math.floor(Date.now() / 1000) + 3600;
  return { accessToken: jwtWithExp(expClaim), user: me };
}

function rawMe(me: NpiMe) {
  return {
    id: me.id,
    nameAr: me.nameAr,
    roleKey: me.roleKey,
    roleNameAr: me.roleNameAr,
    permissions: me.permissions,
    organization: { id: me.organizationId },
  };
}

function makeFakeDb() {
  const rows = new Map<string, CopilotSessionRow>();
  const db: SessionDb = {
    copilotSession: {
      async create({ data }) {
        const row: CopilotSessionRow = { ...data };
        rows.set(data.id, row);
        return row;
      },
      async findUnique({ where }) {
        return rows.get(where.id) ?? null;
      },
      async updateMany({ where, data }) {
        const row = rows.get(where.id);
        if (!row) return { count: 0 };
        rows.set(where.id, { ...row, ...data });
        return { count: 1 };
      },
      async deleteMany({ where }) {
        const existed = rows.delete(where.id);
        return { count: existed ? 1 : 0 };
      },
    },
  };
  return { db, rows };
}

function makeNpiFor(meImpl: () => Promise<unknown>) {
  let calls = 0;
  const npiFor = (_token: string) => ({
    me: async () => {
      calls += 1;
      return meImpl();
    },
    listDepartments: async () => [],
    listDepartmentDirectory: async () => [],
  });
  return { npiFor, callCount: () => calls };
}

function makeResolvedPosition(overrides: Partial<ResolvedPosition> = {}): ResolvedPosition {
  return {
    positionId: 'pos-1',
    roleKey: 'sales',
    departmentId: null,
    departmentNameAr: null,
    titleAr: 'مندوب مبيعات',
    personaAr: 'شخصية',
    source: 'role_only',
    ...overrides,
  };
}

function idFor(cookieValue: string): string {
  return createHash('sha256').update(cookieValue).digest('hex');
}

describe('createSession', () => {
  it('produces a random cookie value whose stored row id is its SHA-256', async () => {
    const { db, rows } = makeFakeDb();
    const now = () => new Date('2026-01-01T00:00:00Z');
    const { npiFor } = makeNpiFor(async () => rawMe(makeMe()));
    const deps: SessionDeps = { db, key: KEY, npiFor, now, positions: async () => makeResolvedPosition() };

    const a = await createSession(deps, makeLogin(makeMe()));
    const b = await createSession(deps, makeLogin(makeMe()));

    expect(a.cookieValue).not.toBe(b.cookieValue);
    expect(rows.has(idFor(a.cookieValue))).toBe(true);
    expect(rows.has(idFor(b.cookieValue))).toBe(true);
  });

  it('stores the NPI token encrypted, and it decrypts back to the original', async () => {
    const { db, rows } = makeFakeDb();
    const now = () => new Date('2026-01-01T00:00:00Z');
    const { npiFor } = makeNpiFor(async () => rawMe(makeMe()));
    const deps: SessionDeps = { db, key: KEY, npiFor, now, positions: async () => makeResolvedPosition() };
    const login = makeLogin(makeMe());

    const { cookieValue } = await createSession(deps, login);
    const row = rows.get(idFor(cookieValue))!;

    expect(row.tokenEncrypted).not.toBe(login.accessToken);
    const { decrypt } = await import('../src/crypto/aead');
    expect(decrypt(row.tokenEncrypted, KEY)).toBe(login.accessToken);
  });

  it("honours the JWT's exp claim as the session's expiresAt", async () => {
    const { db, rows } = makeFakeDb();
    const now = () => new Date('2026-01-01T00:00:00Z');
    const { npiFor } = makeNpiFor(async () => rawMe(makeMe()));
    const deps: SessionDeps = { db, key: KEY, npiFor, now, positions: async () => makeResolvedPosition() };
    const expSeconds = Math.floor(new Date('2026-01-01T02:00:00Z').getTime() / 1000);
    const login = makeLogin(makeMe(), expSeconds);

    const { cookieValue, expiresAt } = await createSession(deps, login);
    expect(expiresAt.getTime()).toBe(expSeconds * 1000);
    expect(rows.get(idFor(cookieValue))!.expiresAt.getTime()).toBe(expSeconds * 1000);
  });

  it('falls back to 12 hours when exp cannot be read', async () => {
    const { db } = makeFakeDb();
    const now = () => new Date('2026-01-01T00:00:00Z');
    const { npiFor } = makeNpiFor(async () => rawMe(makeMe()));
    const deps: SessionDeps = { db, key: KEY, npiFor, now, positions: async () => makeResolvedPosition() };
    const login: NpiLogin = { accessToken: 'not-a-jwt', user: makeMe() };

    const { expiresAt } = await createSession(deps, login);
    expect(expiresAt.getTime()).toBe(now().getTime() + 12 * 60 * 60 * 1000);
  });

  it('falls back to 12 hours when the exp claim is present but not a number', async () => {
    const { db } = makeFakeDb();
    const now = () => new Date('2026-01-01T00:00:00Z');
    const { npiFor } = makeNpiFor(async () => rawMe(makeMe()));
    const deps: SessionDeps = { db, key: KEY, npiFor, now, positions: async () => makeResolvedPosition() };
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ exp: 'soon' })).toString('base64url');
    const login: NpiLogin = { accessToken: `${header}.${payload}.sig`, user: makeMe() };

    const { expiresAt } = await createSession(deps, login);
    expect(expiresAt.getTime()).toBe(now().getTime() + 12 * 60 * 60 * 1000);
  });

  it('creates the session even when position resolution throws an NpiError (role only)', async () => {
    const { db, rows } = makeFakeDb();
    const now = () => new Date('2026-01-01T00:00:00Z');
    const { npiFor } = makeNpiFor(async () => rawMe(makeMe()));
    const deps: SessionDeps = {
      db,
      key: KEY,
      npiFor,
      now,
      positions: async () => {
        throw new NpiError({ status: 403, kind: 'forbidden', npiMessage: null });
      },
    };

    const { cookieValue, user } = await createSession(deps, makeLogin(makeMe()));
    expect(user.positionId).toBeNull();
    expect(user.positionTitleAr).toBeNull();
    expect(user.departmentId).toBeNull();
    expect(user.roleKey).toBe('sales');
    expect(rows.get(idFor(cookieValue))!.departmentId).toBeNull();
  });

  it('isAdmin is true only when roleKey is "admin"', async () => {
    const { db } = makeFakeDb();
    const now = () => new Date('2026-01-01T00:00:00Z');
    const { npiFor } = makeNpiFor(async () => rawMe(makeMe()));
    const deps: SessionDeps = { db, key: KEY, npiFor, now, positions: async () => makeResolvedPosition() };

    const salesResult = await createSession(deps, makeLogin(makeMe({ roleKey: 'sales' })));
    expect(salesResult.user.isAdmin).toBe(false);

    const adminResult = await createSession(deps, makeLogin(makeMe({ roleKey: 'admin' })));
    expect(adminResult.user.isAdmin).toBe(true);
  });
});

describe('readSession', () => {
  it('returns null when there is no cookie', async () => {
    const { db } = makeFakeDb();
    const { npiFor } = makeNpiFor(async () => rawMe(makeMe()));
    const deps: SessionDeps = { db, key: KEY, npiFor, positions: async () => makeResolvedPosition() };

    expect(await readSession(deps, undefined)).toBeNull();
  });

  it('returns null for an unknown cookie value', async () => {
    const { db } = makeFakeDb();
    const { npiFor } = makeNpiFor(async () => rawMe(makeMe()));
    const deps: SessionDeps = { db, key: KEY, npiFor, positions: async () => makeResolvedPosition() };

    expect(await readSession(deps, 'not-a-real-session-value')).toBeNull();
  });

  it('deletes and returns null for an expired row', async () => {
    let current = new Date('2026-01-01T00:00:00Z');
    const now = () => current;
    const { db, rows } = makeFakeDb();
    const { npiFor } = makeNpiFor(async () => rawMe(makeMe()));
    const deps: SessionDeps = { db, key: KEY, npiFor, now, positions: async () => makeResolvedPosition() };

    const expSeconds = Math.floor(new Date('2026-01-01T01:00:00Z').getTime() / 1000);
    const { cookieValue } = await createSession(deps, makeLogin(makeMe(), expSeconds));

    current = new Date('2026-01-01T01:00:01Z'); // 1s past expiry
    const result = await readSession(deps, cookieValue);

    expect(result).toBeNull();
    expect(rows.has(idFor(cookieValue))).toBe(false);
  });

  it('deletes and returns null when the stored token has been tampered with', async () => {
    const { db, rows } = makeFakeDb();
    const now = () => new Date('2026-01-01T00:00:00Z');
    const { npiFor } = makeNpiFor(async () => rawMe(makeMe()));
    const deps: SessionDeps = { db, key: KEY, npiFor, now, positions: async () => makeResolvedPosition() };

    const { cookieValue } = await createSession(deps, makeLogin(makeMe()));
    const id = idFor(cookieValue);
    const row = rows.get(id)!;
    rows.set(id, { ...row, tokenEncrypted: row.tokenEncrypted.slice(0, -2) + 'zz' });

    const result = await readSession(deps, cookieValue);
    expect(result).toBeNull();
    expect(rows.has(id)).toBe(false);
  });

  it('calls NPI me() once within 60 seconds, and again after 60 seconds', async () => {
    let current = new Date('2026-01-01T00:00:00Z');
    const now = () => current;
    const { db } = makeFakeDb();
    const { npiFor, callCount } = makeNpiFor(async () => rawMe(makeMe()));
    const deps: SessionDeps = { db, key: KEY, npiFor, now, positions: async () => makeResolvedPosition() };

    const { cookieValue } = await createSession(deps, makeLogin(makeMe()));

    await readSession(deps, cookieValue);
    expect(callCount()).toBe(1);

    current = new Date(current.getTime() + 30_000);
    await readSession(deps, cookieValue);
    expect(callCount()).toBe(1); // still cached

    current = new Date(current.getTime() + 31_000); // total +61s
    await readSession(deps, cookieValue);
    expect(callCount()).toBe(2);
  });

  it('deletes the row and returns null when NPI answers 401', async () => {
    const { db, rows } = makeFakeDb();
    const now = () => new Date('2026-01-01T00:00:00Z');
    const { npiFor } = makeNpiFor(async () => {
      throw new NpiError({ status: 401, kind: 'unauthorized', npiMessage: null });
    });
    const deps: SessionDeps = { db, key: KEY, npiFor, now, positions: async () => makeResolvedPosition() };

    const { cookieValue } = await createSession(deps, makeLogin(makeMe()));
    const result = await readSession(deps, cookieValue);

    expect(result).toBeNull();
    expect(rows.has(idFor(cookieValue))).toBe(false);
  });

  it('rethrows a network error from NPI and keeps the row', async () => {
    const { db, rows } = makeFakeDb();
    const now = () => new Date('2026-01-01T00:00:00Z');
    const { npiFor } = makeNpiFor(async () => {
      throw new NpiError({ status: 0, kind: 'network', npiMessage: null });
    });
    const deps: SessionDeps = { db, key: KEY, npiFor, now, positions: async () => makeResolvedPosition() };

    const { cookieValue } = await createSession(deps, makeLogin(makeMe()));

    await expect(readSession(deps, cookieValue)).rejects.toBeInstanceOf(NpiError);
    expect(rows.has(idFor(cookieValue))).toBe(true);
  });

  it('updates lastSeenAt at most once a minute', async () => {
    let current = new Date('2026-01-01T00:00:00Z');
    const now = () => current;
    const { db, rows } = makeFakeDb();
    const { npiFor } = makeNpiFor(async () => rawMe(makeMe()));
    const deps: SessionDeps = { db, key: KEY, npiFor, now, positions: async () => makeResolvedPosition() };

    const { cookieValue } = await createSession(deps, makeLogin(makeMe()));
    const id = idFor(cookieValue);
    const t0 = rows.get(id)!.lastSeenAt.getTime();

    current = new Date(t0 + 10_000);
    await readSession(deps, cookieValue);
    expect(rows.get(id)!.lastSeenAt.getTime()).toBe(t0); // unchanged, < 1 minute

    current = new Date(t0 + 61_000);
    await readSession(deps, cookieValue);
    expect(rows.get(id)!.lastSeenAt.getTime()).toBe(t0 + 61_000); // updated
  });

  it('destroySession removes the row and evicts the me() cache entry', async () => {
    const now = () => new Date('2026-01-01T00:00:00Z');
    const { db, rows } = makeFakeDb();
    const meFirst = makeMe({ nameAr: 'الأول' });
    const { npiFor, callCount } = makeNpiFor(async () => rawMe(meFirst));
    const deps: SessionDeps = { db, key: KEY, npiFor, now, positions: async () => makeResolvedPosition() };

    const { cookieValue } = await createSession(deps, makeLogin(meFirst));
    await readSession(deps, cookieValue); // populates the me() cache
    expect(callCount()).toBe(1);

    await destroySession(deps, cookieValue);
    expect(rows.size).toBe(0);

    // Force the same session id to exist again (white-box, via direct fake-db
    // access) with a DIFFERENT user, to prove the me() cache — not just the
    // row — was evicted: a stale cache would otherwise leak the first user's
    // name back out for this id.
    const id = idFor(cookieValue);
    const meSecond = makeMe({ nameAr: 'الثاني' });
    rows.set(id, {
      id,
      npiUserId: meSecond.id,
      npiOrgId: meSecond.organizationId,
      roleKey: meSecond.roleKey,
      departmentId: null,
      tokenEncrypted: encrypt('new-token', KEY),
      expiresAt: new Date(now().getTime() + 3600_000),
      lastSeenAt: now(),
    });
    const { npiFor: npiFor2 } = makeNpiFor(async () => rawMe(meSecond));
    const deps2: SessionDeps = { ...deps, npiFor: npiFor2 };

    const session = await readSession(deps2, cookieValue);
    expect(session?.user.nameAr).toBe('الثاني');
  });
});

describe('type-level checks', () => {
  it('the real PrismaClient satisfies SessionDb', () => {
    // Compile-only assertion: if PrismaClient's `copilotSession` delegate
    // stops matching SessionDb's minimal shape, this file fails to compile
    // (and therefore fails this test run) rather than only failing silently
    // at runtime somewhere else.
    function _typeCheck(client: PrismaClient): SessionDb {
      return client;
    }
    void _typeCheck;
    expect(true).toBe(true);
  });
});
