// Fakes with an injected clock — no real database. See src/auth/ratelimit.ts
// for the exact window/reset semantics this file locks down.
import { isBlocked, recordAttempt, rateLimitKey, type RateLimitDb, type LoginAttemptRow } from '../src/auth/ratelimit';

interface StoredRow extends LoginAttemptRow {
  key: string;
}

function makeFakeDb() {
  const rows: StoredRow[] = [];
  const db: RateLimitDb = {
    loginAttempt: {
      async findMany({ where }) {
        return rows
          .filter((r) => r.key === where.key)
          .map(({ attemptedAt, succeeded }) => ({ attemptedAt, succeeded }));
      },
      async create({ data }) {
        rows.push({ key: data.key, succeeded: data.succeeded, attemptedAt: data.attemptedAt });
        return null;
      },
      async deleteMany({ where }) {
        let removed = 0;
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i].key === where.key && rows[i].attemptedAt < where.attemptedAt.lt) {
            rows.splice(i, 1);
            removed += 1;
          }
        }
        return { count: removed };
      },
    },
  };
  return { db, rows };
}

const MINUTE = 60_000;

describe('rateLimitKey', () => {
  it('gives the same key for different casing and surrounding whitespace', () => {
    expect(rateLimitKey('  Someone@Example.com ')).toBe(rateLimitKey('someone@example.com'));
  });

  it('gives different keys for different e-mails', () => {
    expect(rateLimitKey('a@example.com')).not.toBe(rateLimitKey('b@example.com'));
  });

  it('never returns the e-mail itself (stored as a hash, not in clear)', () => {
    const key = rateLimitKey('someone@example.com');
    expect(key).not.toContain('someone');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('isBlocked / recordAttempt', () => {
  it('4 failures are not blocked', async () => {
    let current = new Date('2026-01-01T00:00:00Z');
    const now = () => current;
    const { db } = makeFakeDb();
    const key = 'k1';

    for (let i = 0; i < 4; i++) {
      current = new Date(current.getTime() + 1000);
      await recordAttempt({ db, now }, key, false);
    }

    expect(await isBlocked({ db, now }, key)).toBe(false);
  });

  it('5 failures are blocked', async () => {
    let current = new Date('2026-01-01T00:00:00Z');
    const now = () => current;
    const { db } = makeFakeDb();
    const key = 'k1';

    for (let i = 0; i < 5; i++) {
      current = new Date(current.getTime() + 1000);
      await recordAttempt({ db, now }, key, false);
    }

    expect(await isBlocked({ db, now }, key)).toBe(true);
  });

  it('failures older than 15 minutes do not count', async () => {
    let current = new Date('2026-01-01T00:00:00Z');
    const now = () => current;
    const { db } = makeFakeDb();
    const key = 'k1';

    // 5 failures, all outside the 15-minute window by the time we check.
    for (let i = 0; i < 5; i++) {
      current = new Date(current.getTime() + 1000);
      await recordAttempt({ db, now }, key, false);
    }

    current = new Date(current.getTime() + 16 * MINUTE);
    expect(await isBlocked({ db, now }, key)).toBe(false);
  });

  it('a success resets the count', async () => {
    let current = new Date('2026-01-01T00:00:00Z');
    const now = () => current;
    const { db } = makeFakeDb();
    const key = 'k1';

    for (let i = 0; i < 4; i++) {
      current = new Date(current.getTime() + 1000);
      await recordAttempt({ db, now }, key, false);
    }
    current = new Date(current.getTime() + 1000);
    await recordAttempt({ db, now }, key, true);

    // 4 more failures after the success: still below the 5-failure threshold
    // because the success reset the count to zero.
    for (let i = 0; i < 4; i++) {
      current = new Date(current.getTime() + 1000);
      await recordAttempt({ db, now }, key, false);
    }

    expect(await isBlocked({ db, now }, key)).toBe(false);
  });

  it('keys are independent', async () => {
    let current = new Date('2026-01-01T00:00:00Z');
    const now = () => current;
    const { db } = makeFakeDb();

    for (let i = 0; i < 5; i++) {
      current = new Date(current.getTime() + 1000);
      await recordAttempt({ db, now }, 'attacker', false);
    }

    expect(await isBlocked({ db, now }, 'attacker')).toBe(true);
    expect(await isBlocked({ db, now }, 'innocent')).toBe(false);
  });

  it('a blocked attempt, not recorded by the caller, lets the window expire naturally', async () => {
    let current = new Date('2026-01-01T00:00:00Z');
    const now = () => current;
    const { db, rows } = makeFakeDb();
    const key = 'k1';

    for (let i = 0; i < 5; i++) {
      current = new Date(current.getTime() + 1000);
      await recordAttempt({ db, now }, key, false);
    }
    expect(await isBlocked({ db, now }, key)).toBe(true);

    // The caller (the auth route) must not call recordAttempt while blocked.
    // Simulate that discipline: no further recordAttempt calls happen here.
    const countAtBlock = rows.length;
    current = new Date(current.getTime() + 16 * MINUTE);
    expect(await isBlocked({ db, now }, key)).toBe(false);
    expect(rows.length).toBe(countAtBlock); // nothing new was recorded
  });

  it('old rows are pruned after 24 hours', async () => {
    let current = new Date('2026-01-01T00:00:00Z');
    const now = () => current;
    const { db, rows } = makeFakeDb();
    const key = 'k1';

    await recordAttempt({ db, now }, key, false);
    expect(rows.length).toBe(1);

    current = new Date(current.getTime() + 25 * 60 * 60 * 1000); // +25h
    await recordAttempt({ db, now }, key, false);

    // The first (now 25h-old) row was pruned by this second recordAttempt;
    // only the fresh one remains.
    expect(rows.length).toBe(1);
    expect(rows[0].attemptedAt.getTime()).toBe(current.getTime());
  });
});
