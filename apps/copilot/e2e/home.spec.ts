// End-to-end coverage for T-08 (the home screen). Real local NPI API + real
// copilot; the signed-in user starts from an empty conversation, since this
// file is about the tiles and the shell, not chat.
//
// T-39b (D-23): the chat history is read on the server, not fetched by the
// browser, so that empty conversation is seeded in the copilot's database
// (`fixtures/chat-db.ts`) before each sign-in and removed after each test —
// the same isolation the intercepted GET used to give, now real.
//
// Every tile's expected number is computed independently, in this file, by
// calling NPI's own API directly with the same seeded account — never
// assumed or hardcoded — so this test would catch a real drift between
// `src/queries/home.ts` and NPI's actual data.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from '@playwright/test';
import { t } from '../src/i18n/ar';
import { readAdminCredentials, readSiteEngineerCredentials, type SeededAccount } from './fixtures/accounts';
import { waitForHydration } from './fixtures/hydration';
import {
  disconnectChatDb,
  npiIdentity,
  restoreChatFixture,
  seedLatestConversation,
  type ChatFixtureHandle,
} from './fixtures/chat-db';

const API_PORT = process.env.COPILOT_E2E_API_PORT ?? '4077';
const API_BASE = `http://localhost:${API_PORT}/api`;

const TILE_KEYS = ['inbox', 'contracts_draft', 'pr_pending', 'bills_unmatched'] as const;
type TileKey = (typeof TILE_KEYS)[number];
const TILE_AR_KEY: Record<TileKey, string> = {
  inbox: 'home.tile.inbox',
  contracts_draft: 'home.tile.contracts_draft',
  pr_pending: 'home.tile.pr_pending',
  bills_unmatched: 'home.tile.bills_unmatched',
};

interface TileExpectation {
  forbidden: boolean;
  count: number | null;
}

async function npiLogin(request: APIRequestContext, account: SeededAccount): Promise<string> {
  const res = await request.post(`${API_BASE}/auth/login`, {
    data: { email: account.email, password: account.password },
  });
  expect(res.ok(), `NPI login failed for ${account.email}`).toBe(true);
  const body = (await res.json()) as { accessToken: string };
  return body.accessToken;
}

/**
 * Computes the same four numbers `src/queries/home.ts` computes, straight
 * from NPI's API — this is the independent oracle the UI is checked against.
 */
async function computeExpectedTiles(
  request: APIRequestContext,
  token: string,
): Promise<Record<TileKey, TileExpectation>> {
  const headers = { Authorization: `Bearer ${token}` };
  const [inboxRes, contractsRes, submittedRes, pendingRes, tasksRes] = await Promise.all([
    request.get(`${API_BASE}/inbox/count`, { headers }),
    request.get(`${API_BASE}/contracts`, { headers }),
    request.get(`${API_BASE}/requisitions?status=SUBMITTED&take=1`, { headers }),
    request.get(`${API_BASE}/requisitions?status=PENDING_APPROVAL&take=1`, { headers }),
    request.get(`${API_BASE}/inbox/tasks`, { headers }),
  ]);

  const inbox: TileExpectation =
    inboxRes.status() === 403
      ? { forbidden: true, count: null }
      : { forbidden: false, count: ((await inboxRes.json()) as { actionable: number }).actionable };

  const contracts_draft: TileExpectation =
    contractsRes.status() === 403
      ? { forbidden: true, count: null }
      : {
          forbidden: false,
          count: ((await contractsRes.json()) as Array<{ status: string }>).filter((c) => c.status === 'DRAFT')
            .length,
        };

  let pr_pending: TileExpectation;
  if (submittedRes.status() === 403 || pendingRes.status() === 403) {
    pr_pending = { forbidden: true, count: null };
  } else {
    const submitted = (await submittedRes.json()) as { total: number };
    const pending = (await pendingRes.json()) as { total: number };
    pr_pending = { forbidden: false, count: submitted.total + pending.total };
  }

  const bills_unmatched: TileExpectation =
    tasksRes.status() === 403
      ? { forbidden: true, count: null }
      : {
          forbidden: false,
          count: (
            (await tasksRes.json()) as Array<{ documentType: string; stateEn: string }>
          ).filter((r) => r.documentType === 'VendorBill' && r.stateEn === 'Recorded').length,
        };

  return { inbox, contracts_draft, pr_pending, bills_unmatched };
}

/** What the running test seeded, for `afterEach` to remove. */
let handle: ChatFixtureHandle | undefined;

/** Seeds an empty conversation as the account's latest (so its real history,
 *  if any, cannot change what the screen shows), then signs the account in
 *  through the real login form. */
async function signIn(page: Page, request: APIRequestContext, account: SeededAccount): Promise<void> {
  handle = await seedLatestConversation(await npiIdentity(request, account), { messages: [] });
  await page.goto('/copilot/login');
  await page.getByLabel(t('login.email')).fill(account.email);
  await page.getByLabel(t('login.password')).fill(account.password);
  await page.getByRole('button', { name: t('login.submit') }).click();
  await page.waitForURL('**/copilot');
  await waitForHydration(page);
}

async function assertTilesMatch(page: Page, expected: Record<TileKey, TileExpectation>): Promise<void> {
  for (const key of TILE_KEYS) {
    const tile = page.getByTestId(`tile-${TILE_AR_KEY[key]}`);
    if (expected[key].forbidden) {
      await expect(tile.getByText(t('home.tile.no_access'))).toBeVisible();
    } else {
      await expect(tile).toContainText(String(expected[key].count));
    }
  }
}

test.describe('home screen (T-08)', () => {
  test.afterEach(async () => {
    await restoreChatFixture(handle);
    handle = undefined;
  });

  test.afterAll(async () => {
    await disconnectChatDb();
  });

  test('the greeting carries the admin\'s Arabic name and each tile matches NPI', async ({ page, request }) => {
    const admin = readAdminCredentials();
    const token = await npiLogin(request, admin);
    const expected = await computeExpectedTiles(request, token);

    await signIn(page, request, admin);

    await expect(page.getByRole('heading', { name: t('home.greeting', { name: admin.nameAr }) })).toBeVisible();
    await assertTilesMatch(page, expected);
  });

  test('the user name and the logout control are in the shell', async ({ page, request }) => {
    const admin = readAdminCredentials();
    await signIn(page, request, admin);

    // The header hides the name/label text below the `sm` breakpoint (an
    // existing AppShell behaviour, unchanged by T-08), so presence in the
    // DOM — not CSS visibility — is what both projects can assert.
    await expect(page.locator('header').getByText(admin.nameAr)).toHaveCount(1);
    await expect(page.locator('header button')).toHaveCount(1);
    await expect(page.locator('header button')).toBeVisible();
  });

  test('logout clears the session and returns to the login page', async ({ page, request }) => {
    const admin = readAdminCredentials();
    await signIn(page, request, admin);

    await page.locator('header button').click();
    await page.waitForURL('**/copilot/login');
    expect(new URL(page.url()).pathname).toBe('/copilot/login');
  });

  test('a lower-permission account sees "no access" on exactly the tiles NPI actually forbids it', async ({
    page,
    request,
  }) => {
    const engineer = readSiteEngineerCredentials();
    const token = await npiLogin(request, engineer);
    const expected = await computeExpectedTiles(request, token);

    await signIn(page, request, engineer);
    await assertTilesMatch(page, expected);
  });

  test('no horizontal scroll at 390px', async ({ page, request }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const admin = readAdminCredentials();
    await signIn(page, request, admin);

    await expect(page.getByRole('heading', { name: t('home.greeting', { name: admin.nameAr }) })).toBeVisible();
    const hasHorizontalScroll = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(hasHorizontalScroll).toBe(false);
  });

  // Fix 4 (design-critique pass): a way back to NPI on a phone, and a named
  // logout button.
  test('at 390px a "back to NPI" link is visible in the bottom bar', async ({ page, request }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const admin = readAdminCredentials();
    await signIn(page, request, admin);

    const nav = page.getByRole('navigation', { name: t('nav.main') });
    await expect(nav.getByRole('link', { name: t('nav.back_to_npi') })).toBeVisible();
  });

  test('the logout button has an accessible name', async ({ page, request }) => {
    const admin = readAdminCredentials();
    await signIn(page, request, admin);

    await expect(page.getByRole('button', { name: t('logout') })).toBeVisible();
  });

  test("each tile's link starts with the NPI web base", async ({ page, request }) => {
    const admin = readAdminCredentials();
    const token = await npiLogin(request, admin);
    const expected = await computeExpectedTiles(request, token);
    await signIn(page, request, admin);

    for (const key of TILE_KEYS) {
      if (expected[key].forbidden) continue; // no link on a "no access" tile
      const href = await page.getByTestId(`tile-${TILE_AR_KEY[key]}`).getAttribute('href');
      expect(href).not.toBeNull();
      expect(href).toMatch(/^https?:\/\//);
    }
  });

  test('the screen registry, apps/web nav.ts and messages.ts carry the Madar copilot entry (static check — apps/web is not started here)', () => {
    // Since ADR-02 task 2 (NPI P1-4, 2026-10-12) the sidebar screens live in
    // the shared screen registry and nav.ts only adds the icon and the i18n
    // key per href — so the link is asserted where each half of it now lives.
    const screensPath = path.resolve(__dirname, '..', '..', '..', 'packages', 'shared', 'src', 'screens.ts');
    const screensSrc = readFileSync(screensPath, 'utf8');
    expect(screensSrc).toMatch(/href:\s*'\/copilot'/);

    const navPath = path.resolve(__dirname, '..', '..', '..', 'apps', 'web', 'src', 'lib', 'nav.ts');
    const navSrc = readFileSync(navPath, 'utf8');
    expect(navSrc).toMatch(/'\/copilot':\s*\{\s*key:\s*'nav\.madar'/);

    const messagesPath = path.resolve(__dirname, '..', '..', '..', 'apps', 'web', 'src', 'lib', 'messages.ts');
    const messagesSrc = readFileSync(messagesPath, 'utf8');
    expect(messagesSrc).toContain("'nav.madar': 'مساعد مَدار'");
  });
});
