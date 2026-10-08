// T-34 part B: the usage counter's readers (`src/queries/usage.ts`) against an
// in-memory fake db. No network, no database. Every call the readers make is
// recorded, so the tests can prove what reached the `where` (organization
// scoping is in the query, never a post-filter). The real-database side is
// tests/cost-db.spec.ts.
import { CAP_REACHED_MESSAGE_AR, aggregateUsage, riyadhDay } from '../src/audit/cost';
import type { UsageRowLike } from '../src/audit/usage-types';
import {
  DAILY_USAGE_SELECT,
  USAGE_AUDIT_SELECT,
  loadCapStatus,
  loadDailyUsage,
  loadDocumentUsage,
  loadUsageReport,
  type DailyUsageRowLike,
  type UsageAuditWhere,
  type UsageDb,
} from '../src/queries/usage';

// ─── Fakes ──────────────────────────────────────────────────────────────────

const ORG_A = 'org-a';
const ORG_B = 'org-b';

interface FakeAuditRow extends UsageRowLike {
  npiOrgId: string;
}
interface FakeDailyRow extends DailyUsageRowLike {
  npiOrgId: string;
}

function auditRow(overrides: Partial<FakeAuditRow> & Pick<FakeAuditRow, 'ts'>): FakeAuditRow {
  return {
    npiOrgId: ORG_A,
    npiUserId: 'u1',
    event: 'chat',
    modelTier: 'economy',
    modelId: 'claude-haiku-4-5-20251001',
    tokensIn: 0,
    tokensOut: 0,
    costUsdMicro: 0n,
    documentId: null,
    error: null,
    ...overrides,
  };
}

function dailyRow(overrides: Partial<FakeDailyRow> & Pick<FakeDailyRow, 'day'>): FakeDailyRow {
  return {
    npiOrgId: ORG_A,
    npiUserId: 'u1',
    messageCount: 1,
    tokensIn: 0,
    tokensOut: 0,
    costUsdMicro: 0n,
    ...overrides,
  };
}

function pick<T extends object>(row: T, select: Record<string, true>): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(select)) out[key] = (row as Record<string, unknown>)[key];
  return out as Partial<T>;
}

interface Recorded {
  auditFindMany: unknown[];
  auditReturned: UsageRowLike[][];
  usageFindUnique: unknown[];
  usageFindMany: unknown[];
}

function buildFakeDb(seed: { audit: FakeAuditRow[]; daily?: FakeDailyRow[] }) {
  const calls: Recorded = { auditFindMany: [], auditReturned: [], usageFindUnique: [], usageFindMany: [] };
  const daily = seed.daily ?? [];

  const matchesAudit = (r: FakeAuditRow, where: UsageAuditWhere): boolean => {
    if (r.npiOrgId !== where.npiOrgId) return false;
    if (where.ts !== undefined && (r.ts < where.ts.gte || r.ts >= where.ts.lt)) return false;
    if (where.npiUserId !== undefined && r.npiUserId !== where.npiUserId) return false;
    if (where.documentId !== undefined && r.documentId !== where.documentId) return false;
    return true;
  };

  const db: UsageDb = {
    llmAudit: {
      async findMany(args) {
        calls.auditFindMany.push(args);
        const rows = seed.audit
          .filter((r) => matchesAudit(r, args.where))
          .sort((a, b) => a.ts.getTime() - b.ts.getTime())
          .map((r) => pick(r, args.select) as UsageRowLike);
        calls.auditReturned.push(rows);
        return rows;
      },
    },
    dailyUsage: {
      async findUnique(args) {
        calls.usageFindUnique.push(args);
        const { npiUserId, day } = args.where.npiUserId_day;
        const found = daily.find((r) => r.npiUserId === npiUserId && r.day.getTime() === day.getTime());
        return found ? { tokensIn: found.tokensIn, tokensOut: found.tokensOut } : null;
      },
      async findMany(args) {
        calls.usageFindMany.push(args);
        const { npiOrgId, day } = args.where;
        return daily
          .filter((r) => r.npiOrgId === npiOrgId && r.day >= day.gte && r.day < day.lt)
          .sort((a, b) => a.day.getTime() - b.day.getTime() || (a.npiUserId < b.npiUserId ? -1 : a.npiUserId > b.npiUserId ? 1 : 0))
          .map((r) => pick(r, args.select) as DailyUsageRowLike);
      },
    },
  };
  return { db, calls };
}

// Riyadh day 1 = 2026-03-02 = [2026-03-01T21:00Z, 2026-03-02T21:00Z); day 2 = 2026-03-03.
const PERIOD = { from: new Date('2026-03-01T21:00:00.000Z'), to: new Date('2026-03-03T21:00:00.000Z') };

// Deliberately not in ts order: the fake sorts by the `orderBy` it is given.
const FIXTURE: FakeAuditRow[] = [
  auditRow({
    ts: new Date('2026-03-03T08:00:00.000Z'),
    npiUserId: 'u1',
    event: 'chat',
    tokensIn: 50,
    tokensOut: 20,
    costUsdMicro: 100n,
  }),
  auditRow({
    ts: new Date('2026-03-02T21:00:00.000Z'),
    npiUserId: 'u2',
    event: 'extract_po',
    modelTier: 'advanced',
    modelId: 'claude-sonnet-5',
    tokensIn: 300,
    tokensOut: 100,
    costUsdMicro: 1600n,
    documentId: 'doc-1',
  }),
  auditRow({
    ts: new Date('2026-03-02T05:00:00.000Z'),
    npiUserId: 'u1',
    event: 'chat',
    tokensIn: 100,
    tokensOut: 50,
    costUsdMicro: 150n,
  }),
  auditRow({
    ts: new Date('2026-03-02T20:59:59.999Z'),
    npiUserId: 'u2',
    event: 'extract_pr',
    tokensIn: 200,
    tokensOut: 100,
    costUsdMicro: 700n,
    documentId: 'doc-2',
  }),
  auditRow({
    ts: new Date('2026-03-02T06:00:00.000Z'),
    npiUserId: 'u1',
    event: 'extract_vendor_bill',
    modelTier: 'advanced',
    modelId: 'claude-sonnet-5',
    tokensIn: 1000,
    tokensOut: 200,
    costUsdMicro: 4000n,
    documentId: 'doc-1',
  }),
  // A system row on doc-1, earlier than any model call on it.
  auditRow({
    ts: new Date('2026-03-02T04:00:00.000Z'),
    npiUserId: 'u1',
    event: 'refused_confidential',
    modelTier: null,
    modelId: null,
    documentId: 'doc-1',
  }),
  // The gate refused: no model, no tokens.
  auditRow({
    ts: new Date('2026-03-03T09:00:00.000Z'),
    npiUserId: 'u2',
    event: 'cap_reached',
    modelTier: null,
    modelId: null,
  }),
  // A failed model attempt: counted as a call and as an error, no tokens.
  auditRow({
    ts: new Date('2026-03-03T10:00:00.000Z'),
    npiUserId: 'u1',
    event: 'extract_grn',
    documentId: 'doc-3',
    error: 'timeout',
  }),
  auditRow({
    ts: new Date('2026-03-03T11:00:00.000Z'),
    npiUserId: 'u1',
    event: 'setup_parse',
    modelTier: 'advanced',
    modelId: 'claude-sonnet-5',
    tokensIn: 10,
    tokensOut: 10,
    costUsdMicro: 40n,
  }),
  // Another organization, same document id as org A's doc-1 and huge numbers.
  auditRow({
    ts: new Date('2026-03-02T07:00:00.000Z'),
    npiOrgId: ORG_B,
    npiUserId: 'u3',
    event: 'extract_vendor_bill',
    modelTier: 'advanced',
    modelId: 'claude-sonnet-5',
    tokensIn: 9999,
    tokensOut: 9999,
    costUsdMicro: 99999n,
    documentId: 'doc-1',
  }),
];

const ORG_A_ROW_COUNT = FIXTURE.filter((r) => r.npiOrgId === ORG_A).length;

// ─── loadUsageReport ────────────────────────────────────────────────────────

describe('loadUsageReport', () => {
  it('passes exactly the organization, the half-open period, ts-ascending order and the counter columns (no npiUserId key when unscoped)', async () => {
    const { db, calls } = buildFakeDb({ audit: FIXTURE });
    await loadUsageReport(db, { npiOrgId: ORG_A }, PERIOD);
    expect(calls.auditFindMany).toHaveLength(1);
    expect(calls.auditFindMany[0]).toStrictEqual({
      where: { npiOrgId: ORG_A, ts: { gte: PERIOD.from, lt: PERIOD.to } },
      orderBy: { ts: 'asc' },
      select: USAGE_AUDIT_SELECT,
    });
    const where = (calls.auditFindMany[0] as { where: Record<string, unknown> }).where;
    expect(Object.keys(where).sort()).toEqual(['npiOrgId', 'ts']);
  });

  it('adds npiUserId, and only npiUserId, when scoped to one employee', async () => {
    const { db, calls } = buildFakeDb({ audit: FIXTURE });
    await loadUsageReport(db, { npiOrgId: ORG_A, npiUserId: 'u2' }, PERIOD);
    expect(calls.auditFindMany[0]).toStrictEqual({
      where: { npiOrgId: ORG_A, ts: { gte: PERIOD.from, lt: PERIOD.to }, npiUserId: 'u2' },
      orderBy: { ts: 'asc' },
      select: USAGE_AUDIT_SELECT,
    });
    const where = (calls.auditFindMany[0] as { where: Record<string, unknown> }).where;
    expect('documentId' in where).toBe(false);
  });

  it('returns aggregateUsage over the rows the fake returned, with the figures worked out by hand', async () => {
    const { db, calls } = buildFakeDb({ audit: FIXTURE });
    const report = await loadUsageReport(db, { npiOrgId: ORG_A }, PERIOD);

    expect(report).toStrictEqual(aggregateUsage(calls.auditReturned[0] ?? [], PERIOD));

    // Org B's row never reached the fake's result for org A.
    expect(calls.auditReturned[0]).toHaveLength(ORG_A_ROW_COUNT);
    expect((calls.auditReturned[0] ?? []).some((r) => r.npiUserId === 'u3')).toBe(false);

    expect(report.totals).toEqual({
      calls: 7,
      errors: 1,
      capReached: 1,
      tokensIn: 1660,
      tokensOut: 480,
      costUsdMicro: 6590n,
    });
    expect(report.byUser.map((b) => b.key)).toEqual(['u1', 'u2']);
    expect(report.byDocument.map((b) => b.key)).toEqual(['doc-1', 'doc-2', 'doc-3']);
    expect(report.byDocument[0]?.costUsdMicro).toBe(5600n); // org A's doc-1 only, not org B's 99999
    expect(report.projection.windowDays).toBe(2);
  });

  it('splits the Riyadh days at 21:00Z: 20:59:59.999Z is day 1, 21:00:00.000Z is day 2', async () => {
    const { db } = buildFakeDb({ audit: FIXTURE });
    const report = await loadUsageReport(db, { npiOrgId: ORG_A }, PERIOD);
    expect(report.byDay).toEqual([
      { key: '2026-03-02', calls: 3, tokensIn: 1300, tokensOut: 350, costUsdMicro: 4850n },
      { key: '2026-03-03', calls: 4, tokensIn: 360, tokensOut: 130, costUsdMicro: 1740n },
    ]);
  });

  it('keeps both tiers in the report with the right sums', async () => {
    const { db } = buildFakeDb({ audit: FIXTURE });
    const report = await loadUsageReport(db, { npiOrgId: ORG_A }, PERIOD);
    expect(report.byTier.map((b) => b.key)).toEqual(['economy', 'advanced']);
    expect(report.byTier[0]).toMatchObject({ calls: 4, tokensIn: 350, tokensOut: 170, costUsdMicro: 950n });
    expect(report.byTier[1]).toMatchObject({ calls: 3, tokensIn: 1310, tokensOut: 310, costUsdMicro: 5640n });
  });

  it('never lets organization B into organization A report, and org B sees only its own row', async () => {
    const { db, calls } = buildFakeDb({ audit: FIXTURE });
    const a = await loadUsageReport(db, { npiOrgId: ORG_A }, PERIOD);
    const b = await loadUsageReport(db, { npiOrgId: ORG_B }, PERIOD);
    expect(a.totals.costUsdMicro).toBe(6590n);
    expect(b.totals).toEqual({ calls: 1, errors: 0, capReached: 0, tokensIn: 9999, tokensOut: 9999, costUsdMicro: 99999n });
    expect(b.byUser.map((u) => u.key)).toEqual(['u3']);
    for (const recorded of calls.auditFindMany) {
      expect(typeof (recorded as { where: UsageAuditWhere }).where.npiOrgId).toBe('string');
    }
  });

  it('scoped to one user reports only that user', async () => {
    const { db } = buildFakeDb({ audit: FIXTURE });
    const report = await loadUsageReport(db, { npiOrgId: ORG_A, npiUserId: 'u2' }, PERIOD);
    expect(report.byUser.map((u) => u.key)).toEqual(['u2']);
    expect(report.totals).toMatchObject({ calls: 2, capReached: 1, costUsdMicro: 2300n });
  });

  it('excludes a row exactly at period.to and includes one exactly at period.from', async () => {
    const edge = [
      auditRow({ ts: new Date('2026-03-01T21:00:00.000Z'), tokensIn: 1, costUsdMicro: 1n }),
      auditRow({ ts: new Date('2026-03-03T21:00:00.000Z'), tokensIn: 2, costUsdMicro: 2n }),
    ];
    const { db } = buildFakeDb({ audit: edge });
    const report = await loadUsageReport(db, { npiOrgId: ORG_A }, PERIOD);
    expect(report.totals.calls).toBe(1);
    expect(report.totals.costUsdMicro).toBe(1n);
  });
});

// ─── loadDocumentUsage ──────────────────────────────────────────────────────

describe('loadDocumentUsage', () => {
  it('queries by organization and document with no time bound', async () => {
    const { db, calls } = buildFakeDb({ audit: FIXTURE });
    await loadDocumentUsage(db, { npiOrgId: ORG_A, documentId: 'doc-1' });
    expect(calls.auditFindMany[0]).toStrictEqual({
      where: { npiOrgId: ORG_A, documentId: 'doc-1' },
      orderBy: { ts: 'asc' },
      select: USAGE_AUDIT_SELECT,
    });
    const where = (calls.auditFindMany[0] as { where: Record<string, unknown> }).where;
    expect('ts' in where).toBe(false);
  });

  it('bounds firstTs and lastTs by the first and last row, a system row included', async () => {
    const { db, calls } = buildFakeDb({ audit: FIXTURE });
    const usage = await loadDocumentUsage(db, { npiOrgId: ORG_A, documentId: 'doc-1' });
    expect(calls.auditReturned[0]).toHaveLength(3); // system row + two model calls
    expect(usage.documentId).toBe('doc-1');
    expect(usage.firstTs).toEqual(new Date('2026-03-02T04:00:00.000Z')); // the system row
    expect(usage.lastTs).toEqual(new Date('2026-03-02T21:00:00.000Z'));
  });

  it('matches aggregateUsage over the document rows and excludes the other organization document of the same id', async () => {
    const { db, calls } = buildFakeDb({ audit: FIXTURE });
    const usage = await loadDocumentUsage(db, { npiOrgId: ORG_A, documentId: 'doc-1' });
    const rows = calls.auditReturned[0] ?? [];
    const first = rows[0];
    const last = rows[rows.length - 1];
    if (first === undefined || last === undefined) throw new Error('fixture has no doc-1 rows');
    const expected = aggregateUsage(rows, { from: first.ts, to: new Date(last.ts.getTime() + 1) });

    expect(usage.totals).toStrictEqual(expected.totals);
    expect(usage.byDay).toStrictEqual(expected.byDay);
    expect(usage.byTier).toStrictEqual(expected.byTier);
    expect(usage.byFlow).toStrictEqual(expected.byFlow);

    expect(usage.totals).toEqual({
      calls: 2,
      errors: 0,
      capReached: 0,
      tokensIn: 1300,
      tokensOut: 300,
      costUsdMicro: 5600n,
    });
    expect(usage.byDay.map((b) => b.key)).toEqual(['2026-03-02', '2026-03-03']);
    expect(usage.byFlow.map((b) => b.key)).toEqual(['po', 'vendor_bill']);
  });

  it('reports zeros and null bounds for a document that only another organization has', async () => {
    const { db } = buildFakeDb({ audit: FIXTURE });
    const usage = await loadDocumentUsage(db, { npiOrgId: ORG_B, documentId: 'doc-3' });
    expect(usage.totals.calls).toBe(0);
    expect(usage.totals.costUsdMicro).toBe(0n);
    expect(usage.firstTs).toBeNull();
    expect(usage.lastTs).toBeNull();
  });

  it('returns the zero shapes for a document without rows, with both tiers as zero buckets', async () => {
    const { db } = buildFakeDb({ audit: FIXTURE });
    const usage = await loadDocumentUsage(db, { npiOrgId: ORG_A, documentId: 'doc-none' });
    expect(usage).toStrictEqual({
      documentId: 'doc-none',
      totals: { calls: 0, errors: 0, capReached: 0, tokensIn: 0, tokensOut: 0, costUsdMicro: 0n },
      byDay: [],
      byTier: [
        { key: 'economy', calls: 0, tokensIn: 0, tokensOut: 0, costUsdMicro: 0n },
        { key: 'advanced', calls: 0, tokensIn: 0, tokensOut: 0, costUsdMicro: 0n },
      ],
      byFlow: [],
      firstTs: null,
      lastTs: null,
    });
  });

  it('counts a document with a single row (first equals last) inside its own one-millisecond period', async () => {
    const single = [
      auditRow({ ts: new Date('2026-03-02T05:00:00.000Z'), tokensIn: 5, tokensOut: 6, costUsdMicro: 7n, documentId: 'doc-x' }),
    ];
    const { db } = buildFakeDb({ audit: single });
    const usage = await loadDocumentUsage(db, { npiOrgId: ORG_A, documentId: 'doc-x' });
    expect(usage.totals).toMatchObject({ calls: 1, tokensIn: 5, tokensOut: 6, costUsdMicro: 7n });
    expect(usage.firstTs).toEqual(usage.lastTs);
  });
});

// ─── loadCapStatus ──────────────────────────────────────────────────────────

describe('loadCapStatus', () => {
  const DAILY: FakeDailyRow[] = [
    dailyRow({ npiUserId: 'u1', day: new Date('2026-03-02T00:00:00.000Z'), tokensIn: 400_000, tokensOut: 200_000 }),
    dailyRow({ npiUserId: 'u2', day: new Date('2026-03-02T00:00:00.000Z'), tokensIn: 1_000, tokensOut: 500 }),
  ];

  it('keys the lookup by the user and the Riyadh day of now: 20:59:59.999Z is 2026-03-02, 21:00:00.000Z is 2026-03-03', async () => {
    const { db, calls } = buildFakeDb({ audit: [], daily: DAILY });
    const before = new Date('2026-03-02T20:59:59.999Z');
    const after = new Date('2026-03-02T21:00:00.000Z');
    const a = await loadCapStatus(db, { npiUserId: 'u1', cap: 600_000, now: before });
    const b = await loadCapStatus(db, { npiUserId: 'u1', cap: 600_000, now: after });

    expect(calls.usageFindUnique[0]).toStrictEqual({
      where: { npiUserId_day: { npiUserId: 'u1', day: riyadhDay(before) } },
      select: { tokensIn: true, tokensOut: true },
    });
    expect(riyadhDay(before)).toEqual(new Date('2026-03-02T00:00:00.000Z'));
    expect(calls.usageFindUnique[1]).toStrictEqual({
      where: { npiUserId_day: { npiUserId: 'u1', day: new Date('2026-03-03T00:00:00.000Z') } },
      select: { tokensIn: true, tokensOut: true },
    });
    expect(a.day).toBe('2026-03-02');
    expect(b.day).toBe('2026-03-03');
    // The next day has no row yet: back to zero.
    expect(a.used).toBe(600_000);
    expect(b.used).toBe(0);
  });

  it('reports not reached with used 0 and no message when the user has no row', async () => {
    const { db } = buildFakeDb({ audit: [], daily: DAILY });
    const status = await loadCapStatus(db, { npiUserId: 'nobody', cap: 600_000, now: new Date('2026-03-02T10:00:00.000Z') });
    expect(status).toEqual({
      day: '2026-03-02',
      cap: 600_000,
      used: 0,
      remaining: 600_000,
      share: 0,
      reached: false,
      messageAr: null,
    });
  });

  it('reports reached with the gate message when the day sits exactly on the cap', async () => {
    const { db } = buildFakeDb({ audit: [], daily: DAILY });
    const status = await loadCapStatus(db, { npiUserId: 'u1', cap: 600_000, now: new Date('2026-03-02T10:00:00.000Z') });
    expect(status.reached).toBe(true);
    expect(status.used).toBe(600_000);
    expect(status.remaining).toBe(0);
    expect(status.share).toBe(1);
    expect(status.messageAr).toBe(CAP_REACHED_MESSAGE_AR);
  });

  it('reports the cap it was given, not a default', async () => {
    const { db } = buildFakeDb({ audit: [], daily: DAILY });
    const status = await loadCapStatus(db, { npiUserId: 'u2', cap: 123, now: new Date('2026-03-02T10:00:00.000Z') });
    expect(status.cap).toBe(123);
    expect(status.used).toBe(1_500);
    expect(status.reached).toBe(true);
    expect(status.messageAr).toBe(CAP_REACHED_MESSAGE_AR);
  });

  it('leaves a user under the cap with the remaining tokens and no message', async () => {
    const { db } = buildFakeDb({ audit: [], daily: DAILY });
    const status = await loadCapStatus(db, { npiUserId: 'u2', cap: 600_000, now: new Date('2026-03-02T10:00:00.000Z') });
    expect(status.reached).toBe(false);
    expect(status.used).toBe(1_500);
    expect(status.remaining).toBe(598_500);
    expect(status.messageAr).toBeNull();
  });
});

// ─── loadDailyUsage ─────────────────────────────────────────────────────────

describe('loadDailyUsage', () => {
  const D1 = new Date('2026-03-02T00:00:00.000Z');
  const D2 = new Date('2026-03-03T00:00:00.000Z');
  const DAILY: FakeDailyRow[] = [
    dailyRow({ npiUserId: 'u2', day: D2, messageCount: 4, tokensIn: 40, tokensOut: 4, costUsdMicro: 400n }),
    dailyRow({ npiUserId: 'u2', day: D1, messageCount: 2, tokensIn: 20, tokensOut: 2, costUsdMicro: 200n }),
    dailyRow({ npiUserId: 'u1', day: D2, messageCount: 3, tokensIn: 30, tokensOut: 3, costUsdMicro: 300n }),
    dailyRow({ npiUserId: 'u1', day: D1, messageCount: 1, tokensIn: 10, tokensOut: 1, costUsdMicro: 123456789012n }),
    dailyRow({ npiUserId: 'u1', day: new Date('2026-03-01T00:00:00.000Z'), messageCount: 9 }), // before the period
    dailyRow({ npiUserId: 'u1', day: new Date('2026-03-04T00:00:00.000Z'), messageCount: 9 }), // after the period
    dailyRow({ npiOrgId: ORG_B, npiUserId: 'u9', day: D1, messageCount: 77 }),
  ];

  it('asks for the Riyadh days the period touches: [2026-03-01T21:00Z, 2026-03-03T21:00Z) is gte 2026-03-02, lt 2026-03-04', async () => {
    const { db, calls } = buildFakeDb({ audit: [], daily: DAILY });
    await loadDailyUsage(db, { npiOrgId: ORG_A }, PERIOD);
    expect(calls.usageFindMany[0]).toStrictEqual({
      where: {
        npiOrgId: ORG_A,
        day: { gte: new Date('2026-03-02T00:00:00.000Z'), lt: new Date('2026-03-04T00:00:00.000Z') },
      },
      orderBy: [{ day: 'asc' }, { npiUserId: 'asc' }],
      select: DAILY_USAGE_SELECT,
    });
  });

  it('asks for exactly one day when the period sits inside one Riyadh day', async () => {
    const { db, calls } = buildFakeDb({ audit: [], daily: DAILY });
    const rows = await loadDailyUsage(
      db,
      { npiOrgId: ORG_A },
      { from: new Date('2026-03-02T05:00:00.000Z'), to: new Date('2026-03-02T10:00:00.000Z') },
    );
    expect((calls.usageFindMany[0] as { where: { day: unknown } }).where.day).toStrictEqual({
      gte: new Date('2026-03-02T00:00:00.000Z'),
      lt: new Date('2026-03-03T00:00:00.000Z'),
    });
    expect(rows.map((r) => r.day)).toEqual(['2026-03-02', '2026-03-02']);
  });

  it('does not take the day after when the period ends exactly at a Riyadh midnight', async () => {
    const { db, calls } = buildFakeDb({ audit: [], daily: DAILY });
    await loadDailyUsage(
      db,
      { npiOrgId: ORG_A },
      { from: new Date('2026-03-01T21:00:00.000Z'), to: new Date('2026-03-02T21:00:00.000Z') },
    );
    expect((calls.usageFindMany[0] as { where: { day: unknown } }).where.day).toStrictEqual({
      gte: new Date('2026-03-02T00:00:00.000Z'),
      lt: new Date('2026-03-03T00:00:00.000Z'),
    });
  });

  it('treats an empty period as the one day it sits in', async () => {
    const { db, calls } = buildFakeDb({ audit: [], daily: DAILY });
    const at = new Date('2026-03-02T05:00:00.000Z');
    await loadDailyUsage(db, { npiOrgId: ORG_A }, { from: at, to: at });
    expect((calls.usageFindMany[0] as { where: { day: unknown } }).where.day).toStrictEqual({
      gte: new Date('2026-03-02T00:00:00.000Z'),
      lt: new Date('2026-03-03T00:00:00.000Z'),
    });
  });

  it('returns day ascending, then user ascending, with the day as a key and the cost as a string', async () => {
    const { db } = buildFakeDb({ audit: [], daily: DAILY });
    const rows = await loadDailyUsage(db, { npiOrgId: ORG_A }, PERIOD);
    expect(rows).toStrictEqual([
      { npiUserId: 'u1', day: '2026-03-02', messageCount: 1, tokensIn: 10, tokensOut: 1, costUsdMicro: '123456789012' },
      { npiUserId: 'u2', day: '2026-03-02', messageCount: 2, tokensIn: 20, tokensOut: 2, costUsdMicro: '200' },
      { npiUserId: 'u1', day: '2026-03-03', messageCount: 3, tokensIn: 30, tokensOut: 3, costUsdMicro: '300' },
      { npiUserId: 'u2', day: '2026-03-03', messageCount: 4, tokensIn: 40, tokensOut: 4, costUsdMicro: '400' },
    ]);
  });

  it('never returns another organization rows, and org B gets only its own', async () => {
    const { db } = buildFakeDb({ audit: [], daily: DAILY });
    const a = await loadDailyUsage(db, { npiOrgId: ORG_A }, PERIOD);
    const b = await loadDailyUsage(db, { npiOrgId: ORG_B }, PERIOD);
    expect(a.some((r) => r.npiUserId === 'u9')).toBe(false);
    expect(b).toStrictEqual([
      { npiUserId: 'u9', day: '2026-03-02', messageCount: 77, tokensIn: 0, tokensOut: 0, costUsdMicro: '0' },
    ]);
  });
});
