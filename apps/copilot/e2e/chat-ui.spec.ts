// End-to-end coverage for T-12 (the chat UI). Real local NPI API + real
// copilot, real login — only `/copilot/api/chat` is intercepted, per the
// task brief ("no test may call the real chat model"). Runs on both the
// `desktop` and `mobile` Playwright projects.
import type { Route } from '@playwright/test';
import { test, expect } from '@playwright/test';
import { t } from '../src/i18n/ar';
import { readAdminCredentials } from './fixtures/accounts';

const CHAT_PATH = '**/copilot/api/chat';

function jsonRoute(route: Route, status: number, body: unknown) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/** Registers the chat-route mock, then signs the seeded admin in and lands
 *  on the home page. The mock must be registered before the login's
 *  navigation to `/copilot`, since `Chat` fires its GET the moment it mounts. */
async function gotoHomeMocked(
  page: import('@playwright/test').Page,
  onRequest: (route: Route) => Promise<void> | void,
) {
  await page.goto('/copilot/login');
  await page.route(CHAT_PATH, async (route) => onRequest(route));

  const { email, password } = readAdminCredentials();
  await page.getByLabel(t('login.email')).fill(email);
  await page.getByLabel(t('login.password')).fill(password);
  await page.getByRole('button', { name: t('login.submit') }).click();
  await page.waitForURL('**/copilot');
}

test.describe('chat UI (T-12)', () => {
  test('empty state shows home.empty and three chips; a chip fills the composer without sending', async ({
    page,
  }) => {
    let postCalls = 0;
    await gotoHomeMocked(page, (route) => {
      if (route.request().method() === 'POST') {
        postCalls += 1;
        return jsonRoute(route, 200, {
          conversationId: 'c1',
          messageId: 'm1',
          kind: 'answer',
          textAr: 'لن يصل هذا',
          badges: [],
          memoryNotes: [],
        });
      }
      return jsonRoute(route, 200, { conversationId: null, messages: [] });
    });

    const log = page.getByRole('log');
    await expect(log.getByText(t('home.empty'))).toBeVisible();

    const chip = page.getByRole('button', { name: t('chat.suggest.3') });
    await expect(chip).toBeVisible();
    await chip.click();

    const textarea = page.getByLabel(t('chat.placeholder'));
    await expect(textarea).toHaveValue(t('chat.suggest.3'));
    await expect(textarea).toBeFocused();
    expect(postCalls).toBe(0);
  });

  test('the loading state is shown while the initial GET is pending', async ({ page }) => {
    await gotoHomeMocked(page, async (route) => {
      if (route.request().method() === 'GET') {
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }
      return jsonRoute(route, 200, { conversationId: null, messages: [] });
    });

    // The skeleton renders synchronously on mount, independent of the
    // artificial GET delay above, so it must already be visible here.
    await expect(page.locator('[aria-busy="true"]')).toBeVisible();
    await expect(page.getByRole('log').getByText(t('home.empty'))).toBeVisible();
  });

  test('a sent message appears, the waiting indicator shows, then the mocked answer with its badge and memory note', async ({
    page,
  }) => {
    await gotoHomeMocked(page, async (route) => {
      if (route.request().method() === 'GET') {
        return jsonRoute(route, 200, { conversationId: null, messages: [] });
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
      return jsonRoute(route, 200, {
        conversationId: 'c1',
        messageId: 'm1',
        kind: 'answer',
        textAr: 'هذا ردي عليك',
        badges: ['قراءة صندوق المهام'],
        memoryNotes: [{ id: 'f1', factAr: 'يفضل التواصل صباحاً', sourceType: 'chat' }],
      });
    });

    const textarea = page.getByLabel(t('chat.placeholder'));
    await textarea.fill('وش المهام اللي تنتظرني؟');
    await page.getByRole('button', { name: t('chat.send') }).click();

    const log = page.getByRole('log');
    await expect(log.getByText('وش المهام اللي تنتظرني؟')).toBeVisible();
    await expect(page.getByRole('status').getByText(t('chat.waiting'))).toBeVisible();

    await expect(log.getByText('هذا ردي عليك')).toBeVisible();
    await expect(log.getByText('قراءة صندوق المهام')).toBeVisible();
    await expect(log.getByText(t('memory.note'))).toBeVisible();
    await expect(log.getByText('يفضل التواصل صباحاً')).toBeVisible();
  });

  test('an hr_refusal reply is shown as a notice with the text of hr.refusal', async ({ page }) => {
    await gotoHomeMocked(page, (route) => {
      if (route.request().method() === 'GET') {
        return jsonRoute(route, 200, { conversationId: null, messages: [] });
      }
      return jsonRoute(route, 200, {
        conversationId: 'c1',
        messageId: 'm1',
        kind: 'hr_refusal',
        textAr: t('hr.refusal'),
        badges: [],
        memoryNotes: [],
      });
    });

    const textarea = page.getByLabel(t('chat.placeholder'));
    await textarea.fill('قيّم أداء الموظف فلان');
    await page.getByRole('button', { name: t('chat.send') }).click();

    await expect(page.getByRole('log').getByText(t('hr.refusal'))).toBeVisible();
  });

  test('a 500 shows the Arabic error and gives the typed text back to the composer', async ({ page }) => {
    const serverMessage = 'تعذر إكمال الطلب الآن';
    await gotoHomeMocked(page, (route) => {
      if (route.request().method() === 'GET') {
        return jsonRoute(route, 200, { conversationId: null, messages: [] });
      }
      return jsonRoute(route, 500, { error: 'server', messageAr: serverMessage });
    });

    const textarea = page.getByLabel(t('chat.placeholder'));
    await textarea.fill('طلب شراء جديد');
    await page.getByRole('button', { name: t('chat.send') }).click();

    await expect(page.getByRole('log').getByText(serverMessage)).toBeVisible();
    await expect(textarea).toHaveValue('طلب شراء جديد');
  });

  test('a GET 503 shows the error state, and retry loads the conversation', async ({ page }) => {
    // Keyed on an explicit "has retry been clicked yet" flag rather than a
    // raw call counter: React's dev-mode Strict Mode double-invokes mount
    // effects, so the initial GET can legitimately fire more than once
    // before the first assertion runs. Every GET before the click must stay
    // 503 (whichever of those duplicate calls resolves last still lands on
    // the error state), and the click itself only ever fires one GET.
    let retried = false;
    await gotoHomeMocked(page, (route) => {
      if (route.request().method() !== 'GET') return jsonRoute(route, 200, {});
      if (!retried) {
        return jsonRoute(route, 503, { error: 'npi_down', messageAr: 'تعذر الوصول إلى NPI الآن' });
      }
      return jsonRoute(route, 200, { conversationId: null, messages: [] });
    });

    await expect(page.getByRole('alert').getByText('تعذر الوصول إلى NPI الآن')).toBeVisible();
    retried = true;
    await page.getByRole('button', { name: t('action.retry') }).click();

    await expect(page.getByRole('log').getByText(t('home.empty'))).toBeVisible();
  });

  test('Enter sends the message; Shift+Enter only inserts a new line', async ({ page }) => {
    await gotoHomeMocked(page, (route) => {
      if (route.request().method() === 'GET') {
        return jsonRoute(route, 200, { conversationId: null, messages: [] });
      }
      return jsonRoute(route, 200, {
        conversationId: 'c1',
        messageId: 'm1',
        kind: 'answer',
        textAr: 'تم',
        badges: [],
        memoryNotes: [],
      });
    });

    const textarea = page.getByLabel(t('chat.placeholder'));
    await textarea.fill('السطر الأول');
    await textarea.press('Shift+Enter');
    await textarea.type('السطر الثاني');
    await expect(textarea).toHaveValue('السطر الأول\nالسطر الثاني');
    await expect(page.getByRole('log').getByText('السطر الأول')).toHaveCount(0);

    await textarea.press('Enter');
    await expect(textarea).toHaveValue('');
    await expect(page.getByRole('log').getByText('السطر الأول')).toBeVisible();
  });

  test('an answer containing a raw image tag is shown as literal text and opens no dialog', async ({ page }) => {
    const payload = '<img src=x onerror=alert(1)>';
    let dialogSeen = false;
    page.on('dialog', (dialog) => {
      dialogSeen = true;
      void dialog.dismiss();
    });

    await gotoHomeMocked(page, (route) => {
      if (route.request().method() === 'GET') {
        return jsonRoute(route, 200, { conversationId: null, messages: [] });
      }
      return jsonRoute(route, 200, {
        conversationId: 'c1',
        messageId: 'm1',
        kind: 'answer',
        textAr: payload,
        badges: [],
        memoryNotes: [],
      });
    });

    const textarea = page.getByLabel(t('chat.placeholder'));
    await textarea.fill('أرسل لي هذا النص');
    await page.getByRole('button', { name: t('chat.send') }).click();

    await expect(page.getByRole('log').getByText(payload, { exact: false })).toBeVisible();
    expect(await page.locator('img[src="x"]').count()).toBe(0);
    expect(dialogSeen).toBe(false);
  });

  test('no horizontal scroll at 390px with a long message and a long unbroken code', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const longCode = 'PRJ-' + '0'.repeat(300);
    const longMessage = 'رسالة طويلة جداً '.repeat(40) + longCode;

    await gotoHomeMocked(page, (route) => {
      if (route.request().method() === 'GET') {
        return jsonRoute(route, 200, { conversationId: null, messages: [] });
      }
      return jsonRoute(route, 200, {
        conversationId: 'c1',
        messageId: 'm1',
        kind: 'answer',
        textAr: longMessage,
        badges: [],
        memoryNotes: [],
      });
    });

    const textarea = page.getByLabel(t('chat.placeholder'));
    await textarea.fill('اختبار طول الرسالة');
    await page.getByRole('button', { name: t('chat.send') }).click();
    await expect(page.getByRole('log').getByText(longCode, { exact: false })).toBeVisible();

    const hasHorizontalScroll = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(hasHorizontalScroll).toBe(false);
  });
});
