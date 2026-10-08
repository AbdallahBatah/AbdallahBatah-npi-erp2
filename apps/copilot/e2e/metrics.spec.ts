// End-to-end coverage for T-35 (the metrics screen, F-19; spec/madar/05 §M4 row
// T-35 gate, 07 G-M4-4, 09 §4 rows 4.5/4.6, 06 AT-13). Real local NPI API +
// real copilot, real login — same shape as `e2e/trust.spec.ts`.
//
// Proves: the administrator sees the «القياس» nav item and `/copilot/metrics`
// with six cards a1..a6 in order carrying the seeded figures (memory 92 %,
// names 93.8 % / structured 100 %, the extract:po fields 35 of 36, the time
// median of the two seeded jobs against the 30-minute baseline, the 12.5
// minute onboarding); the CSV export has the fixed header of G-M4-4 and
// exactly six assumption rows whose a2 / a4 / a5 lines carry the same figures;
// a non-administrator gets the forbidden notice, no nav item and 403 from the
// export, no session gets 401; and at 390 px the page itself does not scroll
// horizontally.
//
// Does not prove: any model call (none is made anywhere in this spec), any NPI
// write (the fixture writes copilot rows only), or anything about the demo
// data's own rows beyond their shape — a1's figure and a3's cost come from the
// organization's real `daily_usage` / `llm_audit`, so they are asserted on
// shape only; the exact a5 time line and the exact a6 figure are asserted only
// when the organization held no `po` jobs / completed sessions of its own
// before the seed. The `eval_runs` table has no organization column: the three
// seeded runs are the latest of their kind until `afterEach` removes them.
// Nothing is intercepted: the real route and the real screen are the subject.
// Runs on both the `desktop` and `mobile` Playwright projects (the screen is
// read-only; the fixture is per test).
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { test, expect } from '@playwright/test';
import { t } from '../src/i18n/ar';
import { formatNumber } from '../src/i18n/format';
import { METRICS_CSV_FILENAME, METRICS_CSV_HEADER } from '../src/metrics/types';
import { readAdminCredentials, readSiteEngineerCredentials, type SeededAccount } from './fixtures/accounts';
import {
  cleanupMetricsFixture,
  disconnectMetricsDb,
  seedMetricsFixture,
  type MetricsFixture,
} from './fixtures/metrics-db';

const API_PORT = process.env.COPILOT_E2E_API_PORT ?? '4077';
const API_BASE = `http://localhost:${API_PORT}/api`;

const ASSUMPTIONS = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'] as const;

interface NpiIdentity {
  npiOrgId: string;
  npiUserId: string;
}

async function npiIdentity(request: APIRequestContext, account: SeededAccount): Promise<NpiIdentity> {
  const res = await request.post(`${API_BASE}/auth/login`, { data: { email: account.email, password: account.password } });
  expect(res.ok(), `NPI login failed for ${account.email}`).toBe(true);
  const body = (await res.json()) as { user: { id: string; organization: { id: string } } };
  return { npiOrgId: body.user.organization.id, npiUserId: body.user.id };
}

async function signIn(page: Page, account: SeededAccount): Promise<void> {
  await page.goto('/copilot/login');
  await page.getByLabel(t('login.email')).fill(account.email);
  await page.getByLabel(t('login.password')).fill(account.password);
  await page.getByRole('button', { name: t('login.submit') }).click();
  await page.waitForURL('**/copilot');
}

function card(page: Page, assumption: (typeof ASSUMPTIONS)[number]): Locator {
  return page.locator(`[data-testid="metric-card"][data-assumption="${assumption}"]`);
}

/** One RFC 4180 record: comma separated, a field may be wrapped in double
 *  quotes (then it may hold commas, and `""` is one quote). */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

test.describe('metrics screen (T-35)', () => {
  // Every test signs in through the real login and then loads the screen or
  // the endpoint — real round trips through the dev server.
  test.describe.configure({ timeout: 60000 });

  let fixture: MetricsFixture;

  test.beforeEach(async ({ request }) => {
    const admin = await npiIdentity(request, readAdminCredentials());
    fixture = await seedMetricsFixture({ npiOrgId: admin.npiOrgId, adminUserId: admin.npiUserId });
  });

  test.afterEach(async () => {
    await cleanupMetricsFixture(fixture);
  });

  test.afterAll(async () => {
    await disconnectMetricsDb();
  });

  test('admin sees the nav item and six cards in order with the seeded figures', async ({ page }) => {
    await signIn(page, readAdminCredentials());

    const nav = page.getByRole('navigation', { name: t('nav.main') });
    await expect(nav.getByRole('link', { name: t('nav.metrics'), exact: true })).toBeVisible();

    await page.goto('/copilot/metrics');
    await expect(page.getByRole('heading', { name: t('metrics.title'), exact: true })).toBeVisible();
    await expect(page.getByTestId('metrics-generated')).toBeVisible();

    const grid = page.getByTestId('metrics-grid');
    await expect(grid.getByTestId('metric-card')).toHaveCount(6);
    const order = await grid
      .getByTestId('metric-card')
      .evaluateAll((cards) => cards.map((c) => c.getAttribute('data-assumption') ?? ''));
    expect(order).toEqual([...ASSUMPTIONS]);

    for (const a of ASSUMPTIONS) {
      await expect(card(page, a).getByTestId('metric-label')).toHaveText(t(`metrics.${a}`));
    }

    // a2 — the seeded memory run: 0.92, 46 of 50 answered.
    const a2 = card(page, 'a2');
    await expect(a2).toHaveAttribute('data-verdict', 'met');
    await expect(a2.getByTestId('metric-value')).toHaveText('92%');
    await expect(a2.getByTestId('metric-details')).toContainText(
      t('metrics.a2.answered', { answered: formatNumber(46), total: formatNumber(50) }),
    );

    // a4 — the seeded pii run: names 0.9375 -> 93.8 %, structured 1 -> 100 %.
    const a4 = card(page, 'a4');
    await expect(a4).toHaveAttribute('data-verdict', 'met');
    await expect(a4.getByTestId('metric-value')).toHaveText('93.8%');
    await expect(a4.getByTestId('metric-secondary-value')).toHaveText('100%');
    await expect(a4.getByTestId('metric-details')).toContainText(
      t('metrics.a4.sentences', { n: formatNumber(100) }),
    );

    // a5 — the seeded extract:po run (35 of 36) and, when the organization has
    // no other approved po job, the exact median of 3.0 and 5.0 minutes.
    const a5 = card(page, 'a5');
    await expect(a5.getByTestId('metric-secondary')).toBeVisible();
    await expect(a5.getByTestId('metric-secondary')).toContainText(t('metrics.a5.time_ratio'));
    await expect(a5.getByTestId('metric-details')).toContainText(
      t('metrics.a5.flow_line', { flow: t('flow.po'), correct: formatNumber(35), total: formatNumber(36) }),
    );
    if (fixture.otherPoJobs === 0) {
      await expect(a5.getByTestId('metric-details')).toContainText(
        t('metrics.a5.time_line', {
          flow: t('flow.po'),
          minutes: formatNumber(4),
          baseline: formatNumber(30),
          n: formatNumber(2),
        }),
      );
    }

    // a1 — the scratch user adds ten working days of messages to whatever the
    // demo data holds, so the figure itself is not asserted.
    const a1 = card(page, 'a1');
    await expect(a1.getByTestId('metric-value')).not.toHaveText('—');
    expect(['met', 'not_met']).toContain(await a1.getAttribute('data-verdict'));
    await expect(a1.getByTestId('metric-details')).toContainText(
      t('metrics.a1.working_days', { n: formatNumber(fixture.workingDaysSeeded) }),
    );

    // a3 — the organization's own llm_audit: measured, or no data yet.
    const a3 = card(page, 'a3');
    const a3Verdict = await a3.getAttribute('data-verdict');
    expect(['measured', 'no_data']).toContain(a3Verdict);
    if (a3Verdict === 'measured') {
      expect(await a3.getByTestId('metric-value').innerText()).toMatch(
        new RegExp(`${t('metrics.unit.usd')}$`),
      );
      await expect(a3.getByTestId('metric-secondary')).toBeVisible();
    }

    // a6 — the seeded completed session of 12.5 minutes.
    const a6 = card(page, 'a6');
    if (fixture.otherCompletedSessions === 0) {
      await expect(a6.getByTestId('metric-value')).toHaveText(`${formatNumber(12.5)} ${t('metrics.unit.minutes')}`);
      await expect(a6).toHaveAttribute('data-verdict', 'met');
    } else {
      expect(['met', 'not_met']).toContain(await a6.getAttribute('data-verdict'));
    }
  });

  test('the CSV has the fixed header and six assumption rows', async ({ page }) => {
    await signIn(page, readAdminCredentials());

    const res = await page.request.get('/copilot/api/metrics/export');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toMatch(/^text\/csv/);
    expect(res.headers()['content-disposition']).toContain(METRICS_CSV_FILENAME);

    const raw = await res.body();
    // The UTF-8 byte order mark (EF BB BF): Excel needs it for the Arabic labels.
    expect([...raw.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = raw.toString('utf8');
    expect(text.startsWith('﻿')).toBe(true);

    const lines = text.slice(1).split('\r\n');
    expect(lines[lines.length - 1]).toBe('');
    lines.pop();
    expect(lines[0]).toBe(METRICS_CSV_HEADER);
    const dataLines = lines.slice(1);
    expect(dataLines).toHaveLength(6);

    const rows = dataLines.map(splitCsvLine);
    for (const row of rows) expect(row).toHaveLength(6);
    expect(rows.map((row) => row[0])).toEqual([...ASSUMPTIONS]);

    const [, a2, , a4, a5] = rows;
    // fields: assumption, metric, value, target, measured_at, details
    expect(a2[1]).toBe(t('metrics.a2'));
    expect(a2[2]).toBe('0.9200');
    expect(a2[3]).toBe('>=0.85');
    expect(a2[4]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    expect(a2[4]).toBe(fixture.base.toISOString());

    expect(a4[2]).toBe('0.9375');
    expect(a4[3]).toBe('>=0.90;>=0.95');

    expect(a5[3]).toBe('>=0.90;<=0.3333');
    if (fixture.otherPoJobs === 0) expect(a5[5]).toContain('po:4.0/30');

    // The screen's own export link.
    await page.goto('/copilot/metrics');
    const link = page.getByTestId('metrics-export');
    await expect(link).toBeVisible();
    expect(await link.getAttribute('href')).toMatch(/\/copilot\/api\/metrics\/export$/);
    expect(await link.evaluate((el) => el.hasAttribute('download'))).toBe(true);
  });

  test('a non-administrator sees metrics.forbidden, no nav item, and 403 from the export; no session is 401', async ({
    page,
    request,
  }) => {
    await signIn(page, readSiteEngineerCredentials());

    const nav = page.getByRole('navigation', { name: t('nav.main') });
    await expect(nav.getByRole('link', { name: t('nav.metrics'), exact: true })).toHaveCount(0);

    await page.goto('/copilot/metrics');
    await expect(page.getByText(t('metrics.forbidden'))).toBeVisible();
    await expect(page.getByTestId('metrics-grid')).toHaveCount(0);

    const forbidden = await page.request.get('/copilot/api/metrics/export');
    expect(forbidden.status()).toBe(403);

    // The test's own `request` fixture holds no copilot cookie.
    const anonymous = await request.get('/copilot/api/metrics/export');
    expect(anonymous.status()).toBe(401);
  });

  test('at 390 px the page itself does not scroll horizontally', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'the 390 px layout is only measured on the mobile project');

    await signIn(page, readAdminCredentials());
    await page.goto('/copilot/metrics');
    await expect(page.getByTestId('metrics-grid').getByTestId('metric-card')).toHaveCount(6);

    const pageFits = await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    );
    expect(pageFits).toBe(true);
  });
});
