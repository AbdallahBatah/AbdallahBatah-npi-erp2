// Unit tests for src/components/handover/api.ts — the browser-side calls to
// /copilot/api/handover (and the chat endpoint for a predecessor's
// transcript). `fetch` is mocked throughout; no network, no server.
import { t } from '../src/i18n/ar';
import {
  loadCandidates,
  loadHandover,
  loadHandovers,
  loadPredecessorConversation,
  narrate,
  reassign,
} from '../src/components/handover/api';
import type {
  HandoverBody,
  HandoverCandidatesView,
  HandoverSummary,
  HandoverView,
  ReassignOutcome,
} from '../src/positions/handover-types';

function fakeResponse(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body === undefined) throw new Error('no body');
      return body;
    },
  } as Response;
}

function respondWith(status: number, body?: unknown) {
  const impl = jest.fn(async (_url: string, _init?: RequestInit) => fakeResponse(status, body));
  (global as unknown as { fetch: jest.Mock }).fetch = impl;
  return impl;
}

afterEach(() => jest.restoreAllMocks());

// ─── Bodies shaped like what the route returns ──────────────────────────────

function summary(over: Partial<HandoverSummary> = {}): HandoverSummary {
  return {
    id: 'h1',
    positionId: 'p1',
    positionTitleAr: 'مدير المشاريع',
    fromUserId: 'u1',
    toUserId: 'u2',
    createdAt: '2026-10-06T08:00:00.000Z',
    narrativeStatus: 'written',
    ...over,
  };
}

function body(over: Partial<HandoverBody> = {}): HandoverBody {
  return {
    version: 1,
    generatedAt: '2026-10-06T08:00:00.000Z',
    position: { id: 'p1', roleKey: 'pm', roleNameAr: 'مدير المشاريع', departmentId: null, departmentNameAr: null, titleAr: 'مدير المشاريع' },
    predecessor: { npiUserId: 'u1', nameAr: 'سعد', since: '2026-01-01T00:00:00.000Z' },
    successor: { npiUserId: 'u2', nameAr: 'ماجد' },
    tasks: {
      status: 'read',
      items: [
        {
          id: 'a1',
          documentType: 'PURCHASE_REQUISITION',
          documentCode: 'PR-00025',
          amount: 12800,
          currentStep: 1,
          stepCount: 2,
          waitingSince: '2026-10-01T08:00:00.000Z',
          raisedByNameAr: null,
          escalated: false,
        },
      ],
    },
    vendors: [{ npiVendorId: null, nameAr: null, code: null, factsAr: ['المورد شركة الخليج يسلّم خلال 10 أيام.'] }],
    routines: [{ factId: 'f1', factAr: 'يُراجع طلبات الشراء كل أحد.', sourceType: 'chat' }],
    companyFacts: [],
    narrative: {
      status: 'written',
      summaryAr: 'يتولى المنصب متابعة طلبات الشراء.',
      firstWeekAr: ['راجع الطلبات'],
      cautionsAr: ['الاعتماد في NPI فقط'],
      modelId: 'm',
      writtenAt: '2026-10-06T08:00:01.000Z',
    },
    ...over,
  };
}

function view(over: Partial<HandoverView> = {}): HandoverView {
  return { ...summary(), body: body(), bodyAr: 'نص', ...over };
}

const candidates: HandoverCandidatesView = {
  position: { id: 'p1', titleAr: 'مدير المشاريع', roleKey: 'pm' },
  holders: [{ npiUserId: 'u1', nameAr: 'سعد' }],
  candidates: [{ npiUserId: 'u2', nameAr: 'ماجد' }],
};

const outcome: ReassignOutcome = {
  handoverId: 'h1',
  endedAssignmentIds: ['as1'],
  assignmentId: 'as2',
  narrativeStatus: 'written',
};

const transcript = {
  conversationId: 'c1',
  messages: [
    { id: 'm1', role: 'user', textAr: 'وش حالة الطلبات؟', badges: [], memoryNotes: [], createdAt: '2026-10-05T08:00:00.000Z' },
    { id: 'm2', role: 'assistant', textAr: 'لا طلبات.', badges: [], memoryNotes: [], createdAt: '2026-10-05T08:00:05.000Z', kind: 'answer' },
  ],
};

// ─── Entry points × statuses ────────────────────────────────────────────────

interface Entry {
  name: string;
  call: () => Promise<{ ok: boolean; kind?: string; messageAr?: string }>;
  valid: unknown;
  malformed: unknown;
  /** The Arabic text the 404 falls back to when the body carries none. */
  notFoundAr: string;
}

const entries: Entry[] = [
  { name: 'loadHandovers', call: () => loadHandovers(), valid: { handovers: [summary()] }, malformed: { handovers: [{ id: 1 }] }, notFoundAr: t('handover.not_found') },
  { name: 'loadHandover', call: () => loadHandover('h1'), valid: { handover: view() }, malformed: { handover: { id: 'h1' } }, notFoundAr: t('handover.not_found') },
  { name: 'loadCandidates', call: () => loadCandidates('p1'), valid: { candidates }, malformed: { candidates: { position: null } }, notFoundAr: t('handover.not_found') },
  { name: 'reassign', call: () => reassign('p1', 'u2'), valid: { outcome }, malformed: { outcome: { handoverId: 5 } }, notFoundAr: t('handover.not_found') },
  { name: 'narrate', call: () => narrate('h1'), valid: { handover: view() }, malformed: { handover: null }, notFoundAr: t('handover.not_found') },
  { name: 'loadPredecessorConversation', call: () => loadPredecessorConversation('c1'), valid: transcript, malformed: { messages: [{ id: 'm1', role: 'system' }] }, notFoundAr: t('handover.chats.not_found') },
];

describe.each(entries)('$name', (entry) => {
  it('returns the parsed body on a 200 with a valid body', async () => {
    respondWith(200, entry.valid);
    const result = await entry.call();
    expect(result.ok).toBe(true);
  });

  it('a 200 with a malformed body is a server error, never a throw', async () => {
    respondWith(200, entry.malformed);
    const result = await entry.call();
    expect(result).toEqual({ ok: false, kind: 'server', messageAr: t('state.error') });
  });

  it('a 200 that is not JSON is a server error', async () => {
    respondWith(200, undefined);
    expect(await entry.call()).toEqual({ ok: false, kind: 'server', messageAr: t('state.error') });
  });

  it('a network failure is a server error', async () => {
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => {
      throw new Error('offline');
    });
    expect(await entry.call()).toEqual({ ok: false, kind: 'server', messageAr: t('state.error') });
  });

  it('401 → unauthenticated', async () => {
    respondWith(401, { error: 'unauthenticated' });
    expect(await entry.call()).toEqual({ ok: false, kind: 'unauthenticated' });
  });

  it('403 → forbidden, with the server text when it sent one', async () => {
    respondWith(403, { error: 'forbidden', messageAr: 'نص الخادم' });
    expect(await entry.call()).toEqual({ ok: false, kind: 'forbidden', messageAr: 'نص الخادم' });
    respondWith(403, {});
    expect(await entry.call()).toEqual({ ok: false, kind: 'forbidden', messageAr: t('handover.forbidden') });
  });

  it('404 → not_found, falling back to the screen text', async () => {
    respondWith(404, { error: 'not_found' });
    expect(await entry.call()).toEqual({ ok: false, kind: 'not_found', messageAr: entry.notFoundAr });
    respondWith(404, { error: 'not_found', messageAr: 'نص الخادم' });
    expect(await entry.call()).toEqual({ ok: false, kind: 'not_found', messageAr: 'نص الخادم' });
  });

  it('400 → invalid', async () => {
    respondWith(400, { error: 'not_candidate', messageAr: t('handover.not_candidate') });
    expect(await entry.call()).toEqual({ ok: false, kind: 'invalid', messageAr: t('handover.not_candidate') });
  });

  it('409 → conflict', async () => {
    respondWith(409, { error: 'already_holder', messageAr: t('handover.already_holder') });
    expect(await entry.call()).toEqual({ ok: false, kind: 'conflict', messageAr: t('handover.already_holder') });
  });

  it('502 and 503 → npi', async () => {
    respondWith(502, { error: 'npi_error', messageAr: t('handover.directory_unreadable') });
    expect(await entry.call()).toEqual({ ok: false, kind: 'npi', messageAr: t('handover.directory_unreadable') });
    respondWith(503, { error: 'npi_down' });
    expect(await entry.call()).toEqual({ ok: false, kind: 'npi', messageAr: t('home.error.npi') });
  });

  it('any other status → server error', async () => {
    respondWith(500, { error: 'server', messageAr: 'ignored' });
    expect(await entry.call()).toEqual({ ok: false, kind: 'server', messageAr: t('state.error') });
  });
});

// ─── Requests ───────────────────────────────────────────────────────────────

describe('requests', () => {
  it('loadHandover GETs ?id= with the id encoded', async () => {
    const impl = respondWith(200, { handover: view() });
    await loadHandover('a b');
    const [url, init] = impl.mock.calls[0];
    expect(url).toBe('/copilot/api/handover?id=a%20b');
    expect(init?.method).toBe('GET');
    expect(init?.credentials).toBe('same-origin');
  });

  it('loadCandidates GETs ?positionId=', async () => {
    const impl = respondWith(200, { candidates });
    await loadCandidates('p1');
    expect(impl.mock.calls[0][0]).toBe('/copilot/api/handover?positionId=p1');
  });

  it('reassign POSTs the action body as JSON', async () => {
    const impl = respondWith(200, { outcome });
    const result = await reassign('p1', 'u2');
    expect(result).toEqual({ ok: true, outcome });
    const [url, init] = impl.mock.calls[0];
    expect(url).toBe('/copilot/api/handover');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init?.body as string)).toEqual({ action: 'reassign', positionId: 'p1', toUserId: 'u2' });
  });

  it('narrate POSTs the narrate action', async () => {
    const impl = respondWith(200, { handover: view() });
    await narrate('h1');
    expect(JSON.parse(impl.mock.calls[0][1]?.body as string)).toEqual({ action: 'narrate', id: 'h1' });
  });

  it('loadPredecessorConversation GETs the chat endpoint and keeps only the transcript fields', async () => {
    const impl = respondWith(200, transcript);
    const result = await loadPredecessorConversation('c1');
    expect(impl.mock.calls[0][0]).toBe('/copilot/api/chat?conversationId=c1');
    expect(result).toEqual({
      ok: true,
      messages: [
        { id: 'm1', role: 'user', textAr: 'وش حالة الطلبات؟', createdAt: '2026-10-05T08:00:00.000Z' },
        { id: 'm2', role: 'assistant', textAr: 'لا طلبات.', createdAt: '2026-10-05T08:00:05.000Z' },
      ],
    });
  });
});

// ─── The HandoverView guard ─────────────────────────────────────────────────

describe('the HandoverView guard', () => {
  async function load(v: unknown) {
    respondWith(200, { handover: v });
    return loadHandover('h1');
  }
  const serverError = { ok: false, kind: 'server', messageAr: t('state.error') };

  it('accepts every narrative status and a view with or without predecessorConversations', async () => {
    const failed = view({ body: body({ narrative: { status: 'failed', reason: 'تأخر الرد', failedAt: '2026-10-06T08:00:01.000Z' } }) });
    const skipped = view({ body: body({ narrative: { status: 'skipped' } }) });
    const withChats = view({ predecessorConversations: [{ id: 'c1', titleAr: null, updatedAt: '2026-10-05T08:00:00.000Z', messageCount: 2 }] });
    const skippedTasks = view({ body: body({ tasks: { status: 'skipped', reason: 'no_permission' } }) });
    const noPredecessor = view({ body: body({ predecessor: null }) });
    for (const v of [view(), failed, skipped, withChats, skippedTasks, noPredecessor]) {
      const result = await load(v);
      expect(result).toEqual({ ok: true, handover: v });
    }
  });

  it('rejects a body with version 2', async () => {
    expect(await load({ ...view(), body: { ...body(), version: 2 } })).toEqual(serverError);
  });

  it('rejects a task whose amount is a string', async () => {
    const bad = view({
      body: body({
        tasks: {
          status: 'read',
          items: [{ ...(body().tasks as { items: object[] }).items[0], amount: '12800.00' } as never],
        },
      }),
    });
    expect(await load(bad)).toEqual(serverError);
  });

  it('rejects a narrative with an unknown status', async () => {
    expect(await load({ ...view(), body: { ...body(), narrative: { status: 'pending' } } })).toEqual(serverError);
  });

  it('rejects a skipped tasks section with an unknown reason', async () => {
    expect(await load({ ...view(), body: { ...body(), tasks: { status: 'skipped', reason: 'whatever' } } })).toEqual(serverError);
  });

  it('rejects a summary with an unknown narrativeStatus', async () => {
    expect(await load({ ...view(), narrativeStatus: 'pending' })).toEqual(serverError);
  });

  it('rejects predecessorConversations that is not an array of conversations', async () => {
    expect(await load({ ...view(), predecessorConversations: [{ id: 'c1' }] })).toEqual(serverError);
  });

  it('rejects a fact with an unknown sourceType', async () => {
    const bad = { ...view(), body: { ...body(), routines: [{ factId: 'f1', factAr: 'x', sourceType: 'web' }] } };
    expect(await load(bad)).toEqual(serverError);
  });
});
