// T-30 (F-13, BR-07, AT-12, G-M3-8): the handover of a position. Real login,
// the real copilot API and the real NPI API of the e2e run (:4077);
// `page.route` is not used anywhere in this file.
//
// What this spec proves:
//  1. The settings screen links a position to the reassignment screen, which
//     lists the NPI users who may take it over (a candidate is a pm who does
//     not hold it) — no submit here (describe 1, test 1).
//  2. A handover document written by the server's own `reassignPosition`
//     (fixtures/handover.ts) shows the administrator what NPI's approval
//     matrix waits on from the role — checked against NPI's own approvals
//     inbox for the successor, which holds the same role — the vendors and
//     routines of the firm's memory, the narrative, and the predecessor's
//     conversations, which open read-only (test 2).
//  3. The successor reads the document, sees no predecessor conversations,
//     cannot open one (404 on the chat endpoint), and cannot list candidates
//     or reassign (403) (test 3). An unrelated user sees nothing (test 4).
//
// What it does NOT prove: the reassignment through the browser with the real
// model (only `@live-handover`, once, with `COPILOT_LIVE=1`); the chat's
// seven-day guidance (a unit test and the reviewer's live run); the mobile
// viewport (the spec writes real records, so the `mobile` project reports
// every test as skipped — never as passed).
//
// Decisions:
//  - The documents are made by the server's own function with a scripted
//    narrative model (no model in the default run, same as T-28 D-T28-1).
//  - Serial, one fixture. Test 1 puts the position back in its starting state
//    (pm1 holds it, pm2 does not) because the seeded handover has already
//    moved it; that does not touch the document the other tests read.
//  - The task list is compared with NPI's `/approvals/inbox` for pm2 (the role
//    is the same, NPI is the oracle). The document shows at most 50 tasks,
//    oldest first; when NPI holds more than 50 chains for the role the spec
//    checks "50 shown, all of them NPI's" and does not claim the new one is
//    among them.
import type { APIRequestContext, Page, PlaywrightWorkerArgs } from '@playwright/test';
import { test, expect } from '@playwright/test';
import { t } from '../src/i18n/ar';
import { formatDate, formatNumber } from '../src/i18n/format';
import type { HandoverView } from '../src/positions/handover-types';
import { readAdminCredentials, readSiteEngineerCredentials, type SeededAccount } from './fixtures/accounts';
import {
  PREDECESSOR_CHAT,
  ROUTINE_FACT_AR,
  SCRIPTED_NARRATIVE,
  VENDOR_FACTS,
  disconnectHandoverDb,
  handoverAuditRows,
  handoverRow,
  npiInboxCodes,
  pendingRequisitionForPm,
  resetPmPosition,
  seedHandover,
  seedPositionMemory,
  seedPredecessorChat,
  type PmPositionState,
  type SeededChat,
} from './fixtures/handover';
import { npiLogin } from './fixtures/scratch-orgs';

// ─── Shared helpers ─────────────────────────────────────────────────────────

const DESKTOP_ONLY = 'writes real NPI and copilot records; the desktop project is enough';

/** Skips every test of the enclosing describe outside the `desktop` project. */
function desktopOnly(): void {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', DESKTOP_ONLY);
  });
}

/** `next dev` compiles a route on its first visit; the first assertion after a
 *  `goto` of a page the run has not visited yet gets this long. */
const FIRST_PAINT = { timeout: 60_000 } as const;

/** NPI's document codes (`PR-00025`, `PO-00007`, …) — the one Latin text on the page. */
const DOCUMENT_CODE = /[A-Z]{2,4}-\d{3,6}/;

/** The handover shows at most this many tasks (D-T30-6). */
const TASK_CAP = 50;

async function signIn(page: Page, account: SeededAccount): Promise<void> {
  await page.goto('/copilot/login');
  await page.getByLabel(t('login.email')).fill(account.email);
  await page.getByLabel(t('login.password')).fill(account.password);
  await page.getByRole('button', { name: t('login.submit') }).click();
  await page.waitForURL('**/copilot');
}

/** A request context of its own, signed in to the copilot through the same
 *  endpoint the login form posts to — for a second user next to the page. */
async function apiSession(
  playwright: PlaywrightWorkerArgs['playwright'],
  baseURL: string | undefined,
  account: SeededAccount,
): Promise<APIRequestContext> {
  if (baseURL === undefined) throw new Error('playwright.config.ts sets no baseURL');
  const context = await playwright.request.newContext({ baseURL });
  const res = await context.post('/copilot/api/auth', { data: { email: account.email, password: account.password } });
  if (!res.ok()) {
    await context.dispose();
    throw new Error(`copilot login failed for ${account.email}: HTTP ${res.status()}`);
  }
  return context;
}

// ─── The handover, written by the server's own function ─────────────────────

test.describe('handover (T-30)', () => {
  test.describe.configure({ mode: 'serial', timeout: 90_000 });
  desktopOnly();

  let state: PmPositionState;
  let chat: SeededChat;
  let requisitionCode: string;
  let handoverId: string;

  test.beforeAll(async ({ request }, testInfo) => {
    if (testInfo.project.name !== 'desktop') return;
    // The first call of the run compiles the copilot's auth route and logs in
    // three users; give the fixture room.
    test.setTimeout(180_000);

    // `resetPmPosition` makes sure the second pm exists in NPI (idempotent),
    // signs pm1 in through the real login so `resolvePosition` creates the
    // position and pm1's assignment, and clears every other holder.
    state = await resetPmPosition(request);
    await seedPositionMemory(state.orgId, state.positionId);
    chat = await seedPredecessorChat(state.orgId, state.pm1.userId, state.positionId);
    requisitionCode = (await pendingRequisitionForPm(request)).code;
    handoverId = (await seedHandover(request, { positionId: state.positionId, pm2UserId: state.pm2.userId })).handoverId;
  });

  test.afterAll(disconnectHandoverDb);

  test('1. settings links the position to the reassignment screen, which offers pm2 and not the holder', async ({ page, request }) => {
    // The seeded handover has already made pm2 the holder; put the position
    // back to "pm1 holds it" (same position) before reading the candidates.
    const reset = await resetPmPosition(request, { positionId: state.positionId });
    expect(reset.positionId).toBe(state.positionId);

    await signIn(page, readAdminCredentials());
    await page.goto('/copilot/settings');

    const link = page.locator(`[data-testid="settings-position-reassign"][href*="positionId=${state.positionId}"]`);
    await expect(link).toBeVisible(FIRST_PAINT);
    await expect(link).toContainText(t('settings.positions.reassign'));
    await link.click();
    await page.waitForURL(new RegExp(`/copilot/handover\\?positionId=${state.positionId}$`));

    const select = page.getByTestId('handover-candidate');
    await expect(select).toBeVisible(FIRST_PAINT);
    // pm1's name is a prefix of pm2's: compare whole option texts, not substrings.
    await expect(select.locator('option', { hasText: state.pm2.nameAr })).toHaveCount(1);
    const options = (await select.locator('option').allTextContents()).map((text) => text.trim());
    expect(options).toContain(state.pm2.nameAr);
    expect(options).not.toContain(state.pm1.nameAr);

    await expect(page.getByRole('button', { name: t('handover.reassign.submit') })).toBeEnabled();
    // No submit: reassigning through the screen calls the model (`@live-handover`).
  });

  test('2. the administrator reads the document: tasks, vendors, routines, narrative, predecessor chats', async ({ page, request }) => {
    const row = await handoverRow(handoverId);
    expect(row.fromUserId).toBe(state.pm1.userId);
    expect(row.toUserId).toBe(state.pm2.userId);

    await signIn(page, readAdminCredentials());
    await page.goto(`/copilot/handover?id=${handoverId}`);

    const doc = page.getByTestId('handover-doc');
    await expect(doc).toBeVisible(FIRST_PAINT);
    await expect(doc).toContainText(state.positionTitleAr);
    await expect(doc).toContainText(t('handover.from', { name: state.pm1.nameAr }));
    await expect(doc).toContainText(t('handover.since', { date: formatDate(state.pm1.since) }));
    await expect(doc).toContainText(t('handover.to', { name: state.pm2.nameAr }));
    await expect(doc).toContainText(t('handover.generated_at', { date: formatDate(row.createdAt) }));

    // Tasks: the requisition is there, with its amount, and the set of codes is NPI's own.
    const tasks = page.getByTestId('handover-tasks');
    const taskRows = tasks.getByTestId('handover-task');
    const inboxCodes = await npiInboxCodes(request, state.pm2);
    if (inboxCodes.length <= TASK_CAP) {
      const mine = taskRows.filter({ hasText: requisitionCode });
      await expect(mine).toHaveCount(1);
      await expect(mine).toContainText(t('handover.task.amount', { amount: formatNumber(12800) }));
    } else {
      test.info().annotations.push({
        type: 'note',
        description: `NPI holds ${inboxCodes.length} chains for the pm role; the document lists the oldest ${TASK_CAP}, so the new requisition is not asserted by code`,
      });
    }
    await expect(taskRows.first()).toBeVisible();
    // The code sits in the row's first paragraph («طلب شراء PR-00025»); the
    // whole row's text would glue it to the amount that follows (PR-00025 + 12,800).
    const titles = await taskRows.evaluateAll((rows) => rows.map((row) => row.querySelector('p')?.textContent ?? ''));
    const shown = titles.map((text) => DOCUMENT_CODE.exec(text)?.[0] ?? `no-code:${text}`);
    if (inboxCodes.length <= TASK_CAP) {
      expect([...shown].sort()).toEqual([...inboxCodes].sort());
    } else {
      expect(shown).toHaveLength(TASK_CAP);
      for (const code of shown) expect(inboxCodes).toContain(code);
    }

    // Vendors: each seeded vendor appears once (the org's memory may hold other vendors too).
    const vendors = page.getByTestId('handover-vendors');
    for (const vendor of VENDOR_FACTS) {
      await expect(vendors.getByTestId('handover-vendor').filter({ hasText: vendor.nameAr })).toHaveCount(1);
    }
    expect(await vendors.getByTestId('handover-vendor').count()).toBeGreaterThanOrEqual(VENDOR_FACTS.length);

    // Routines.
    await expect(page.getByTestId('handover-routines')).toContainText(ROUTINE_FACT_AR);

    // Narrative: the scripted one, verbatim.
    const narrative = page.getByTestId('handover-narrative');
    await expect(narrative).toContainText(SCRIPTED_NARRATIVE.summaryAr);
    for (const line of [...SCRIPTED_NARRATIVE.firstWeekAr, ...SCRIPTED_NARRATIVE.cautionsAr]) {
      await expect(narrative).toContainText(line);
    }

    // The predecessor's conversation, listed for the administrator and opened read-only.
    const chats = page.getByTestId('handover-chats');
    const chatRow = chats.getByRole('listitem').filter({ hasText: PREDECESSOR_CHAT.titleAr });
    await expect(chatRow).toHaveCount(1);
    await expect(chatRow).toContainText(
      t('handover.chats.item', { title: PREDECESSOR_CHAT.titleAr, date: formatDate(chat.updatedAt), count: formatNumber(2) }),
    );
    await chatRow.getByRole('button', { name: t('handover.chats.open') }).click();

    const transcript = page.getByTestId('handover-chat-transcript');
    await expect(transcript).toBeVisible(FIRST_PAINT);
    await expect(transcript).toContainText(PREDECESSOR_CHAT.userText);
    await expect(transcript).toContainText(PREDECESSOR_CHAT.assistantText);
    // Read-only: no composer anywhere in the transcript.
    await expect(transcript.getByRole('textbox')).toHaveCount(0);
  });

  test('3. the successor reads the document but not the predecessor\'s chats, and cannot reassign', async ({
    page,
    playwright,
    baseURL,
  }) => {
    const row = await handoverRow(handoverId);

    await signIn(page, state.pm2);
    const nav = page.getByRole('navigation', { name: t('nav.main') });
    await expect(nav.getByRole('link', { name: t('nav.handover') })).toBeVisible();

    // The list shows the document.
    await page.goto('/copilot/handover');
    const item = page.locator(`a[href*="id=${handoverId}"]`);
    await expect(item).toBeVisible(FIRST_PAINT);
    await expect(item).toContainText(
      t('handover.list.item', { position: row.positionTitleAr, date: formatDate(row.createdAt) }),
    );

    // The document renders, without the administrator-only section.
    await page.goto(`/copilot/handover?id=${handoverId}`);
    await expect(page.getByTestId('handover-doc')).toBeVisible(FIRST_PAINT);
    await expect(page.getByTestId('handover-tasks')).toBeVisible();
    await expect(page.getByTestId('handover-chats')).toHaveCount(0);

    const pm2 = await apiSession(playwright, baseURL, state.pm2);
    const admin = await apiSession(playwright, baseURL, readAdminCredentials());
    try {
      // BR-07: the predecessor's conversation is not the successor's, and is the administrator's.
      const chatPath = `/copilot/api/chat?conversationId=${encodeURIComponent(chat.conversationId)}`;
      const denied = await pm2.get(chatPath);
      expect(denied.status()).toBe(404);

      const allowed = await admin.get(chatPath);
      expect(allowed.status()).toBe(200);
      const transcript = (await allowed.json()) as { conversationId: string; messages: { textAr: string }[] };
      expect(transcript.conversationId).toBe(chat.conversationId);
      expect(transcript.messages.map((m) => m.textAr)).toEqual([PREDECESSOR_CHAT.userText, PREDECESSOR_CHAT.assistantText]);

      // The document through the API: the successor's view carries no predecessor conversations; the administrator's does.
      const docPath = `/copilot/api/handover?id=${encodeURIComponent(handoverId)}`;
      const asPm2 = await pm2.get(docPath);
      expect(asPm2.status()).toBe(200);
      const pm2View = ((await asPm2.json()) as { handover: HandoverView }).handover;
      expect(pm2View.id).toBe(handoverId);
      expect(pm2View).not.toHaveProperty('predecessorConversations');

      const asAdmin = await admin.get(docPath);
      expect(asAdmin.status()).toBe(200);
      const adminView = ((await asAdmin.json()) as { handover: HandoverView }).handover;
      expect(adminView.predecessorConversations?.map((c) => c.id)).toContain(chat.conversationId);

      // Candidates and both actions are the administrator's.
      const candidates = await pm2.get(`/copilot/api/handover?positionId=${encodeURIComponent(state.positionId)}`);
      expect(candidates.status()).toBe(403);
      expect(((await candidates.json()) as { messageAr: string }).messageAr).toBe(t('handover.forbidden'));

      const reassign = await pm2.post('/copilot/api/handover', {
        data: { action: 'reassign', positionId: state.positionId, toUserId: state.pm1.userId },
      });
      expect(reassign.status()).toBe(403);

      const narrate = await pm2.post('/copilot/api/handover', { data: { action: 'narrate', id: handoverId } });
      expect(narrate.status()).toBe(403);
    } finally {
      await pm2.dispose();
      await admin.dispose();
    }
  });

  test('4. an unrelated user sees no document and no list entry', async ({ page, playwright, baseURL }) => {
    const engineer = readSiteEngineerCredentials();

    await signIn(page, engineer);
    await page.goto(`/copilot/handover?id=${handoverId}`);
    await expect(page.getByText(t('handover.not_found'))).toBeVisible(FIRST_PAINT);
    await expect(page.getByTestId('handover-doc')).toHaveCount(0);

    await page.goto('/copilot/handover');
    await expect(page.getByText(t('handover.list.empty'))).toBeVisible(FIRST_PAINT);

    const session = await apiSession(playwright, baseURL, engineer);
    try {
      const doc = await session.get(`/copilot/api/handover?id=${encodeURIComponent(handoverId)}`);
      expect(doc.status()).toBe(404);
      expect(((await doc.json()) as { messageAr: string }).messageAr).toBe(t('handover.not_found'));

      const list = await session.get('/copilot/api/handover');
      expect(list.status()).toBe(200);
      expect(((await list.json()) as { handovers: unknown[] }).handovers).toEqual([]);

      const chatRes = await session.get(`/copilot/api/chat?conversationId=${encodeURIComponent(chat.conversationId)}`);
      expect(chatRes.status()).toBe(404);
    } finally {
      await session.dispose();
    }
  });
});

// ─── The reassignment through the browser, with the real model ──────────────

test.describe('handover with the real model (T-30, live)', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });
  desktopOnly();

  let state: PmPositionState;
  let requisitionCode: string;

  test.beforeAll(async ({ request }, testInfo) => {
    if (testInfo.project.name !== 'desktop' || !process.env.COPILOT_LIVE) return;
    test.setTimeout(180_000);
    state = await resetPmPosition(request);
    requisitionCode = (await pendingRequisitionForPm(request)).code;
  });

  test.afterAll(disconnectHandoverDb);

  test('@live-handover the administrator reassigns the position to pm2 and the document is written', async ({ page, request }, testInfo) => {
    test.skip(
      !process.env.COPILOT_LIVE,
      'live run with the real model: COPILOT_LIVE=1 and ANTHROPIC_API_KEY in the copilot server (e.g. dotenv -e ../../.env -v COPILOT_LIVE=1 -- playwright test --project desktop --grep @live-handover)',
    );
    test.setTimeout(180_000);

    // A small margin for the clock difference between this process and the database.
    const startedAt = new Date(Date.now() - 5_000);
    const admin = readAdminCredentials();

    await signIn(page, admin);
    await page.goto(`/copilot/handover?positionId=${state.positionId}`);

    const select = page.getByTestId('handover-candidate');
    await expect(select).toBeVisible(FIRST_PAINT);
    await select.selectOption({ label: state.pm2.nameAr });
    const submit = page.getByRole('button', { name: t('handover.reassign.submit') });
    await expect(submit).toBeEnabled();
    await submit.click();

    // The model call can take up to a minute.
    await page.waitForURL(/\/copilot\/handover\?id=/, { timeout: 90_000 });

    const narrative = page.getByTestId('handover-narrative');
    await expect(narrative).toBeVisible(FIRST_PAINT);
    // Written (the card carries the first-week list) or failed (the card says
    // so). Both are reported verbatim; the model's wording is never asserted.
    const written = narrative.getByText(t('handover.narrative.first_week'));
    const failed = narrative.getByText(t('handover.narrative.failed', { reason: '' }).trim(), { exact: false });
    await expect(written.or(failed).first()).toBeVisible();
    await testInfo.attach('narrative', { body: (await narrative.innerText()).trim(), contentType: 'text/plain; charset=utf-8' });
    await testInfo.attach('narrative-outcome', {
      body: (await written.count()) > 0 ? 'written' : 'failed',
      contentType: 'text/plain; charset=utf-8',
    });

    // The new requisition is among the tasks (the oldest 50 are listed; a
    // fresh local NPI holds far fewer).
    await expect(page.getByTestId('handover-tasks').getByTestId('handover-task').filter({ hasText: requisitionCode })).toHaveCount(1);

    // The trail: one model call for the narrative and one reassignment row, both the administrator's.
    const rows = await handoverAuditRows((await npiLogin(request, admin)).userId, startedAt);
    expect(rows.filter((r) => r.event === 'handover_narrative')).toHaveLength(1);
    expect(rows.filter((r) => r.event === 'position_reassigned')).toHaveLength(1);
  });
});
