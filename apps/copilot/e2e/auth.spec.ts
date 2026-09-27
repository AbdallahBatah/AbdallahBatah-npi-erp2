// End-to-end coverage for T-05 (G-M1-3): real local NPI API + real copilot,
// no mocks. Requires PostgreSQL running with NPI's seed already loaded (see
// playwright.config.ts's webServer entries).
import { test, expect } from '@playwright/test';
import { t } from '../src/i18n/ar';
import { readAdminCredentials } from './fixtures/accounts';

test.describe('login (T-05)', () => {
  test('the login page is Arabic, RTL, and both fields start empty', async ({ page }) => {
    await page.goto('/copilot/login');

    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByText(t('app.name'))).toBeVisible();

    await expect(page.getByLabel(t('login.email'))).toHaveValue('');
    await expect(page.getByLabel(t('login.password'))).toHaveValue('');
  });

  test('a wrong password shows the invalid-credentials message', async ({ page }) => {
    const { email } = readAdminCredentials();
    await page.goto('/copilot/login');

    await page.getByLabel(t('login.email')).fill(email);
    await page.getByLabel(t('login.password')).fill('definitely-the-wrong-password');
    await page.getByRole('button', { name: t('login.submit') }).click();

    await expect(page.locator('p[role="alert"]')).toHaveText(t('login.error.invalid'));
  });

  test('the seeded admin logs in, lands on /copilot, and gets a correctly scoped session cookie', async ({
    page,
    context,
  }) => {
    const { email, password, nameAr } = readAdminCredentials();
    await page.goto('/copilot/login');

    await page.getByLabel(t('login.email')).fill(email);
    await page.getByLabel(t('login.password')).fill(password);
    await page.getByRole('button', { name: t('login.submit') }).click();

    await page.waitForURL('**/copilot');
    expect(new URL(page.url()).pathname).toBe('/copilot');

    const cookies = await context.cookies();
    const sessionCookie = cookies.find((c) => c.name === 'copilot_session');
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie?.httpOnly).toBe(true);
    expect(sessionCookie?.path).toBe('/copilot');

    const res = await page.request.get('/copilot/api/auth');
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { user: { nameAr: string } };
    expect(body.user.nameAr).toBe(nameAr);

    // The response must never carry the NPI token or anything resembling it.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('accessToken');
    expect(raw).not.toMatch(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/); // a JWT shape
  });

  test('visiting /copilot without a session cookie redirects to /copilot/login', async ({ page, context }) => {
    await context.clearCookies();
    await page.goto('/copilot');

    await page.waitForURL('**/copilot/login');
    expect(new URL(page.url()).pathname).toBe('/copilot/login');
  });

  test('logout clears the session, and /copilot redirects to login again', async ({ page }) => {
    const { email, password } = readAdminCredentials();
    await page.goto('/copilot/login');
    await page.getByLabel(t('login.email')).fill(email);
    await page.getByLabel(t('login.password')).fill(password);
    await page.getByRole('button', { name: t('login.submit') }).click();
    await page.waitForURL('**/copilot');

    const res = await page.request.delete('/copilot/api/auth');
    expect(res.status()).toBe(204);

    await page.goto('/copilot');
    await page.waitForURL('**/copilot/login');
    expect(new URL(page.url()).pathname).toBe('/copilot/login');
  });

  test('six wrong passwords for a throwaway address trip this app\'s own rate limit', async ({ page, request }) => {
    // A fresh, made-up address per run — never a seeded demo account — so
    // this test can never lock out a real login used by the other tests.
    const email = `ratelimit-${Date.now()}-${Math.random().toString(36).slice(2)}@npi.sa`;

    for (let i = 0; i < 5; i++) {
      const res = await request.post('/copilot/api/auth', {
        data: { email, password: 'wrong-password' },
      });
      expect(res.status(), `attempt ${i + 1}`).toBe(401);
    }

    await page.goto('/copilot/login');
    await page.getByLabel(t('login.email')).fill(email);
    await page.getByLabel(t('login.password')).fill('wrong-password');
    await page.getByRole('button', { name: t('login.submit') }).click();

    await expect(page.locator('p[role="alert"]')).toHaveText(t('login.error.rate_limited'));
  });

  test('a cookie whose session no longer exists still gets the login form, not a redirect loop', async ({
    page,
    context,
    baseURL,
  }) => {
    await context.addCookies([
      { name: 'copilot_session', value: 'no-such-session', url: `${baseURL}/copilot` },
    ]);
    const response = await page.goto('/copilot/login');
    expect(response?.status()).toBe(200);
    expect(new URL(page.url()).pathname).toBe('/copilot/login');
    await expect(page.getByLabel(t('login.email'))).toBeVisible();
  });

  test('the login page has no horizontal scroll at 390px', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/copilot/login');

    const hasHorizontalScroll = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(hasHorizontalScroll).toBe(false);
  });

  // Fix 6 (design-critique pass): an empty/incomplete form is caught
  // client-side, before any request leaves the browser.
  test('submitting the empty form shows login.error.required and sends no request', async ({ page }) => {
    await page.goto('/copilot/login');

    let authRequests = 0;
    await page.route('**/copilot/api/auth', (route) => {
      authRequests += 1;
      return route.continue();
    });

    await page.getByRole('button', { name: t('login.submit') }).click();

    await expect(page.locator('p[role="alert"]')).toHaveText(t('login.error.required'));
    expect(authRequests).toBe(0);
  });

  test('the required-fields error disappears as soon as a field is edited', async ({ page }) => {
    await page.goto('/copilot/login');

    await page.getByRole('button', { name: t('login.submit') }).click();
    await expect(page.locator('p[role="alert"]')).toHaveText(t('login.error.required'));

    await page.getByLabel(t('login.email')).fill('a');
    await expect(page.locator('p[role="alert"]')).toHaveCount(0);
  });

  // Fix 5 (design-critique pass): NPI's mark on the login card.
  test('the NPI icon is visible on the login card', async ({ page }) => {
    await page.goto('/copilot/login');

    const icon = page.locator('img[src*="/brand/npi-icon.svg"]');
    await expect(icon).toBeVisible();
    // A broken/blocked image asset still occupies its box (and so still
    // counts as "visible" to Playwright's own check above) — this extra
    // assertion is what actually confirms the SVG itself decoded.
    await expect(async () => {
      const naturalWidth = await icon.evaluate((el: HTMLImageElement) => el.naturalWidth);
      expect(naturalWidth).toBeGreaterThan(0);
    }).toPass();
  });
});
