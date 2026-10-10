// End-to-end coverage for T-38 (camera and microphone on a phone, F-21, AT-16,
// G-M5-1; spec/madar/03 §2 `Composer`, 05 §M5 row T-38, 06 AT-16). Real local
// NPI API + real copilot, real login as the seeded administrator;
// `/copilot/api/chat`, `/copilot/api/documents`, `/copilot/api/documents/consent`
// and `/copilot/api/intake` are intercepted — no test may call the model, and
// the intake endpoint is the contract between the card and the server (see
// `e2e/preview.spec.ts`, whose setup this file copies).
//
// Proves, at 390 px: the camera button hands a photo to the existing
// upload -> consent -> intake path (AT-04 by camera) and a phone photo above
// `PHOTO_MAX_BYTES` is re-encoded smaller before it leaves the browser; the
// mic button dictates into the composer through a faked `SpeechRecognition`
// (AT-03 by voice) and degrades to a disabled button plus a status line when
// the browser has none; the administrator's seven bottom tabs all fit inside
// the bar; the composer's four controls are 44 px touch targets inside the
// viewport; and the page never scrolls sideways at any of those stages.
//
// Does not prove: the real camera or the real recognizer (a headless Chromium
// has neither — the file input is fed with `setInputFiles` and the recognizer
// is a stand-in installed before the page loads), nor any model call or NPI
// write. Runs on the `mobile` Playwright project only (390 x 844).
//
// T-39b (D-23): the chat history is read on the server, not fetched by the
// browser, so the empty conversation these tests start from is seeded in the
// copilot's database (`fixtures/chat-db.ts`) before the login and removed after
// each test, instead of being mocked through a GET.
import type { APIRequestContext, Page, Route } from '@playwright/test';
import { test, expect } from '@playwright/test';
import { createCanvas } from '@napi-rs/canvas';
import { randomFillSync } from 'node:crypto';
import { t } from '../src/i18n/ar';
import { PHOTO_MAX_BYTES } from '../src/components/chat/photo';
import type { IntakeView } from '../src/intake/types';
import { readAdminCredentials } from './fixtures/accounts';
import { waitForHydration } from './fixtures/hydration';
import {
  disconnectChatDb,
  npiIdentity,
  restoreChatFixture,
  seedLatestConversation,
  type ChatFixtureHandle,
} from './fixtures/chat-db';
import {
  billExecutedView,
  billView,
  DOCUMENT_ID,
  JOB_ID,
  PR_ITEM,
  PR_QTY,
  prExecutedView,
  prView,
  PROJECT_CODE,
  VENDOR,
} from './fixtures/intake';

const CHAT_PATH = '**/copilot/api/chat';
const DOCUMENTS_PATH = '**/copilot/api/documents';
const CONSENT_PATH = '**/copilot/api/documents/consent';
const INTAKE_PATH = '**/copilot/api/intake*';

const BILL_FLOW_AR = t('flow.vendor_bill');
const PR_FLOW_AR = t('flow.pr');
const SENTENCE = 'أبي 40 لوح 550 واط للمشروع PRJ-00012 قبل الخميس';
const INTERIM = 'أبي 40 لوح';

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'the phone layout is only measured on the mobile project');
});

// ─── Test data ─────────────────────────────────────────────────────────────

/** A real 640x480 JPEG (a flat page with a few dark bars, like a photographed invoice). */
function smallJpeg(): Buffer {
  const canvas = createCanvas(640, 480);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f5f1e6';
  ctx.fillRect(0, 0, 640, 480);
  ctx.fillStyle = '#222222';
  for (let i = 0; i < 12; i += 1) ctx.fillRect(40, 40 + i * 32, 200 + ((i * 53) % 320), 12);
  return canvas.toBuffer('image/jpeg', 85);
}

/** A 4000x3000 JPEG of pure random noise: JPEG cannot compress it, so it stays far above `PHOTO_MAX_BYTES`. */
function largeNoiseJpeg(): Buffer {
  const canvas = createCanvas(4000, 3000);
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(4000, 3000);
  randomFillSync(image.data);
  for (let i = 3; i < image.data.length; i += 4) image.data[i] = 255;
  ctx.putImageData(image, 0, 0);
  return canvas.toBuffer('image/jpeg', 90);
}

// ─── Mocks (same shape as e2e/preview.spec.ts) ─────────────────────────────

function jsonRoute(route: Route, status: number, body: unknown) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

interface Mocks {
  chatPosts: Record<string, unknown>[];
  documentPosts: { contentType: string; body: Buffer }[];
  consentPosts: Record<string, unknown>[];
  intakePosts: Record<string, unknown>[];
}

interface Scenario {
  /** One reply per chat POST, in order; the last one repeats. */
  chatReplies?: unknown[];
  /** The job the intake GET returns for `JOB_ID`. */
  job?: IntakeView;
  /** What the intake POST answers (the approve). */
  approved?: IntakeView;
  /** The document the upload endpoint returns. */
  document?: { fileName: string; sizeBytes?: number };
}

const ok = (body: IntakeView) => ({ job: body });

function intakeReply(flowLabel: string, withDocument: boolean) {
  return {
    conversationId: 'conv-1',
    messageId: 'm-intake',
    kind: 'intake',
    intakeJobId: JOB_ID,
    ...(withDocument ? { documentId: DOCUMENT_ID } : {}),
    textAr: t('chat.intake_ready', { flow: flowLabel }),
    badges: [flowLabel],
    memoryNotes: [],
  };
}

/** What the running test seeded, for `afterEach` to remove. */
let handle: ChatFixtureHandle | undefined;

/**
 * Seeds an empty conversation for the admin, registers every mock, then signs
 * the admin in and lands on the home page. The seed goes in before the login's
 * navigation, since the server reads it while rendering `/copilot`. Any
 * `addInitScript` the test needs must be installed before calling this (it
 * navigates first).
 */
async function setup(page: Page, request: APIRequestContext, scenario: Scenario = {}): Promise<Mocks> {
  const mocks: Mocks = { chatPosts: [], documentPosts: [], consentPosts: [], intakePosts: [] };
  let chatCalls = 0;

  const admin = readAdminCredentials();
  handle = await seedLatestConversation(await npiIdentity(request, admin), { messages: [] });

  await page.goto('/copilot/login');

  await page.route(CHAT_PATH, (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    mocks.chatPosts.push(route.request().postDataJSON() as Record<string, unknown>);
    const replies = scenario.chatReplies ?? [intakeReply(BILL_FLOW_AR, true)];
    const reply = replies[Math.min(chatCalls, replies.length - 1)];
    chatCalls += 1;
    return jsonRoute(route, 200, reply);
  });

  await page.route(DOCUMENTS_PATH, (route) => {
    const request = route.request();
    if (request.method() !== 'POST') return route.fallback();
    const body = request.postDataBuffer();
    mocks.documentPosts.push({ contentType: request.headers()['content-type'] ?? '', body: body ?? Buffer.alloc(0) });
    const doc = scenario.document ?? { fileName: 'فاتورة.jpg' };
    return jsonRoute(route, 201, {
      document: {
        id: DOCUMENT_ID,
        fileName: doc.fileName,
        mime: 'image/jpeg',
        sizeBytes: doc.sizeBytes ?? body?.byteLength ?? 0,
        kind: 'image',
        pageCount: 1,
        textChars: null,
        createdAt: '2026-10-05T09:00:00.000Z',
      },
    });
  });

  await page.route(CONSENT_PATH, (route) => {
    mocks.consentPosts.push(route.request().postDataJSON() as Record<string, unknown>);
    return jsonRoute(route, 200, {
      consentEventId: 'ce-1',
      documentId: DOCUMENT_ID,
      decision: 'approved',
      policyLine: t('consent.policy_line'),
    });
  });

  await page.route(INTAKE_PATH, (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      const id = new URL(request.url()).searchParams.get('id') ?? '';
      return id === JOB_ID
        ? jsonRoute(route, 200, ok(scenario.job ?? billView()))
        : jsonRoute(route, 404, { error: 'not_found', messageAr: t('intake.not_found') });
    }
    mocks.intakePosts.push(request.postDataJSON() as Record<string, unknown>);
    return jsonRoute(route, 200, ok(scenario.approved ?? billExecutedView()));
  });

  await page.getByLabel(t('login.email')).fill(admin.email);
  await page.getByLabel(t('login.password')).fill(admin.password);
  await page.getByRole('button', { name: t('login.submit') }).click();
  await page.waitForURL('**/copilot');
  await waitForHydration(page);
  return mocks;
}

// ─── Fake SpeechRecognition ────────────────────────────────────────────────

/**
 * Installed with `page.addInitScript` before the first navigation, so the
 * page's `isSpeechSupported()` (which looks the constructor up at call time)
 * finds it. A headless Chromium has no recognizer to drive.
 *
 * Behaves like the real thing where `src/voice/speech.ts` depends on it: the
 * event's `results` is the cumulative list (the finals so far, then the
 * current interim one), `resultIndex` is the first result that is new or
 * changed, results are array-likes with `length`/`item`, handlers can be set
 * as properties or added with `addEventListener`. `stop()` and `abort()` only
 * record the call — the test decides when recognition ends with `end()`.
 */
const FAKE_SPEECH_SCRIPT = String.raw`
(() => {
  const instances = [];

  function arrayLike(items) {
    const list = { length: items.length, item(i) { return this[i]; } };
    items.forEach((item, i) => { list[i] = item; });
    return list;
  }

  class FakeSpeechRecognition {
    constructor() {
      this.lang = '';
      this.continuous = false;
      this.interimResults = false;
      this.maxAlternatives = 1;
      this.onresult = null;
      this.onend = null;
      this.onerror = null;
      this.started = false;
      this.stopped = false;
      this.aborted = false;
      this._listeners = {};
      this._finals = [];
      this._interim = null;
      instances.push(this);
    }
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
    removeEventListener(type, fn) { this._listeners[type] = (this._listeners[type] || []).filter((f) => f !== fn); }
    start() { this.started = true; }
    stop() { this.stopped = true; }
    abort() { this.aborted = true; }
    _dispatch(type, event) {
      const handler = this['on' + type];
      if (typeof handler === 'function') handler.call(this, event);
      (this._listeners[type] || []).slice().forEach((fn) => fn.call(this, event));
    }
    _result(transcript, isFinal) {
      const alt = { transcript, confidence: 0.9 };
      return { 0: alt, length: 1, isFinal, item(i) { return i === 0 ? alt : undefined; } };
    }
    _emit(text, isFinal) {
      let resultIndex;
      if (isFinal) {
        this._finals.push(text);
        this._interim = null;
        resultIndex = this._finals.length - 1;
      } else {
        this._interim = text;
        resultIndex = this._finals.length;
      }
      const items = this._finals.map((f) => this._result(f, true));
      if (this._interim !== null) items.push(this._result(this._interim, false));
      this._dispatch('result', { type: 'result', resultIndex, results: arrayLike(items) });
    }
    _end() { this.started = false; this._dispatch('end', { type: 'end' }); }
    _error(kind) { this._dispatch('error', { type: 'error', error: kind, message: '' }); }
  }

  const latest = () => {
    const instance = instances[instances.length - 1];
    if (!instance) throw new Error('no SpeechRecognition instance was created');
    return instance;
  };

  Object.defineProperty(window, 'SpeechRecognition', { value: FakeSpeechRecognition, configurable: true, writable: true });
  Object.defineProperty(window, 'webkitSpeechRecognition', { value: undefined, configurable: true, writable: true });
  delete window.webkitSpeechRecognition;

  window.__speechFake = {
    instances,
    emit(text, isFinal) { latest()._emit(text, isFinal); },
    end() { latest()._end(); },
    error(kind) { latest()._error(kind); },
  };
})();
`;

/** Both constructors gone, as in Firefox. */
const NO_SPEECH_SCRIPT = String.raw`
(() => {
  Object.defineProperty(window, 'SpeechRecognition', { value: undefined, configurable: true, writable: true });
  Object.defineProperty(window, 'webkitSpeechRecognition', { value: undefined, configurable: true, writable: true });
  delete window.SpeechRecognition;
  delete window.webkitSpeechRecognition;
})();
`;

interface FakeInstance {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  started: boolean;
  stopped: boolean;
  aborted: boolean;
}

interface FakeSpeechWindow {
  __speechFake: { instances: FakeInstance[]; emit(text: string, isFinal: boolean): void; end(): void; error(kind: string): void };
}

const fakeInstance = (page: Page) =>
  page.evaluate(() => {
    const i = (window as unknown as FakeSpeechWindow).__speechFake.instances.at(-1);
    return i ? { lang: i.lang, continuous: i.continuous, interimResults: i.interimResults, started: i.started, stopped: i.stopped, aborted: i.aborted } : null;
  });

const fakeEmit = (page: Page, text: string, isFinal: boolean) =>
  page.evaluate(([value, final]) => (window as unknown as FakeSpeechWindow).__speechFake.emit(value as string, final as boolean), [text, isFinal]);

const fakeEnd = (page: Page) => page.evaluate(() => (window as unknown as FakeSpeechWindow).__speechFake.end());

// ─── Page helpers and geometry assertions ──────────────────────────────────

const card = (page: Page) => page.getByTestId('preview-card');
const fieldOf = (page: Page, path: string) => card(page).locator(`[data-path="${path}"]`);
const approveButton = (page: Page) => card(page).getByRole('button', { name: t('preview.approve'), exact: true });
const sendButton = (page: Page) => page.getByRole('button', { name: t('chat.send'), exact: true });
const composerBox = (page: Page) => page.getByPlaceholder(t('chat.placeholder'));
const micStatus = (page: Page, text: string) => page.getByRole('status').getByText(text, { exact: true });

/** The page itself must not scroll sideways. */
async function expectNoSidewaysScroll(page: Page, stage: string) {
  const widths = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(widths.scrollWidth, `${stage}: the page scrolls sideways`).toBeLessThanOrEqual(widths.clientWidth);
}

/**
 * The bottom bar sits inside the viewport and nothing in it is clipped:
 * `scrollWidth <= clientWidth`, every link inside the bar's box, and no label
 * cut with an ellipsis. (Fixed elements do not count toward the page's
 * `scrollWidth`, so `expectNoSidewaysScroll` alone never saw this defect.)
 */
async function expectNavFits(page: Page, stage: string) {
  const nav = page.getByRole('navigation', { name: t('nav.main') });
  await expect(nav).toBeVisible();
  const report = await nav.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const links = Array.from(el.querySelectorAll('a'));
    return {
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      left: rect.left,
      right: rect.right,
      innerWidth: window.innerWidth,
      clippedLinks: links
        .filter((a) => {
          const r = a.getBoundingClientRect();
          return r.left < rect.left - 0.5 || r.right > rect.right + 0.5;
        })
        .map((a) => (a.textContent ?? '').trim()),
      truncatedLabels: links
        .flatMap((a) => Array.from(a.querySelectorAll<HTMLElement>('span:not([aria-hidden="true"])')))
        .filter((span) => (span.textContent ?? '').trim().length > 0 && span.scrollWidth > span.clientWidth)
        .map((span) => (span.textContent ?? '').trim()),
    };
  });
  expect(report.scrollWidth, `${stage}: the bar's content is wider than the bar`).toBeLessThanOrEqual(report.clientWidth);
  expect(report.left, `${stage}: the bar starts left of the viewport`).toBeGreaterThanOrEqual(-0.5);
  expect(report.right, `${stage}: the bar ends right of the viewport`).toBeLessThanOrEqual(report.innerWidth + 0.5);
  expect(report.clippedLinks, `${stage}: tabs clipped by the bar`).toEqual([]);
  expect(report.truncatedLabels, `${stage}: tab labels cut with an ellipsis`).toEqual([]);
}

/** The no-sideways assertion of AT-16 plus the bar check, at one named stage. */
async function expectFits(page: Page, stage: string) {
  await expectNoSidewaysScroll(page, stage);
  await expectNavFits(page, stage);
}

// ─── The tests ─────────────────────────────────────────────────────────────

test.describe('phone: camera, voice and layout (T-38, AT-16)', () => {
  test.afterEach(async () => {
    await restoreChatFixture(handle);
    handle = undefined;
  });

  test.afterAll(async () => {
    await disconnectChatDb();
  });

  test('AT-04 by camera: a photo goes through upload, consent and the card, to the record in NPI', async ({ page, request }) => {
    const mocks = await setup(page, request, { job: billView(), approved: billExecutedView() });
    await expectFits(page, 'home');

    // The camera is a phone affordance: visible here, and the input asks the OS for the rear camera.
    await expect(page.getByTestId('camera-button')).toBeVisible();
    await expect(page.getByRole('button', { name: t('chat.camera'), exact: true })).toBeVisible();
    const cameraInput = page.getByTestId('camera-input');
    await expect(cameraInput).toHaveAttribute('capture', 'environment');
    await expect(cameraInput).toHaveAttribute('accept', /image\//);

    await cameraInput.setInputFiles({ name: 'invoice.jpg', mimeType: 'image/jpeg', buffer: smallJpeg() });

    // The upload is a multipart POST carrying the file; the user's bubble names it.
    await expect.poll(() => mocks.documentPosts.length).toBe(1);
    expect(mocks.documentPosts[0].contentType).toMatch(/^multipart\/form-data/);
    expect(mocks.documentPosts[0].body.toString('latin1')).toContain('name="file"');
    const log = page.getByRole('log');
    await expect(log.getByText(t('chat.attached', { name: 'فاتورة.jpg' }))).toBeVisible();

    // An image never reaches a model before the user agrees: the consent card comes first.
    const consent = page.getByTestId('consent-card');
    await expect(consent).toBeVisible();
    expect(mocks.consentPosts).toHaveLength(0);
    expect(mocks.chatPosts).toHaveLength(0);
    await expectFits(page, 'consent card');

    await consent.getByRole('button', { name: t('consent.approve') }).click();
    await expect.poll(() => mocks.consentPosts.length).toBe(1);
    expect(mocks.consentPosts[0]).toEqual({ documentId: DOCUMENT_ID, decision: 'approved' });
    await expect(log.getByText(t('chat.consent_recorded'))).toBeVisible();

    // Then the document goes to the chat on its own: no text, the document id and the seeded conversation it continues, nothing else.
    await expect.poll(() => mocks.chatPosts.length).toBe(1);
    expect(mocks.chatPosts[0]).toEqual({ conversationId: 'conv-1', documentId: DOCUMENT_ID });

    await expect(card(page)).toBeVisible();
    await expect(card(page).getByText(BILL_FLOW_AR, { exact: true })).toBeVisible();
    await expect(fieldOf(page, 'vendor.nameAr')).toContainText(VENDOR);
    await expect(fieldOf(page, 'total')).toContainText('3,450.00');
    await expect(approveButton(page)).toBeEnabled();
    await expectFits(page, 'bill card');

    await approveButton(page).click();
    await expect.poll(() => mocks.intakePosts.length).toBe(1);
    expect(mocks.intakePosts[0]).toEqual({ id: JOB_ID, action: 'approve' });

    const execution = page.getByTestId('execution-card');
    await expect(execution).toBeVisible();
    await expect(execution).toContainText('BILL-00007');
    await expect(execution.getByText(t('exec.done_all'))).toBeVisible();
    await expectFits(page, 'execution card');
  });

  test('a large phone photo is downscaled before it is uploaded', async ({ page, request }) => {
    test.setTimeout(90_000);
    const original = largeNoiseJpeg();
    // The premise: this is the kind of photo that used to exceed the server's limits.
    expect(original.byteLength).toBeGreaterThan(PHOTO_MAX_BYTES);

    const mocks = await setup(page, request, { document: { fileName: 'photo-large.jpg' } });
    await page.getByTestId('camera-input').setInputFiles({ name: 'photo-large.jpeg', mimeType: 'image/jpeg', buffer: original });

    await expect.poll(() => mocks.documentPosts.length, { timeout: 45_000 }).toBe(1);
    const upload = mocks.documentPosts[0];
    expect(upload.contentType).toMatch(/^multipart\/form-data/);

    // Re-encoded smaller: well under half of what the camera produced.
    expect(upload.body.byteLength).toBeLessThan(original.byteLength / 2);
    const head = upload.body.toString('latin1');
    expect(head).toMatch(/Content-Disposition: form-data; name="file"; filename="[^"]+\.jpg"/);
    expect(head).toContain('Content-Type: image/jpeg');

    await expect(page.getByTestId('consent-card')).toBeVisible();
    await expectFits(page, 'consent card after a large photo');
  });

  test('AT-03 by voice: the dictated sentence lands in the composer, is sent by the user, and becomes a purchase requisition', async ({ page, request }) => {
    await page.addInitScript(FAKE_SPEECH_SCRIPT);
    const mocks = await setup(page, request, {
      chatReplies: [intakeReply(PR_FLOW_AR, false)],
      job: prView(),
      approved: prExecutedView(),
    });
    await expectFits(page, 'home');

    const mic = page.getByTestId('mic-button');
    await expect(mic).toBeEnabled();
    await expect(mic).toHaveAttribute('aria-pressed', 'false');

    await mic.click();
    await expect(mic).toHaveAttribute('aria-pressed', 'true');
    await expect(micStatus(page, t('chat.mic_listening'))).toBeVisible();
    expect(await fakeInstance(page)).toMatchObject({ lang: 'ar-SA', continuous: true, interimResults: true, started: true, stopped: false });
    await expectFits(page, 'listening');

    // The interim words show up as they are heard; the final sentence replaces them.
    await fakeEmit(page, INTERIM, false);
    await expect(composerBox(page)).toHaveValue(INTERIM);
    await fakeEmit(page, SENTENCE, true);
    await expect(composerBox(page)).toHaveValue(SENTENCE);

    // A second click asks the recognizer to stop; the button stays pressed until it reports the end.
    await mic.click();
    await expect.poll(async () => (await fakeInstance(page))?.stopped).toBe(true);
    await fakeEnd(page);
    await expect(mic).toHaveAttribute('aria-pressed', 'false');
    await expect(micStatus(page, t('chat.mic_listening'))).toHaveCount(0);
    await expect(composerBox(page)).toHaveValue(SENTENCE);

    // Dictation never sends: nothing has left the composer until the user presses send.
    expect(mocks.chatPosts).toHaveLength(0);
    await sendButton(page).click();
    await expect.poll(() => mocks.chatPosts.length).toBe(1);
    expect(mocks.chatPosts[0]).toMatchObject({ text: SENTENCE });
    expect(mocks.chatPosts[0]).not.toHaveProperty('documentId');

    await expect(card(page)).toBeVisible();
    await expect(card(page).getByText(PR_FLOW_AR, { exact: true })).toBeVisible();
    await expect(fieldOf(page, 'projectCode')).toContainText(PROJECT_CODE);
    await expect(fieldOf(page, 'lines.0.itemName')).toContainText(PR_ITEM);
    await expect(fieldOf(page, 'lines.0.qty')).toContainText(String(PR_QTY));
    await expect(approveButton(page)).toBeEnabled();
    await expectFits(page, 'requisition card');

    await approveButton(page).click();
    await expect.poll(() => mocks.intakePosts.length).toBe(1);
    expect(mocks.intakePosts[0]).toEqual({ id: JOB_ID, action: 'approve' });
    const execution = page.getByTestId('execution-card');
    await expect(execution).toBeVisible();
    await expect(execution).toContainText('PR-00031');
    await expectFits(page, 'execution card');
  });

  test('a browser without speech recognition: the mic is disabled, says why, and typing still works', async ({ page, request }) => {
    await page.addInitScript(NO_SPEECH_SCRIPT);
    const mocks = await setup(page, request, {
      chatReplies: [{ conversationId: 'conv-1', messageId: 'm-answer', kind: 'answer', textAr: 'تم استلام رسالتك', badges: [], memoryNotes: [] }],
    });

    const mic = page.getByTestId('mic-button');
    await expect(mic).toBeDisabled();
    await expect(mic).toHaveAttribute('title', t('chat.mic_unsupported'));
    await expect(micStatus(page, t('chat.mic_unsupported'))).toBeVisible();
    await expectFits(page, 'mic unsupported');

    await composerBox(page).fill('كم رصيد المشروع؟');
    await sendButton(page).click();
    await expect.poll(() => mocks.chatPosts.length).toBe(1);
    expect(mocks.chatPosts[0]).toMatchObject({ text: 'كم رصيد المشروع؟' });
    await expect(page.getByRole('log').getByText('تم استلام رسالتك')).toBeVisible();
    await expectFits(page, 'after sending typed text');
  });

  test("the administrator's seven tabs fit inside the bottom bar", async ({ page, request }) => {
    await setup(page, request);
    await expectFits(page, 'home');

    const nav = page.getByRole('navigation', { name: t('nav.main') });
    // Six screens for an administrator plus the way out to NPI.
    await expect(nav.getByRole('link')).toHaveCount(7);
    for (const key of ['nav.home', 'nav.setup', 'nav.settings', 'nav.trust', 'nav.metrics', 'nav.handover'] as const) {
      await expect(nav.getByRole('link', { name: t(key), exact: true })).toBeVisible();
    }
    const back = nav.getByRole('link', { name: t('nav.back_to_npi'), exact: true });
    await expect(back).toBeVisible();
    const box = (await back.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(-0.5);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 0.5);
  });

  test('the composer at 390 px: four controls, each a 44 px target inside the viewport', async ({ page, request }) => {
    await setup(page, request);
    await expectFits(page, 'home');

    const viewport = page.viewportSize()!;
    const wrapper = (await page.getByTestId('composer-wrapper').boundingBox())!;
    expect(wrapper.x).toBeGreaterThanOrEqual(-0.5);
    expect(wrapper.x + wrapper.width).toBeLessThanOrEqual(viewport.width + 0.5);

    const controls = {
      attach: page.getByRole('button', { name: t('chat.attach'), exact: true }),
      camera: page.getByTestId('camera-button'),
      mic: page.getByTestId('mic-button'),
      send: sendButton(page),
    };
    for (const [name, locator] of Object.entries(controls)) {
      await expect(locator, name).toBeVisible();
      const box = (await locator.boundingBox())!;
      expect(box.height, `${name}: touch target height`).toBeGreaterThanOrEqual(44);
      expect(box.x, `${name}: left edge`).toBeGreaterThanOrEqual(-0.5);
      expect(box.x + box.width, `${name}: right edge`).toBeLessThanOrEqual(viewport.width + 0.5);
    }
  });
});
