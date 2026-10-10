// End-to-end coverage for T-22's attach + consent flow. Real local NPI API +
// real copilot, real login — `/copilot/api/chat`, `/copilot/api/documents`
// and `/copilot/api/documents/consent` are all intercepted (no test may call
// the real model, and the backend's consent route does not need to exist for
// this spec to run, since it is never actually hit). Runs on both the
// `desktop` and `mobile` Playwright projects.
//
// T-39b (D-23): the chat history is read on the server, not fetched by the
// browser, so the "always an empty conversation" this spec needs is now seeded
// in the copilot's database (`fixtures/chat-db.ts`) before the login and
// removed after each test, instead of being mocked through a GET.
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
} from './fixtures/chat-db';

const CHAT_PATH = '**/copilot/api/chat';
const DOCUMENTS_PATH = '**/copilot/api/documents';
const CONSENT_PATH = '**/copilot/api/documents/consent';

// A real, minimal 1x1 PNG — small enough to inline, large enough for the
// browser to accept as a genuine image file for `setInputFiles`.
const PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

function jsonRoute(route: Route, status: number, body: unknown) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/** What the running test seeded, for `afterEach` to remove. */
let handle: ChatFixtureHandle | undefined;

/** Seeds an empty conversation for the admin (this spec is only about the
 *  attach/consent flow, not chat history), registers the chat-route mock for
 *  the POST, then signs the admin in and lands on the home page. The seed must
 *  exist before the login's navigation to `/copilot`, since the server reads
 *  it while rendering that page (same pattern as `e2e/chat-ui.spec.ts`). */
async function gotoHomeMocked(page: Page, request: APIRequestContext) {
  const admin = readAdminCredentials();
  handle = await seedLatestConversation(await npiIdentity(request, admin), { messages: [] });

  await page.goto('/copilot/login');
  await page.route(CHAT_PATH, (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    return jsonRoute(route, 200, {
      conversationId: 'c1',
      messageId: 'm1',
      kind: 'answer',
      textAr: 'لن يصل هذا',
      badges: [],
      memoryNotes: [],
    });
  });

  await page.getByLabel(t('login.email')).fill(admin.email);
  await page.getByLabel(t('login.password')).fill(admin.password);
  await page.getByRole('button', { name: t('login.submit') }).click();
  await page.waitForURL('**/copilot');
  await waitForHydration(page);
}

function documentBody(kind: 'image' | 'pdf_scanned' | 'pdf_text', overrides: Record<string, unknown> = {}) {
  return {
    document: {
      id: 'doc-1',
      fileName: 'فاتورة.png',
      mime: 'image/png',
      sizeBytes: PNG_BUFFER.byteLength,
      kind,
      pageCount: 1,
      textChars: kind === 'pdf_text' ? 500 : null,
      createdAt: '2026-10-04T00:00:00.000Z',
    },
    ...overrides,
  };
}

async function attachPng(page: Page, fileName = 'فاتورة.png') {
  await page.locator('[data-testid="attach-input"]').setInputFiles({
    name: fileName,
    mimeType: 'image/png',
    buffer: PNG_BUFFER,
  });
}

test.describe('attach + consent flow (T-22)', () => {
  test.afterEach(async () => {
    await restoreChatFixture(handle);
    handle = undefined;
  });

  test.afterAll(async () => {
    await disconnectChatDb();
  });

  test('image attachment shows the consent card before any consent call; approve records it', async ({ page, request }) => {
    let consentCalls = 0;
    let consentBody: unknown;

    await gotoHomeMocked(page, request);
    await page.route(DOCUMENTS_PATH, (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      return jsonRoute(route, 201, documentBody('image'));
    });
    await page.route(CONSENT_PATH, async (route) => {
      consentCalls += 1;
      consentBody = route.request().postDataJSON();
      return jsonRoute(route, 200, {
        consentEventId: 'ce-1',
        documentId: 'doc-1',
        decision: 'approved',
        policyLine: t('consent.policy_line'),
      });
    });

    await attachPng(page);

    const log = page.getByRole('log');
    await expect(log.getByText(t('chat.attached', { name: 'فاتورة.png' }))).toBeVisible();

    const card = page.getByTestId('consent-card');
    await expect(card).toBeVisible();
    // `getByText` would hit both the visible `<h3>` title and the sr-only
    // span that duplicates it for `aria-labelledby` — the heading role is
    // unambiguous.
    await expect(card.getByRole('heading', { name: t('consent.title') })).toBeVisible();
    await expect(card.getByText(t('consent.policy_line'), { exact: false })).toBeVisible();

    // AT-04: the card appears before any consent call is made.
    expect(consentCalls).toBe(0);

    await card.getByRole('button', { name: t('consent.approve') }).click();

    await expect.poll(() => consentCalls).toBe(1);
    expect(consentBody).toEqual({ documentId: 'doc-1', decision: 'approved' });
    await expect(card).not.toBeVisible();
    await expect(log.getByText(t('chat.consent_recorded'))).toBeVisible();
  });

  test('cancel records a cancelled decision and shows the cancellation notice', async ({ page, request }) => {
    let consentCalls = 0;
    let consentBody: unknown;

    await gotoHomeMocked(page, request);
    await page.route(DOCUMENTS_PATH, (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      return jsonRoute(route, 201, documentBody('image'));
    });
    await page.route(CONSENT_PATH, async (route) => {
      consentCalls += 1;
      consentBody = route.request().postDataJSON();
      return jsonRoute(route, 200, {
        consentEventId: 'ce-2',
        documentId: 'doc-1',
        decision: 'cancelled',
        policyLine: t('consent.policy_line'),
      });
    });

    await attachPng(page);

    const card = page.getByTestId('consent-card');
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: t('consent.cancel') }).click();

    await expect.poll(() => consentCalls).toBe(1);
    expect(consentBody).toEqual({ documentId: 'doc-1', decision: 'cancelled' });
    await expect(card).not.toBeVisible();
    await expect(page.getByRole('log').getByText(t('chat.consent_cancelled'))).toBeVisible();
  });

  test('a pdf_text document needs no consent card and never calls the consent endpoint', async ({ page, request }) => {
    let consentCalls = 0;

    await gotoHomeMocked(page, request);
    await page.route(DOCUMENTS_PATH, (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      const body = documentBody('pdf_text');
      body.document.fileName = 'عقد.pdf';
      body.document.mime = 'application/pdf';
      return jsonRoute(route, 201, body);
    });
    await page.route(CONSENT_PATH, (route) => {
      consentCalls += 1;
      return jsonRoute(route, 200, {});
    });

    await attachPng(page, 'عقد.pdf');

    await expect(page.getByTestId('consent-card')).toHaveCount(0);
    await expect(page.getByRole('log').getByText(t('chat.document_text_ready'))).toBeVisible();
    expect(consentCalls).toBe(0);
  });

  test('a refused_confidential upload shows an error bubble with no card and no consent call', async ({ page, request }) => {
    let consentCalls = 0;
    const refusalMessage = t('intake.refused_confidential');

    await gotoHomeMocked(page, request);
    await page.route(DOCUMENTS_PATH, (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      return jsonRoute(route, 422, { error: 'refused_confidential', messageAr: refusalMessage });
    });
    await page.route(CONSENT_PATH, (route) => {
      consentCalls += 1;
      return jsonRoute(route, 200, {});
    });

    await attachPng(page, 'عقد-سري.png');

    await expect(page.getByRole('log').getByText(refusalMessage)).toBeVisible();
    await expect(page.getByTestId('consent-card')).toHaveCount(0);
    expect(consentCalls).toBe(0);
  });

  test('a failed consent call keeps the card up with an error, and a retry succeeds', async ({ page, request }) => {
    let consentCalls = 0;

    await gotoHomeMocked(page, request);
    await page.route(DOCUMENTS_PATH, (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      return jsonRoute(route, 201, documentBody('image'));
    });
    await page.route(CONSENT_PATH, async (route) => {
      consentCalls += 1;
      if (consentCalls === 1) {
        return jsonRoute(route, 500, { error: 'server', messageAr: t('chat.error.generic') });
      }
      return jsonRoute(route, 200, {
        consentEventId: 'ce-3',
        documentId: 'doc-1',
        decision: 'approved',
        policyLine: t('consent.policy_line'),
      });
    });

    await attachPng(page);

    const card = page.getByTestId('consent-card');
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: t('consent.approve') }).click();

    await expect.poll(() => consentCalls).toBe(1);
    await expect(card).toBeVisible();
    await expect(card.getByRole('alert')).toBeVisible();

    await card.getByRole('button', { name: t('consent.approve') }).click();
    await expect.poll(() => consentCalls).toBe(2);
    await expect(card).not.toBeVisible();
    await expect(page.getByRole('log').getByText(t('chat.consent_recorded'))).toBeVisible();
  });

  test('no horizontal scroll at the configured viewport while the consent card is shown', async ({ page, request }) => {
    await gotoHomeMocked(page, request);
    await page.route(DOCUMENTS_PATH, (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      return jsonRoute(route, 201, documentBody('image'));
    });
    await page.route(CONSENT_PATH, (route) => jsonRoute(route, 200, {}));

    await attachPng(page);
    await expect(page.getByTestId('consent-card')).toBeVisible();

    const hasHorizontalScroll = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(hasHorizontalScroll).toBe(false);
  });
});
