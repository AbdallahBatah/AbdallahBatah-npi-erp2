// T-34 part B against the real local `npi_copilot` database (not a mock): the
// usage counter's readers over rows seeded the way the gate writes them.
// Like tests/audit-db.spec.ts these must FAIL — not silently skip — when the
// database is unreachable, so no try/catch swallows a connection error.
import './helpers/load-env';
import { CAP_REACHED_MESSAGE_AR, riyadhDay } from '../src/audit/cost';
import { getDb } from '../src/db';
import { costUsdMicro } from '../src/llm/pricing';
import {
  loadCapStatus,
  loadDailyUsage,
  loadDocumentUsage,
  loadUsageReport,
  type UsageDb,
} from '../src/queries/usage';

const db = getDb();

// No cast: the real Prisma client must satisfy UsageDb as declared
// (the same pattern tests/audit-db.spec.ts proves for AuditQueryDb).
const usageDb: UsageDb = db;

const runId = Math.random().toString(36).slice(2, 10);
const orgId = `test-usage-${runId}`;
const otherOrgId = `test-usage-other-${runId}`;
const user1 = `test-usage-u1-${runId}`;
const user2 = `test-usage-u2-${runId}`;
const otherUser = `test-usage-ox-${runId}`;
const docA = `doc-a-${runId}`;
const docB = `doc-b-${runId}`;

const ECONOMY_MODEL = 'claude-haiku-4-5-20251001';
const ADVANCED_MODEL = 'claude-sonnet-5';

// Riyadh day 1 = 2026-03-02 (instants 05:00Z), day 2 = 2026-03-03 (05:00Z).
const DAY1 = '2026-03-02T05:00:00.000Z';
const PERIOD = { from: new Date('2026-03-01T21:00:00.000Z'), to: new Date('2026-03-03T21:00:00.000Z') };

const createdAuditIds: string[] = [];
const createdUsageIds: string[] = [];

interface Seed {
  ts: string;
  user: string;
  event: string;
  tier: 'economy' | 'advanced' | null;
  tokensIn: number;
  tokensOut: number;
  documentId?: string;
  error?: string;
  org?: string;
}

// Eight model rows: two users x two days x both tiers, plus a failed attempt.
const MODEL_SEEDS: Seed[] = [
  { ts: '2026-03-02T05:00:00.000Z', user: user1, event: 'chat', tier: 'economy', tokensIn: 1000, tokensOut: 500 },
  { ts: '2026-03-02T05:01:00.000Z', user: user1, event: 'extract_vendor_bill', tier: 'advanced', tokensIn: 2000, tokensOut: 800, documentId: docA },
  { ts: '2026-03-03T05:00:00.000Z', user: user1, event: 'chat', tier: 'economy', tokensIn: 3000, tokensOut: 1000 },
  { ts: '2026-03-03T05:01:00.000Z', user: user1, event: 'extract_po', tier: 'advanced', tokensIn: 1500, tokensOut: 600, documentId: docA },
  { ts: '2026-03-02T06:00:00.000Z', user: user2, event: 'extract_pr', tier: 'economy', tokensIn: 800, tokensOut: 200, documentId: docB },
  { ts: '2026-03-02T06:01:00.000Z', user: user2, event: 'chat', tier: 'advanced', tokensIn: 4000, tokensOut: 1500 },
  { ts: '2026-03-03T06:00:00.000Z', user: user2, event: 'chat', tier: 'economy', tokensIn: 600, tokensOut: 300 },
  { ts: '2026-03-03T06:01:00.000Z', user: user2, event: 'setup_parse', tier: 'advanced', tokensIn: 100, tokensOut: 50 },
  // A failed model attempt: counted as a call and as an error, no tokens, no cost.
  { ts: '2026-03-03T07:00:00.000Z', user: user1, event: 'extract_grn', tier: 'economy', tokensIn: 0, tokensOut: 0, error: 'timeout' },
];

function modelOf(tier: 'economy' | 'advanced'): string {
  return tier === 'economy' ? ECONOMY_MODEL : ADVANCED_MODEL;
}

function costOf(seed: Seed): bigint {
  return seed.tier === null ? 0n : costUsdMicro(modelOf(seed.tier), seed.tokensIn, seed.tokensOut);
}

function sum(seeds: Seed[]): { calls: number; tokensIn: number; tokensOut: number; cost: bigint } {
  return seeds.reduce(
    (acc, s) => ({
      calls: acc.calls + 1,
      tokensIn: acc.tokensIn + s.tokensIn,
      tokensOut: acc.tokensOut + s.tokensOut,
      cost: acc.cost + costOf(s),
    }),
    { calls: 0, tokensIn: 0, tokensOut: 0, cost: 0n },
  );
}

async function insertAudit(seed: Seed): Promise<void> {
  const row = await db.llmAudit.create({
    data: {
      ts: new Date(seed.ts),
      npiOrgId: seed.org ?? orgId,
      npiUserId: seed.user,
      documentId: seed.documentId ?? null,
      event: seed.event,
      modelTier: seed.tier,
      modelId: seed.tier === null ? null : modelOf(seed.tier),
      tokensIn: seed.tokensIn,
      tokensOut: seed.tokensOut,
      costUsdMicro: costOf(seed),
      error: seed.error ?? null,
    },
  });
  createdAuditIds.push(row.id);
}

beforeAll(async () => {
  for (const seed of MODEL_SEEDS) await insertAudit(seed);

  // The gate refused user 2 on day 2: a system row, no model.
  await insertAudit({ ts: '2026-03-03T08:00:00.000Z', user: user2, event: 'cap_reached', tier: null, tokensIn: 0, tokensOut: 0 });

  // Another organization, inside the period, with a document of the same id as org A's.
  await insertAudit({
    ts: '2026-03-02T05:30:00.000Z',
    user: otherUser,
    event: 'extract_vendor_bill',
    tier: 'advanced',
    tokensIn: 50_000,
    tokensOut: 20_000,
    documentId: docA,
    org: otherOrgId,
  });

  const usageRows = [
    { npiOrgId: orgId, npiUserId: user1, day: riyadhDay(new Date(DAY1)), messageCount: 7, tokensIn: 400_000, tokensOut: 200_000, costUsdMicro: 123_456_789_012n },
    { npiOrgId: orgId, npiUserId: user2, day: riyadhDay(new Date(DAY1)), messageCount: 2, tokensIn: 1_000, tokensOut: 500, costUsdMicro: 4_321n },
    { npiOrgId: otherOrgId, npiUserId: otherUser, day: riyadhDay(new Date(DAY1)), messageCount: 99, tokensIn: 1, tokensOut: 1, costUsdMicro: 1n },
  ];
  for (const data of usageRows) {
    const created = await db.dailyUsage.create({ data });
    createdUsageIds.push(created.id);
  }
});

afterAll(async () => {
  if (createdAuditIds.length > 0) {
    await db.llmAudit.deleteMany({ where: { id: { in: createdAuditIds } } });
  }
  if (createdUsageIds.length > 0) {
    await db.dailyUsage.deleteMany({ where: { id: { in: createdUsageIds } } });
  }
  await db.$disconnect();
});

describe('the usage readers against the real npi_copilot database', () => {
  it('reports the two-day period: totals, two day keys, two tier sums, documents and users cost-descending, the other organization absent', async () => {
    const report = await loadUsageReport(usageDb, { npiOrgId: orgId }, PERIOD);

    const all = sum(MODEL_SEEDS);
    expect(report.totals).toEqual({
      calls: all.calls,
      errors: 1,
      capReached: 1,
      tokensIn: all.tokensIn,
      tokensOut: all.tokensOut,
      costUsdMicro: all.cost,
    });
    expect(all.calls).toBe(9);

    expect(report.byDay.map((b) => b.key)).toEqual(['2026-03-02', '2026-03-03']);
    const day1 = sum(MODEL_SEEDS.filter((s) => s.ts < '2026-03-02T21:00'));
    const day2 = sum(MODEL_SEEDS.filter((s) => s.ts >= '2026-03-02T21:00'));
    expect(report.byDay[0]).toMatchObject({ calls: day1.calls, tokensIn: day1.tokensIn, tokensOut: day1.tokensOut, costUsdMicro: day1.cost });
    expect(report.byDay[1]).toMatchObject({ calls: day2.calls, tokensIn: day2.tokensIn, tokensOut: day2.tokensOut, costUsdMicro: day2.cost });

    expect(report.byTier.map((b) => b.key)).toEqual(['economy', 'advanced']);
    const economy = sum(MODEL_SEEDS.filter((s) => s.tier === 'economy'));
    const advanced = sum(MODEL_SEEDS.filter((s) => s.tier === 'advanced'));
    expect(report.byTier[0]).toMatchObject({ calls: economy.calls, tokensIn: economy.tokensIn, tokensOut: economy.tokensOut, costUsdMicro: economy.cost });
    expect(report.byTier[1]).toMatchObject({ calls: advanced.calls, tokensIn: advanced.tokensIn, tokensOut: advanced.tokensOut, costUsdMicro: advanced.cost });

    // docA (two advanced calls) costs more than docB (one economy call); the
    // other organization's docA is not in here.
    const a = sum(MODEL_SEEDS.filter((s) => s.documentId === docA));
    const b = sum(MODEL_SEEDS.filter((s) => s.documentId === docB));
    expect(a.cost > b.cost).toBe(true);
    expect(report.byDocument).toHaveLength(2);
    expect(report.byDocument[0]).toMatchObject({ key: docA, calls: 2, costUsdMicro: a.cost });
    expect(report.byDocument[1]).toMatchObject({ key: docB, calls: 1, costUsdMicro: b.cost });

    const u1 = sum(MODEL_SEEDS.filter((s) => s.user === user1));
    const u2 = sum(MODEL_SEEDS.filter((s) => s.user === user2));
    const expectedUsers = [
      { key: user1, cost: u1.cost, calls: u1.calls },
      { key: user2, cost: u2.cost, calls: u2.calls },
    ].sort((x, y) => (x.cost === y.cost ? 0 : x.cost > y.cost ? -1 : 1));
    expect(report.byUser.map((u) => u.key)).toEqual(expectedUsers.map((u) => u.key));
    expect(report.byUser.map((u) => u.costUsdMicro)).toEqual(expectedUsers.map((u) => u.cost));
    expect(report.byUser.some((u) => u.key === otherUser)).toBe(false);

    expect(report.projection.windowDays).toBe(2);
    expect(report.projection.monthlyUsdMicro).toBe((all.cost * 30n) / 2n);
  });

  it('scoped to one user reports only that user', async () => {
    const report = await loadUsageReport(usageDb, { npiOrgId: orgId, npiUserId: user2 }, PERIOD);
    const u2 = MODEL_SEEDS.filter((s) => s.user === user2);
    const expected = sum(u2);
    expect(report.byUser.map((u) => u.key)).toEqual([user2]);
    expect(report.totals).toMatchObject({
      calls: expected.calls,
      capReached: 1,
      tokensIn: expected.tokensIn,
      tokensOut: expected.tokensOut,
      costUsdMicro: expected.cost,
    });
  });

  it('reports the other organization on its own', async () => {
    const report = await loadUsageReport(usageDb, { npiOrgId: otherOrgId }, PERIOD);
    expect(report.totals.calls).toBe(1);
    expect(report.byUser.map((u) => u.key)).toEqual([otherUser]);
    expect(report.byDocument.map((d) => d.key)).toEqual([docA]);
  });

  it('counts a document over its whole life: two calls on docA, first and last ts, the other organization docA excluded', async () => {
    const usage = await loadDocumentUsage(usageDb, { npiOrgId: orgId, documentId: docA });
    const a = sum(MODEL_SEEDS.filter((s) => s.documentId === docA));
    expect(usage.totals).toMatchObject({ calls: 2, tokensIn: a.tokensIn, tokensOut: a.tokensOut, costUsdMicro: a.cost });
    expect(usage.firstTs).toEqual(new Date('2026-03-02T05:01:00.000Z'));
    expect(usage.lastTs).toEqual(new Date('2026-03-03T05:01:00.000Z'));
    expect(usage.byDay.map((b) => b.key)).toEqual(['2026-03-02', '2026-03-03']);
    expect(usage.byFlow.map((b) => b.key)).toEqual(['po', 'vendor_bill']);
    expect(usage.byTier[0]).toMatchObject({ key: 'economy', calls: 0 });
    expect(usage.byTier[1]).toMatchObject({ key: 'advanced', calls: 2 });
  });

  it('returns the zero shapes for a document that does not exist', async () => {
    const usage = await loadDocumentUsage(usageDb, { npiOrgId: orgId, documentId: `doc-none-${runId}` });
    expect(usage.totals.calls).toBe(0);
    expect(usage.firstTs).toBeNull();
    expect(usage.lastTs).toBeNull();
    expect(usage.byTier.map((b) => b.key)).toEqual(['economy', 'advanced']);
  });

  it('reports the capped user as reached with the gate message, and the other user as not reached', async () => {
    const now = new Date('2026-03-02T10:00:00.000Z');
    const capped = await loadCapStatus(usageDb, { npiUserId: user1, cap: 600_000, now });
    expect(capped).toEqual({
      day: '2026-03-02',
      cap: 600_000,
      used: 600_000,
      remaining: 0,
      share: 1,
      reached: true,
      messageAr: CAP_REACHED_MESSAGE_AR,
    });

    const other = await loadCapStatus(usageDb, { npiUserId: user2, cap: 600_000, now });
    expect(other.used).toBe(1_500);
    expect(other.remaining).toBe(598_500);
    expect(other.reached).toBe(false);
    expect(other.messageAr).toBeNull();

    // The next Riyadh day starts at 21:00Z: no row yet, back to zero.
    const nextDay = await loadCapStatus(usageDb, { npiUserId: user1, cap: 600_000, now: new Date('2026-03-02T21:00:00.000Z') });
    expect(nextDay.day).toBe('2026-03-03');
    expect(nextDay.used).toBe(0);
    expect(nextDay.reached).toBe(false);
  });

  it('reads the per-user-per-day accumulator: the two rows of the organization, day then user ascending', async () => {
    const rows = await loadDailyUsage(usageDb, { npiOrgId: orgId }, PERIOD);
    expect(rows).toEqual([
      { npiUserId: user1, day: '2026-03-02', messageCount: 7, tokensIn: 400_000, tokensOut: 200_000, costUsdMicro: '123456789012' },
      { npiUserId: user2, day: '2026-03-02', messageCount: 2, tokensIn: 1_000, tokensOut: 500, costUsdMicro: '4321' },
    ]);
  });

  it('finds no accumulator rows in a period before the seed days', async () => {
    const rows = await loadDailyUsage(
      usageDb,
      { npiOrgId: orgId },
      { from: new Date('2026-02-01T00:00:00.000Z'), to: new Date('2026-02-02T00:00:00.000Z') },
    );
    expect(rows).toEqual([]);
  });
});
