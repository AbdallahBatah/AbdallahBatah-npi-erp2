// End-to-end coverage for T-12 (the chat UI). Real local NPI API + real
// copilot, real login — only `/copilot/api/chat`'s POST is intercepted, per the
// task brief ("no test may call the real chat model"). Runs on both the
// `desktop` and `mobile` Playwright projects.
//
// T-39b (D-23): the history no longer arrives through a browser-side GET —
// `/copilot` reads the caller's latest conversation on the server and renders
// it in the first HTML. So each test seeds that conversation in the copilot's
// database (`fixtures/chat-db.ts`; an empty one by default) before it signs in,
// instead of mocking the GET, and removes it afterwards.
import type { APIRequestContext, Page, Route } from '@playwright/test';
import { test, expect } from '@playwright/test';
import { t } from '../src/i18n/ar';
import { readAdminCredentials } from './fixtures/accounts';
import { waitForHydration } from './fixtures/hydration';
import {
  disconnectChatDb,
  npiIdentity,
  restoreChatFixture,
  seedLatestConversation,
  type ChatFixtureHandle,
  type ChatSeed,
  type HistoryMessage,
} from './fixtures/chat-db';

const CHAT_PATH = '**/copilot/api/chat';

function jsonRoute(route: Route, status: number, body: unknown) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/** What the running test seeded, for `afterEach` to remove. */
let handle: ChatFixtureHandle | undefined;

/** Seeds the admin's latest conversation (empty unless `seed` says otherwise),
 *  registers the chat-route mock for the POST, then signs the admin in and
 *  lands on the home page. The seed must exist before the login's navigation
 *  to `/copilot`, since the server reads it while rendering that page. The
 *  mock must not answer a GET: the page does not send one any more, and a
 *  handler that sees one lets it through to the network. */
async function gotoHomeMocked(
  page: Page,
  request: APIRequestContext,
  onRequest: (route: Route) => Promise<void> | void,
  seed: ChatSeed = { messages: [] },
) {
  const admin = readAdminCredentials();
  handle = await seedLatestConversation(await npiIdentity(request, admin), seed);

  await page.goto('/copilot/login');
  await page.route(CHAT_PATH, async (route) => onRequest(route));

  await page.getByLabel(t('login.email')).fill(admin.email);
  await page.getByLabel(t('login.password')).fill(admin.password);
  await page.getByRole('button', { name: t('login.submit') }).click();
  await page.waitForURL('**/copilot');
  await waitForHydration(page);
}

test.describe('chat UI (T-12)', () => {
  test.afterEach(async () => {
    await restoreChatFixture(handle);
    handle = undefined;
  });

  test.afterAll(async () => {
    await disconnectChatDb();
  });

  test('empty state shows home.empty and three chips; a chip fills the composer without sending', async ({
    page,
    request,
  }) => {
    let postCalls = 0;
    await gotoHomeMocked(page, request, (route) => {
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
      return route.fallback();
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

  test('the history arrives with the page: the empty state is in the first paint and the browser sends no history GET', async ({
    page,
    request,
  }) => {
    let historyGets = 0;
    await gotoHomeMocked(page, request, (route) => {
      if (route.request().method() === 'GET') historyGets += 1;
      return route.fallback();
    });

    // Server-rendered: no skeleton to wait out, the empty state is simply there.
    await expect(page.getByRole('log').getByText(t('home.empty'))).toBeVisible();
    expect(historyGets).toBe(0);
  });

  test('a sent message appears, the waiting indicator shows, then the mocked answer with its badge and memory note', async ({
    page,
    request,
  }) => {
    await gotoHomeMocked(page, request, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
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

  test('an hr_refusal reply is shown as a notice with the text of hr.refusal', async ({ page, request }) => {
    await gotoHomeMocked(page, request, (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
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

  test('a 500 shows the Arabic error and gives the typed text back to the composer', async ({ page, request }) => {
    const serverMessage = 'تعذر إكمال الطلب الآن';
    await gotoHomeMocked(page, request, (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      return jsonRoute(route, 500, { error: 'server', messageAr: serverMessage });
    });

    const textarea = page.getByLabel(t('chat.placeholder'));
    await textarea.fill('طلب شراء جديد');
    await page.getByRole('button', { name: t('chat.send') }).click();

    await expect(page.getByRole('log').getByText(serverMessage)).toBeVisible();
    await expect(textarea).toHaveValue('طلب شراء جديد');
  });

  // The former "a GET 503 shows the error state, and retry loads the conversation"
  // test cannot be driven any more: the first load never goes through the client
  // GET. `loadConversation`'s 503 mapping stays unit-tested in tests/chat-api.spec.ts.

  test('Enter sends the message; Shift+Enter only inserts a new line', async ({ page, request }) => {
    await gotoHomeMocked(page, request, (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
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

  test('an answer containing a raw image tag is shown as literal text and opens no dialog', async ({ page, request }) => {
    const payload = '<img src=x onerror=alert(1)>';
    let dialogSeen = false;
    page.on('dialog', (dialog) => {
      dialogSeen = true;
      void dialog.dismiss();
    });

    await gotoHomeMocked(page, request, (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
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

  test('no horizontal scroll at 390px with a long message and a long unbroken code', async ({ page, request }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const longCode = 'PRJ-' + '0'.repeat(300);
    const longMessage = 'رسالة طويلة جداً '.repeat(40) + longCode;

    await gotoHomeMocked(page, request, (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
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

  // Fix 1 (design-critique pass): the composer used to scroll with the page
  // and end up hidden behind the fixed bottom tab bar on a phone. Eight
  // messages is enough to make the page taller than either viewport below,
  // so the sticky composer actually has to engage.
  function eightMessages(): HistoryMessage[] {
    const roles = ['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant'] as const;
    return roles.map((role, i) => ({
      id: `m${i}`,
      role,
      textAr:
        i === 5
          ? 'PRJ-00012 هو رقم المشروع الذي تسأل عنه، ويمكنك متابعته من صندوق المهام.'
          : role === 'user'
            ? `سؤال رقم ${i} عن حالة الطلب`
            : `رد رقم ${i} على استفسارك، ومعه تفاصيل إضافية عن الحالة الحالية`,
      badges: [],
      memoryNotes: [],
      createdAt: new Date(2026, 0, 1, 0, i).toISOString(),
    }));
  }

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 390, height: 640 },
  ] as const) {
    test(`composer stays clear of the tab bar and the last message at ${viewport.width}x${viewport.height}`, async ({
      page,
      request,
    }) => {
      await page.setViewportSize(viewport);
      await gotoHomeMocked(
        page,
        request,
        (route) => {
          if (route.request().method() !== 'POST') return route.fallback();
          return jsonRoute(route, 200, {});
        },
        { conversationId: 'c1', messages: eightMessages() },
      );

      const composer = page.getByTestId('composer-wrapper');
      const tabBar = page.getByRole('navigation', { name: t('nav.main') });
      const log = page.getByRole('log');

      await expect(composer).toBeVisible();
      const composerBox = (await composer.boundingBox())!;
      const tabBarBox = (await tabBar.boundingBox())!;
      const viewportSize = page.viewportSize()!;

      // Fully inside the viewport.
      expect(composerBox.y).toBeGreaterThanOrEqual(0);
      expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(viewportSize.height + 1);

      // Does not overlap the fixed bottom tab bar.
      expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(tabBarBox.y + 1);

      // The newest message ends above the composer's top.
      const lastMessage = log.locator('p').last();
      const lastMessageBox = (await lastMessage.boundingBox())!;
      expect(lastMessageBox.y + lastMessageBox.height).toBeLessThanOrEqual(composerBox.y + 1);
    });
  }

  test('a message starting with a document code stays right-to-left, and the assistant sits nearer the inline-start edge', async ({
    page,
    request,
  }) => {
    await gotoHomeMocked(
      page,
      request,
      (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        return jsonRoute(route, 200, {});
      },
      { conversationId: 'c1', messages: eightMessages() },
    );

    const log = page.getByRole('log');
    const codeMessage = log.getByText('PRJ-00012', { exact: false });
    await expect(codeMessage).toBeVisible();
    const direction = await codeMessage.evaluate((el) => getComputedStyle(el).direction);
    expect(direction).toBe('rtl');

    // messages[5] (the PRJ-00012 one) is an assistant turn; messages[4] right
    // before it is the user's own turn — compare those two bubbles' distance
    // from the inline-start edge. This UI is RTL, so inline-start is the
    // viewport's RIGHT edge: distance-to-that-edge = viewportWidth - (x +
    // width), and "nearer the inline-start edge" means the smaller distance.
    const viewportSize = page.viewportSize()!;
    const assistantBubble = log.getByText('PRJ-00012', { exact: false }).locator('..');
    const userBubble = log.getByText('سؤال رقم 4', { exact: false }).locator('..');
    const assistantBox = (await assistantBubble.boundingBox())!;
    const userBox = (await userBubble.boundingBox())!;
    const assistantDistanceFromStart = viewportSize.width - (assistantBox.x + assistantBox.width);
    const userDistanceFromStart = viewportSize.width - (userBox.x + userBox.width);
    expect(assistantDistanceFromStart).toBeLessThan(userDistanceFromStart);
  });
});
