// T-34 (F-18, G-M4-3): the usage counter's pure suite - Riyadh day arithmetic,
// event -> flow mapping, aggregation over llm_audit rows, JSON-safe
// serialization, the cap arithmetic - plus the proof that the gate in
// src/llm/client.ts and the counter agree on «a day» and «reached».
// No database, no network, no model, no process.env: env objects are passed in.
import {
  CAP_REACHED_MESSAGE_AR,
  PROJECTION_MONTH_DAYS,
  RIYADH_OFFSET_MS,
  aggregateUsage,
  capStatus,
  dayKeyOf,
  flowOfEvent,
  isUsageTier,
  riyadhDay,
  riyadhDayCount,
  riyadhDayKey,
  riyadhDayPeriod,
  riyadhTrailingPeriod,
  serializeUsageReport,
  usageFlowLabelAr,
} from '../src/audit/cost';
import { USAGE_FLOWS, USAGE_TIERS, type UsageBucket, type UsageRowLike } from '../src/audit/usage-types';
import { t } from '../src/i18n/ar';
import { createLlmClient, dailyTokenCap, type LlmAuditData, type LlmContext, type LlmDb } from '../src/llm/client';
import type { ModelProvider, ModelResponse, ProviderCall, RedactedRequest } from '../src/llm/provider';
import { costUsdMicro } from '../src/llm/pricing';
import { staticPrompt } from '../src/privacy/pseudonymizer';

const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-5';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// ─── fixtures ───────────────────────────────────────────────────────────────

function row(overrides: Partial<UsageRowLike> = {}): UsageRowLike {
  return {
    ts: new Date('2026-03-02T06:00:00.000Z'),
    npiUserId: 'u1',
    event: 'chat',
    modelTier: 'economy',
    modelId: HAIKU,
    tokensIn: 100,
    tokensOut: 50,
    costUsdMicro: costUsdMicro(HAIKU, 100, 50),
    documentId: null,
    error: null,
    ...overrides,
  };
}

/** A priced model call: cost always derived from the pricing table. */
function call(
  model: typeof HAIKU | typeof SONNET,
  tokensIn: number,
  tokensOut: number,
  overrides: Partial<UsageRowLike> = {},
): UsageRowLike {
  return row({
    modelId: model,
    modelTier: model === SONNET ? 'advanced' : 'economy',
    tokensIn,
    tokensOut,
    costUsdMicro: costUsdMicro(model, tokensIn, tokensOut),
    ...overrides,
  });
}

function systemRow(event: string, overrides: Partial<UsageRowLike> = {}): UsageRowLike {
  return row({
    event,
    modelId: null,
    modelTier: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsdMicro: 0n,
    ...overrides,
  });
}

const sumBig = (items: readonly { costUsdMicro: bigint }[]): bigint =>
  items.reduce((acc, item) => acc + item.costUsdMicro, 0n);
const sumNum = (items: readonly { tokensIn: number; tokensOut: number }[], field: 'tokensIn' | 'tokensOut'): number =>
  items.reduce((acc, item) => acc + item[field], 0);

function expectBucketsSumTo(
  buckets: readonly UsageBucket[],
  expected: { calls: number; tokensIn: number; tokensOut: number; costUsdMicro: bigint },
): void {
  expect(buckets.reduce((acc, b) => acc + b.calls, 0)).toBe(expected.calls);
  expect(sumNum(buckets, 'tokensIn')).toBe(expected.tokensIn);
  expect(sumNum(buckets, 'tokensOut')).toBe(expected.tokensOut);
  expect(sumBig(buckets)).toBe(expected.costUsdMicro);
}

// The period of the main fixture: Riyadh days 2026-03-02 and 2026-03-03.
const PERIOD = {
  from: new Date('2026-03-01T21:00:00.000Z'),
  to: new Date('2026-03-03T21:00:00.000Z'),
};

function buildFixture(): { rows: UsageRowLike[]; inside: UsageRowLike[]; weird: UsageRowLike } {
  const weird = call(HAIKU, 70, 20, {
    ts: new Date('2026-03-03T14:00:00.000Z'),
    npiUserId: 'u2',
    event: 'chat',
    modelTier: 'weird',
  });
  const inside: UsageRowLike[] = [
    // Riyadh day 2026-03-02
    call(HAIKU, 100, 50, { ts: new Date('2026-03-01T22:00:00.000Z'), npiUserId: 'u1', event: 'chat' }),
    call(SONNET, 2000, 800, {
      ts: new Date('2026-03-02T06:00:00.000Z'),
      npiUserId: 'u1',
      event: 'extract_customer_contract',
      documentId: 'd1',
    }),
    call(SONNET, 1500, 600, {
      ts: new Date('2026-03-02T07:00:00.000Z'),
      npiUserId: 'u2',
      event: 'extract_customer_contract_edit',
      documentId: 'd1',
    }),
    call(HAIKU, 800, 300, {
      ts: new Date('2026-03-02T08:00:00.000Z'),
      npiUserId: 'u2',
      event: 'extract_pr',
      documentId: 'd2',
    }),
    call(HAIKU, 300, 100, { ts: new Date('2026-03-02T09:00:00.000Z'), npiUserId: 'u1', event: 'memory_extract' }),
    // 1 ms before Riyadh midnight: still day 1
    call(SONNET, 1000, 400, {
      ts: new Date('2026-03-02T20:59:59.999Z'),
      npiUserId: 'u1',
      event: 'handover_narrative',
    }),
    // exactly Riyadh midnight: day 2
    call(HAIKU, 200, 80, { ts: new Date('2026-03-02T21:00:00.000Z'), npiUserId: 'u2', event: 'setup_parse' }),
    // Riyadh day 2026-03-03
    call(HAIKU, 120, 60, { ts: new Date('2026-03-03T10:00:00.000Z'), npiUserId: 'u2', event: 'chat' }),
    // a failed call: still a call, zero tokens, zero cost
    row({
      ts: new Date('2026-03-03T11:00:00.000Z'),
      npiUserId: 'u1',
      event: 'extract_vendor_bill',
      modelTier: 'advanced',
      modelId: SONNET,
      tokensIn: 0,
      tokensOut: 0,
      costUsdMicro: 0n,
      documentId: 'd2',
      error: 'timeout',
    }),
    systemRow('cap_reached', { ts: new Date('2026-03-03T12:00:00.000Z'), npiUserId: 'u1' }),
    systemRow('refused_confidential', { ts: new Date('2026-03-03T12:30:00.000Z'), npiUserId: 'u2' }),
    call(HAIKU, 90, 30, { ts: new Date('2026-03-03T13:00:00.000Z'), npiUserId: 'u1', event: 'router' }),
    weird,
  ];
  const outside: UsageRowLike[] = [
    call(SONNET, 900_000, 90_000, { ts: new Date('2026-03-01T20:59:59.999Z'), npiUserId: 'u1', event: 'chat' }),
    call(SONNET, 800_000, 80_000, { ts: new Date('2026-03-03T21:00:00.000Z'), npiUserId: 'u2', event: 'chat' }),
  ];
  // Interleave the outside rows so order never matters.
  const rows = [outside[0], ...inside.slice(0, 6), outside[1], ...inside.slice(6)];
  return { rows, inside, weird };
}

// ─── the day ────────────────────────────────────────────────────────────────

describe('riyadhDay / riyadhDayKey / dayKeyOf', () => {
  it('maps 20:59:59.999Z to the same UTC date and 21:00:00.000Z to the next one', () => {
    expect(riyadhDayKey(new Date('2026-03-01T20:59:59.999Z'))).toBe('2026-03-01');
    expect(riyadhDayKey(new Date('2026-03-01T21:00:00.000Z'))).toBe('2026-03-02');
    expect(riyadhDay(new Date('2026-03-01T20:59:59.999Z')).toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(riyadhDay(new Date('2026-03-01T21:00:00.000Z')).toISOString()).toBe('2026-03-02T00:00:00.000Z');
  });

  it('returns UTC midnight of the Riyadh calendar day', () => {
    const day = riyadhDay(new Date('2026-03-02T15:34:56.789Z'));
    expect(day.getUTCHours()).toBe(0);
    expect(day.getUTCMinutes()).toBe(0);
    expect(day.getUTCSeconds()).toBe(0);
    expect(day.getUTCMilliseconds()).toBe(0);
  });

  it('uses a fixed +3 h offset', () => {
    expect(RIYADH_OFFSET_MS).toBe(3 * HOUR_MS);
  });

  it('dayKeyOf formats a date-only value with no offset applied', () => {
    expect(dayKeyOf(new Date('2026-03-02T00:00:00.000Z'))).toBe('2026-03-02');
    expect(dayKeyOf(riyadhDay(new Date('2026-03-02T05:00:00.000Z')))).toBe('2026-03-02');
  });
});

describe('riyadhDayPeriod / riyadhTrailingPeriod', () => {
  const now = new Date('2026-03-02T05:00:00.000Z');

  it('riyadhDayPeriod is [21:00Z of the previous UTC day, +24 h)', () => {
    const period = riyadhDayPeriod(now);
    expect(period.from.toISOString()).toBe('2026-03-01T21:00:00.000Z');
    expect(period.to.toISOString()).toBe('2026-03-02T21:00:00.000Z');
  });

  it('riyadhTrailingPeriod(now, 7) starts six days before today and ends with today', () => {
    const today = riyadhDayPeriod(now);
    const week = riyadhTrailingPeriod(now, 7);
    expect(week.from.getTime()).toBe(today.from.getTime() - 6 * DAY_MS);
    expect(week.to.getTime()).toBe(today.to.getTime());
  });

  it('treats days of 0 and -3 as 1', () => {
    const today = riyadhDayPeriod(now);
    expect(riyadhTrailingPeriod(now, 0)).toEqual(today);
    expect(riyadhTrailingPeriod(now, -3)).toEqual(today);
    expect(riyadhTrailingPeriod(now, 1)).toEqual(today);
  });
});

describe('riyadhDayCount', () => {
  const now = new Date('2026-03-02T05:00:00.000Z');

  it('counts a same-instant period as one day', () => {
    expect(riyadhDayCount({ from: now, to: now })).toBe(1);
  });

  it('counts exactly one Riyadh day as one', () => {
    expect(riyadhDayCount(riyadhDayPeriod(now))).toBe(1);
  });

  it('counts a period ending 1 ms after Riyadh midnight as two', () => {
    const today = riyadhDayPeriod(now);
    expect(riyadhDayCount({ from: today.from, to: new Date(today.to.getTime() + 1) })).toBe(2);
  });

  it('counts seven full Riyadh days as seven', () => {
    expect(riyadhDayCount(riyadhTrailingPeriod(now, 7))).toBe(7);
  });

  it('counts an inverted period as one', () => {
    const today = riyadhDayPeriod(now);
    expect(riyadhDayCount({ from: today.to, to: today.from })).toBe(1);
  });
});

// ─── the flow ───────────────────────────────────────────────────────────────

describe('flowOfEvent', () => {
  const documentFlows = ['customer_contract', 'pr', 'po', 'grn', 'vendor_bill'] as const;

  it.each(documentFlows)('maps extract_%s and extract_%s_edit to the flow', (flow) => {
    expect(flowOfEvent(`extract_${flow}`)).toBe(flow);
    expect(flowOfEvent(`extract_${flow}_edit`)).toBe(flow);
  });

  it.each([
    ['chat', 'chat'],
    ['setup_parse', 'setup'],
    ['memory_extract', 'memory'],
    ['handover_narrative', 'handover'],
  ] as const)('maps %s to %s', (event, flow) => {
    expect(flowOfEvent(event)).toBe(flow);
  });

  it.each(['router', 'cap_reached', 'refused_confidential', '', 'extract_unknown', 'extract_pr_edit_x'])(
    'maps the unknown event %p to other',
    (event) => {
      expect(flowOfEvent(event)).toBe('other');
    },
  );
});

describe('usageFlowLabelAr', () => {
  it('uses flow.* for the five document flows and usage.flow.* for the rest', () => {
    expect(usageFlowLabelAr('customer_contract')).toBe(t('flow.customer_contract'));
    expect(usageFlowLabelAr('pr')).toBe(t('flow.pr'));
    expect(usageFlowLabelAr('po')).toBe(t('flow.po'));
    expect(usageFlowLabelAr('grn')).toBe(t('flow.grn'));
    expect(usageFlowLabelAr('vendor_bill')).toBe(t('flow.vendor_bill'));
    expect(usageFlowLabelAr('chat')).toBe(t('usage.flow.chat'));
    expect(usageFlowLabelAr('setup')).toBe(t('usage.flow.setup'));
    expect(usageFlowLabelAr('memory')).toBe(t('usage.flow.memory'));
    expect(usageFlowLabelAr('handover')).toBe(t('usage.flow.handover'));
    expect(usageFlowLabelAr('other')).toBe(t('usage.flow.other'));
  });

  it.each([...USAGE_FLOWS])('label of %s is non-empty and contains no Latin letter', (flow) => {
    const label = usageFlowLabelAr(flow);
    expect(label.length).toBeGreaterThan(0);
    expect(/[A-Za-z]/.test(label)).toBe(false);
  });
});

describe('isUsageTier', () => {
  it('accepts exactly the two tiers', () => {
    expect(isUsageTier('economy')).toBe(true);
    expect(isUsageTier('advanced')).toBe(true);
    expect([...USAGE_TIERS]).toEqual(['economy', 'advanced']);
  });

  it.each([null, '', 'Economy', 'vision'])('rejects %p', (value) => {
    expect(isUsageTier(value)).toBe(false);
  });
});

// ─── aggregation ────────────────────────────────────────────────────────────

describe('aggregateUsage: the two-day fixture', () => {
  const { rows, inside, weird } = buildFixture();
  const calls = inside.filter((r) => r.modelId !== null);
  const report = aggregateUsage(rows, PERIOD);

  it('counts the model calls inside the period, the errors and the cap refusals', () => {
    // 13 in-period rows, of which cap_reached and refused_confidential have no model.
    expect(inside).toHaveLength(13);
    expect(calls).toHaveLength(11);
    expect(report.totals.calls).toBe(calls.length);
    expect(report.totals.errors).toBe(1);
    expect(report.totals.capReached).toBe(1);
  });

  it('sums tokens and cost over the calls only, ignoring rows outside [from, to)', () => {
    expect(report.totals.tokensIn).toBe(sumNum(calls, 'tokensIn'));
    expect(report.totals.tokensOut).toBe(sumNum(calls, 'tokensOut'));
    expect(report.totals.costUsdMicro).toBe(sumBig(calls));
    // The two outside rows carry 970,000 + 880,000 tokens; none of it is counted.
    expect(report.totals.tokensIn).toBeLessThan(100_000);
  });

  it('puts the rows 1 ms either side of Riyadh midnight on the right days', () => {
    expect(report.byDay.map((b) => b.key)).toEqual(['2026-03-02', '2026-03-03']);
    const [day1, day2] = report.byDay;
    expect(day1.calls).toBe(6); // chat, contract, contract edit, pr, memory, handover (20:59:59.999Z)
    expect(day2.calls).toBe(5); // setup_parse (21:00:00.000Z), chat, failed bill, router, weird
    const expectedDay1 = calls.filter((r) => riyadhDayKey(r.ts) === '2026-03-02');
    expect(day1.costUsdMicro).toBe(sumBig(expectedDay1));
    expect(day2.costUsdMicro).toBe(sumBig(calls.filter((r) => riyadhDayKey(r.ts) === '2026-03-03')));
    expect(day1.costUsdMicro).toBe(
      costUsdMicro(HAIKU, 100, 50) +
        costUsdMicro(SONNET, 2000, 800) +
        costUsdMicro(SONNET, 1500, 600) +
        costUsdMicro(HAIKU, 800, 300) +
        costUsdMicro(HAIKU, 300, 100) +
        costUsdMicro(SONNET, 1000, 400),
    );
  });

  it('byTier is always [economy, advanced] and leaves the unknown tier to the totals', () => {
    expect(report.byTier.map((b) => b.key)).toEqual(['economy', 'advanced']);
    const [economy, advanced] = report.byTier;
    expect(economy.calls).toBe(6);
    expect(advanced.calls).toBe(4);
    expect(economy.calls + advanced.calls).toBe(report.totals.calls - 1);
    expect(economy.costUsdMicro + advanced.costUsdMicro).toBe(report.totals.costUsdMicro - weird.costUsdMicro);
    expect(weird.costUsdMicro).toBeGreaterThan(0n);
  });

  it('byFlow is in USAGE_FLOWS order with no empty flow, and sums to the totals', () => {
    const keys = report.byFlow.map((b) => b.key);
    expect(keys).toEqual(['customer_contract', 'pr', 'vendor_bill', 'chat', 'setup', 'memory', 'handover', 'other']);
    expect(keys).toEqual(USAGE_FLOWS.filter((flow) => keys.includes(flow)));
    expect(report.byFlow.every((b) => b.calls > 0)).toBe(true);
    expect(report.byFlow.find((b) => b.key === 'customer_contract')?.calls).toBe(2);
    expect(report.byFlow.find((b) => b.key === 'chat')?.calls).toBe(3); // two chat rows + the weird-tier chat row
    expect(report.byFlow.find((b) => b.key === 'other')?.calls).toBe(1); // router
    expect(sumBig(report.byFlow)).toBe(report.totals.costUsdMicro);
  });

  it('byDocument lists only rows with a document, costlier document first', () => {
    expect(report.byDocument.map((b) => b.key)).toEqual(['d1', 'd2']);
    const [d1, d2] = report.byDocument;
    expect(d1.calls).toBe(2);
    expect(d2.calls).toBe(2); // extract_pr + the failed vendor bill
    expect(d1.costUsdMicro).toBe(costUsdMicro(SONNET, 2000, 800) + costUsdMicro(SONNET, 1500, 600));
    expect(d2.costUsdMicro).toBe(costUsdMicro(HAIKU, 800, 300));
    expect(d1.costUsdMicro).toBeGreaterThan(d2.costUsdMicro);
    expect(d1.tokensIn).toBe(3500);
    expect(d2.tokensIn).toBe(800);
  });

  it('byUser is cost descending and every breakdown sums to the totals', () => {
    const costs = report.byUser.map((b) => b.costUsdMicro);
    expect(costs).toEqual([...costs].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0)));
    expect(report.byUser.map((b) => b.key).sort()).toEqual(['u1', 'u2']);

    const expected = {
      calls: report.totals.calls,
      tokensIn: report.totals.tokensIn,
      tokensOut: report.totals.tokensOut,
      costUsdMicro: report.totals.costUsdMicro,
    };
    expectBucketsSumTo(report.byDay, expected);
    expectBucketsSumTo(report.byFlow, expected);
    expectBucketsSumTo(report.byUser, expected);
    expect(report.byUser.find((b) => b.key === 'u1')?.calls).toBe(
      calls.filter((r) => r.npiUserId === 'u1').length,
    );
  });

  it('projects the window average and a 30-day month with bigint flooring', () => {
    expect(PROJECTION_MONTH_DAYS).toBe(30);
    expect(report.projection.windowDays).toBe(2);
    expect(report.projection.dailyAverageUsdMicro).toBe(report.totals.costUsdMicro / 2n);
    expect(report.projection.monthlyUsdMicro).toBe((report.totals.costUsdMicro * 30n) / 2n);
  });

  it('echoes the period by value as fresh Date objects', () => {
    expect(report.period).toEqual(PERIOD);
    expect(report.period).not.toBe(PERIOD);
    expect(report.period.from).not.toBe(PERIOD.from);
    expect(report.period.to).not.toBe(PERIOD.to);
  });

  it('does not depend on the order of the input rows', () => {
    expect(aggregateUsage([...rows].reverse(), PERIOD)).toEqual(report);
  });
});

describe('aggregateUsage: ordering ties and edge inputs', () => {
  const now = new Date('2026-03-02T05:00:00.000Z');
  const today = riyadhDayPeriod(now);

  it('breaks a cost tie by key ascending for users and documents', () => {
    const at = new Date('2026-03-02T06:00:00.000Z');
    const rows = [
      call(HAIKU, 100, 50, { ts: at, npiUserId: 'u-b', documentId: 'doc-b' }),
      call(HAIKU, 100, 50, { ts: at, npiUserId: 'u-a', documentId: 'doc-a' }),
      call(HAIKU, 5000, 1000, { ts: at, npiUserId: 'u-c', documentId: 'doc-c' }),
    ];
    const report = aggregateUsage(rows, today);
    expect(report.byUser.map((b) => b.key)).toEqual(['u-c', 'u-a', 'u-b']);
    expect(report.byDocument.map((b) => b.key)).toEqual(['doc-c', 'doc-a', 'doc-b']);
    expect(report.byUser[1].costUsdMicro).toBe(report.byUser[2].costUsdMicro);
  });

  it('returns zeros and empty breakdowns for an empty iterable', () => {
    const report = aggregateUsage([], today);
    expect(report.totals).toEqual({
      calls: 0,
      errors: 0,
      capReached: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsdMicro: 0n,
    });
    expect(report.byDay).toEqual([]);
    expect(report.byFlow).toEqual([]);
    expect(report.byDocument).toEqual([]);
    expect(report.byUser).toEqual([]);
    expect(report.byTier).toEqual([
      { key: 'economy', calls: 0, tokensIn: 0, tokensOut: 0, costUsdMicro: 0n },
      { key: 'advanced', calls: 0, tokensIn: 0, tokensOut: 0, costUsdMicro: 0n },
    ]);
    expect(report.projection).toEqual({ windowDays: 1, dailyAverageUsdMicro: 0n, monthlyUsdMicro: 0n });
  });

  it('accepts any Iterable: a Set and a generator', () => {
    const a = call(HAIKU, 100, 50, { ts: now, npiUserId: 'u1' });
    const b = call(SONNET, 200, 100, { ts: now, npiUserId: 'u2' });
    const fromArray = aggregateUsage([a, b], today);

    expect(aggregateUsage(new Set([a, b]), today)).toEqual(fromArray);

    function* generate(): Generator<UsageRowLike> {
      yield a;
      yield b;
    }
    expect(aggregateUsage(generate(), today)).toEqual(fromArray);
    expect(fromArray.totals.calls).toBe(2);
  });

  it('floors the integer projection: 1000n over three days is 333n a day and 10000n a month', () => {
    const period = riyadhTrailingPeriod(now, 3);
    const report = aggregateUsage([row({ ts: now, costUsdMicro: 1000n })], period);
    expect(report.totals.costUsdMicro).toBe(1000n);
    expect(report.projection.windowDays).toBe(3);
    expect(report.projection.dailyAverageUsdMicro).toBe(333n);
    expect(report.projection.monthlyUsdMicro).toBe(10000n);
  });

  it('counts a failed call (error set, zero tokens) as a call and an error', () => {
    const failed = row({ ts: now, error: 'rate_limited', tokensIn: 0, tokensOut: 0, costUsdMicro: 0n });
    const report = aggregateUsage([failed], today);
    expect(report.totals.calls).toBe(1);
    expect(report.totals.errors).toBe(1);
    expect(report.totals.costUsdMicro).toBe(0n);
    expect(report.byUser).toHaveLength(1);
  });

  it('counts an error on a system row in errors only', () => {
    const report = aggregateUsage([systemRow('intake_execution_failed', { ts: now, error: 'npi_down' })], today);
    expect(report.totals.errors).toBe(1);
    expect(report.totals.calls).toBe(0);
    expect(report.byUser).toEqual([]);
  });
});

// ─── serialization ──────────────────────────────────────────────────────────

describe('serializeUsageReport', () => {
  const { rows } = buildFixture();
  const report = aggregateUsage(rows, PERIOD);
  const view = serializeUsageReport(report);

  it('turns every bigint into its decimal string', () => {
    const decimal = /^\d+$/;
    expect(view.totals.costUsdMicro).toMatch(decimal);
    expect(view.totals.costUsdMicro).toBe(report.totals.costUsdMicro.toString());
    expect(view.projection.dailyAverageUsdMicro).toMatch(decimal);
    expect(view.projection.dailyAverageUsdMicro).toBe(report.projection.dailyAverageUsdMicro.toString());
    expect(view.projection.monthlyUsdMicro).toMatch(decimal);
    expect(view.projection.monthlyUsdMicro).toBe(report.projection.monthlyUsdMicro.toString());
    expect(view.projection.windowDays).toBe(2);

    const pairs: [readonly UsageBucket[], typeof view.byDay][] = [
      [report.byDay, view.byDay],
      [report.byTier, view.byTier],
      [report.byFlow, view.byFlow],
      [report.byDocument, view.byDocument],
      [report.byUser, view.byUser],
    ];
    for (const [source, rendered] of pairs) {
      expect(rendered).toHaveLength(source.length);
      rendered.forEach((bucket, index) => {
        expect(typeof bucket.costUsdMicro).toBe('string');
        expect(bucket.costUsdMicro).toMatch(decimal);
        expect(bucket.costUsdMicro).toBe(source[index].costUsdMicro.toString());
        expect(bucket.key).toBe(source[index].key);
        expect(bucket.calls).toBe(source[index].calls);
        expect(bucket.tokensIn).toBe(source[index].tokensIn);
        expect(bucket.tokensOut).toBe(source[index].tokensOut);
      });
    }
  });

  it('renders both period dates as ISO strings', () => {
    expect(view.period).toEqual({ from: '2026-03-01T21:00:00.000Z', to: '2026-03-03T21:00:00.000Z' });
  });

  it('survives JSON.stringify and round-trips by value', () => {
    expect(() => JSON.stringify(view)).not.toThrow();
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
  });

  it('does not mutate the report it was given', () => {
    expect(typeof report.totals.costUsdMicro).toBe('bigint');
    expect(typeof report.projection.monthlyUsdMicro).toBe('bigint');
    expect(report.byUser.every((b) => typeof b.costUsdMicro === 'bigint')).toBe(true);
    expect(report.period.from).toBeInstanceOf(Date);
    expect(report.period.to).toBeInstanceOf(Date);
  });

  it('serializes an empty report without throwing', () => {
    const empty = serializeUsageReport(aggregateUsage([], riyadhDayPeriod(new Date('2026-03-02T05:00:00.000Z'))));
    expect(() => JSON.stringify(empty)).not.toThrow();
    expect(empty.totals.costUsdMicro).toBe('0');
    expect(empty.byTier.map((b) => b.costUsdMicro)).toEqual(['0', '0']);
  });
});

// ─── the cap ────────────────────────────────────────────────────────────────

describe('capStatus', () => {
  const day = new Date('2026-03-02T00:00:00.000Z');

  it('reports an untouched day (no daily_usage row)', () => {
    const status = capStatus(null, 600_000, day);
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

  it('is not reached one token below the cap', () => {
    const status = capStatus({ tokensIn: 599_999, tokensOut: 0 }, 600_000, day);
    expect(status.used).toBe(599_999);
    expect(status.remaining).toBe(1);
    expect(status.reached).toBe(false);
    expect(status.messageAr).toBeNull();
  });

  it('is reached exactly on the cap, with the cap message', () => {
    const status = capStatus({ tokensIn: 600_000, tokensOut: 0 }, 600_000, day);
    expect(status.reached).toBe(true);
    expect(status.remaining).toBe(0);
    expect(status.share).toBe(1);
    expect(status.messageAr).toBe(CAP_REACHED_MESSAGE_AR);
    expect(status.messageAr).toBe(t('usage.cap.reached'));
  });

  it('clamps remaining at 0 and share at 1 above the cap', () => {
    const status = capStatus({ tokensIn: 700_000, tokensOut: 100 }, 600_000, day);
    expect(status.used).toBe(700_100);
    expect(status.reached).toBe(true);
    expect(status.remaining).toBe(0);
    expect(status.share).toBe(1);
  });

  it('adds tokensIn and tokensOut', () => {
    const status = capStatus({ tokensIn: 150_000, tokensOut: 150_000 }, 600_000, day);
    expect(status.used).toBe(300_000);
    expect(status.share).toBe(0.5);
    expect(status.remaining).toBe(300_000);
    expect(status.reached).toBe(false);
  });

  it('treats a cap of 0 as a full share and reached', () => {
    const status = capStatus(null, 0, day);
    expect(status.share).toBe(1);
    expect(status.reached).toBe(true);
    expect(status.remaining).toBe(0);
  });

  it('echoes the day through dayKeyOf', () => {
    expect(capStatus(null, 10, new Date('2026-12-31T00:00:00.000Z')).day).toBe('2026-12-31');
    expect(capStatus(null, 10, day).day).toBe(dayKeyOf(day));
  });
});

// ─── G-M4-3: the gate and the counter agree ─────────────────────────────────

function makeRequest(overrides: Partial<RedactedRequest> = {}): RedactedRequest {
  return {
    tier: 'economy',
    purpose: 'chat',
    system: staticPrompt('system prompt'),
    messages: [{ role: 'user', content: staticPrompt('hello') }],
    ...overrides,
  };
}

function makeCtx(overrides: Partial<LlmContext> = {}): LlmContext {
  return { npiOrgId: 'org-1', npiUserId: 'user-1', ...overrides };
}

function okResponse(overrides: Partial<ModelResponse> = {}): ModelResponse {
  return {
    text: 'hello back',
    toolCalls: [],
    stopReason: 'end_turn',
    tokensIn: 10,
    tokensOut: 20,
    modelId: HAIKU,
    ...overrides,
  };
}

class FakeProvider implements ModelProvider {
  readonly name = 'anthropic' as const;
  calls: ProviderCall[] = [];
  constructor(private impl: (call: ProviderCall) => Promise<ModelResponse> | ModelResponse) {}
  async complete(callArgs: ProviderCall): Promise<ModelResponse> {
    this.calls.push(callArgs);
    return this.impl(callArgs);
  }
}

interface FakeUsageRow {
  npiOrgId: string;
  npiUserId: string;
  day: Date;
  tokensIn: number;
  tokensOut: number;
  costUsdMicro: bigint;
  messageCount: number;
}

class FakeDb implements LlmDb {
  auditRows: LlmAuditData[] = [];
  usage = new Map<string, FakeUsageRow>();

  private key(npiUserId: string, day: Date): string {
    return `${npiUserId}::${day.toISOString()}`;
  }

  llmAudit = {
    create: async (args: { data: LlmAuditData }) => {
      this.auditRows.push(args.data);
      return args.data;
    },
  };

  dailyUsage = {
    findUnique: async (args: { where: { npiUserId_day: { npiUserId: string; day: Date } } }) => {
      const row = this.usage.get(this.key(args.where.npiUserId_day.npiUserId, args.where.npiUserId_day.day));
      return row ? { ...row } : null;
    },
    upsert: async (args: {
      where: { npiUserId_day: { npiUserId: string; day: Date } };
      create: FakeUsageRow;
      update: {
        tokensIn?: { increment: number };
        tokensOut?: { increment: number };
        costUsdMicro?: { increment: bigint };
      };
    }) => {
      const key = this.key(args.where.npiUserId_day.npiUserId, args.where.npiUserId_day.day);
      const existing = this.usage.get(key);
      if (existing) {
        const upd = args.update;
        if (upd.tokensIn) existing.tokensIn += upd.tokensIn.increment;
        if (upd.tokensOut) existing.tokensOut += upd.tokensOut.increment;
        if (upd.costUsdMicro) existing.costUsdMicro += upd.costUsdMicro.increment;
      } else {
        this.usage.set(key, { ...args.create });
      }
      return this.usage.get(key);
    },
  };

  seedUsage(row: FakeUsageRow): void {
    this.usage.set(this.key(row.npiUserId, row.day), row);
  }

  read(npiUserId: string, day: Date): FakeUsageRow | undefined {
    return this.usage.get(this.key(npiUserId, day));
  }
}

/** The fake db's audit rows carry no `ts` (the database defaults it); give
 *  them the gate's clock so the counter can place them in a period. */
function asUsageRows(rows: readonly LlmAuditData[], ts: Date): UsageRowLike[] {
  return rows.map((r) => ({
    ts,
    npiUserId: r.npiUserId,
    event: r.event,
    modelTier: r.modelTier,
    modelId: r.modelId,
    tokensIn: r.tokensIn,
    tokensOut: r.tokensOut,
    costUsdMicro: r.costUsdMicro,
    documentId: r.documentId,
    error: r.error,
  }));
}

function seed(db: FakeDb, day: Date, tokensIn: number, tokensOut = 0): FakeUsageRow {
  const usageRow: FakeUsageRow = {
    npiOrgId: 'org-1',
    npiUserId: 'user-1',
    day,
    tokensIn,
    tokensOut,
    costUsdMicro: 0n,
    messageCount: 3,
  };
  db.seedUsage(usageRow);
  return usageRow;
}

describe('G-M4-3: the gate and the counter agree', () => {
  const env = {} as NodeJS.ProcessEnv;
  const now = new Date('2026-03-02T05:00:00.000Z'); // Riyadh day 2026-03-02

  it('refuses at the cap with the cap message and writes one cap_reached row the counter sees', async () => {
    const provider = new FakeProvider(() => okResponse());
    const db = new FakeDb();
    const seeded = seed(db, riyadhDay(now), 600_000);
    const client = createLlmClient({ provider, db, env, now: () => now });

    const rejection = await client.complete(makeRequest(), makeCtx()).then(
      () => null,
      (err: unknown) => err,
    );
    expect(rejection).toMatchObject({ kind: 'cap_reached' });
    const messageAr = (rejection as { messageAr: string }).messageAr;
    expect(messageAr).toBe(CAP_REACHED_MESSAGE_AR);
    expect(messageAr).toBe(t('usage.cap.reached'));
    expect(messageAr).toBe('بلغت حد الاستخدام اليومي. يتجدد الحد غداً.');

    expect(provider.calls).toHaveLength(0);
    expect(db.auditRows).toHaveLength(1);
    expect(db.auditRows[0].event).toBe('cap_reached');
    expect(db.auditRows[0].modelId).toBeNull();
    expect(db.auditRows[0].tokensIn).toBe(0);
    expect(db.auditRows[0].tokensOut).toBe(0);
    expect(db.auditRows[0].costUsdMicro).toBe(0n);

    // The counter reaches the same verdict, with the same words.
    const status = capStatus(seeded, dailyTokenCap(env), riyadhDay(now));
    expect(status.reached).toBe(true);
    expect(status.messageAr).toBe(messageAr);
    expect(status.day).toBe('2026-03-02');

    const report = aggregateUsage(asUsageRows(db.auditRows, now), riyadhDayPeriod(now));
    expect(report.totals.capReached).toBe(1);
    expect(report.totals.calls).toBe(0);
    expect(report.totals.costUsdMicro).toBe(0n);
  });

  it('passes one token below the cap, grows the usage row, and the counter then reports reached', async () => {
    const response = okResponse({ tokensIn: 10, tokensOut: 20 });
    const provider = new FakeProvider(() => response);
    const db = new FakeDb();
    const seeded = seed(db, riyadhDay(now), 599_999);
    const before = capStatus(seeded, dailyTokenCap(env), riyadhDay(now));
    expect(before.reached).toBe(false);
    expect(before.remaining).toBe(1);

    const client = createLlmClient({ provider, db, env, now: () => now });
    await expect(client.complete(makeRequest(), makeCtx())).resolves.toBeDefined();
    expect(provider.calls).toHaveLength(1);

    const grown = db.read('user-1', riyadhDay(now));
    expect(grown).toBeDefined();
    expect(grown?.tokensIn).toBe(599_999 + response.tokensIn);
    expect(grown?.tokensOut).toBe(response.tokensOut);

    const after = capStatus(grown ?? null, dailyTokenCap(env), riyadhDay(now));
    expect(after.used).toBe(599_999 + response.tokensIn + response.tokensOut);
    expect(after.reached).toBe(true);
    expect(after.messageAr).toBe(CAP_REACHED_MESSAGE_AR);

    // The next attempt is refused, which is what the counter already showed.
    await expect(client.complete(makeRequest(), makeCtx())).rejects.toMatchObject({ kind: 'cap_reached' });
    expect(provider.calls).toHaveLength(1);

    // The audit row of the successful call, as the counter reads it.
    const callRows = asUsageRows(db.auditRows.slice(0, 1), now);
    const report = aggregateUsage(callRows, riyadhDayPeriod(now));
    expect(report.totals.calls).toBe(1);
    expect(report.totals.tokensIn).toBe(response.tokensIn);
    expect(report.totals.tokensOut).toBe(response.tokensOut);
    expect(report.totals.costUsdMicro).toBe(costUsdMicro(response.modelId, response.tokensIn, response.tokensOut));
    expect(report.totals.capReached).toBe(0);
    expect(grown?.costUsdMicro).toBe(report.totals.costUsdMicro);
  });

  it('counts the refusal and the call together over a whole day', async () => {
    const provider = new FakeProvider(() => okResponse());
    const db = new FakeDb();
    seed(db, riyadhDay(now), 599_999);
    const client = createLlmClient({ provider, db, env, now: () => now });
    await client.complete(makeRequest(), makeCtx());
    await expect(client.complete(makeRequest(), makeCtx())).rejects.toMatchObject({ kind: 'cap_reached' });

    const report = aggregateUsage(asUsageRows(db.auditRows, now), riyadhDayPeriod(now));
    expect(report.totals.calls).toBe(1);
    expect(report.totals.capReached).toBe(1);
    expect(report.totals.errors).toBe(0);
  });

  it('keys the cap on the Riyadh day: refused at 20:59:59.999Z, a fresh day at 21:00:00.000Z', async () => {
    const capDay = new Date('2026-03-02T00:00:00.000Z');

    const refusedProvider = new FakeProvider(() => okResponse());
    const refusedDb = new FakeDb();
    seed(refusedDb, capDay, 600_000);
    const lastMoment = new Date('2026-03-02T20:59:59.999Z');
    const refusing = createLlmClient({ provider: refusedProvider, db: refusedDb, env, now: () => lastMoment });
    await expect(refusing.complete(makeRequest(), makeCtx())).rejects.toMatchObject({ kind: 'cap_reached' });
    expect(refusedProvider.calls).toHaveLength(0);
    expect(riyadhDayKey(lastMoment)).toBe('2026-03-02');

    const passedProvider = new FakeProvider(() => okResponse());
    const passedDb = new FakeDb();
    seed(passedDb, capDay, 600_000);
    const nextMidnight = new Date('2026-03-02T21:00:00.000Z');
    const passing = createLlmClient({ provider: passedProvider, db: passedDb, env, now: () => nextMidnight });
    await expect(passing.complete(makeRequest(), makeCtx())).resolves.toBeDefined();
    expect(passedProvider.calls).toHaveLength(1);
    expect(riyadhDayKey(nextMidnight)).toBe('2026-03-03');
    // The new day's usage row is a different row from the capped one.
    expect(passedDb.read('user-1', riyadhDay(nextMidnight))?.tokensIn).toBe(10);
    expect(passedDb.read('user-1', capDay)?.tokensIn).toBe(600_000);
  });

  it('honors a lowered cap through the same arithmetic as the counter', async () => {
    const lowEnv = { COPILOT_DAILY_TOKEN_CAP: '100' } as unknown as NodeJS.ProcessEnv;
    const provider = new FakeProvider(() => okResponse());
    const db = new FakeDb();
    const seeded = seed(db, riyadhDay(now), 60, 40);
    const client = createLlmClient({ provider, db, env: lowEnv, now: () => now });
    await expect(client.complete(makeRequest(), makeCtx())).rejects.toMatchObject({ kind: 'cap_reached' });
    expect(capStatus(seeded, dailyTokenCap(lowEnv), riyadhDay(now)).reached).toBe(true);
    expect(capStatus({ tokensIn: 60, tokensOut: 39 }, dailyTokenCap(lowEnv), riyadhDay(now)).reached).toBe(false);
  });
});

describe('dailyTokenCap', () => {
  it('defaults to 600,000 when unset', () => {
    expect(dailyTokenCap({} as NodeJS.ProcessEnv)).toBe(600_000);
  });

  it('takes a positive finite number string', () => {
    expect(dailyTokenCap({ COPILOT_DAILY_TOKEN_CAP: '100' } as unknown as NodeJS.ProcessEnv)).toBe(100);
  });

  it.each(['', 'abc', '-5', '0', '1e400'])('falls back to 600,000 for %p', (raw) => {
    expect(dailyTokenCap({ COPILOT_DAILY_TOKEN_CAP: raw } as unknown as NodeJS.ProcessEnv)).toBe(600_000);
  });
});
