// Milestone 1 smoke (T-13): one pass through everything an employee can do
// today, against the real local NPI API and the real copilot, with nothing
// intercepted. The two chat turns used here are answered without a model
// (the HR guard and the fixed reply to an entry request), so the run needs
// no API key.
import { test, expect, type Page } from '@playwright/test';
import { t } from '../src/i18n/ar';
import { readAdminCredentials } from './fixtures/accounts';

const JWT_SHAPE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;

async function signIn(page: Page) {
  const { email, password } = readAdminCredentials();
  await page.goto('/copilot/login');
  await page.getByLabel(t('login.email')).fill(email);
  await page.getByLabel(t('login.password')).fill(password);
  await page.getByRole('button', { name: t('login.submit') }).click();
  await page.waitForURL('**/copilot');
}

async function send(page: Page, text: string) {
  const composer = page.getByPlaceholder(t('chat.placeholder'));
  await composer.fill(text);
  await composer.press('Enter');
}

test.describe('milestone 1 smoke (T-13)', () => {
  test('sign in, read the home screen, chat, reload, sign out', async ({ page }) => {
    const { nameAr } = readAdminCredentials();
    await signIn(page);

    // Home: greeting and the four tiles, each with a number.
    await expect(page.getByRole('heading', { name: t('home.greeting', { name: nameAr }) })).toBeVisible();
    for (const key of [
      'home.tile.inbox',
      'home.tile.contracts_draft',
      'home.tile.pr_pending',
      'home.tile.bills_unmatched',
    ] as const) {
      const tile = page.getByTestId(`tile-${key}`);
      await expect(tile).toContainText(t(key));
      await expect(tile).toContainText(/\d+/);
    }

    // Chat: a question about an employee's performance is refused.
    const question = `مين أكفأ مهندس عندنا؟ ${Date.now()}`;
    await send(page, question);
    const log = page.getByRole('log');
    await expect(log).toContainText(question);
    await expect(log.getByText(t('hr.refusal')).last()).toBeVisible();

    // Chat: an entry request gets the fixed reply and the flow as a badge.
    await send(page, 'أبي 40 لوح 550 واط للمشروع PRJ-00012 قبل الخميس');
    await expect(log.getByText(t('chat.flow_pending', { flow: t('flow.pr') })).last()).toBeVisible();
    await expect(log.getByText(t('flow.pr'), { exact: true }).last()).toBeVisible();

    // The conversation is still there after a reload.
    await page.reload();
    const reloaded = page.getByRole('log');
    await expect(reloaded).toContainText(question);
    await expect(reloaded.getByText(t('hr.refusal')).last()).toBeVisible();

    // Nothing that looks like a token is in the page.
    expect(await page.content()).not.toMatch(JWT_SHAPE);

    // Sign out.
    await page.getByRole('button', { name: t('logout') }).click();
    await page.waitForURL('**/copilot/login');
    await page.goto('/copilot');
    await page.waitForURL('**/copilot/login');
  });

  test('the chat endpoint refuses a caller with no session and a cross-site caller', async ({ page, request }) => {
    const anonymous = await request.post('/copilot/api/chat', { data: { text: 'مرحبا' } });
    expect(anonymous.status()).toBe(401);

    await signIn(page);
    const crossSite = await page.request.post('/copilot/api/chat', {
      data: { text: 'مرحبا' },
      headers: { Origin: 'https://example.invalid' },
    });
    expect(crossSite.status()).toBe(403);

    const notJson = await page.request.post('/copilot/api/chat', {
      data: 'text=hello',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    expect(notJson.status()).toBe(415);

    const othersConversation = await page.request.post('/copilot/api/chat', {
      data: { text: 'مين أكفأ مهندس عندنا؟', conversationId: 'not-my-conversation' },
    });
    expect(othersConversation.status()).toBe(404);
  });

  test('session and chat responses are never cacheable and never carry a token', async ({ page }) => {
    await signIn(page);
    for (const path of ['/copilot/api/auth', '/copilot/api/chat']) {
      const res = await page.request.get(path);
      expect(res.status(), path).toBe(200);
      expect(res.headers()['cache-control'], path).toContain('no-store');
      expect(await res.text(), path).not.toMatch(JWT_SHAPE);
    }
  });
});
