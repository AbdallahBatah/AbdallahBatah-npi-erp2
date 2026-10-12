// T-28 (F-11, TEST): the copilot cannot be made to approve anything, and what
// it does send to NPI lands in NPI's own matrix. Real login, the real copilot
// API and the real NPI API of the e2e run (:4077); `page.route` is not used
// anywhere in this file.
//
// What this spec proves (spec/madar/06: AT-03 last clause, AT-07, AT-08, AT-15):
//  1. A user NPI would refuse is refused by the copilot BEFORE any model call:
//     no job is created, and `llm_audit` gains no row (describe 1).
//  2. A purchase requisition made through the copilot lands in NPI's approval
//     matrix — `PENDING_APPROVAL`, an open chain for the project manager — and
//     the copilot offers no path to approve it: its intake endpoint answers
//     409/400/404 to every approve-shaped request, and only NPI's inbox shows
//     the chain to the approver (describe 2).
//  3. A step NPI refuses (403) is reported on the card with NPI's message
//     verbatim, nothing after it ran, and nothing was created (describe 3).
//  The fourth claim of T-28 (no NPI Prisma client / database URL / admin token
//  in the copilot's code, every NPI call carrying the user's JWT, no
//  approve/decide/delete call in `src`) is static and lives in
//  `tests/invariants.spec.ts`.
//
// What it does NOT prove: the chat path for «اعتمده» without a model (only the
// `@live-no-bypass` test below reaches it, once, with the real model and
// `COPILOT_LIVE=1`); the mobile viewport (the spec writes real records, so the
// `mobile` project reports every test as skipped — never as passed).
//
// Decisions (spec/madar T-28 brief):
//  - D-T28-1  No model and no mock of the copilot. A job that needs an
//    extraction is created by the fixture through the server's own
//    `startIntake` with a scripted extraction (e2e/fixtures/no-bypass.ts), so
//    everything after the extraction is the application's own code and NPI.
//  - D-T28-3  Serial, one fixture per describe. The seeded jobs and the NPI
//    records the tests create are NOT deleted afterwards: they stay as the
//    users' own history in `npi_copilot` / `npi_erp` (demo data only), exactly
//    like every earlier e2e run, and `llm_audit` rows are an audit trail.
//  - D-T28-4  Describe 3 is a SIMULATION. The executive cannot reach a
//    contract card through the chat (describe 1 proves that gate), so the
//    fixture creates the job directly, standing in for «a permission was
//    revoked between preview and approval». What is under test is the
//    executor's handling of NPI's refusal, not the gate.
//  - D-T28-5  Scenario 2(e) is the one place a test calls NPI's approve
//    endpoint: NPI's own guard is exercised, as the backstop — it is NPI's
//    rule, not the copilot's. The copilot's own invariant is that it never
//    issues this call (tests/invariants.spec.ts, tests/npi-client.spec.ts).
import type { APIRequestContext, Page, PlaywrightWorkerArgs, Response } from '@playwright/test';
import { test, expect } from '@playwright/test';
import { t } from '../src/i18n/ar';
import type { IntakeView } from '../src/intake/types';
import { NpiError } from '../src/npi/errors';
import {
  readAdminCredentials,
  readSalesCredentials,
  readSeededAccount,
  readSiteEngineerCredentials,
  type SeededAccount,
} from './fixtures/accounts';
import {
  API_BASE,
  SEEDED_CUSTOMER_VAT,
  auditRows,
  disconnectNoBypassDb,
  jobRow,
  npiCount,
  npiCustomerNameByVat,
  npiInbox,
  npiRequisition,
  seedPreviewJob,
  type SeededJob,
} from './fixtures/no-bypass';
import { npiLogin } from './fixtures/scratch-orgs';

// ─── Shared helpers ─────────────────────────────────────────────────────────

const CONTRACT_SENTENCE = 'عقد جديد مع شركة النخيل للمقاولات';
const PR_CHAT_SENTENCE = 'طلب شراء: 40 لوح 550 واط قبل الخميس';
const PR_JOB_SENTENCE = 'طلب شراء: 40 لوح 550 واط قبل الخميس لاستكمال أعمال التركيب';

const DESKTOP_ONLY = 'writes real NPI records; the desktop project is enough';

/** Skips every test of the enclosing describe outside the `desktop` project. */
function desktopOnly(): void {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', DESKTOP_ONLY);
  });
}

const isPost = (res: Response, pathname: string): boolean =>
  res.request().method() === 'POST' && new URL(res.url()).pathname === pathname;
const isIntakePost = (res: Response): boolean => isPost(res, '/copilot/api/intake');
const isChatPost = (res: Response): boolean => isPost(res, '/copilot/api/chat');

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

const card = (page: Page) => page.getByTestId('preview-card');
const approveButton = (page: Page) => card(page).getByRole('button', { name: t('preview.approve'), exact: true });

/** Vouches for every value the card shows as unconfirmed — a click each, and
 *  the card is rebuilt from the server's answer before the next one. The
 *  button's accessible name is «⚠ {preview.unconfirmed}» (PreviewCard.tsx). */
async function confirmAll(page: Page): Promise<void> {
  const buttons = card(page).getByRole('button', { name: t('preview.unconfirmed') });
  for (let guard = 0; guard < 20; guard += 1) {
    const before = await buttons.count();
    if (before === 0) return;
    const answered = page.waitForResponse(isIntakePost);
    await buttons.first().click();
    expect((await answered).status()).toBe(200);
    await expect(buttons).toHaveCount(before - 1);
  }
  throw new Error('confirmAll: still unconfirmed values after 20 confirmations');
}

/** If the card asks which catalogue item the line means, picks MOD-550. The
 *  radio is controlled: it flips only when the server's view comes back. */
async function chooseIfOffered(page: Page, label: string): Promise<void> {
  const group = card(page).locator('[data-testid="preview-choice"][data-target="lines.0.item"]');
  if ((await group.count()) === 0) return;
  const radio = group.getByRole('radio', { name: label });
  if (await radio.isChecked()) return;
  const answered = page.waitForResponse(isIntakePost);
  await radio.click();
  expect((await answered).status()).toBe(200);
  await expect(radio).toBeChecked();
}

async function intakeJob(res: Response): Promise<IntakeView> {
  return ((await res.json()) as { job: IntakeView }).job;
}

// ─── 1. The gate ────────────────────────────────────────────────────────────

test.describe('the gate: a user NPI would refuse is refused before any model call (AT-15)', () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });
  desktopOnly();
  test.afterAll(disconnectNoBypassDb);

  test('(a) the engineer asks for a contract in the chat: refused on the screen, no job, no audit row', async ({ page, request }) => {
    const engineer = readSiteEngineerCredentials();
    const { userId } = await npiLogin(request, engineer);
    const expected = t('intake.forbidden', { flow: t('flow.customer_contract') });

    await signIn(page, engineer);
    const composer = page.getByLabel(t('chat.placeholder'));
    // The home page is server-rendered before the chat bundle hydrates; on a
    // cold `next dev` the first compile of that bundle takes well over the
    // default 5 s (seen on the first run: the tiles were there, the composer was not).
    await expect(composer).toBeEditable({ timeout: 90_000 });

    // A Message bubble: `kind: 'error'` is rendered as a danger-toned notice
    // inside the log (Message.tsx), as a text child, so an exact text match.
    const log = page.getByRole('log');
    const shownBefore = await log.getByText(expected, { exact: true }).count();
    const auditBefore = await auditRows({ npiUserId: userId });

    await composer.fill(CONTRACT_SENTENCE);
    const replied = page.waitForResponse(isChatPost);
    await composer.press('Enter');
    const res = await replied;

    expect(res.status()).toBe(200);
    const body = (await res.json()) as { kind: string; textAr: string; intakeJobId?: string };
    expect(body.kind).toBe('error');
    expect(body.textAr).toBe(expected);
    expect(body).not.toHaveProperty('intakeJobId');

    await expect(log.getByText(expected, { exact: true })).toHaveCount(shownBefore + 1);

    // Zero model calls, zero audit events: every model call writes one row
    // (src/llm/client.ts) and a refusal writes none.
    expect(await auditRows({ npiUserId: userId })).toEqual(auditBefore);
  });

  test('(b) sales asks for a purchase requisition: refused, no job, no audit row', async ({ page, request }) => {
    const sales = readSalesCredentials();
    const { userId } = await npiLogin(request, sales);
    await signIn(page, sales);
    const auditBefore = await auditRows({ npiUserId: userId });

    const res = await page.request.post('/copilot/api/chat', { data: { text: PR_CHAT_SENTENCE } });

    expect(res.status()).toBe(200);
    const body = (await res.json()) as { kind: string; textAr: string; intakeJobId?: string };
    expect(body.kind).toBe('error');
    expect(body.textAr).toBe(t('intake.forbidden', { flow: t('flow.pr') }));
    expect(body).not.toHaveProperty('intakeJobId');
    expect(await auditRows({ npiUserId: userId })).toEqual(auditBefore);
  });
});

// ─── 2. A requisition from the copilot lands in the matrix ──────────────────

test.describe('a PR from the copilot lands in the matrix; the copilot cannot approve it (AT-03, AT-08)', () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });
  desktopOnly();

  let seeded: SeededJob;
  /** Set by (a): the requisition the execution created. */
  let created: { id: string; code: string } | undefined;

  const requisition = (): { id: string; code: string } => {
    if (created === undefined) throw new Error('the execution test (a) did not record a requisition');
    return created;
  };

  test.beforeAll(async ({ request }, testInfo) => {
    if (testInfo.project.name !== 'desktop') return;
    seeded = await seedPreviewJob(request, readSiteEngineerCredentials(), 'pr', PR_JOB_SENTENCE);
    // One extraction request, answered by the script. The scripted model is
    // not the audited client, so the job's trail starts empty: any row that
    // appears below was written by the code under test.
    expect(seeded.llmCalls).toBe(1);
    expect(await auditRows({ intakeJobId: seeded.jobId })).toEqual([]);
  });

  test.afterAll(disconnectNoBypassDb);

  test('(a) the engineer approves the card: both steps run in NPI and the card is read-only', async ({ page }) => {
    await signIn(page, readSiteEngineerCredentials());
    await page.goto(`/copilot/documents/${seeded.jobId}`);

    await expect(card(page)).toBeVisible();
    await expect(card(page).getByRole('heading', { name: t('preview.title') })).toBeVisible();
    await expect(card(page)).toContainText(t('flow.pr'));
    await expect(card(page).getByTestId('preview-steps').locator('li')).toHaveText([
      t('preview.step.pr_create', { n: 1 }),
      t('preview.step.pr_submit'),
    ]);

    await chooseIfOffered(page, 'MOD-550');
    await confirmAll(page);
    await expect(approveButton(page)).toBeEnabled();

    const answered = page.waitForResponse(isIntakePost);
    await approveButton(page).click();
    const res = await answered;
    expect(res.status()).toBe(200);
    const job = await intakeJob(res);
    expect(job.status).toBe('done');

    const entity = job.execution?.steps[0]?.entity;
    expect(entity, 'step 1 created the requisition').toBeTruthy();
    const { id, code } = entity!;
    expect(code).toMatch(/^PR-\d{5}$/);
    created = { id, code: code as string };

    const execution = page.getByTestId('execution-card');
    await expect(execution).toBeVisible();
    await expect(execution.getByText(t('exec.done_all'))).toBeVisible();
    await expect(execution.getByText(t('exec.after_matrix'))).toBeVisible();
    await expect(execution.getByText(t('exec.done', { entity: t('exec.kind.requisition'), code: code as string }))).toBeVisible();

    const steps = execution.getByTestId('execution-step');
    await expect(steps).toHaveCount(2);
    await expect(steps.nth(0)).toHaveAttribute('data-state', 'done');
    await expect(steps.nth(1)).toHaveAttribute('data-state', 'done');

    // The one link goes to the requisition's page in NPI (step 2 creates nothing).
    const link = execution.getByRole('link', { name: t('exec.open_in_npi') });
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute('href', new RegExp(`/requisitions/${id}$`));

    // The preview is read-only once approved.
    await expect(card(page).getByText(t('preview.approved'))).toBeVisible();
    await expect(approveButton(page)).toHaveCount(0);
  });

  test('(b) NPI holds it as PENDING_APPROVAL with an open chain for the project manager', async ({ request }) => {
    const { id } = requisition();
    const { token } = await npiLogin(request, readSiteEngineerCredentials());

    const pr = await npiRequisition(request, token, id);

    expect(pr.status).toBe('PENDING_APPROVAL');
    expect(Number(pr.estimatedTotal)).toBe(12800); // 40 x 320, seed item MOD-550
    expect(pr.requestedById).toBe(seeded.caller.npiUserId);
    expect(pr.pendingApproval).not.toBeNull();
    expect(pr.pendingApproval?.status).toBe('PENDING');
    expect(pr.pendingApproval?.currentStep).toBe(1);
    // NPI's seed writes the company roles (ROLE_PRESETS, P1-13): key 'pm' has
    // nameEn 'Projects general manager', and the seeded PURCHASE_REQUISITION
    // rule (from 0 SAR) is the chain ['pm'].
    expect(pr.pendingApproval?.steps[0]?.role.nameEn).toBe('Projects general manager');
    // What the trail holds: `engine.open` writes OPEN at creation, the submit
    // transition writes SUBMIT. No APPROVE, by anyone.
    expect(pr.workflow.history.map((h) => h.actionCode)).toEqual(['OPEN', 'SUBMIT']);
  });

  test('(c) only NPI\'s inbox shows it: the project manager sees the chain, the engineer does not', async ({ request }) => {
    const { id, code } = requisition();
    const pm = await npiLogin(request, readSeededAccount('pm'));
    const engineer = await npiLogin(request, readSiteEngineerCredentials());

    const pmEntry = (await npiInbox(request, pm.token)).find((e) => e.documentId === id);
    expect(pmEntry, 'the pm inbox holds the requisition').toBeDefined();
    expect(pmEntry?.documentCode).toBe(code);
    expect(pmEntry?.documentType).toBe('PURCHASE_REQUISITION');
    expect(pmEntry?.canDecide).toBe(true);

    expect((await npiInbox(request, engineer.token)).some((e) => e.documentId === id)).toBe(false);
  });

  test('(d) the copilot offers no approval path: every approve-shaped request is refused', async ({ playwright, baseURL }) => {
    const { id, code } = requisition();
    const session = await apiSession(playwright, baseURL, readSiteEngineerCredentials());
    try {
      // The job is `done`: a second approve finds nothing to approve.
      const again = await session.post('/copilot/api/intake', { data: { id: seeded.jobId, action: 'approve' } });
      expect(again.status()).toBe(409);
      expect(((await again.json()) as { error: string }).error).toBe('state');

      // The intake endpoint has six actions; none of these is one of them.
      for (const action of ['decide', 'approve_npi']) {
        const res = await session.post('/copilot/api/intake', { data: { id: seeded.jobId, action } });
        expect(res.status(), action).toBe(400);
        expect(((await res.json()) as { error: string }).error, action).toBe('bad_request');
      }
    } finally {
      await session.dispose();
    }

    // The trail: one row, written by the executor, and no model event.
    expect((await auditRows({ intakeJobId: seeded.jobId })).map((r) => r.event)).toEqual(['intake_executed']);
    const row = await jobRow(seeded.jobId);
    expect(row.status).toBe('done');
    expect(row.npiEntityRefs).toHaveLength(1);
    expect(row.npiEntityRefs?.[0]).toMatchObject({ kind: 'requisition', id, code });
  });

  test('(e) NPI\'s own backstop (not the copilot\'s rule): the raiser cannot approve it', async ({ request }) => {
    // This is the ONE direct call to NPI's approve action in the whole spec
    // (D-T28-5), made with the engineer's own NPI token and never through the
    // copilot. It exercises NPI's guard, the backstop; the copilot's own
    // invariant is that it never issues this call (tests/invariants.spec.ts,
    // tests/npi-client.spec.ts).
    const { id } = requisition();
    const { token } = await npiLogin(request, readSiteEngineerCredentials());

    const res = await request.post(`${API_BASE}/requisitions/${id}/actions`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { action: 'APPROVE' },
    });

    expect(res.status()).toBe(403);
    // apps/api/src/modules/procurement/requisitions.service.ts, `approve()`:
    // ForbiddenException('You cannot approve a requisition you raised yourself')
    expect(((await res.json()) as { message: string }).message).toBe('You cannot approve a requisition you raised yourself');

    const pr = await npiRequisition(request, token, id);
    expect(pr.status).toBe('PENDING_APPROVAL');
    expect(pr.workflow.history.map((h) => h.actionCode)).not.toContain('APPROVE');
  });

  test('(f) another user can neither see nor act on the job', async ({ playwright, baseURL }) => {
    const session = await apiSession(playwright, baseURL, readSalesCredentials());
    try {
      const read = await session.get(`/copilot/api/intake?id=${encodeURIComponent(seeded.jobId)}`);
      expect(read.status()).toBe(404);
      expect(((await read.json()) as { messageAr: string }).messageAr).toBe(t('intake.not_found'));

      const act = await session.post('/copilot/api/intake', { data: { id: seeded.jobId, action: 'approve' } });
      expect(act.status()).toBe(404);
      expect(((await act.json()) as { error: string }).error).toBe('not_found');
    } finally {
      await session.dispose();
    }
    expect((await jobRow(seeded.jobId)).status).toBe('done');
  });

  test('@live-no-bypass (g) the engineer asks the chat to approve the requisition: nothing is approved', async ({ page, request }, testInfo) => {
    test.skip(
      !process.env.COPILOT_LIVE || !process.env.ANTHROPIC_API_KEY,
      'live run with the real model: COPILOT_LIVE=1 and ANTHROPIC_API_KEY in the test process (e.g. dotenv -e ../../.env -v COPILOT_LIVE=1 -- playwright test --project desktop)',
    );
    test.setTimeout(180_000);

    const { id, code } = requisition();
    const engineer = readSiteEngineerCredentials();
    const { token } = await npiLogin(request, engineer);
    const auditBefore = await auditRows({ intakeJobId: seeded.jobId });

    await signIn(page, engineer);
    const composer = page.getByLabel(t('chat.placeholder'));
    // The home page is server-rendered before the chat bundle hydrates; on a
    // cold `next dev` the first compile of that bundle takes well over the
    // default 5 s (seen on the first run: the tiles were there, the composer was not).
    await expect(composer).toBeEditable({ timeout: 90_000 });
    await composer.fill(`اعتمد الطلب ${code}`);
    const replied = page.waitForResponse(isChatPost, { timeout: 90_000 });
    await composer.press('Enter');
    const res = await replied;

    expect(res.status()).toBe(200);
    const body = (await res.json()) as { kind: string; textAr: string; intakeJobId?: string };
    // The reviewer reads the reply from the attachment, not the console.
    await testInfo.attach('chat-reply', { body: body.textAr, contentType: 'text/plain; charset=utf-8' });
    // `answer`: the model really answered (an `error` reply would prove nothing
    // about the claim); never an intake job.
    expect(body.kind).toBe('answer');
    expect(body.intakeJobId).toBeUndefined();

    const pr = await npiRequisition(request, token, id);
    expect(pr.status).toBe('PENDING_APPROVAL');
    expect(pr.workflow.history.map((h) => h.actionCode)).not.toContain('APPROVE');
    // The job's own trail is untouched: still the single execution row.
    expect(await auditRows({ intakeJobId: seeded.jobId })).toEqual(auditBefore);
    expect(auditBefore.map((r) => r.event)).toEqual(['intake_executed']);
  });
});

// ─── 3. A refused step is reported verbatim and writes nothing ──────────────

test.describe('a refused step is reported verbatim and writes nothing (D-T28-4; T-27 D-T27-8)', () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });
  desktopOnly();

  let seeded: SeededJob;
  let contractsBefore = 0;
  let customersBefore = 0;
  let customerNameAr = '';

  test.beforeAll(async ({ request }, testInfo) => {
    if (testInfo.project.name !== 'desktop') return;
    // SIMULATION (D-T28-4): the executive has no `commercial.contract.write`
    // and cannot reach this card through the chat (describe 1). The job is
    // made directly, standing in for a permission revoked between preview and
    // approval. The executive CAN read customers, so the preview resolves
    // normally. (The project manager played this part until NPI's P1-13 made
    // the company roles the seed's default: `pm` now holds contract write.)
    seeded = await seedPreviewJob(request, readSeededAccount('executive'), 'customer_contract', CONTRACT_SENTENCE);
    expect(seeded.llmCalls).toBe(1);

    const admin = await npiLogin(request, readAdminCredentials());
    contractsBefore = await npiCount(request, admin.token, '/contracts');
    customersBefore = await npiCount(request, admin.token, '/customers');
    customerNameAr = await npiCustomerNameByVat(request, admin.token, SEEDED_CUSTOMER_VAT);
  });

  test.afterAll(disconnectNoBypassDb);

  test('(a) the card reports NPI\'s refusal verbatim, stops at step 2 and runs nothing after it', async ({ page }) => {
    await signIn(page, readSeededAccount('executive'));
    await page.goto(`/copilot/documents/${seeded.jobId}`);

    await expect(card(page)).toBeVisible();
    // customer_use (CUS-00001 matched by VAT, no NPI write), contract_create,
    // and the manual activation.
    const plan = card(page).getByTestId('preview-steps').locator('li');
    await expect(plan).toHaveCount(3);
    await expect(plan.nth(0)).toContainText(t('preview.step.customer_use', { name: customerNameAr }));
    await expect(plan.nth(2)).toHaveText(t('preview.step.contract_activate_manual'));

    await confirmAll(page);
    await expect(approveButton(page)).toBeEnabled();

    const answered = page.waitForResponse(isIntakePost);
    await approveButton(page).click();
    const res = await answered;
    // A failed execution still answers 200 with the final view.
    expect(res.status()).toBe(200);
    const job = await intakeJob(res);
    expect(job.status).toBe('failed');
    expect(job.execution?.failedAt).toBe(2);

    // NPI's own English reason is quoted verbatim from
    // apps/api/src/common/guards/permissions.guard.ts
    // (ForbiddenException('Insufficient permissions')); the Arabic around it is
    // the application's own mapping, built here through `NpiError`, never retyped.
    const refusal = new NpiError({ status: 403, kind: 'forbidden', npiMessage: 'Insufficient permissions' }).messageAr;

    const execution = page.getByTestId('execution-card');
    await expect(execution).toBeVisible();
    await expect(execution.getByRole('alert')).toContainText(
      t('exec.failed', { n: 2, reason: refusal, created: t('preview.empty_value') }),
    );

    const steps = execution.getByTestId('execution-step');
    await expect(steps).toHaveCount(3);
    await expect(steps.nth(0)).toHaveAttribute('data-state', 'done');
    await expect(steps.nth(1)).toHaveAttribute('data-state', 'failed');
    await expect(steps.nth(1).getByText(refusal)).toBeVisible();
    await expect(steps.nth(2)).toHaveAttribute('data-state', 'pending');
    await expect(execution.getByText(t('exec.done_all'))).toHaveCount(0);

    // Read-only, and nothing to approve a second time.
    await expect(card(page).getByText(t('preview.approved'))).toBeVisible();
    await expect(approveButton(page)).toHaveCount(0);
  });

  test('(b) nothing was created in NPI, and the trail says which step failed and why', async ({ request }) => {
    const admin = await npiLogin(request, readAdminCredentials());
    expect(await npiCount(request, admin.token, '/contracts')).toBe(contractsBefore);
    expect(await npiCount(request, admin.token, '/customers')).toBe(customersBefore);

    const row = await jobRow(seeded.jobId);
    expect(row.status).toBe('failed');
    expect(row.npiEntityRefs).toEqual([]);
    expect(row.executionLogJson?.failedAt).toBe(2);

    const rows = await auditRows({ intakeJobId: seeded.jobId });
    expect(rows.map((r) => r.event)).toEqual(['intake_execution_failed']);
    // `${n}: ${label} — ${NpiError.messageAr}` (src/execute/run.ts), and the
    // Arabic carries NPI's own reason (permissions.guard.ts).
    expect(rows[0].error).toContain('2:');
    expect(rows[0].error).toContain('Insufficient permissions');
  });
});
