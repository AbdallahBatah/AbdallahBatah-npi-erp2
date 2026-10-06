// T-31 (M3, F-05…F-11, TEST): the live scenarios AT-01…AT-06 of spec/madar/06,
// end to end: the real browser, the copilot of the e2e run (:3177), the NPI api
// of the e2e run (:4077) and THE REAL MODEL. This is the one spec in which the
// whole chain of M3 runs together — a sentence or a document, the permission /
// consent gate, the extraction (names redacted), the resolution against NPI,
// the preview card, and the execution in NPI as the logged-in user.
//
// Run (never part of the default run: every describe title carries
// `@live-flows`, which `playwright.config.ts`'s `grepInvert: /@live/` filters):
//
//   npx dotenv -e ../../.env -v COPILOT_LIVE=1 -- npx playwright test e2e/scenarios.spec.ts --project desktop
//
// (the :4000 / :3110 dev servers must be down first; a run takes minutes.)
//
// What it proves, one describe per scenario, in this order (D-T31-10):
//  - AT-06  a document whose NAME holds the confidential word is refused before any read: the
//           refusal bubble, no card, no model call, one `refused_confidential` row.
//  - AT-01  contract-01.pdf (text PDF) -> a card (customer, 850,000.00, three
//           milestones, retention, VAT confirmed), an outbound text without the
//           customer's name, a sentence edit, then approve: customer + DRAFT
//           contract + the PDF attached, in NPI, under the user's id.
//  - AT-02  contract-02.pdf -> the seeded customer matched by VAT number, offered
//           on the card, no duplicate customer, a contract with four milestones.
//  - AT-03  a requisition from a sentence -> a card, a PENDING_APPROVAL requisition
//           with an open chain for the `pm` role, visible in the pm's NPI inbox;
//           asking the chat to approve it approves nothing.
//  - AT-05  grn-01.jpg (delivery-note photo) under consent -> a DRAFT goods receipt
//           against a purchase order, quantities and serials as read.
//  - AT-04  bill-01.jpg (vendor-bill photo): consent before any model call; cancel
//           sends nothing; approve sends the image under a consent id; the bill
//           lands in NPI in its recorded state and in the accountant's inbox.
//
// What it does NOT prove: the `mobile` project (every test reports skipped, never
// passed: the spec writes real records); a `po` flow scenario (06 has none); the
// WBS clause of AT-03 (the seed has no WBS elements, D-T31-5); the printed codes
// of the eval photos against NPI (D-T31-1: they are the eval set's imagined ones).
//
// Decisions (spec/madar T-31 brief):
//  - D-T31-1  AT-04/AT-05 create their own purchase order (and, for AT-04, an
//             accepted receipt) before the browser part, over HTTP, as the seeded
//             administrator (fixtures/reset.ts) — never through `src/npi/client.ts`.
//             The card first shows the PRINTED code the extraction read, then the
//             live code is typed into the card's inline edit and the re-resolution
//             is asserted.
//  - D-T31-2  AT-04's document is bill-01.jpg (06 names bill-04.jpg, a text PDF in USD).
//  - D-T31-3  AT-01 on a repeat run: the customer exists, so the «matched» branch
//             is asserted instead of «new» (`at01-branch` says which).
//  - D-T31-4  The 25 s of AT-01 is measured, attached (`at01-latency-ms`) and
//             asserted softly; nothing is changed to meet it.
//  - D-T31-5  AT-03's project is ensured by the fixture; no WBS clause.
//  - D-T31-6  A request from the engineer to approve it is answered by the model in words;
//             no NPI 403 occurs because the copilot makes no call.
//  - D-T31-7  Roles: AT-01/02/06 sales; AT-03 site engineer (pm reads the inbox);
//             AT-04 accountant; AT-05 pm. Pre-state writes are the administrator's.
//  - D-T31-8  Serials of fixture receipts carry a run id (fixtures/reset.ts).
//  - D-T31-9  Audit reads are scoped by user and time (`startedAt` 5 s early).
//  - D-T31-10 One serial describe per scenario; a failure never blocks another.
//
// Nothing a run creates is deleted (T-28 D-T28-3); every pre-state is built for a
// repeat run on the same databases.
import type { APIRequestContext, Locator, Page, Response, TestInfo } from '@playwright/test';
import { test, expect } from '@playwright/test';
import { t } from '../src/i18n/ar';
import { formatNumber } from '../src/i18n/format';
import type { FlowType, IntakeView } from '../src/intake/types';
import { readRoles } from '../src/npi/admin';
import {
  readAdminCredentials,
  readSalesCredentials,
  readSeededAccount,
  readSiteEngineerCredentials,
  type SeededAccount,
} from './fixtures/accounts';
import {
  CONFIDENTIAL_FILE_NAME,
  EVAL_DOCS,
  attachEvalDoc,
  evalExpected,
  expectedLength,
  expectedNumber,
  expectedString,
  type EvalDoc,
  type EvalExpected,
} from './fixtures/docs';
import {
  auditRows,
  disconnectNoBypassDb,
  jobRow,
  npiCount,
  npiCustomerNameByVat,
  npiInbox,
  npiRequisition,
} from './fixtures/no-bypass';
import {
  auditRowsSince,
  billPrestate,
  disconnectScenariosDb,
  ensureProject,
  grnPrestate,
  intakeJobsSince,
  newRunId,
  npiAttachmentNames,
  npiContract,
  npiCustomerIdByVat,
  npiInboxTasks,
  npiPurchaseOrderDetail,
} from './fixtures/reset';
import { npiGet, npiLogin } from './fixtures/scratch-orgs';

// ─── The scenario sentences (the only Arabic typed in this file) ────────────
// Each is the user's own sentence from spec/madar 06 / 09, never a value an
// assertion compares against.

/** 06 AT-01 ("the user writes it and attaches the contract") / 09 3.1: the words that
 *  travel with the contract and that the router reads; a bare attachment is asked
 *  which kind it is instead (`src/agents/run.ts`: no sentence, no classifier). */
const CONTRACT_SENTENCE = 'عقد جديد';
/** 09 3.2: the sentence the user types after pressing the edit button. */
const RETENTION_EDIT_SENTENCE = 'المحتجزات 5%';
const EDITED_RETENTION = 5;

const PR_QTY = 40;
/** packages/db/prisma/seed.ts: item MOD-550's unitCost — what NPI prices the
 *  line at (40 x 320 = 12,800, above the PR >= 10,000 rule for `pm`). */
const MOD_550_UNIT_COST = 320;
/** 06 AT-03 / 09 3.4: the engineer's sentence, with the live project code. */
const prSentence = (projectCode: string): string => `أبي ${PR_QTY} لوح 550 واط للمشروع ${projectCode} قبل الخميس`;
/** 09 3.5: the second sentence of the engineer, asking the chat to approve. */
const approveSentence = (code: string): string => `اعتمد الطلب ${code}`;

// ─── Shared helpers ─────────────────────────────────────────────────────────

const DESKTOP_ONLY = 'writes real NPI and copilot records; the desktop project is enough';
const LIVE_SKIP =
  'live run with the real model: COPILOT_LIVE=1 and ANTHROPIC_API_KEY in the test process (e.g. npx dotenv -e ../../.env -v COPILOT_LIVE=1 -- npx playwright test e2e/scenarios.spec.ts --project desktop)';

/** `next dev` compiles a route on its first visit; the first assertion after a
 *  `goto` of a page the run has not visited yet gets this long. */
const FIRST_PAINT = { timeout: 60_000 } as const;
/** Every wait that includes a model call or an execution in NPI. */
const MODEL_WAIT = 120_000;

/** The separator the card joins serial numbers with (`displayOf` in `src/intake/preview.ts`). */
const ARABIC_COMMA = String.fromCharCode(0x60c);

const DOCUMENTS_PATH = '/copilot/api/documents';
const CONSENT_PATH = '/copilot/api/documents/consent';

/** Skips every test of the enclosing describe outside the `desktop` project. */
function desktopOnly(): void {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', DESKTOP_ONLY);
  });
}

/** Skips every test of the enclosing describe unless the run is live. */
function liveOnly(): void {
  test.beforeEach(() => {
    test.skip(!process.env.COPILOT_LIVE, LIVE_SKIP);
  });
}

/** A `beforeAll` writes pre-state only in a live desktop run. */
const liveDesktop = (testInfo: TestInfo): boolean => testInfo.project.name === 'desktop' && Boolean(process.env.COPILOT_LIVE);

async function disconnectAll(): Promise<void> {
  await disconnectScenariosDb();
  await disconnectNoBypassDb();
}

const isPost = (res: Response, pathname: string): boolean =>
  res.request().method() === 'POST' && new URL(res.url()).pathname === pathname;
const isIntakePost = (res: Response): boolean => isPost(res, '/copilot/api/intake');
const isChatPost = (res: Response): boolean => isPost(res, '/copilot/api/chat');
const isDocumentsPost = (res: Response): boolean => isPost(res, DOCUMENTS_PATH);
const isConsentPost = (res: Response): boolean => isPost(res, CONSENT_PATH);

/** `page.waitForResponse` whose rejection is only raised where it is awaited
 *  (a test that fails earlier leaves no unhandled rejection behind). */
function watch(page: Page, match: (res: Response) => boolean, timeout: number): Promise<Response> {
  const pending = page.waitForResponse(match, { timeout });
  pending.catch(() => undefined);
  return pending;
}

async function signIn(page: Page, account: SeededAccount): Promise<void> {
  await page.goto('/copilot/login');
  await page.getByLabel(t('login.email')).fill(account.email);
  await page.getByLabel(t('login.password')).fill(account.password);
  await page.getByRole('button', { name: t('login.submit') }).click();
  await page.waitForURL('**/copilot');
}

/** The composer, once the chat bundle hydrated (a cold `next dev` compiles it on first visit). */
async function readyComposer(page: Page): Promise<Locator> {
  const composer = page.getByLabel(t('chat.placeholder'));
  await expect(composer).toBeEditable({ timeout: 90_000 });
  return composer;
}

/** What `PreviewCard` shows for an amount (`formatAmount` in `src/intake/labels.ts`,
 *  the same locale pin as `e2e/fixtures/intake.ts` `amountText`). */
const amountText = (n: number): string =>
  n.toLocaleString('ar-SA-u-nu-latn-ca-gregory', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

type Attachable = string | string[] | Record<string, unknown>;

/** The reviewer reads the run from the attachments, not from the console. */
async function attach(testInfo: TestInfo, name: string, value: Attachable): Promise<void> {
  const body = typeof value === 'string' ? value : Array.isArray(value) ? value.join('\n') : JSON.stringify(value, null, 2);
  await testInfo.attach(name, { body, contentType: 'text/plain; charset=utf-8' });
}

interface ChatBody {
  kind: string;
  textAr: string;
  intakeJobId?: string;
  documentId?: string;
}

async function chatBody(res: Response): Promise<ChatBody> {
  const body = (await res.json()) as Partial<ChatBody> | null;
  if (body === null || typeof body.kind !== 'string' || typeof body.textAr !== 'string') {
    throw new Error(`/copilot/api/chat answered a body of an unexpected shape: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return { kind: body.kind, textAr: body.textAr, intakeJobId: body.intakeJobId, documentId: body.documentId };
}

async function intakeJob(res: Response): Promise<IntakeView> {
  return ((await res.json()) as { job: IntakeView }).job;
}

interface UploadBody {
  document: { id: string; fileName: string; pageCount: number; kind: string };
  deduplicated?: boolean;
}

/** `intake_jobs.id` of a chat reply that must carry a card. */
function jobIdOf(reply: ChatBody): string {
  if (reply.kind !== 'intake' || reply.intakeJobId === undefined) {
    throw new Error(`expected an intake reply with a job, got kind "${reply.kind}": ${reply.textAr}`);
  }
  return reply.intakeJobId;
}

function stepLines(job: IntakeView): string[] {
  return (job.execution?.steps ?? []).map(
    (s) => `${s.n}. [${s.state}] ${s.labelAr}${s.entity ? ` => ${s.entity.kindAr} ${s.entity.code ?? s.entity.id}` : ''}`,
  );
}

function entityOf(job: IntakeView, kindAr: string): { id: string; code: string | null; kindAr: string } {
  const entity = job.execution?.steps.find((s) => s.entity?.kindAr === kindAr)?.entity;
  if (entity === undefined) throw new Error(`the execution created no «${kindAr}»: ${stepLines(job).join(' | ')}`);
  return entity;
}

/** Bare local readers of NPI's wire (copied from `fixtures/no-bypass.ts`, not exported there). */
type Rec = Record<string, unknown>;
function shape(what: string, body: unknown): never {
  throw new Error(`NPI response shape changed: ${what} (got ${JSON.stringify(body).slice(0, 300)})`);
}
function rec(value: unknown, what: string): Rec {
  return typeof value === 'object' && value !== null ? (value as Rec) : shape(what, value);
}
function arr(value: unknown, what: string): unknown[] {
  return Array.isArray(value) ? value : shape(what, value);
}
function text(value: unknown, what: string): string {
  return typeof value === 'string' ? value : shape(what, value);
}

/**
 * The codes of every purchase order NPI holds. `GET /procurement/purchase-orders`
 * (`procurement.controller.ts` `@Get('purchase-orders')`, `scm.procurement.read`) is
 * `ProcurementService.listPos` (`procurement.service.ts` 133): a bare `findMany`
 * array of `PurchaseOrder` rows, `code` among them.
 */
async function npiPurchaseOrderCodes(request: APIRequestContext, token: string): Promise<string[]> {
  return arr(await npiGet(request, token, '/procurement/purchase-orders'), 'purchase orders').map((row) =>
    text(rec(row, 'purchase order row').code, 'purchaseOrder.code'),
  );
}

/** Preview cards on the page once every card of the history finished loading (`intake-loading`). */
async function settledCardCount(page: Page): Promise<number> {
  await expect(page.getByTestId('intake-loading')).toHaveCount(0, { timeout: 30_000 });
  return page.getByTestId('preview-card').count();
}

// ─── The card, driven through its own controls ──────────────────────────────

interface IntakeUi {
  /** The `preview-card` of THIS job. */
  card: Locator;
  exec: Locator;
  approve: Locator;
  field(path: string): Locator;
  /** The text of the field's value (the first `<bdi>`), trimmed. */
  value(path: string): Promise<string>;
  steps: Locator;
  notes(): Promise<string[]>;
  blockers(): Promise<string[]>;
  confirmAll(): Promise<void>;
  chooseIfOffered(target: string, label: string): Promise<void>;
  setField(path: string, value: string): Promise<void>;
  approveAndWait(): Promise<IntakeView>;
}

/**
 * One job's card. Inside the chat log (`jobId` given) the panel is the one whose
 * compact link points at that job's page: the conversation history keeps every
 * earlier card of the user (a repeat run, or an earlier scenario), so a bare
 * `preview-card` locator would be ambiguous. On the document page (`jobId` null)
 * there is exactly one panel.
 */
function intakeUi(page: Page, jobId: string | null): IntakeUi {
  const panels = page.getByTestId('intake-panel');
  const panel = jobId === null ? panels : panels.filter({ has: page.locator(`a[href="/copilot/documents/${jobId}"]`) });
  const card = panel.getByTestId('preview-card');
  const field = (path: string): Locator => card.locator(`[data-path="${path}"]`);
  const approve = card.getByRole('button', { name: t('preview.approve'), exact: true });

  return {
    card,
    exec: panel.getByTestId('execution-card'),
    approve,
    field,
    async value(path) {
      return (await field(path).locator('bdi').first().innerText()).trim();
    },
    steps: card.getByTestId('preview-steps').locator('li'),
    async notes() {
      return card.getByTestId('preview-notes').locator('li').allInnerTexts();
    },
    async blockers() {
      return card.getByTestId('preview-blockers').locator('li').allInnerTexts();
    },

    /** Vouches for every value the card shows as unconfirmed — a click each, and
     *  the card is rebuilt from the server's answer before the next one. The
     *  button's accessible name is «⚠ {preview.unconfirmed}» (PreviewCard.tsx). */
    async confirmAll() {
      const buttons = card.getByRole('button', { name: t('preview.unconfirmed') });
      for (let guard = 0; guard < 30; guard += 1) {
        const before = await buttons.count();
        if (before === 0) return;
        const answered = page.waitForResponse(isIntakePost);
        await buttons.first().click();
        expect((await answered).status()).toBe(200);
        await expect(buttons).toHaveCount(before - 1);
      }
      throw new Error('confirmAll: still unconfirmed values after 30 confirmations');
    },

    /** If the card asks `target` (`customer`, `vendor`, `lines.0.item`…), picks the
     *  radio whose label contains `label`. The radio is controlled: it flips only
     *  when the server's view comes back. */
    async chooseIfOffered(target, label) {
      const group = card.locator(`[data-testid="preview-choice"][data-target="${target}"]`);
      if ((await group.count()) === 0) return;
      const radio = group.getByRole('radio', { name: label });
      if (await radio.isChecked()) return;
      const answered = page.waitForResponse(isIntakePost);
      await radio.click();
      expect((await answered).status()).toBe(200);
      await expect(radio).toBeChecked();
    },

    /** The inline edit of one field: pencil -> textbox -> save (a `set` action: the
     *  server re-reads NPI and rebuilds the card). */
    async setField(path, value) {
      const target = field(path);
      await target.getByRole('button', { name: t('preview.edit_field') }).click();
      await target.getByRole('textbox').fill(value);
      const answered = watch(page, isIntakePost, 60_000);
      await target.getByRole('button', { name: t('preview.save_field') }).click();
      expect((await answered).status()).toBe(200);
      await expect(target.getByRole('textbox')).toHaveCount(0);
    },

    async approveAndWait() {
      const answered = watch(page, isIntakePost, MODEL_WAIT);
      await approve.click();
      const res = await answered;
      expect(res.status()).toBe(200);
      return intakeJob(res);
    },
  };
}

/** Confirms what can be vouched for, records what still blocks approving, and expects the button enabled. */
async function readyToApprove(testInfo: TestInfo, tag: string, ui: IntakeUi): Promise<void> {
  await ui.confirmAll();
  const blockers = await ui.blockers();
  await attach(testInfo, `${tag}-blockers`, blockers.length > 0 ? blockers : '(none)');
  await expect(ui.approve).toBeEnabled();
}

/**
 * The answer to an attached document. A bare attachment (no sentence for the
 * router to read) is answered `choose_flow` with five chips, because the
 * classifier is not asked about an empty text (`src/agents/run.ts` `runTurn`):
 * the user presses the flow's chip, which re-sends the document with that flow.
 * When the router already knows the flow the answer is the card's reply itself.
 */
async function documentReply(
  page: Page,
  testInfo: TestInfo,
  tag: string,
  firstAnswer: Promise<Response>,
  flow: FlowType,
  chipsBefore: number,
): Promise<ChatBody> {
  let res = await firstAnswer;
  expect(res.status()).toBe(200);
  let body = await chatBody(res);
  if (body.kind === 'choose_flow') {
    await attach(testInfo, `${tag}-chat-flow`, `the router asked which kind of document it is; chip pressed: ${t(`flow.${flow}` as const)}`);
    const chips = page.getByTestId('flow-chips');
    await expect(chips).toHaveCount(chipsBefore + 1);
    const second = watch(page, isChatPost, MODEL_WAIT);
    await chips.last().getByRole('button', { name: t(`flow.${flow}` as const), exact: true }).click();
    res = await second;
    expect(res.status()).toBe(200);
    body = await chatBody(res);
  } else {
    await attach(testInfo, `${tag}-chat-flow`, `the router knew the flow (kind ${body.kind}); no chip pressed`);
  }
  return body;
}

// ─── AT-06 ──────────────────────────────────────────────────────────────────

test.describe('AT-06 confidential document refused @live-flows', () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });
  desktopOnly();
  test.afterAll(disconnectAll);

  test('a file whose name holds the confidential word is refused before any read: a bubble, no card, no model call, one audit event', async ({ page, request }, testInfo) => {
    const sales = readSalesCredentials();
    const { userId } = await npiLogin(request, sales);
    await signIn(page, sales);
    await readyComposer(page);

    const log = page.getByRole('log');
    const refusal = t('intake.refused_confidential');
    const bubblesBefore = await log.getByText(refusal, { exact: true }).count();
    const cardsBefore = await settledCardCount(page);
    const chatPosts: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' && new URL(req.url()).pathname === '/copilot/api/chat') chatPosts.push(req.url());
    });

    const startedAt = new Date(Date.now() - 5_000);
    const uploaded = watch(page, isDocumentsPost, 60_000);
    await attachEvalDoc(page, EVAL_DOCS.contract01, CONFIDENTIAL_FILE_NAME);
    const res = await uploaded;

    const body = (await res.json()) as { error?: string; messageAr?: string };
    await attach(testInfo, 'at06-upload-response', { status: res.status(), ...body });
    expect(res.status()).toBe(422);
    expect(body.error).toBe('refused_confidential');
    expect(body.messageAr).toBe(refusal);

    // A local error bubble (Chat.tsx `appendNotice`), exact text.
    await expect(log.getByText(refusal, { exact: true })).toHaveCount(bubblesBefore + 1);
    await expect(page.getByTestId('consent-card')).toHaveCount(0);
    expect(await settledCardCount(page)).toBe(cardsBefore);
    expect(chatPosts, 'a refused document is never sent to the chat').toEqual([]);

    // The refusal wrote its one event (`api/documents/route.ts` `writeAuditEvent`):
    // no model, no image, and nothing else.
    const rows = await auditRowsSince(userId, startedAt);
    await attach(testInfo, 'at06-audit-rows', rows.map((r) => `${r.event} model=${r.modelId} imageSent=${r.imageSent}`));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: 'refused_confidential', modelId: null, imageSent: false });
    expect(await intakeJobsSince(userId, startedAt)).toEqual([]);
  });
});

// ─── AT-01 ──────────────────────────────────────────────────────────────────

test.describe('AT-01 contract from a text PDF @live-flows', () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });
  desktopOnly();
  liveOnly();

  const doc: EvalDoc = EVAL_DOCS.contract01;
  let expected: EvalExpected;
  let vat = '';
  let existing: { id: string; nameAr: string } | null = null;
  let customersBefore = 0;
  let contractsBefore = 0;
  /** Set by (a): the job the following tests drive on the document page. */
  let jobId = '';

  test.beforeAll(async ({ request }, testInfo) => {
    if (!liveDesktop(testInfo)) return;
    const admin = await npiLogin(request, readAdminCredentials());
    expected = evalExpected(doc);
    vat = expectedString(expected, 'customer.vatNumber');
    existing = await npiCustomerIdByVat(request, admin.token, vat);
    customersBefore = await npiCount(request, admin.token, '/customers');
    contractsBefore = await npiCount(request, admin.token, '/contracts');
  });

  test.afterAll(disconnectAll);

  test('(a) the document becomes a card: customer, value, milestones, retention, VAT confirmed; the outbound text holds no name', async ({ page, request }, testInfo) => {
    const sales = readSalesCredentials();
    const { userId } = await npiLogin(request, sales);
    await signIn(page, sales);
    const composer = await readyComposer(page);

    const log = page.getByRole('log');
    const attachedBubble = log.getByText(t('chat.attached', { name: doc.file }), { exact: true });
    const attachedBefore = await attachedBubble.count();

    await composer.fill(CONTRACT_SENTENCE);
    const startedAt = new Date(Date.now() - 5_000);
    const uploaded = watch(page, isDocumentsPost, 60_000);
    const replied = watch(page, isChatPost, MODEL_WAIT);
    await attachEvalDoc(page, doc);
    const t0 = Date.now();

    const upload = await uploaded;
    expect([200, 201]).toContain(upload.status());
    const uploadBody = (await upload.json()) as UploadBody;
    await attach(testInfo, 'at01-upload', `HTTP ${upload.status()}, deduplicated: ${uploadBody.deduplicated === true}, pages: ${uploadBody.document.pageCount}`);
    await expect(attachedBubble).toHaveCount(attachedBefore + 1);
    await expect(log.getByText(t('chat.document_text_ready'), { exact: true })).toHaveCount(1);

    // The reading status (page 1 of n) while the server reads. It may be too quick to catch.
    const reading = page.getByRole('status').getByText(t('intake.reading', { n: 1, total: uploadBody.document.pageCount }));
    await expect(reading).toBeVisible({ timeout: 5_000 }).then(
      () => attach(testInfo, 'at01-reading-status', 'observed'),
      () => attach(testInfo, 'at01-reading-status', 'not observed'),
    );

    const res = await replied;
    expect(res.status()).toBe(200);
    const reply = await chatBody(res);
    await attach(testInfo, 'at01-chat-reply', `${reply.kind}: ${reply.textAr}`);
    jobId = jobIdOf(reply);

    const ui = intakeUi(page, jobId);
    await expect(ui.card).toBeVisible({ timeout: MODEL_WAIT });
    const latency = Date.now() - t0;
    await attach(testInfo, 'at01-latency-ms', String(latency));
    // D-T31-4: «within 25 s» is measured and reported; the remaining assertions still run.
    expect.soft(latency, 'AT-01: the card should appear within 25 s').toBeLessThanOrEqual(25_000);

    // The card.
    await expect(ui.card.getByRole('heading', { name: t('preview.title') })).toBeVisible();
    // Known limit (T-26, PROGRESS.md): a Word-exported PDF's text layer can turn
    // «لا» into «ال» («للمقاولات» → «للمقاوالت»); the extraction flags the name
    // (`extract.warn.ligature`) and the user corrects it on the card — the owner's
    // own path in 09 3.1. The reading is attached verbatim; when it differs from
    // the document's name the inline edit puts the documented name in, and the
    // assertion runs on what the card then holds.
    const documentedName = expectedString(expected, 'customer.nameAr');
    const readName = await ui.value('customer.nameAr');
    await attach(testInfo, 'at01-customer-name-read', readName);
    if (readName !== documentedName) {
      const ligatureWarning = await ui.field('customer.nameAr').getByText(t('extract.warn.ligature')).count();
      await attach(testInfo, 'at01-customer-name-ligature-warning', String(ligatureWarning > 0));
      await ui.setField('customer.nameAr', documentedName);
    }
    await expect(ui.field('customer.nameAr')).toContainText(documentedName);
    await expect(ui.field('totalValue')).toContainText(amountText(expectedNumber(expected, 'totalValue')));
    await expect(ui.field('retentionPct').locator('bdi').first()).toHaveText(formatNumber(expectedNumber(expected, 'retentionPct')));
    await expect(ui.field('customer.vatNumber')).toHaveAttribute('data-status', 'confirmed');
    await expect(ui.field('customer.vatNumber').getByText(t('preview.confirmed'))).toBeVisible();

    const milestones = expectedLength(expected, 'milestones.length');
    const rows = ui.card.getByTestId('preview-lines').getByTestId('preview-line');
    await expect(rows).toHaveCount(milestones);
    for (let i = 0; i < milestones; i += 1) {
      await expect(ui.field(`milestones.${i}.percent`).locator('bdi').first()).toHaveText(formatNumber(expectedNumber(expected, `milestones.${i}.percent`)));
    }

    // D-T31-3: the customer branch depends on whether an earlier run created it.
    const cardName = await ui.value('customer.nameAr');
    const firstStep = ui.steps.first();
    if (existing === null) {
      await attach(testInfo, 'at01-branch', 'new');
      await expect(firstStep).toHaveText(t('preview.step.customer_new', { name: cardName }));
      await expect(ui.card.getByTestId('preview-notes').getByText(t('preview.customer_new'))).toBeVisible();
    } else {
      await attach(testInfo, 'at01-branch', `repeat: the customer exists in NPI as «${existing.nameAr}»`);
      await expect(firstStep).toHaveText(t('preview.step.customer_use', { name: existing.nameAr }));
      const choice = ui.card.locator('[data-testid="preview-choice"][data-target="customer"]');
      await expect(choice).toBeVisible();
      await expect(choice).toContainText(t('preview.customer_match', { name: existing.nameAr }));
    }
    await attach(testInfo, 'at01-card-notes', await ui.notes());

    // The audit: one extraction, no image, and the customer's name never left.
    const rowsSince = await auditRowsSince(userId, startedAt);
    await attach(testInfo, 'at01-audit-events', rowsSince.map((r) => r.event));
    const extractions = rowsSince.filter((r) => r.event === 'extract_customer_contract');
    expect(extractions).toHaveLength(1);
    const outbound = extractions[0].outboundRedactedText;
    expect(extractions[0].imageSent).toBe(false);
    expect(outbound, 'the extraction row holds the outbound text').not.toBeNull();
    await attach(testInfo, 'at01-outbound-redacted-text', (outbound ?? '').slice(0, 600));
    // The second word of the customer's name: the name proper, taken from expected.json.
    const nameProper = expectedString(expected, 'customer.nameAr').split(' ')[1];
    expect(nameProper, 'expected.json holds a multi-word customer name').toBeTruthy();
    expect(outbound ?? '').not.toContain(nameProper);
    // Informational: the VAT number is NOT redacted (the pseudonymizer redacts names;
    // the model must read the number to extract it) — recorded, not asserted.
    await attach(testInfo, 'at01-outbound-contains-vat', String((outbound ?? '').includes(vat)));
  });

  test('(b) a sentence edit changes the retention (09 3.2); the inline edit puts the documented value back', async ({ page, request }, testInfo) => {
    const { userId } = await npiLogin(request, readSalesCredentials());
    await signIn(page, readSalesCredentials());
    await page.goto(`/copilot/documents/${jobId}`);
    const ui = intakeUi(page, null);
    await expect(ui.card).toBeVisible(FIRST_PAINT);
    const startedAt = new Date(Date.now() - 5_000);

    await ui.card.getByRole('button', { name: t('preview.edit'), exact: true }).click();
    await ui.card.getByPlaceholder(t('preview.edit_prompt')).fill(RETENTION_EDIT_SENTENCE);
    const answered = watch(page, isIntakePost, MODEL_WAIT);
    await ui.card.getByRole('button', { name: t('preview.edit_send') }).click();
    expect((await answered).status()).toBe(200);
    await expect(ui.field('retentionPct').locator('bdi').first()).toHaveText(formatNumber(EDITED_RETENTION));

    const rows = await auditRowsSince(userId, startedAt);
    await attach(testInfo, 'at01-edit-audit-events', rows.map((r) => r.event));
    expect(rows.filter((r) => r.event === 'extract_customer_contract_edit')).toHaveLength(1);

    // So that (c) creates the documented retention.
    const documented = expectedNumber(expected, 'retentionPct');
    await ui.setField('retentionPct', String(documented));
    await expect(ui.field('retentionPct').locator('bdi').first()).toHaveText(formatNumber(documented));
    await expect(ui.field('retentionPct')).toHaveAttribute('data-status', 'confirmed');
  });

  test('(c) approve executes in NPI: customer, DRAFT contract with its milestones, the PDF attached; the card shows the codes', async ({ page, request }, testInfo) => {
    const sales = readSalesCredentials();
    const admin = await npiLogin(request, readAdminCredentials());
    const npi = await npiLogin(request, sales);
    await signIn(page, sales);
    await page.goto(`/copilot/documents/${jobId}`);
    const ui = intakeUi(page, null);
    await expect(ui.card).toBeVisible(FIRST_PAINT);

    await ui.chooseIfOffered('customer', existing === null ? t('preview.option_new') : existing.nameAr);
    await attach(testInfo, 'at01-card-notes-before-approve', await ui.notes());
    await readyToApprove(testInfo, 'at01', ui);
    const planned = await ui.steps.count();

    const job = await ui.approveAndWait();
    await attach(testInfo, 'at01-execution-steps', stepLines(job));
    expect(job.status).toBe('done');
    expect(job.execution?.status).toBe('done');

    // The execution card.
    await expect(ui.exec).toBeVisible();
    await expect(ui.exec.getByText(t('exec.done_all'))).toBeVisible();
    const contractRef = entityOf(job, t('exec.kind.contract'));
    expect(contractRef.code ?? '').toMatch(/^CTR-\d+$/);
    await expect(ui.exec.getByText(t('exec.done', { entity: t('exec.kind.contract'), code: contractRef.code as string }))).toBeVisible();
    const execSteps = ui.exec.getByTestId('execution-step');
    await expect(execSteps).toHaveCount(planned);
    expect(job.execution?.steps).toHaveLength(planned);
    const attachment = job.execution?.steps.find((s) => s.entity?.kindAr === t('exec.kind.attachment'));
    expect(attachment?.state).toBe('done');
    expect(attachment?.entity?.code).toBe(doc.file);
    await expect(execSteps.last()).toHaveAttribute('data-state', 'manual');
    await expect(execSteps.last()).toContainText(t('preview.step.contract_activate_manual'));
    if (existing === null) {
      expect(entityOf(job, t('exec.kind.customer')).code ?? '').toMatch(/^CUS-\d+$/);
    }

    // NPI, as the user.
    const contract = await npiContract(request, npi.token, contractRef.id);
    expect(contract.status).toBe('DRAFT');
    expect(contract.milestones).toHaveLength(expectedLength(expected, 'milestones.length'));
    expect(contract.totalValue).toBe(expectedNumber(expected, 'totalValue'));
    expect(contract.retentionPct).toBe(expectedNumber(expected, 'retentionPct'));
    const customer = await npiCustomerIdByVat(request, npi.token, vat);
    expect(customer, 'the customer is in NPI by its VAT number').not.toBeNull();
    expect(contract.customerId).toBe(existing === null ? customer?.id : existing.id);
    expect(await npiAttachmentNames(request, npi.token, 'contract', contractRef.id)).toContain(doc.file);

    expect(await npiCount(request, admin.token, '/contracts')).toBe(contractsBefore + 1);
    expect(await npiCount(request, admin.token, '/customers')).toBe(customersBefore + (existing === null ? 1 : 0));

    // The job and the trail.
    const row = await jobRow(jobId);
    expect(row.status).toBe('done');
    expect(row.npiEntityRefs?.map((r) => r.kind)).toEqual(existing === null ? ['customer', 'contract', 'attachment'] : ['contract', 'attachment']);
    const events = (await auditRows({ intakeJobId: jobId })).map((r) => r.event);
    await attach(testInfo, 'at01-job-audit-events', events);
    expect(events.filter((e) => e === 'intake_executed')).toHaveLength(1);
  });
});

// ─── AT-02 ──────────────────────────────────────────────────────────────────

test.describe('AT-02 existing customer matched by VAT number @live-flows', () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });
  desktopOnly();
  liveOnly();

  const doc: EvalDoc = EVAL_DOCS.contract02;
  let expected: EvalExpected;
  let vat = '';
  let customerName = '';
  let customersBefore = 0;
  let contractsBefore = 0;
  let jobId = '';

  test.beforeAll(async ({ request }, testInfo) => {
    if (!liveDesktop(testInfo)) return;
    const admin = await npiLogin(request, readAdminCredentials());
    expected = evalExpected(doc);
    vat = expectedString(expected, 'customer.vatNumber');
    customerName = await npiCustomerNameByVat(request, admin.token, vat);
    customersBefore = await npiCount(request, admin.token, '/customers');
    contractsBefore = await npiCount(request, admin.token, '/contracts');
  });

  test.afterAll(disconnectAll);

  test('(a) the card offers the existing customer, matched by VAT number', async ({ page, request }, testInfo) => {
    const sales = readSalesCredentials();
    await npiLogin(request, sales);
    await signIn(page, sales);
    const composer = await readyComposer(page);

    await composer.fill(CONTRACT_SENTENCE);
    const uploaded = watch(page, isDocumentsPost, 60_000);
    const replied = watch(page, isChatPost, MODEL_WAIT);
    await attachEvalDoc(page, doc);
    const upload = await uploaded;
    expect([200, 201]).toContain(upload.status());
    await attach(testInfo, 'at02-upload', `HTTP ${upload.status()}`);

    const res = await replied;
    expect(res.status()).toBe(200);
    const reply = await chatBody(res);
    await attach(testInfo, 'at02-chat-reply', `${reply.kind}: ${reply.textAr}`);
    jobId = jobIdOf(reply);

    const ui = intakeUi(page, jobId);
    await expect(ui.card).toBeVisible({ timeout: MODEL_WAIT });
    await expect(ui.field('customer.vatNumber')).toHaveAttribute('data-status', 'confirmed');
    await expect(ui.field('totalValue')).toContainText(amountText(expectedNumber(expected, 'totalValue')));
    await expect(ui.card.getByTestId('preview-lines').getByTestId('preview-line')).toHaveCount(expectedLength(expected, 'milestones.length'));

    // The existing customer: offered as a choice, checked, and said in the notes.
    const choice = ui.card.locator('[data-testid="preview-choice"][data-target="customer"]');
    await expect(choice).toBeVisible();
    await expect(choice).toContainText(t('preview.customer_match', { name: customerName }));
    await expect(choice.getByRole('radio', { name: customerName })).toBeChecked();
    await expect(ui.card.getByTestId('preview-notes').getByText(t('preview.customer_match', { name: customerName }))).toBeVisible();
    await expect(ui.steps.first()).toHaveText(t('preview.step.customer_use', { name: customerName }));
    await attach(testInfo, 'at02-card-notes', await ui.notes());
  });

  test('(b) approve: a contract with its milestones, and no duplicate customer', async ({ page, request }, testInfo) => {
    const sales = readSalesCredentials();
    const admin = await npiLogin(request, readAdminCredentials());
    const npi = await npiLogin(request, sales);
    await signIn(page, sales);
    await page.goto(`/copilot/documents/${jobId}`);
    const ui = intakeUi(page, null);
    await expect(ui.card).toBeVisible(FIRST_PAINT);

    await ui.chooseIfOffered('customer', customerName);
    await readyToApprove(testInfo, 'at02', ui);
    const planned = await ui.steps.count();

    const job = await ui.approveAndWait();
    await attach(testInfo, 'at02-execution-steps', stepLines(job));
    expect(job.status).toBe('done');
    await expect(ui.exec).toBeVisible();
    await expect(ui.exec.getByText(t('exec.done_all'))).toBeVisible();
    await expect(ui.exec.getByTestId('execution-step')).toHaveCount(planned);

    const contractRef = entityOf(job, t('exec.kind.contract'));
    expect(contractRef.code ?? '').toMatch(/^CTR-\d+$/);
    const contract = await npiContract(request, npi.token, contractRef.id);
    expect(contract.status).toBe('DRAFT');
    expect(contract.milestones).toHaveLength(expectedLength(expected, 'milestones.length'));
    expect(contract.totalValue).toBe(expectedNumber(expected, 'totalValue'));
    const customer = await npiCustomerIdByVat(request, npi.token, vat);
    expect(contract.customerId).toBe(customer?.id);
    expect(await npiAttachmentNames(request, npi.token, 'contract', contractRef.id)).toContain(doc.file);

    expect(await npiCount(request, admin.token, '/contracts')).toBe(contractsBefore + 1);
    expect(await npiCount(request, admin.token, '/customers')).toBe(customersBefore);

    const row = await jobRow(jobId);
    expect(row.npiEntityRefs?.map((r) => r.kind)).toEqual(['contract', 'attachment']);
    const events = (await auditRows({ intakeJobId: jobId })).map((r) => r.event);
    await attach(testInfo, 'at02-job-audit-events', events);
    expect(events.filter((e) => e === 'intake_executed')).toHaveLength(1);
  });
});

// ─── AT-03 ──────────────────────────────────────────────────────────────────

test.describe('AT-03 requisition from a sentence hits the matrix @live-flows', () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });
  desktopOnly();
  liveOnly();

  let project: { id: string; code: string; nameAr: string };
  let pmInboxBefore: string[] = [];
  /** Set by (a): the requisition the execution created, and its job. */
  let created: { id: string; code: string } | undefined;
  let jobId = '';

  test.beforeAll(async ({ request }, testInfo) => {
    if (!liveDesktop(testInfo)) return;
    project = await ensureProject(request);
    const pm = await npiLogin(request, readSeededAccount('pm'));
    pmInboxBefore = (await npiInbox(request, pm.token)).map((entry) => entry.documentCode);
  });

  test.afterAll(disconnectAll);

  test('(a) the sentence becomes a card, a requisition in NPI, and a chain for the project manager', async ({ page, request }, testInfo) => {
    const engineer = readSiteEngineerCredentials();
    const { token, userId } = await npiLogin(request, engineer);
    await signIn(page, engineer);
    const composer = await readyComposer(page);

    const sentence = prSentence(project.code);
    await attach(testInfo, 'at03-sentence', sentence);
    await composer.fill(sentence);
    const startedAt = new Date(Date.now() - 5_000);
    const replied = watch(page, isChatPost, MODEL_WAIT);
    await composer.press('Enter');
    const res = await replied;
    expect(res.status()).toBe(200);
    const reply = await chatBody(res);
    await attach(testInfo, 'at03-chat-reply', `${reply.kind}: ${reply.textAr}`);
    jobId = jobIdOf(reply);

    const ui = intakeUi(page, jobId);
    await expect(ui.card).toBeVisible({ timeout: MODEL_WAIT });
    await expect(ui.card.getByTestId('preview-lines').getByTestId('preview-line')).toHaveCount(1);
    await expect(ui.field('lines.0.qty').locator('bdi').first()).toHaveText(formatNumber(PR_QTY));
    // The line's item: if the card asks which catalogue item, MOD-550 (a code, not a name).
    await ui.chooseIfOffered('lines.0.item', 'MOD-550');
    await expect(ui.field('projectCode')).toContainText(project.code);
    const notes = await ui.notes();
    await attach(testInfo, 'at03-card-notes', notes);
    expect(notes).not.toContain(t('preview.project_none', { name: project.code }));

    await readyToApprove(testInfo, 'at03', ui);
    const job = await ui.approveAndWait();
    await attach(testInfo, 'at03-execution-steps', stepLines(job));
    expect(job.status).toBe('done');

    await expect(ui.exec).toBeVisible();
    await expect(ui.exec.getByText(t('exec.done_all'))).toBeVisible();
    await expect(ui.exec.getByText(t('exec.after_matrix'))).toBeVisible();
    const requisition = entityOf(job, t('exec.kind.requisition'));
    expect(requisition.code ?? '').toMatch(/^PR-\d{5}$/);
    created = { id: requisition.id, code: requisition.code as string };
    await expect(ui.exec.getByText(t('exec.done', { entity: t('exec.kind.requisition'), code: created.code }))).toBeVisible();
    const steps = ui.exec.getByTestId('execution-step');
    await expect(steps).toHaveCount(2);
    await expect(steps.nth(0)).toHaveAttribute('data-state', 'done');
    await expect(steps.nth(1)).toHaveAttribute('data-state', 'done');

    // NPI, as the engineer: the requisition is in the matrix.
    const pr = await npiRequisition(request, token, created.id);
    expect(pr.status).toBe('PENDING_APPROVAL');
    expect(Number(pr.estimatedTotal)).toBe(PR_QTY * MOD_550_UNIT_COST);
    expect(pr.requestedById).toBe(userId);
    expect(pr.pendingApproval?.status).toBe('PENDING');
    const admin = await npiLogin(request, readAdminCredentials());
    const pmRole = readRoles(await npiGet(request, admin.token, '/admin/roles')).find((role) => role.key === 'pm');
    expect(pmRole, "NPI has a role with key 'pm'").toBeDefined();
    expect(pr.pendingApproval?.steps[0]?.role.nameAr).toBe(pmRole?.nameAr);
    expect(pr.workflow.history.map((h) => h.actionCode)).toEqual(['OPEN', 'SUBMIT']);

    // The pm's inbox holds it, signable; the engineer's does not.
    const pm = await npiLogin(request, readSeededAccount('pm'));
    expect(pmInboxBefore).not.toContain(created.code);
    const entry = (await npiInbox(request, pm.token)).find((e) => e.documentId === created?.id);
    expect(entry, 'the pm inbox holds the requisition').toBeDefined();
    expect(entry?.documentCode).toBe(created.code);
    expect(entry?.canDecide).toBe(true);
    expect((await npiInbox(request, token)).some((e) => e.documentId === created?.id)).toBe(false);

    const rows = await auditRowsSince(userId, startedAt);
    await attach(testInfo, 'at03-audit-events', rows.map((r) => r.event));
    expect(rows.filter((r) => r.event === 'extract_pr')).toHaveLength(1);
  });

  test('(b) the engineer asks the chat to approve it: answered in words, nothing approved (D-T31-6)', async ({ page, request }, testInfo) => {
    if (created === undefined) throw new Error('(a) did not record a requisition');
    const engineer = readSiteEngineerCredentials();
    const { token } = await npiLogin(request, engineer);
    const auditBefore = (await auditRows({ intakeJobId: jobId })).map((r) => r.event);

    await signIn(page, engineer);
    const composer = await readyComposer(page);
    await composer.fill(approveSentence(created.code));
    const replied = watch(page, isChatPost, MODEL_WAIT);
    await composer.press('Enter');
    const res = await replied;

    expect(res.status()).toBe(200);
    const body = await chatBody(res);
    await attach(testInfo, 'at03-approve-chat-reply', body.textAr);
    // `answer`: the model really answered; never an intake job.
    expect(body.kind).toBe('answer');
    expect(body.intakeJobId).toBeUndefined();

    const pr = await npiRequisition(request, token, created.id);
    expect(pr.status).toBe('PENDING_APPROVAL');
    expect(pr.workflow.history.map((h) => h.actionCode)).not.toContain('APPROVE');
    expect((await auditRows({ intakeJobId: jobId })).map((r) => r.event)).toEqual(auditBefore);
  });
});

// ─── AT-05 ──────────────────────────────────────────────────────────────────

test.describe('AT-05 goods receipt from a delivery-note photo @live-flows', () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });
  desktopOnly();
  liveOnly();

  const doc: EvalDoc = EVAL_DOCS.grn01;
  let expected: EvalExpected;
  let po: Awaited<ReturnType<typeof grnPrestate>>['po'];

  test.beforeAll(async ({ request }, testInfo) => {
    if (!liveDesktop(testInfo)) return;
    ({ po } = await grnPrestate(request));
    expected = evalExpected(doc);
  });

  test.afterAll(disconnectAll);

  test('a delivery-note photo under consent becomes a DRAFT goods receipt against the purchase order', async ({ page, request }, testInfo) => {
    const pmAccount = readSeededAccount('pm');
    const pm = await npiLogin(request, pmAccount);
    const printedCode = expectedString(expected, 'purchaseOrderCode');
    const lineCount = expectedLength(expected, 'lines.length');
    // D-T31-1: does NPI already hold a DIFFERENT order with the code the photo prints?
    const printedKnown = (await npiPurchaseOrderCodes(request, pm.token)).includes(printedCode);

    await signIn(page, pmAccount);
    await readyComposer(page);
    const log = page.getByRole('log');
    const attachedBubble = log.getByText(t('chat.attached', { name: doc.file }), { exact: true });
    const attachedBefore = await attachedBubble.count();
    const chipsBefore = await page.getByTestId('flow-chips').count();

    // The photo: the consent card comes first, and nothing has been sent.
    const startedAt = new Date(Date.now() - 5_000);
    const uploaded = watch(page, isDocumentsPost, 60_000);
    await attachEvalDoc(page, doc);
    const upload = await uploaded;
    expect([200, 201]).toContain(upload.status());
    await attach(testInfo, 'at05-upload', `HTTP ${upload.status()}`);
    await expect(attachedBubble).toHaveCount(attachedBefore + 1);
    const consent = page.getByTestId('consent-card');
    await expect(consent).toBeVisible();
    await expect(consent.getByRole('heading', { name: t('consent.title') })).toBeVisible();
    await expect(consent.getByText(t('consent.policy_line'), { exact: false })).toBeVisible();
    expect(await auditRowsSince(pm.userId, startedAt), 'no model call before the consent').toEqual([]);

    const consented = watch(page, isConsentPost, 60_000);
    const replied = watch(page, isChatPost, MODEL_WAIT);
    await consent.getByRole('button', { name: t('consent.approve') }).click();
    const consentRes = await consented;
    expect(consentRes.status()).toBe(200);
    const consentEventId = ((await consentRes.json()) as { consentEventId: string }).consentEventId;
    await expect(log.getByText(t('chat.consent_recorded'), { exact: true })).toHaveCount(1);

    const reply = await documentReply(page, testInfo, 'at05', replied, 'grn', chipsBefore);
    await attach(testInfo, 'at05-chat-reply', `${reply.kind}: ${reply.textAr}`);
    const jobId = jobIdOf(reply);
    const ui = intakeUi(page, jobId);
    await expect(ui.card).toBeVisible({ timeout: MODEL_WAIT });

    // The extraction's reading: the printed order code (D-T31-1).
    await expect(ui.field('purchaseOrderCode')).toContainText(printedCode);
    await attach(testInfo, 'at05-printed-code', `${printedCode} (live order: ${po.code}; an order with the printed code exists in NPI: ${printedKnown})`);
    if (po.code === printedCode) {
      await attach(testInfo, 'at05-printed-code-matched-live', 'the live order happens to carry the printed code');
    } else if (printedKnown) {
      await attach(testInfo, 'at05-printed-code-exists-in-npi', 'NPI holds another order with the printed code, so no «not found» note is expected');
    } else {
      await expect(ui.card.getByTestId('preview-notes').getByText(t('preview.po_none', { code: printedCode }))).toBeVisible();
    }
    await attach(testInfo, 'at05-card-notes-before-fix', await ui.notes());

    // The way out: type the live code; the card re-resolves against NPI.
    await ui.setField('purchaseOrderCode', po.code);
    await expect(ui.field('purchaseOrderCode')).toContainText(po.code);
    await expect(ui.card.getByText(t('preview.po_none', { code: po.code }))).toHaveCount(0);
    if (po.code !== printedCode) await expect(ui.card.getByText(t('preview.po_none', { code: printedCode }))).toHaveCount(0);
    await expect(ui.steps.first()).toHaveText(t('preview.step.grn_create', { code: po.code, n: lineCount }));

    // The lines: quantities and serial numbers as read.
    await expect(ui.card.getByTestId('preview-lines').getByTestId('preview-line')).toHaveCount(lineCount);
    await expect(ui.field('lines.0.qty').locator('bdi').first()).toHaveText(formatNumber(expectedNumber(expected, 'lines.0.qty')));
    const shownSerials = (await ui.value('lines.0.serials')).split(ARABIC_COMMA).map((s) => s.trim()).filter((s) => s.length > 0);
    await attach(testInfo, 'at05-serials-shown', shownSerials);
    await attach(testInfo, 'at05-serials-status', (await ui.field('lines.0.serials').getAttribute('data-status')) ?? '(no data-status)');
    expect(shownSerials).toHaveLength(expectedLength(expected, 'lines.0.serials'));
    // A line that matches several order lines asks which: pick by the SKU the photo prints.
    for (let i = 0; i < lineCount; i += 1) {
      await ui.chooseIfOffered(`lines.${i}.poLine`, expectedString(expected, `lines.${i}.sku`));
    }
    await attach(testInfo, 'at05-card-notes', await ui.notes());

    await readyToApprove(testInfo, 'at05', ui);
    const job = await ui.approveAndWait();
    await attach(testInfo, 'at05-execution-steps', stepLines(job));
    expect(job.status).toBe('done');

    await expect(ui.exec).toBeVisible();
    await expect(ui.exec.getByText(t('exec.done_all'))).toBeVisible();
    const receiptRef = entityOf(job, t('exec.kind.goods_receipt'));
    expect(receiptRef.code ?? '').toMatch(/^GRN-\d+$/);
    await expect(ui.exec.getByText(t('exec.done', { entity: t('exec.kind.goods_receipt'), code: receiptRef.code as string }))).toBeVisible();
    const execSteps = ui.exec.getByTestId('execution-step');
    await expect(execSteps.last()).toHaveAttribute('data-state', 'manual');
    await expect(execSteps.last()).toContainText(t('preview.step.grn_inspect_manual'));

    // NPI, as the pm: a DRAFT receipt with the quantities read, not billed.
    const detail = await npiPurchaseOrderDetail(request, pm.token, po.id);
    const receipt = detail.goodsReceipts.find((g) => g.code === receiptRef.code);
    expect(receipt, 'the purchase order holds the new receipt').toBeDefined();
    expect(receipt?.status).toBe('DRAFT');
    expect(receipt?.billed).toBe(false);
    for (let i = 0; i < lineCount; i += 1) {
      const sku = expectedString(expected, `lines.${i}.sku`);
      const line = receipt?.lines.find((l) => l.purchaseOrderLineId === po.lineIdBySku[sku]);
      expect(line?.qty, `receipt line for ${sku}`).toBe(expectedNumber(expected, `lines.${i}.qty`));
    }
    // A DRAFT receipt does not move the order: it stays SENT until a receipt is accepted.
    await attach(testInfo, 'at05-po-status', `${detail.status}`);
    expect(['SENT', 'PARTIALLY_RECEIVED']).toContain(detail.status);

    // The audit: the photo went under this consent, and the execution wrote its row.
    const rows = await auditRowsSince(pm.userId, startedAt);
    await attach(testInfo, 'at05-audit-events', rows.map((r) => `${r.event} imageSent=${r.imageSent} consent=${r.consentEventId}`));
    const extractions = rows.filter((r) => r.event === 'extract_grn');
    expect(extractions).toHaveLength(1);
    expect(extractions[0].imageSent).toBe(true);
    expect(extractions[0].consentEventId).not.toBeNull();
    expect(extractions[0].consentEventId).toBe(consentEventId);
    expect(rows.filter((r) => r.event === 'intake_executed' && r.intakeJobId === jobId)).toHaveLength(1);
  });
});

// ─── AT-04 ──────────────────────────────────────────────────────────────────

test.describe('AT-04 vendor bill from a photo with consent @live-flows', () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });
  desktopOnly();
  liveOnly();

  const doc: EvalDoc = EVAL_DOCS.bill01;
  let expected: EvalExpected;
  let prestate: Awaited<ReturnType<typeof billPrestate>>;

  test.beforeAll(async ({ request }, testInfo) => {
    if (!liveDesktop(testInfo)) return;
    prestate = await billPrestate(request, newRunId());
    expected = evalExpected(doc);
  });

  test.afterAll(disconnectAll);

  test('(a) consent is asked before any model call, and cancelling sends nothing', async ({ page, request }, testInfo) => {
    const accountant = readSeededAccount('accountant');
    const { userId } = await npiLogin(request, accountant);
    await signIn(page, accountant);
    await readyComposer(page);
    const log = page.getByRole('log');
    const cardsBefore = await settledCardCount(page);
    const chatPosts: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' && new URL(req.url()).pathname === '/copilot/api/chat') chatPosts.push(req.url());
    });

    const startedAt = new Date(Date.now() - 5_000);
    const uploaded = watch(page, isDocumentsPost, 60_000);
    await attachEvalDoc(page, doc);
    const upload = await uploaded;
    expect([200, 201]).toContain(upload.status());
    await attach(testInfo, 'at04-cancel-upload', `HTTP ${upload.status()}`);

    const consent = page.getByTestId('consent-card');
    await expect(consent).toBeVisible();
    await expect(consent.getByText(t('consent.policy_line'), { exact: false })).toBeVisible();
    expect(await auditRowsSince(userId, startedAt), 'no model call before the consent').toEqual([]);

    const cancelBubbles = log.getByText(t('chat.consent_cancelled'), { exact: true });
    const cancelledBefore = await cancelBubbles.count();
    const consented = watch(page, isConsentPost, 60_000);
    await consent.getByRole('button', { name: t('consent.cancel') }).click();
    const consentRes = await consented;
    expect(consentRes.status()).toBe(200);
    expect(((await consentRes.json()) as { decision: string }).decision).toBe('cancelled');
    await expect(cancelBubbles).toHaveCount(cancelledBefore + 1);
    await expect(consent).toHaveCount(0);

    // Nothing was sent: no chat turn, no job, no card, no audit row.
    const rows = await auditRowsSince(userId, startedAt);
    await attach(testInfo, 'at04-cancel-audit-events', rows.map((r) => r.event));
    expect(rows).toEqual([]);
    expect(chatPosts).toEqual([]);
    expect(await intakeJobsSince(userId, startedAt)).toEqual([]);
    expect(await settledCardCount(page)).toBe(cardsBefore);
  });

  test('(b) approve sends the image under a consent id, and the bill lands in its recorded state in NPI', async ({ page, request }, testInfo) => {
    const accountant = readSeededAccount('accountant');
    const npi = await npiLogin(request, accountant);
    const vendorName = expectedString(expected, 'vendor.nameAr');
    const amountsTotal = prestate.expected.total;
    // A mismatch here is a pre-state error (the fixture or the photo changed), not a product one.
    if (amountsTotal !== expectedNumber(expected, 'total')) {
      throw new Error(`pre-state error: NPI will bill ${amountsTotal} for the accepted receipt, the photo prints ${expectedNumber(expected, 'total')}`);
    }

    await signIn(page, accountant);
    await readyComposer(page);
    const log = page.getByRole('log');
    const attachedBubble = log.getByText(t('chat.attached', { name: doc.file }), { exact: true });
    const attachedBefore = await attachedBubble.count();
    const chipsBefore = await page.getByTestId('flow-chips').count();

    // The same bytes again: a deduplicated upload (200), the consent card again.
    const startedAt = new Date(Date.now() - 5_000);
    const uploaded = watch(page, isDocumentsPost, 60_000);
    await attachEvalDoc(page, doc);
    const upload = await uploaded;
    expect(upload.status()).toBe(200);
    expect(((await upload.json()) as UploadBody).deduplicated).toBe(true);
    await expect(attachedBubble).toHaveCount(attachedBefore + 1);
    const consent = page.getByTestId('consent-card');
    await expect(consent).toBeVisible();
    expect(await auditRowsSince(npi.userId, startedAt), 'no model call before the consent').toEqual([]);

    const consented = watch(page, isConsentPost, 60_000);
    const replied = watch(page, isChatPost, MODEL_WAIT);
    await consent.getByRole('button', { name: t('consent.approve') }).click();
    const consentRes = await consented;
    expect(consentRes.status()).toBe(200);
    const consentEventId = ((await consentRes.json()) as { consentEventId: string }).consentEventId;
    await expect(log.getByText(t('chat.consent_recorded'), { exact: true })).toHaveCount(1);

    const reply = await documentReply(page, testInfo, 'at04', replied, 'vendor_bill', chipsBefore);
    await attach(testInfo, 'at04-chat-reply', `${reply.kind}: ${reply.textAr}`);
    const jobId = jobIdOf(reply);
    const ui = intakeUi(page, jobId);
    await expect(ui.card).toBeVisible({ timeout: MODEL_WAIT });

    // The extraction's reading: the printed order and receipt codes (D-T31-1).
    await expect(ui.field('purchaseOrderCode')).toContainText(expectedString(expected, 'purchaseOrderCode'));
    await expect(ui.field('goodsReceiptCode')).toContainText(expectedString(expected, 'goodsReceiptCode'));
    await attach(testInfo, 'at04-card-notes-before-fix', await ui.notes());

    // The way out: the live codes, typed into the card; each edit re-resolves against NPI.
    await ui.setField('purchaseOrderCode', prestate.po.code);
    await ui.setField('goodsReceiptCode', prestate.receipt.code);
    await expect(ui.field('purchaseOrderCode')).toContainText(prestate.po.code);
    await expect(ui.field('goodsReceiptCode')).toContainText(prestate.receipt.code);
    await expect(ui.steps.first()).toContainText(prestate.receipt.code);

    // The vendor is the seeded one, matched; the amounts agree with what NPI will compute.
    const vendorChoice = ui.card.locator('[data-testid="preview-choice"][data-target="vendor"]');
    await expect(vendorChoice).toContainText(t('preview.vendor_match', { name: vendorName }));
    await ui.chooseIfOffered('vendor', vendorName);
    await expect(ui.field('total')).toContainText(amountText(amountsTotal));
    await expect(ui.card.getByText(t('extract.warn.bill_total_mismatch'))).toHaveCount(0);
    await attach(testInfo, 'at04-card-notes', await ui.notes());

    await readyToApprove(testInfo, 'at04', ui);
    const job = await ui.approveAndWait();
    await attach(testInfo, 'at04-execution-steps', stepLines(job));
    expect(job.status).toBe('done');

    await expect(ui.exec).toBeVisible();
    await expect(ui.exec.getByText(t('exec.done_all'))).toBeVisible();
    const billRef = entityOf(job, t('exec.kind.vendor_bill'));
    expect(billRef.code ?? '').toMatch(/^BILL-\d+$/);
    await expect(ui.exec.getByText(t('exec.done', { entity: t('exec.kind.vendor_bill'), code: billRef.code as string }))).toBeVisible();
    const execSteps = ui.exec.getByTestId('execution-step');
    await expect(execSteps.last()).toHaveAttribute('data-state', 'manual');
    await expect(execSteps.last()).toContainText(t('preview.step.bill_match_npi'));

    // NPI, as the accountant: the receipt is billed, and the bill waits in the inbox in its recorded state.
    const detail = await npiPurchaseOrderDetail(request, npi.token, prestate.po.id);
    expect(detail.goodsReceipts.find((g) => g.id === prestate.receipt.id)?.billed).toBe(true);
    const task = (await npiInboxTasks(request, npi.token)).find((x) => x.documentType === 'VendorBill' && x.documentCode === billRef.code);
    await attach(testInfo, 'at04-inbox-task', task === undefined ? '(not found)' : `${task.documentType} ${task.documentCode} ${task.stateEn}`);
    expect(task, 'the accountant inbox holds the new bill').toBeDefined();
    expect(task?.stateEn).toBe('Recorded');

    // The audit: the image went under the consent this test recorded; one execution row.
    const rows = await auditRowsSince(npi.userId, startedAt);
    await attach(testInfo, 'at04-audit-events', rows.map((r) => `${r.event} imageSent=${r.imageSent} consent=${r.consentEventId}`));
    const extractions = rows.filter((r) => r.event === 'extract_vendor_bill');
    expect(extractions).toHaveLength(1);
    expect(extractions[0].imageSent).toBe(true);
    expect(extractions[0].consentEventId).toBe(consentEventId);
    expect(rows.filter((r) => r.event === 'intake_executed' && r.intakeJobId === jobId)).toHaveLength(1);
  });
});
