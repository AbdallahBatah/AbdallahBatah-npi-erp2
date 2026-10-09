// T-43 (spec/madar/05 row T-43, F-22, G-M5-4/5): checks a DEPLOYED stack — the
// demo server behind Caddy, or a local `next start` — instead of the dev
// servers the default run brings up. It runs only with COPILOT_LIVE=1 and
// COPILOT_LIVE_BASE=<origin> (see `npm run e2e:live-demo`), never as part of the
// default run (playwright.config.ts: grepInvert /@live/), and it starts nothing.
//
// What each test proves:
//   1. /copilot/api/health answers 200 { ok: true } through the gateway.
//   2. The login screen is served with the production CSP (no 'unsafe-eval').
//   3. The seeded administrator signs in and the session cookie is HTTPS-only.
//      That account is the one the nightly demo reset re-creates, so a green
//      run after the 03:00 Riyadh reset is the "nightly reset keeps it working"
//      evidence.
//   4. D-11: NPI's sidebar `next/link` to /copilot (a different app on the same
//      origin) really lands in the copilot. A soft navigation that stays inside
//      the NPI app would render NPI's not-found page and fail here.
import { test, expect } from '@playwright/test';
import { t } from '../src/i18n/ar';
import { readAdminCredentials } from './fixtures/accounts';

const BASE = (process.env.COPILOT_LIVE_BASE ?? '').replace(/\/$/, '');

test.describe('deployed copilot (T-43) @live-demo', () => {
  test.skip(!BASE, 'COPILOT_LIVE_BASE is not set — nothing deployed to check');

  test('the health probe answers 200 { ok: true } through the gateway', async ({ request }) => {
    const res = await request.get(`${BASE}/copilot/api/health`);
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers()['cache-control']).toContain('no-store');
  });

  test('the login screen is served with the production security policy', async ({ page }) => {
    const res = await page.goto('/copilot/login');
    expect(res).not.toBeNull();
    expect(res?.status()).toBe(200);
    await expect(page).toHaveURL(/\/copilot\/login$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page.getByLabel(t('login.email'))).toHaveValue('');
    await expect(page.getByLabel(t('login.password'))).toHaveValue('');

    const csp = res?.headers()['content-security-policy'];
    expect(csp).toBeDefined();
    expect(csp).not.toContain("'unsafe-eval'");
  });

  test('the seeded administrator signs in and gets an HTTPS-only session cookie', async ({
    page,
    context,
    request,
  }) => {
    const { email, password } = readAdminCredentials();
    await page.goto('/copilot/login');
    await page.getByLabel(t('login.email')).fill(email);
    await page.getByLabel(t('login.password')).fill(password);
    await page.getByRole('button', { name: t('login.submit') }).click();

    await expect(page).toHaveURL(/\/copilot\/?$/, { timeout: 30_000 });
    await expect(page.locator('textarea').first()).toBeVisible();

    const cookies = await context.cookies(`${BASE}/copilot`);
    const session = cookies.find((c) => c.name === 'copilot_session');
    expect(session).toBeDefined();
    expect(session?.httpOnly).toBe(true);
    expect(session?.secure).toBe(true);
    expect(session?.sameSite).toBe('Lax');
    expect(session?.path.startsWith('/copilot')).toBe(true);

    // The probe stays green after a login.
    const res = await request.get(`${BASE}/copilot/api/health`);
    expect(res.status()).toBe(200);
  });

  test("NPI's sidebar link reaches the copilot (D-11)", async ({ page, request }) => {
    const probe = await request.get(`${BASE}/login`);
    const html = probe.ok() ? await probe.text() : '';
    test.skip(
      !probe.ok() || !/البريد الإلكتروني|Email/.test(html),
      'NPI web is not served on this origin (copilot-only deployment)',
    );

    // NPI and the copilot share the same accounts.
    const { email, password } = readAdminCredentials();
    await page.goto('/login');
    await page.getByLabel(/البريد الإلكتروني|^Email$/).fill(email);
    await page.locator('input[type="password"]').first().fill(password);
    await page.getByRole('button', { name: /دخول|Sign in/ }).click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });

    const link = page.getByRole('link', { name: /مساعد مَدار|Madar assistant/ });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', '/copilot');
    await link.click();

    // A soft navigation that stays inside the NPI app would show NPI's
    // not-found page and fail below — that is the D-11 observation.
    await expect(page).toHaveURL(/\/copilot(\/login)?\/?$/, { timeout: 30_000 });
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page.getByLabel(t('login.email')).or(page.locator('textarea').first())).toBeVisible({
      timeout: 30_000,
    });
  });
});
