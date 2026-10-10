// End-to-end coverage for T-33 (the trust screen, F-17; spec/madar/05 §M4 row
// T-33 gate, 07 G-M4-2, 09 §4 rows 4.1/4.2 and 3.8, 06 AT-07). Real local NPI
// API + real copilot, real login — same shape as `e2e/settings.spec.ts`.
//
// Proves: the administrator sees the «الثقة» nav item and `/copilot/trust` with
// the seeded `llm_audit` rows newest first, an image send with its consent id,
// a text call without one, and what left the building (redacted, placeholders
// counted, the system prompt behind a toggle); the three filters narrow the
// table; a non-administrator gets the forbidden notice and 403 from the
// endpoint, no session gets 401; the endpoint scopes by organization and
// validates its parameters; and every image send in the whole log of the
// organization carries a consent id (the DB CHECK makes it hold; the test
// states it, G-M4-2).
//
// Does not prove: any model call (none is made anywhere in this spec), any NPI
// write (the fixture writes copilot rows only), or anything about the demo
// log's own rows beyond the integrity check. Nothing is intercepted: the real
// route and the real screen are the subject. Runs on both the `desktop` and
// `mobile` Playwright projects (the screen is read-only; the fixture is per
// test).
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from '@playwright/test';
import { t } from '../src/i18n/ar';
import type { AuditDetailResponse, AuditListView } from '../src/audit/types';
import { readAdminCredentials, readSiteEngineerCredentials, type SeededAccount } from './fixtures/accounts';
import {
  cleanupTrustFixture,
  disconnectTrustDb,
  seedTrustFixture,
  type TrustFixture,
} from './fixtures/trust-db';

const API_PORT = process.env.COPILOT_E2E_API_PORT ?? '4077';
const API_BASE = `http://localhost:${API_PORT}/api`;

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

function rowLocator(page: Page, id: string) {
  return page.locator(`[data-testid="trust-row"][data-id="${id}"]`);
}

test.describe('trust screen (T-33)', () => {
  // Every test signs in through the real login and then loads the screen or
  // the endpoint — real round trips through the dev server.
  test.describe.configure({ timeout: 60000 });

  let fixture: TrustFixture;
  let engineerId: string;

  test.beforeEach(async ({ request }) => {
    const admin = await npiIdentity(request, readAdminCredentials());
    const engineer = await npiIdentity(request, readSiteEngineerCredentials());
    engineerId = engineer.npiUserId;
    // `base` is "now", so the seeded rows are the newest of the organization
    // and sit on the first page (limit 50) whatever the demo log holds.
    fixture = await seedTrustFixture({
      npiOrgId: admin.npiOrgId,
      adminUserId: admin.npiUserId,
      engineerUserId: engineer.npiUserId,
    });
  });

  test.afterEach(async () => {
    await cleanupTrustFixture(fixture);
  });

  test.afterAll(async () => {
    await disconnectTrustDb();
  });

  test('admin sees the nav item, the summary, the five seeded rows in order, the image row with its consent id, the text row without', async ({
    page,
  }) => {
    const admin = readAdminCredentials();
    const engineer = readSiteEngineerCredentials();
    const { rowIds } = fixture;
    await signIn(page, admin);

    const nav = page.getByRole('navigation', { name: t('nav.main') });
    await expect(nav.getByRole('link', { name: t('nav.trust') })).toBeVisible();

    await page.goto('/copilot/trust');
    await expect(page.getByRole('heading', { name: t('trust.title'), exact: true })).toBeVisible();
    await expect(page.getByTestId('trust-summary')).toBeVisible();
    await expect(page.getByTestId('trust-summary-images-ok')).toBeVisible();
    await expect(page.getByTestId('trust-summary-images-missing')).toHaveCount(0);

    for (const id of [rowIds.r1, rowIds.r2, rowIds.r3, rowIds.r4, rowIds.r5]) {
      await expect(rowLocator(page, id)).toBeVisible();
    }

    // Order on the page, restricted to the seeded set.
    const seeded = new Set(Object.values(rowIds));
    const onPage = await page
      .getByTestId('trust-row')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-id') ?? ''));
    expect(onPage.filter((id) => seeded.has(id))).toEqual([rowIds.r1, rowIds.r2, rowIds.r3, rowIds.r4, rowIds.r5]);
    expect(onPage).not.toContain(rowIds.r6);
    await expect(rowLocator(page, rowIds.r6)).toHaveCount(0);

    const r1 = rowLocator(page, rowIds.r1);
    await expect(r1.getByTestId('trust-cell-image-sent')).toHaveText(t('trust.yes'));
    await expect(r1.getByTestId('trust-cell-consent')).toContainText(fixture.consentEventId);
    await expect(r1.getByTestId('trust-cell-event')).toContainText(t('trust.event.extract_vendor_bill'));
    await expect(r1.getByTestId('trust-cell-user')).toContainText(admin.nameAr);

    const r2 = rowLocator(page, rowIds.r2);
    await expect(r2.getByTestId('trust-cell-image-sent')).toHaveText(t('trust.no'));
    await expect(r2.getByTestId('trust-cell-consent')).toHaveText('—');

    await expect(rowLocator(page, rowIds.r3).getByTestId('trust-cell-event')).toContainText(
      t('trust.event.refused_confidential'),
    );
    await expect(rowLocator(page, rowIds.r5).getByTestId('trust-cell-user')).toContainText(engineer.nameAr);

    await expect(page.locator('body')).not.toContainText(fixture.REAL_NAME);
  });

  test('the detail shows what left the building, redacted, and the image block with its consent', async ({ page }) => {
    await signIn(page, readAdminCredentials());
    await page.goto('/copilot/trust');
    const { rowIds } = fixture;

    await expect(rowLocator(page, rowIds.r2)).toBeVisible();
    await rowLocator(page, rowIds.r2).getByTestId('trust-row-open').click();

    const detail = page.getByTestId('trust-detail');
    await expect(detail).toBeVisible();
    await expect(detail.getByTestId('trust-detail-placeholders')).toHaveText(t('trust.detail.placeholders', { n: '2' }));
    const outbound = detail.getByTestId('trust-detail-outbound');
    await expect(outbound).toContainText('⟦عميل_1⟧');
    await expect(outbound).toContainText('⟦رقم_ضريبي_1⟧');
    await expect(outbound).toContainText('PRJ-00012');

    // The system prompt stays folded until asked for.
    await expect(outbound.getByText('تعليمات اختبار')).toHaveCount(0);
    await detail.getByTestId('trust-detail-system-toggle').click();
    await expect(outbound.getByText('تعليمات اختبار')).toBeVisible();

    await expect(page.getByTestId('trust-detail-consent')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(fixture.REAL_NAME);

    // The image row: the consent line and the vision block both carry the consent id.
    await rowLocator(page, rowIds.r1).getByTestId('trust-row-open').click();
    await expect(page.getByTestId('trust-detail-consent')).toContainText(fixture.consentEventId);
    const block = page.getByTestId('trust-detail-block-image');
    await expect(block).toContainText('image/jpeg');
    await expect(block).toContainText(fixture.consentEventId);
    await expect(page.getByTestId('trust-detail-outbound')).toContainText('⟦مورد_1⟧');

    await page.getByTestId('trust-detail-close').click();
    await expect(page.getByTestId('trust-detail')).toHaveCount(0);
  });

  test('the three filters narrow the table and «الكل» restores it', async ({ page }) => {
    await signIn(page, readAdminCredentials());
    await page.goto('/copilot/trust');
    const { rowIds } = fixture;
    const all = [rowIds.r1, rowIds.r2, rowIds.r3, rowIds.r4, rowIds.r5];

    async function expectOnly(visible: string[]): Promise<void> {
      for (const id of all) {
        if (visible.includes(id)) await expect(rowLocator(page, id)).toBeVisible();
      }
      for (const id of all) {
        if (!visible.includes(id)) await expect(rowLocator(page, id)).toHaveCount(0);
      }
    }

    await expectOnly(all);

    await page.getByTestId('trust-filter-image').selectOption('true');
    await expectOnly([rowIds.r1]);
    await page.getByTestId('trust-filter-image').selectOption('');
    await expectOnly(all);

    await page.getByTestId('trust-filter-event').selectOption('refused_confidential');
    await expectOnly([rowIds.r3]);
    await page.getByTestId('trust-filter-event').selectOption('');
    await expectOnly(all);

    await page.getByTestId('trust-filter-user').selectOption(engineerId);
    await expectOnly([rowIds.r5]);
    await page.getByTestId('trust-filter-user').selectOption('');
    await expectOnly(all);
  });

  test('a non-administrator sees trust.forbidden, no nav item, and 403 from the endpoint; no session is 401', async ({
    page,
    request,
  }) => {
    await signIn(page, readSiteEngineerCredentials());

    const nav = page.getByRole('navigation', { name: t('nav.main') });
    await expect(nav.getByRole('link', { name: t('nav.trust') })).toHaveCount(0);

    await page.goto('/copilot/trust');
    await expect(page.getByText(t('trust.forbidden'))).toBeVisible();
    await expect(page.getByTestId('trust-table')).toHaveCount(0);

    const forbidden = await page.request.get('/copilot/api/audit');
    expect(forbidden.status()).toBe(403);

    // The test's own `request` fixture holds no copilot cookie.
    const anonymous = await request.get('/copilot/api/audit');
    expect(anonymous.status()).toBe(401);
  });

  test('the endpoint scopes by organization, validates its parameters, and every image send in the whole log carries a consent id', async ({
    page,
  }) => {
    await signIn(page, readAdminCredentials());
    const { rowIds } = fixture;
    const api = page.request;

    const list = await api.get('/copilot/api/audit?limit=100');
    expect(list.status()).toBe(200);
    const listBody = (await list.json()) as AuditListView;
    const ids = listBody.rows.map((row) => row.id);
    for (const id of [rowIds.r1, rowIds.r2, rowIds.r3, rowIds.r4, rowIds.r5]) expect(ids).toContain(id);
    expect(ids).not.toContain(rowIds.r6);

    // A row of another organization is not found — never 403, never visible.
    expect((await api.get(`/copilot/api/audit?id=${rowIds.r6}`)).status()).toBe(404);

    const detail = await api.get(`/copilot/api/audit?id=${rowIds.r2}`);
    expect(detail.status()).toBe(200);
    const detailBody = (await detail.json()) as AuditDetailResponse;
    expect(detailBody.row.outbound?.kind).toBe('parsed');
    expect(detailBody.row.outbound?.placeholderCount).toBe(2);

    expect((await api.get('/copilot/api/audit?limit=0')).status()).toBe(400);
    expect((await api.get('/copilot/api/audit?imageSent=yes')).status()).toBe(400);

    // Every image send of the organization has a consent id. This is the
    // organization's real log plus the fixture: the DB CHECK is what makes it hold.
    const images = await api.get('/copilot/api/audit?imageSent=true&limit=100');
    expect(images.status()).toBe(200);
    const imagesBody = (await images.json()) as AuditListView;
    expect(imagesBody.rows.length).toBeGreaterThanOrEqual(1);
    for (const row of imagesBody.rows) {
      expect(row.imageSent).toBe(true);
      expect(row.consent, `image row ${row.id} has no consent`).not.toBeNull();
    }
    expect(imagesBody.summary.imageSentWithoutConsent).toBe(0);

    // The integrity check over the whole log, page by page (bounded).
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let pageNo = 0; pageNo < 20; pageNo += 1) {
      const url: string =
        cursor === null
          ? '/copilot/api/audit?limit=100'
          : `/copilot/api/audit?limit=100&cursor=${encodeURIComponent(cursor)}`;
      const res = await api.get(url);
      expect(res.status()).toBe(200);
      const body = (await res.json()) as AuditListView;
      for (const row of body.rows) {
        expect(seen.has(row.id), `row ${row.id} repeated across pages`).toBe(false);
        seen.add(row.id);
        if (row.imageSent) expect(row.consent, `image row ${row.id} has no consent`).not.toBeNull();
      }
      cursor = body.nextCursor;
      if (cursor === null) break;
    }
    expect(cursor, 'the log did not end within 20 pages of 100').toBeNull();
    expect(seen.has(rowIds.r1)).toBe(true);
    expect(seen.has(rowIds.r6)).toBe(false);
  });

  test('at 390 px the page itself does not scroll horizontally', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'the 390 px layout is only measured on the mobile project');

    await signIn(page, readAdminCredentials());
    await page.goto('/copilot/trust');
    await expect(rowLocator(page, fixture.rowIds.r1)).toBeVisible();

    const pageFits = await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    );
    expect(pageFits).toBe(true);

    // The table scrolls inside its own wrapper, not the page.
    const tableScrolls = await page
      .getByTestId('trust-table')
      .evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(tableScrolls).toBe(true);
  });
});
