// Unit tests for src/components/chat/api.ts — the browser-side calls to
// /copilot/api/chat. `fetch` is mocked throughout; no network, no server.
import { t } from '../src/i18n/ar';
import { loadConversation, sendMessage, MAX_MESSAGE_LENGTH } from '../src/components/chat/api';

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

    const result = await sendMessage('مرحباً');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.kind).toBe('answer');
      expect(result.badges).toEqual(['أداة']);
      expect(result.memoryNotes[0].factAr).toBe('حقيقة');
    }
  });

  it('maps 401 to kind "unauthenticated"', async () => {
    mockFetch(jest.fn(async () => fakeResponse(401, { error: 'unauthenticated' })));
    const result = await sendMessage('نص');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('unauthenticated');
  });

  it('maps 413 to kind "too_long" using the server message', async () => {
    mockFetch(jest.fn(async () => fakeResponse(413, { error: 'too_long', messageAr: 'طويلة جداً' })));
    const result = await sendMessage('x'.repeat(MAX_MESSAGE_LENGTH + 1));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('too_long');
      expect(result.messageAr).toBe('طويلة جداً');
    }
  });

  it('falls back to ar.ts for 413 when the server sent no messageAr', async () => {
    mockFetch(jest.fn(async () => fakeResponse(413, { error: 'too_long' })));
    const result = await sendMessage('x');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.messageAr).toBe(t('chat.error.too_long'));
  });

  it('maps 500 to kind "server" using the server message', async () => {
    mockFetch(jest.fn(async () => fakeResponse(500, { error: 'server', messageAr: 'خطأ في الخادم' })));
    const result = await sendMessage('نص');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('server');
      expect(result.messageAr).toBe('خطأ في الخادم');
    }
  });

  it('maps 503 to kind "npi_down" using the server message', async () => {
    mockFetch(jest.fn(async () => fakeResponse(503, { error: 'npi_down', messageAr: 'NPI متعطل' })));
    const result = await sendMessage('نص');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('npi_down');
      expect(result.messageAr).toBe('NPI متعطل');
    }
  });

  it('treats a malformed 200 body as kind "server"', async () => {
    mockFetch(jest.fn(async () => fakeResponse(200, { nope: true })));
    const result = await sendMessage('نص');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('server');
  });

  it('treats a 404 (conversation not found) as kind "server" (no dedicated UI kind)', async () => {
    mockFetch(jest.fn(async () => fakeResponse(404, { error: 'not_found' })));
    const result = await sendMessage('نص', 'missing-conv');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('server');
  });

  it('reports a network failure as kind "network"', async () => {
    mockFetch(jest.fn(async () => { throw new TypeError('fetch failed'); }));
    const result = await sendMessage('نص');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('network');
  });

  it('sends a POST with the right path, headers and body when no conversationId is given', async () => {
    const fetchImpl = jest.fn(async (_url: string, _init?: RequestInit) =>
      fakeResponse(200, { conversationId: 'c1', messageId: 'm1', kind: 'answer', textAr: 'ok', badges: [], memoryNotes: [] }),
    );
    mockFetch(fetchImpl);

    await sendMessage('مرحباً');

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

    await sendMessage('مرحباً', 'c1');

    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(init?.body as string)).toEqual({ text: 'مرحباً', conversationId: 'c1' });
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
