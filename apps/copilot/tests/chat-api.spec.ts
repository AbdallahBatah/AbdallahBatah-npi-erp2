// Unit tests for src/components/chat/api.ts — the browser-side calls to
// /copilot/api/chat. `fetch` is mocked throughout; no network, no server.
import { t } from '../src/i18n/ar';
import {
  loadConversation,
  sendMessage,
  uploadDocument,
  recordConsent,
  consentNeeded,
  MAX_MESSAGE_LENGTH,
  type DocumentSummary,
} from '../src/components/chat/api';

function fakeResponse(status: number, body?: unknown, ok = status >= 200 && status < 300): Response {
  return {
    ok,
    status,
    json: async () => {
      if (body === undefined) throw new Error('no body');
      return body;
    },
  } as Response;
}

function mockFetch(impl: jest.Mock) {
  (global as unknown as { fetch: jest.Mock }).fetch = impl;
}

describe('loadConversation', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns the conversation on a normal 200', async () => {
    const body = {
      conversationId: 'conv-1',
      messages: [
        {
          id: 'm1',
          role: 'user',
          textAr: 'مرحباً',
          badges: [],
          memoryNotes: [],
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    };
    mockFetch(jest.fn(async () => fakeResponse(200, body)));

    const result = await loadConversation();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.conversationId).toBe('conv-1');
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].textAr).toBe('مرحباً');
    }
  });

  it('returns an empty conversation (no conversation yet) as ok', async () => {
    mockFetch(jest.fn(async () => fakeResponse(200, { conversationId: null, messages: [] })));

    const result = await loadConversation();
    expect(result).toEqual({ ok: true, conversationId: null, messages: [] });
  });

  it('maps 401 to kind "unauthenticated"', async () => {
    mockFetch(jest.fn(async () => fakeResponse(401, { error: 'unauthenticated' })));

    const result = await loadConversation();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('unauthenticated');
  });

  it('maps 503 to kind "npi_down" and keeps the server\'s Arabic message', async () => {
    mockFetch(jest.fn(async () => fakeResponse(503, { error: 'npi_down', messageAr: 'تعذر الوصول إلى NPI الآن' })));

    const result = await loadConversation();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('npi_down');
      expect(result.messageAr).toBe('تعذر الوصول إلى NPI الآن');
    }
  });

  it('falls back to ar.ts when a 503 body has no messageAr', async () => {
    mockFetch(jest.fn(async () => fakeResponse(503, { error: 'npi_down' })));

    const result = await loadConversation();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.messageAr).toBe(t('chat.error.generic'));
  });

  it('treats a malformed 200 body as kind "server"', async () => {
    mockFetch(jest.fn(async () => fakeResponse(200, { unexpected: true })));

    const result = await loadConversation();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('server');
      expect(result.messageAr).toBe(t('chat.error.generic'));
    }
  });

  it('treats a body that is not valid JSON as kind "server"', async () => {
    mockFetch(
      jest.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token');
        },
      })),
    );

    const result = await loadConversation();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('server');
  });

  it('reports a network failure as kind "network"', async () => {
    mockFetch(jest.fn(async () => { throw new TypeError('fetch failed'); }));

    const result = await loadConversation();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('network');
  });

  it('any other unexpected status (e.g. 500) is treated as kind "server"', async () => {
    mockFetch(jest.fn(async () => fakeResponse(500, { error: 'server', messageAr: 'ignored on GET' })));

    const result = await loadConversation();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('server');
  });

  it('sends a GET to the fixed chat path with an Accept header and same-origin credentials', async () => {
    const fetchImpl = jest.fn(async (_url: string, _init?: RequestInit) =>
      fakeResponse(200, { conversationId: null, messages: [] }),
    );
    mockFetch(fetchImpl);

    await loadConversation();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/copilot/api/chat');
    expect(init?.method).toBe('GET');
    expect(init?.credentials).toBe('same-origin');
    expect((init?.headers as Record<string, string>).Accept).toBe('application/json');
  });
});

describe('sendMessage', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns the assistant reply on a normal 200', async () => {
    const body = {
      conversationId: 'conv-1',
      messageId: 'm2',
      kind: 'answer',
      textAr: 'تفضل',
      badges: ['أداة'],
      memoryNotes: [{ id: 'f1', factAr: 'حقيقة', sourceType: 'chat' }],
    };
    mockFetch(jest.fn(async () => fakeResponse(200, body)));

    const result = await sendMessage({ text: 'مرحباً' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.kind).toBe('answer');
      expect(result.badges).toEqual(['أداة']);
      expect(result.memoryNotes[0].factAr).toBe('حقيقة');
    }
  });

  it('maps 401 to kind "unauthenticated"', async () => {
    mockFetch(jest.fn(async () => fakeResponse(401, { error: 'unauthenticated' })));
    const result = await sendMessage({ text: 'نص' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('unauthenticated');
  });

  it('maps 413 to kind "too_long" using the server message', async () => {
    mockFetch(jest.fn(async () => fakeResponse(413, { error: 'too_long', messageAr: 'طويلة جداً' })));
    const result = await sendMessage({ text: 'x'.repeat(MAX_MESSAGE_LENGTH + 1) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('too_long');
      expect(result.messageAr).toBe('طويلة جداً');
    }
  });

  it('falls back to ar.ts for 413 when the server sent no messageAr', async () => {
    mockFetch(jest.fn(async () => fakeResponse(413, { error: 'too_long' })));
    const result = await sendMessage({ text: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.messageAr).toBe(t('chat.error.too_long'));
  });

  it('maps 500 to kind "server" using the server message', async () => {
    mockFetch(jest.fn(async () => fakeResponse(500, { error: 'server', messageAr: 'خطأ في الخادم' })));
    const result = await sendMessage({ text: 'نص' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('server');
      expect(result.messageAr).toBe('خطأ في الخادم');
    }
  });

  it('maps 503 to kind "npi_down" using the server message', async () => {
    mockFetch(jest.fn(async () => fakeResponse(503, { error: 'npi_down', messageAr: 'NPI متعطل' })));
    const result = await sendMessage({ text: 'نص' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('npi_down');
      expect(result.messageAr).toBe('NPI متعطل');
    }
  });

  it('treats a malformed 200 body as kind "server"', async () => {
    mockFetch(jest.fn(async () => fakeResponse(200, { nope: true })));
    const result = await sendMessage({ text: 'نص' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('server');
  });

  it('treats a 404 (conversation not found) as kind "server" (no dedicated UI kind)', async () => {
    mockFetch(jest.fn(async () => fakeResponse(404, { error: 'not_found' })));
    const result = await sendMessage({ text: 'نص', conversationId: 'missing-conv' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('server');
  });

  it('reports a network failure as kind "network"', async () => {
    mockFetch(jest.fn(async () => { throw new TypeError('fetch failed'); }));
    const result = await sendMessage({ text: 'نص' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('network');
  });

  it('sends a POST with the right path, headers and body when no conversationId is given', async () => {
    const fetchImpl = jest.fn(async (_url: string, _init?: RequestInit) =>
      fakeResponse(200, { conversationId: 'c1', messageId: 'm1', kind: 'answer', textAr: 'ok', badges: [], memoryNotes: [] }),
    );
    mockFetch(fetchImpl);

    await sendMessage({ text: 'مرحباً' });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/copilot/api/chat');
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('same-origin');
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init?.body as string)).toEqual({ text: 'مرحباً' });
  });

  it('includes conversationId in the body when given', async () => {
    const fetchImpl = jest.fn(async (_url: string, _init?: RequestInit) =>
      fakeResponse(200, { conversationId: 'c1', messageId: 'm1', kind: 'answer', textAr: 'ok', badges: [], memoryNotes: [] }),
    );
    mockFetch(fetchImpl);

    await sendMessage({ text: 'مرحباً', conversationId: 'c1' });

    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(init?.body as string)).toEqual({ text: 'مرحباً', conversationId: 'c1' });
  });
});

// T-26: the object form of sendMessage and the intake fields of a reply.
describe('sendMessage — documents, forced flows and intake replies', () => {
  afterEach(() => jest.restoreAllMocks());

  const answerBody = { conversationId: 'c1', messageId: 'm1', kind: 'answer', textAr: 'ok', badges: [], memoryNotes: [] };

  function bodyOfFirstCall(fetchImpl: jest.Mock): unknown {
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    return JSON.parse(init.body as string);
  }

  it('sends only the keys that are defined', async () => {
    const fetchImpl = jest.fn(async (_url: string, _init?: RequestInit) => fakeResponse(200, answerBody));
    mockFetch(fetchImpl);
    await sendMessage({ text: 'مرحباً' });
    expect(bodyOfFirstCall(fetchImpl)).toEqual({ text: 'مرحباً' });
    expect(Object.keys(bodyOfFirstCall(fetchImpl) as object)).toEqual(['text']);
  });

  it('an attachment alone has no text key', async () => {
    const fetchImpl = jest.fn(async (_url: string, _init?: RequestInit) => fakeResponse(200, answerBody));
    mockFetch(fetchImpl);
    await sendMessage({ documentId: 'doc-1', conversationId: 'c1' });
    const body = bodyOfFirstCall(fetchImpl) as Record<string, unknown>;
    expect(body).toEqual({ documentId: 'doc-1', conversationId: 'c1' });
    expect('text' in body).toBe(false);
  });

  it('carries the document, the chosen flow and the typed text together', async () => {
    const fetchImpl = jest.fn(async (_url: string, _init?: RequestInit) => fakeResponse(200, answerBody));
    mockFetch(fetchImpl);
    await sendMessage({ text: 'عقد النخيل', conversationId: 'c1', documentId: 'doc-1', forcedFlow: 'customer_contract' });
    expect(bodyOfFirstCall(fetchImpl)).toEqual({
      text: 'عقد النخيل',
      conversationId: 'c1',
      documentId: 'doc-1',
      forcedFlow: 'customer_contract',
    });
  });

  it('parses an intake reply with its job id and document', async () => {
    mockFetch(
      jest.fn(async () =>
        fakeResponse(200, {
          conversationId: 'c1',
          messageId: 'm2',
          kind: 'intake',
          textAr: t('chat.intake_ready', { flow: t('flow.customer_contract') }),
          badges: [t('flow.customer_contract')],
          memoryNotes: [],
          intakeJobId: 'job-1',
          documentId: 'doc-1',
        }),
      ),
    );
    const result = await sendMessage({ documentId: 'doc-1' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.kind).toBe('intake');
      expect(result.intakeJobId).toBe('job-1');
      expect(result.documentId).toBe('doc-1');
      expect(result.badges).toEqual([t('flow.customer_contract')]);
    }
  });

  it('parses a choose_flow reply with the document it waits on', async () => {
    mockFetch(
      jest.fn(async () =>
        fakeResponse(200, {
          conversationId: 'c1',
          messageId: 'm3',
          kind: 'choose_flow',
          textAr: t('flow.unknown'),
          badges: [],
          memoryNotes: [],
          documentId: 'doc-1',
        }),
      ),
    );
    const result = await sendMessage({ documentId: 'doc-1' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.kind).toBe('choose_flow');
      expect(result.documentId).toBe('doc-1');
      expect(result.intakeJobId).toBeUndefined();
    }
  });

  it('an ordinary answer carries neither field', async () => {
    mockFetch(jest.fn(async () => fakeResponse(200, answerBody)));
    const result = await sendMessage({ text: 'مرحباً' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect('intakeJobId' in result).toBe(false);
      expect('documentId' in result).toBe(false);
    }
  });

  it('treats a non-string job id as a malformed body', async () => {
    mockFetch(jest.fn(async () => fakeResponse(200, { ...answerBody, kind: 'intake', intakeJobId: 7 })));
    const result = await sendMessage({ text: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('server');
  });

  it('shows the server’s own message for a missing document (404) and for a consent not yet given (409)', async () => {
    mockFetch(jest.fn(async () => fakeResponse(404, { error: 'not_found', messageAr: t('document.error.not_found') })));
    const missing = await sendMessage({ documentId: 'doc-404' });
    expect(missing).toEqual({ ok: false, kind: 'server', messageAr: t('document.error.not_found') });

    mockFetch(jest.fn(async () => fakeResponse(409, { error: 'consent_required', messageAr: t('intake.consent_required') })));
    const consent = await sendMessage({ documentId: 'doc-2', forcedFlow: 'grn' });
    expect(consent).toEqual({ ok: false, kind: 'server', messageAr: t('intake.consent_required') });
  });

  it('falls back to the generic message when a 409 has no body message', async () => {
    mockFetch(jest.fn(async () => fakeResponse(409, { error: 'consent_required' })));
    const result = await sendMessage({ documentId: 'doc-2' });
    expect(result).toEqual({ ok: false, kind: 'server', messageAr: t('chat.error.generic') });
  });
});

describe('loadConversation — intake rows', () => {
  const row = (extra: Record<string, unknown>) => ({
    id: 'm1',
    role: 'assistant',
    textAr: 'نص',
    badges: [],
    memoryNotes: [],
    createdAt: '2026-10-05T09:00:00.000Z',
    ...extra,
  });

  function respondWith(messages: unknown[]) {
    globalThis.fetch = jest.fn(async () => ({
      status: 200,
      json: async () => ({ conversationId: 'c1', messages }),
    })) as unknown as typeof fetch;
  }

  it('keeps the job id and document of an intake reply, so a reload shows the card again', async () => {
    respondWith([
      row({ role: 'user', id: 'm0', textAr: t('chat.attached', { name: 'عقد.pdf' }), documentId: 'doc-1' }),
      row({ kind: 'intake', intakeJobId: 'job-1', documentId: 'doc-1' }),
    ]);
    const result = await loadConversation();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.messages[0]).toMatchObject({ role: 'user', documentId: 'doc-1' });
    expect(result.messages[1]).toMatchObject({ kind: 'intake', intakeJobId: 'job-1', documentId: 'doc-1' });
  });

  it('keeps a choose_flow row with its document', async () => {
    respondWith([row({ kind: 'choose_flow', documentId: 'doc-1', textAr: t('flow.unknown') })]);
    const result = await loadConversation();
    expect(result.ok && result.messages[0].kind).toBe('choose_flow');
    expect(result.ok && result.messages[0].documentId).toBe('doc-1');
  });

  it('rows without the new fields still load', async () => {
    respondWith([row({ kind: 'answer' })]);
    const result = await loadConversation();
    expect(result.ok && result.messages[0].intakeJobId).toBeUndefined();
    expect(result.ok && result.messages[0].documentId).toBeUndefined();
  });

  it('a job id that is not a string is a malformed body', async () => {
    respondWith([row({ kind: 'intake', intakeJobId: 42 })]);
    await expect(loadConversation()).resolves.toMatchObject({ ok: false, kind: 'server' });
  });
});

// Added in review: the kind of a reply survives a reload.
describe('loadConversation — reply kind on history rows', () => {
  const row = (extra: Record<string, unknown>) => ({
    id: 'm1',
    role: 'assistant',
    textAr: 'نص',
    badges: [],
    memoryNotes: [],
    createdAt: '2026-09-27T09:00:00.000Z',
    ...extra,
  });

  function respondWith(messages: unknown[]) {
    globalThis.fetch = jest.fn(async () => ({
      status: 200,
      json: async () => ({ conversationId: 'c1', messages }),
    })) as unknown as typeof fetch;
  }

  it('keeps a valid kind', async () => {
    respondWith([row({ kind: 'hr_refusal' })]);
    const result = await loadConversation();
    expect(result.ok && result.messages[0].kind).toBe('hr_refusal');
  });

  it('accepts a row with no kind (user messages, older rows)', async () => {
    respondWith([row({ role: 'user' })]);
    const result = await loadConversation();
    expect(result.ok && result.messages[0].kind).toBeUndefined();
  });

  it('treats an unknown kind as a malformed body', async () => {
    respondWith([row({ kind: 'approved' })]);
    await expect(loadConversation()).resolves.toMatchObject({ ok: false, kind: 'server' });
  });
});

// T-22: uploadDocument / recordConsent / consentNeeded.
describe('uploadDocument', () => {
  afterEach(() => jest.restoreAllMocks());

  const document: DocumentSummary = {
    id: 'doc-1',
    fileName: 'فاتورة.pdf',
    mime: 'application/pdf',
    sizeBytes: 1024,
    kind: 'pdf_text',
    pageCount: 2,
    textChars: 500,
    createdAt: '2026-10-04T00:00:00.000Z',
  };

  it('returns the document on a 201 (created)', async () => {
    mockFetch(jest.fn(async () => fakeResponse(201, { document })));

    const result = await uploadDocument(new File(['x'], 'فاتورة.pdf'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.document).toEqual(document);
      expect(result.deduplicated).toBe(false);
    }
  });

  it('returns deduplicated: true on a 200 (existing document)', async () => {
    mockFetch(jest.fn(async () => fakeResponse(200, { document, deduplicated: true })));

    const result = await uploadDocument(new File(['x'], 'فاتورة.pdf'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.deduplicated).toBe(true);
  });

  it('maps 422 to kind "refused" carrying the server messageAr', async () => {
    mockFetch(
      jest.fn(async () =>
        fakeResponse(422, { error: 'refused_confidential', messageAr: t('intake.refused_confidential') }),
      ),
    );

    const result = await uploadDocument(new File(['x'], 'عقد-سري.pdf'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('refused');
      expect(result.messageAr).toBe(t('intake.refused_confidential'));
    }
  });

  it('maps 413 to kind "too_large", falling back to ar.ts when the server sends no messageAr', async () => {
    mockFetch(jest.fn(async () => fakeResponse(413, { error: 'too_large' })));

    const result = await uploadDocument(new File(['x'], 'big.pdf'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('too_large');
      expect(result.messageAr).toBe(t('document.error.too_large'));
    }
  });

  it('maps 415 to kind "unsupported" using the server message', async () => {
    const serverMessage = 'صيغة غير مدعومة';
    mockFetch(jest.fn(async () => fakeResponse(415, { error: 'unsupported_type', messageAr: serverMessage })));

    const result = await uploadDocument(new File(['x'], 'file.exe'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('unsupported');
      expect(result.messageAr).toBe(serverMessage);
    }
  });

  it('maps 401 to kind "unauthenticated"', async () => {
    mockFetch(jest.fn(async () => fakeResponse(401, { error: 'unauthenticated' })));

    const result = await uploadDocument(new File(['x'], 'file.pdf'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('unauthenticated');
  });

  it('maps 503 to kind "npi_down" using the server message', async () => {
    mockFetch(jest.fn(async () => fakeResponse(503, { error: 'npi_down', messageAr: 'NPI متعطل' })));

    const result = await uploadDocument(new File(['x'], 'file.pdf'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('npi_down');
      expect(result.messageAr).toBe('NPI متعطل');
    }
  });

  it('treats a malformed 200 body as kind "server"', async () => {
    mockFetch(jest.fn(async () => fakeResponse(200, { nope: true })));

    const result = await uploadDocument(new File(['x'], 'file.pdf'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('server');
      expect(result.messageAr).toBe(t('chat.error.generic'));
    }
  });

  it('reports a network failure as kind "network"', async () => {
    mockFetch(jest.fn(async () => { throw new TypeError('fetch failed'); }));

    const result = await uploadDocument(new File(['x'], 'file.pdf'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('network');
  });

  it('sends a multipart POST with field "file" and no explicit Content-Type header', async () => {
    const fetchImpl = jest.fn(async (_url: string, _init?: RequestInit) => fakeResponse(201, { document }));
    mockFetch(fetchImpl);

    const file = new File(['content'], 'فاتورة.pdf', { type: 'application/pdf' });
    await uploadDocument(file);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/copilot/api/documents');
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('same-origin');
    // No explicit Content-Type: the browser must set the multipart boundary itself.
    expect((init?.headers as Record<string, string> | undefined)?.['Content-Type']).toBeUndefined();
    expect(init?.body).toBeInstanceOf(FormData);
    const form = init?.body as FormData;
    expect(form.get('file')).toBe(file);
  });
});

describe('recordConsent', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns the consentEventId on a normal 200', async () => {
    mockFetch(
      jest.fn(async () =>
        fakeResponse(200, { consentEventId: 'ce-1', documentId: 'doc-1', decision: 'approved', policyLine: '…' }),
      ),
    );

    const result = await recordConsent('doc-1', 'approved');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.consentEventId).toBe('ce-1');
  });

  it('maps 404 to kind "refused" with the server messageAr', async () => {
    const serverMessage = t('document.error.not_found');
    mockFetch(jest.fn(async () => fakeResponse(404, { error: 'not_found', messageAr: serverMessage })));

    const result = await recordConsent('missing-doc', 'approved');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('refused');
      expect(result.messageAr).toBe(serverMessage);
    }
  });

  it('maps 409 to kind "refused" with the server messageAr', async () => {
    const serverMessage = t('document.error.consent_not_needed');
    mockFetch(jest.fn(async () => fakeResponse(409, { error: 'consent_not_needed', messageAr: serverMessage })));

    const result = await recordConsent('doc-1', 'approved');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('refused');
      expect(result.messageAr).toBe(serverMessage);
    }
  });

  it('maps 422 to kind "refused" with the server messageAr', async () => {
    const serverMessage = t('intake.refused_confidential');
    mockFetch(jest.fn(async () => fakeResponse(422, { error: 'refused_confidential', messageAr: serverMessage })));

    const result = await recordConsent('doc-1', 'approved');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('refused');
      expect(result.messageAr).toBe(serverMessage);
    }
  });

  it('maps 401 to kind "unauthenticated"', async () => {
    mockFetch(jest.fn(async () => fakeResponse(401, { error: 'unauthenticated' })));

    const result = await recordConsent('doc-1', 'cancelled');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('unauthenticated');
  });

  it('maps 500 to kind "server" using the server message', async () => {
    const serverMessage = 'خطأ في الخادم';
    mockFetch(jest.fn(async () => fakeResponse(500, { error: 'server', messageAr: serverMessage })));

    const result = await recordConsent('doc-1', 'approved');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('server');
      expect(result.messageAr).toBe(serverMessage);
    }
  });

  it('reports a network failure as kind "network"', async () => {
    mockFetch(jest.fn(async () => { throw new TypeError('fetch failed'); }));

    const result = await recordConsent('doc-1', 'approved');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('network');
  });

  it('sends a JSON POST with documentId and decision', async () => {
    const fetchImpl = jest.fn(async (_url: string, _init?: RequestInit) =>
      fakeResponse(200, { consentEventId: 'ce-1', documentId: 'doc-1', decision: 'approved', policyLine: '…' }),
    );
    mockFetch(fetchImpl);

    await recordConsent('doc-1', 'approved');

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/copilot/api/documents/consent');
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('same-origin');
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init?.body as string)).toEqual({ documentId: 'doc-1', decision: 'approved' });
  });
});

describe('consentNeeded', () => {
  it('is true for image and pdf_scanned', () => {
    expect(consentNeeded('image')).toBe(true);
    expect(consentNeeded('pdf_scanned')).toBe(true);
  });

  it('is false for pdf_text', () => {
    expect(consentNeeded('pdf_text')).toBe(false);
  });
});
