// End-to-end coverage for T-26 and T-27: the preview card, the execution card
// (now after a real execution: done, or stopped at a failed step), the
// document page and the chat wiring around them. Real local NPI API + real
// copilot, real login; `/copilot/api/chat`, `/copilot/api/documents` and
// `/copilot/api/intake` are intercepted — no test may call the model, and the
// intake endpoint is the contract between the card and the server, which
// `tests/intake-job.spec.ts` covers from the other side. Runs on both the
// `desktop` (line table) and `mobile` (stacked line cards) Playwright projects.
//
// T-39b (D-23): the chat history, and the card of every intake message in it,
// are read on the server and rendered in the first HTML — the browser fetches
// neither. So a test that starts from an earlier conversation seeds it (and
// the stored job its card is drawn from) in the copilot's database
// (`fixtures/chat-db.ts`) before the login and removes it afterwards, instead
// of mocking `GET /copilot/api/chat` and `GET /copilot/api/intake`. The intake
// mock stays for what is still fetched in the browser: a card whose job the
// chat has just created, and the `/documents/<job>` page.
import type { APIRequestContext, Page, Route } from '@playwright/test';
import { test, expect } from '@playwright/test';
import { t } from '../src/i18n/ar';
import { FLOW_TYPES } from '../src/onboarding/profile.schema';
import type { IntakeView } from '../src/intake/types';
import { readAdminCredentials } from './fixtures/accounts';
import { waitForHydration } from './fixtures/hydration';
import {
  disconnectChatDb,
  npiIdentity,
  restoreChatFixture,
  seedLatestConversation,
  type ChatFixtureHandle,
  type HistoryMessage,
} from './fixtures/chat-db';
import { cancelledView, contractView, CUSTOMER, DOCUMENT_ID, executedView, executionFailedView, JOB_ID, readyView } from './fixtures/intake';

const CHAT_PATH = '**/copilot/api/chat';
const DOCUMENTS_PATH = '**/copilot/api/documents';
const INTAKE_PATH = '**/copilot/api/intake*';

const FLOW_AR = t('flow.customer_contract');

// A real, minimal 1x1 PNG — the mocked upload endpoint decides what kind of
// document it was, the browser only needs a genuine file to hand over.
const PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

function jsonRoute(route: Route, status: number, body: unknown, delayMs = 0) {
  const fulfill = () => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  return delayMs > 0 ? new Promise<void>((resolve) => setTimeout(resolve, delayMs)).then(fulfill) : fulfill();
}

interface Mocks {
  chatPosts: Record<string, unknown>[];
  intakeGets: string[];
  intakePosts: Record<string, unknown>[];
}

interface Scenario {
  /** Messages seeded as the user's latest conversation (a reload of an earlier conversation). */
  history?: HistoryMessage[];
  /** The stored job the history's card is rendered from on the server; default
   *  `contractView()` when the history carries an intake message. */
  job?: IntakeView;
  /** One reply per chat POST, in order; the last one repeats. */
  chatReplies?: unknown[];
  chatDelayMs?: number;
  /** The document the upload endpoint returns. */
  document?: { kind: 'pdf_text' | 'image' | 'pdf_scanned'; fileName: string; pageCount: number };
  intakeGet?: (id: string) => { status: number; body: unknown };
  intakePost?: (body: Record<string, unknown>) => { status: number; body: unknown; delayMs?: number };
}

const intakeReply = {
  conversationId: 'conv-1',
  messageId: 'm-intake',
  kind: 'intake',
  intakeJobId: JOB_ID,
  documentId: DOCUMENT_ID,
  textAr: t('chat.intake_ready', { flow: FLOW_AR }),
  badges: [FLOW_AR],
  memoryNotes: [],
};

const chooseFlowReply = {
  conversationId: 'conv-1',
  messageId: 'm-choose',
  kind: 'choose_flow',
  documentId: DOCUMENT_ID,
  textAr: t('flow.unknown'),
  badges: [],
  memoryNotes: [],
};

/** The earlier conversation of a user who attached a contract: their bubble, then the reply that carries the card. */
function intakeHistory(): HistoryMessage[] {
  return [
    { id: 'm-user', role: 'user', textAr: t('chat.attached', { name: 'عقد.pdf' }), badges: [], memoryNotes: [], createdAt: '2026-10-05T09:00:00.000Z', documentId: DOCUMENT_ID },
    { id: 'm-bot', role: 'assistant', kind: 'intake', intakeJobId: JOB_ID, documentId: DOCUMENT_ID, textAr: intakeReply.textAr, badges: [FLOW_AR], memoryNotes: [], createdAt: '2026-10-05T09:00:05.000Z' },
  ];
}

const ok = (body: unknown) => ({ status: 200, body: { job: body } });

/** What the running test seeded, for `afterEach` to remove. */
let handle: ChatFixtureHandle | undefined;

test.afterEach(async () => {
  await restoreChatFixture(handle);
  handle = undefined;
});

test.afterAll(async () => {
  await disconnectChatDb();
});

/**
 * Seeds the admin's latest conversation (the scenario's history, with the
 * stored job its card is drawn from), registers every mock, then signs the
 * admin in and lands on the home page. The seed and the mocks go in before the
 * login's navigation, since the server reads the history while rendering
 * `/copilot` (same pattern as `e2e/chat-ui.spec.ts`).
 */
async function setup(page: Page, request: APIRequestContext, scenario: Scenario = {}): Promise<Mocks> {
  const mocks: Mocks = { chatPosts: [], intakeGets: [], intakePosts: [] };
  let chatCalls = 0;

  const admin = readAdminCredentials();
  const history = scenario.history ?? [];
  handle = await seedLatestConversation(await npiIdentity(request, admin), {
    messages: history,
    jobs: history.some((m) => m.intakeJobId) ? [scenario.job ?? contractView()] : [],
  });

  await page.goto('/copilot/login');

  await page.route(CHAT_PATH, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    mocks.chatPosts.push(route.request().postDataJSON() as Record<string, unknown>);
    const replies = scenario.chatReplies ?? [intakeReply];
    const reply = replies[Math.min(chatCalls, replies.length - 1)];
    chatCalls += 1;
    return jsonRoute(route, 200, reply, scenario.chatDelayMs ?? 0);
  });

  await page.route(DOCUMENTS_PATH, (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const doc = scenario.document ?? { kind: 'pdf_text', fileName: 'عقد.pdf', pageCount: 3 };
    return jsonRoute(route, 201, {
      document: {
        id: DOCUMENT_ID,
        fileName: doc.fileName,
        mime: doc.kind === 'pdf_text' ? 'application/pdf' : 'image/png',
        sizeBytes: PNG_BUFFER.byteLength,
        kind: doc.kind,
        pageCount: doc.pageCount,
        textChars: doc.kind === 'pdf_text' ? 900 : null,
        createdAt: '2026-10-05T09:00:00.000Z',
      },
    });
  });

  await page.route(INTAKE_PATH, async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      const id = new URL(request.url()).searchParams.get('id') ?? '';
      mocks.intakeGets.push(id);
      const answer = scenario.intakeGet ? scenario.intakeGet(id) : id === JOB_ID ? ok(contractView()) : { status: 404, body: { error: 'not_found', messageAr: t('intake.not_found') } };
      return jsonRoute(route, answer.status, answer.body);
    }
    const body = request.postDataJSON() as Record<string, unknown>;
    mocks.intakePosts.push(body);
    const answer = scenario.intakePost ? scenario.intakePost(body) : { status: 500, body: { error: 'server' } };
    return jsonRoute(route, answer.status, answer.body, answer.delayMs ?? 0);
  });

  await page.getByLabel(t('login.email')).fill(admin.email);
  await page.getByLabel(t('login.password')).fill(admin.password);
  await page.getByRole('button', { name: t('login.submit') }).click();
  await page.waitForURL('**/copilot');
  await waitForHydration(page);
  return mocks;
}

async function attachContract(page: Page) {
  await page.locator('[data-testid="attach-input"]').setInputFiles({ name: 'عقد.pdf', mimeType: 'image/png', buffer: PNG_BUFFER });
}

const card = (page: Page) => page.getByTestId('preview-card');
const fieldOf = (page: Page, path: string) => card(page).locator(`[data-path="${path}"]`);
const approveButton = (page: Page) => card(page).getByRole('button', { name: t('preview.approve'), exact: true });

test.describe('preview card (T-26)', () => {
  test('attaching a text document reads it and shows the card, with the unconfirmed value waiting for the user', async ({ page, request }) => {
    const mocks = await setup(page, request, { chatDelayMs: 1500 });
    await attachContract(page);

    // The document goes to the chat on its own: no text, the document id and the seeded conversation it continues, nothing else.
    await expect.poll(() => mocks.chatPosts.length).toBe(1);
    expect(mocks.chatPosts[0]).toEqual({ conversationId: 'conv-1', documentId: DOCUMENT_ID });

    // While the server reads, the log says which page.
    await expect(page.getByRole('status').getByText(t('intake.reading', { n: 1, total: 3 }))).toBeVisible();
    await expect(page.getByRole('log').getByText(t('chat.document_text_ready'))).toBeVisible();

    await expect(page.getByRole('log').getByText(intakeReply.textAr)).toBeVisible();
    await expect(card(page)).toBeVisible();
    await expect(card(page).getByRole('heading', { name: t('preview.title') })).toBeVisible();
    expect(mocks.intakeGets).toContain(JOB_ID);

    // Confirmed values carry the badge.
    await expect(fieldOf(page, 'customer.nameAr')).toContainText(CUSTOMER);
    await expect(fieldOf(page, 'customer.nameAr').getByText(t('preview.confirmed'))).toBeVisible();
    await expect(fieldOf(page, 'totalValue')).toContainText('850,000.00');

    // The unconfirmed one is a button, and it names its source.
    const confirmButton = fieldOf(page, 'retentionPct').getByRole('button', { name: t('preview.unconfirmed') });
    await expect(confirmButton).toBeVisible();
    await expect(confirmButton).toHaveAttribute('title', t('preview.evidence', { page: 2, quote: 'المحتجزات 10%' }));
    await expect(fieldOf(page, 'retentionPct')).toContainText(t('extract.warn.low_confidence'));

    await expect(card(page).getByTestId('preview-steps').locator('li')).toHaveCount(4);
    await expect(card(page).getByTestId('preview-lines').getByTestId('preview-line')).toHaveCount(3);
    await expect(card(page).getByTestId('preview-blockers')).toContainText(t('preview.block.unconfirmed', { n: 1 }));
    await expect(approveButton(page)).toBeDisabled();
  });

  test('vouching for the value enables «اعتمد»', async ({ page, request }) => {
    const mocks = await setup(page, request, {
      history: intakeHistory(),
      intakePost: () => ok(readyView()),
    });
    await expect(card(page)).toBeVisible();
    await expect(approveButton(page)).toBeDisabled();

    await fieldOf(page, 'retentionPct').getByRole('button', { name: t('preview.unconfirmed') }).click();

    await expect.poll(() => mocks.intakePosts.length).toBe(1);
    expect(mocks.intakePosts[0]).toEqual({ id: JOB_ID, action: 'confirm', path: 'retentionPct' });
    await expect(approveButton(page)).toBeEnabled();
    await expect(card(page).getByTestId('preview-blockers')).toHaveCount(0);
    await expect(fieldOf(page, 'retentionPct').getByRole('button', { name: t('preview.unconfirmed') })).toHaveCount(0);
    await expect(fieldOf(page, 'retentionPct')).toHaveAttribute('data-status', 'confirmed');
  });

  test('a sentence edit re-reads and shows the new value', async ({ page, request }) => {
    const mocks = await setup(page, request, {
      history: intakeHistory(),
      intakePost: () => ({ ...ok(readyView({ retentionPct: 5 })), delayMs: 1500 }),
    });
    await expect(card(page)).toBeVisible();

    await card(page).getByRole('button', { name: t('preview.edit'), exact: true }).click();
    const box = card(page).getByPlaceholder(t('preview.edit_prompt'));
    await expect(box).toBeVisible();
    await box.fill('المحتجزات 5%');
    await card(page).getByRole('button', { name: t('preview.edit_send') }).click();

    await expect.poll(() => mocks.intakePosts.length).toBe(1);
    expect(mocks.intakePosts[0]).toEqual({ id: JOB_ID, action: 'edit', text: 'المحتجزات 5%' });
    await expect(page.getByRole('status').getByText(t('preview.editing'))).toBeVisible();

    await expect(fieldOf(page, 'retentionPct').locator('bdi').first()).toHaveText('5');
    await expect(page.getByRole('status').getByText(t('preview.editing'))).toHaveCount(0);
    await expect(box).toHaveCount(0);
    await expect(approveButton(page)).toBeEnabled();
  });

  test('a field can be typed over inline', async ({ page, request }) => {
    const mocks = await setup(page, request, {
      history: intakeHistory(),
      intakePost: () => ok(readyView({ totalValue: 900000 })),
    });
    await expect(card(page)).toBeVisible();

    await fieldOf(page, 'totalValue').getByRole('button', { name: t('preview.edit_field') }).click();
    const input = fieldOf(page, 'totalValue').getByRole('textbox');
    await expect(input).toHaveValue('850000');
    await input.fill('900000');
    await fieldOf(page, 'totalValue').getByRole('button', { name: t('preview.save_field') }).click();

    await expect.poll(() => mocks.intakePosts.length).toBe(1);
    expect(mocks.intakePosts[0]).toEqual({ id: JOB_ID, action: 'set', path: 'totalValue', value: '900000' });
    await expect(fieldOf(page, 'totalValue')).toContainText('900,000.00');
    await expect(fieldOf(page, 'totalValue').getByRole('textbox')).toHaveCount(0);
  });

  test('choosing «جديد» for the customer is sent as a choice', async ({ page, request }) => {
    const mocks = await setup(page, request, {
      history: intakeHistory(),
      intakePost: () => ok(contractView({ customerChoice: 'new' })),
    });
    const choice = card(page).getByTestId('preview-choice');
    await expect(choice).toBeVisible();
    await expect(choice.getByRole('radio', { name: CUSTOMER })).toBeChecked();

    // A click, not `check()`: the radio is controlled by the job, so it only turns on once the answer is back.
    await choice.getByRole('radio', { name: t('preview.option_new') }).click();

    await expect.poll(() => mocks.intakePosts.length).toBe(1);
    expect(mocks.intakePosts[0]).toEqual({ id: JOB_ID, action: 'choose', target: 'customer', choice: 'new' });
    await expect(choice.getByRole('radio', { name: t('preview.option_new') })).toBeChecked();
    await expect(card(page).getByTestId('preview-steps')).toContainText(t('preview.step.customer_new', { name: CUSTOMER }));
  });

  test('approving runs the plan in NPI: a waiting line, then every step with the record it created', async ({ page, request }) => {
    const mocks = await setup(page, request, {
      history: intakeHistory(),
      job: readyView(),
      intakePost: () => ({ ...ok(executedView()), delayMs: 800 }),
    });
    await expect(approveButton(page)).toBeEnabled();
    await expect(page.getByTestId('execution-card')).toHaveCount(0);

    await approveButton(page).click();

    await expect.poll(() => mocks.intakePosts.length).toBe(1);
    expect(mocks.intakePosts[0]).toEqual({ id: JOB_ID, action: 'approve' });
    // The request is held: the user sees that something is happening in NPI.
    await expect(page.getByRole('status').getByText(t('exec.running'))).toBeVisible();

    const execution = page.getByTestId('execution-card');
    await expect(execution).toBeVisible();
    await expect(execution.getByText(t('exec.done_all'))).toBeVisible();
    await expect(page.getByRole('status').getByText(t('exec.running'))).toHaveCount(0);
    await expect(execution.getByText(t('exec.done', { entity: 'العقد', code: 'CON-00012' }))).toBeVisible();
    await expect(execution.getByText(t('exec.done', { entity: 'العميل', code: 'CUS-00001' }))).toBeVisible();

    // The contract links to its page in NPI; the attachment has none.
    const contractLink = execution.locator('a[href$="/contracts/con-1"]');
    await expect(contractLink).toHaveCount(1);
    await expect(contractLink).toHaveText(t('exec.open_in_npi'));
    await expect(execution.getByRole('link', { name: t('exec.open_in_npi') })).toHaveCount(2);

    // Four steps: three done, the last one is for NPI's own screen.
    const steps = execution.getByTestId('execution-step');
    await expect(steps).toHaveCount(4);
    await expect(steps.nth(0)).toHaveAttribute('data-state', 'done');
    await expect(steps.nth(1)).toHaveAttribute('data-state', 'done');
    await expect(steps.nth(2)).toHaveAttribute('data-state', 'done');
    const manual = execution.locator('[data-testid="execution-step"][data-state="manual"]');
    await expect(manual).toHaveCount(1);
    await expect(manual.getByText(t('exec.step.manual'), { exact: true })).toBeVisible();
    await expect(execution.getByText(t('exec.manual_hint'))).toBeVisible();

    // Read-only: no approve, edit, cancel, confirm or pencil.
    await expect(card(page).getByText(t('preview.approved'))).toBeVisible();
    await expect(approveButton(page)).toHaveCount(0);
    await expect(card(page).getByRole('button', { name: t('preview.edit'), exact: true })).toHaveCount(0);
    await expect(card(page).getByRole('button', { name: t('preview.cancel'), exact: true })).toHaveCount(0);
    await expect(card(page).getByRole('button', { name: t('preview.edit_field') })).toHaveCount(0);
    await expect(card(page).getByRole('radio')).toHaveCount(0);
  });

  test('a step NPI refuses stops the run: what was created is named and the later steps never ran', async ({ page, request }) => {
    const mocks = await setup(page, request, {
      history: intakeHistory(),
      job: readyView(),
      intakePost: () => ok(executionFailedView()),
    });
    await expect(approveButton(page)).toBeEnabled();

    await approveButton(page).click();

    await expect.poll(() => mocks.intakePosts.length).toBe(1);
    expect(mocks.intakePosts[0]).toEqual({ id: JOB_ID, action: 'approve' });

    const execution = page.getByTestId('execution-card');
    await expect(execution).toBeVisible();
    const alert = execution.getByRole('alert');
    await expect(alert).toContainText('توقفت عند الخطوة 2');
    await expect(alert).toContainText('العميل CUS-00001');
    await expect(alert).toContainText('NPI رفض');

    const steps = execution.getByTestId('execution-step');
    await expect(steps).toHaveCount(4);
    await expect(steps.nth(0)).toHaveAttribute('data-state', 'done');
    await expect(steps.nth(1)).toHaveAttribute('data-state', 'failed');
    await expect(steps.nth(2)).toHaveAttribute('data-state', 'pending');
    await expect(steps.nth(3)).toHaveAttribute('data-state', 'pending');
    await expect(execution.getByText(t('exec.done_all'))).toHaveCount(0);

    // The preview stays on the screen, read-only: nothing can be approved a second time.
    await expect(card(page)).toBeVisible();
    await expect(card(page).getByText(t('preview.approved'))).toBeVisible();
    await expect(approveButton(page)).toHaveCount(0);
  });

  test('cancelling takes two steps and writes nothing until the second', async ({ page, request }) => {
    const mocks = await setup(page, request, {
      history: intakeHistory(),
      intakePost: () => ok(cancelledView()),
    });
    await expect(card(page)).toBeVisible();

    await card(page).getByRole('button', { name: t('preview.cancel'), exact: true }).click();
    await expect(card(page).getByText(t('preview.cancel_confirm'))).toBeVisible();
    expect(mocks.intakePosts).toHaveLength(0);

    // Backing out leaves the job alone.
    await card(page).getByRole('button', { name: t('preview.confirm_no') }).click();
    await expect(card(page).getByText(t('preview.cancel_confirm'))).toHaveCount(0);
    expect(mocks.intakePosts).toHaveLength(0);

    await card(page).getByRole('button', { name: t('preview.cancel'), exact: true }).click();
    await card(page).getByRole('button', { name: t('preview.confirm_yes') }).click();

    await expect.poll(() => mocks.intakePosts.length).toBe(1);
    expect(mocks.intakePosts[0]).toEqual({ id: JOB_ID, action: 'cancel' });
    await expect(card(page).getByText(t('preview.cancelled'))).toBeVisible();
    await expect(page.getByText(t('intake.cancelled'))).toBeVisible();
    await expect(approveButton(page)).toHaveCount(0);
  });

  test('a refused action keeps the card and says why', async ({ page, request }) => {
    const mocks = await setup(page, request, {
      history: intakeHistory(),
      intakePost: () => ({ status: 422, body: { error: 'edit_failed', messageAr: t('extract.failed.invalid_json') } }),
    });
    await expect(card(page)).toBeVisible();

    await card(page).getByRole('button', { name: t('preview.edit'), exact: true }).click();
    await card(page).getByPlaceholder(t('preview.edit_prompt')).fill('المحتجزات 5%');
    await card(page).getByRole('button', { name: t('preview.edit_send') }).click();

    await expect.poll(() => mocks.intakePosts.length).toBe(1);
    await expect(card(page).getByRole('alert').filter({ hasText: t('extract.failed.invalid_json') })).toBeVisible();
    // The sentence is still there to correct.
    await expect(card(page).getByPlaceholder(t('preview.edit_prompt'))).toHaveValue('المحتجزات 5%');
    await expect(fieldOf(page, 'retentionPct').locator('bdi').first()).toHaveText('10');
  });
});

test.describe('which kind of document is it (T-26)', () => {
  test('an unrecognised attachment offers the five flows; a chip sends the document again with that flow', async ({ page, request }) => {
    const mocks = await setup(page, request, { chatReplies: [chooseFlowReply, intakeReply] });
    await attachContract(page);

    await expect(page.getByRole('log').getByText(t('flow.unknown'))).toBeVisible();
    await expect(page.getByRole('log').getByText(t('chat.choose_flow_hint'))).toBeVisible();
    const chips = page.getByTestId('flow-chips');
    for (const flow of FLOW_TYPES) {
      await expect(chips.getByRole('button', { name: t(`flow.${flow}` as const), exact: true })).toBeVisible();
    }
    await expect(chips.getByRole('button')).toHaveCount(5);
    expect(mocks.chatPosts).toHaveLength(1);
    expect(mocks.chatPosts[0]).toEqual({ conversationId: 'conv-1', documentId: DOCUMENT_ID });

    await chips.getByRole('button', { name: FLOW_AR, exact: true }).click();

    await expect.poll(() => mocks.chatPosts.length).toBe(2);
    expect(mocks.chatPosts[1]).toMatchObject({ documentId: DOCUMENT_ID, forcedFlow: 'customer_contract' });
    await expect(card(page)).toBeVisible();
  });
});

test.describe('the document page and reloads (T-26)', () => {
  test('/documents/<job> shows the same card under the page title', async ({ page, request }) => {
    const mocks = await setup(page, request);
    await page.goto(`/copilot/documents/${JOB_ID}`);

    await expect(page.getByRole('heading', { name: t('intake.page_title'), level: 1 })).toBeVisible();
    await expect(card(page)).toBeVisible();
    await expect(fieldOf(page, 'customer.nameAr')).toContainText(CUSTOMER);
    expect(mocks.intakeGets).toContain(JOB_ID);
  });

  test('a job that does not exist (or is not yours) says so, with no retry', async ({ page, request }) => {
    await setup(page, request);
    await page.goto('/copilot/documents/missing');
    await expect(page.getByText(t('intake.not_found'))).toBeVisible();
    await expect(card(page)).toHaveCount(0);
  });

  test('a reload of the conversation brings the card back under its reply', async ({ page, request }) => {
    const mocks = await setup(page, request, { history: intakeHistory() });

    const log = page.getByRole('log');
    await expect(log.getByText(t('chat.attached', { name: 'عقد.pdf' }))).toBeVisible();
    await expect(log.getByText(intakeReply.textAr)).toBeVisible();
    await expect(log.getByTestId('preview-card')).toBeVisible();
    await expect(log.getByRole('link', { name: t('preview.open_page') })).toHaveAttribute('href', `/copilot/documents/${JOB_ID}`);
    // The card came with the page (read on the server): the browser asked for no job.
    expect(mocks.intakeGets).toEqual([]);
  });

  test('a job whose read failed shows its reason instead of a card', async ({ page, request }) => {
    await setup(page, request, {
      history: intakeHistory(),
      job: { ...contractView(), status: 'failed', preview: null, failureAr: t('extract.failed.model_error') },
    });
    await expect(page.getByRole('log').getByText(t('extract.failed.model_error')).first()).toBeVisible();
    await expect(card(page)).toHaveCount(0);
  });
});

test.describe('small screens (T-26)', () => {
  test('the full card never scrolls the page sideways', async ({ page, request }) => {
    await setup(page, request, { history: intakeHistory() });
    await expect(card(page)).toBeVisible();

    const sideways = () => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(await sideways()).toBe(false);

    // With the sentence box and a field editor open as well.
    await card(page).getByRole('button', { name: t('preview.edit'), exact: true }).click();
    await fieldOf(page, 'milestones.1.descriptionAr').getByRole('button', { name: t('preview.edit_field') }).click();
    await expect(card(page).getByPlaceholder(t('preview.edit_prompt'))).toBeVisible();
    await expect(fieldOf(page, 'milestones.1.descriptionAr').getByRole('textbox')).toBeVisible();
    expect(await sideways()).toBe(false);
  });

  test('the executed card with its execution card fits too', async ({ page, request }) => {
    await setup(page, request, { history: intakeHistory(), job: executedView() });
    await expect(page.getByTestId('execution-card')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  });
});
