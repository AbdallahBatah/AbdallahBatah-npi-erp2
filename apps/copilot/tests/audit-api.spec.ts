// Unit tests for src/components/trust/api.ts — the browser-side calls to
// /copilot/api/audit (T-33). `fetch` is mocked throughout; no network, no
// server.
import { t } from '../src/i18n/ar';
import { auditQueryString, loadAudit, loadAuditRow } from '../src/components/trust/api';
import type { AuditDetailView, AuditListView, AuditRowView } from '../src/audit/types';

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

function row(over: Partial<AuditRowView> = {}): AuditRowView {
  return {
    id: 'a1',
    ts: '2026-10-07T08:00:00.000Z',
    npiUserId: 'u1',
    userNameAr: 'سعد',
    event: 'extract_po',
    eventLabelAr: 'استخراج أمر شراء',
    kind: 'model',
    modelTier: 'economy',
    modelId: 'model-economy-1',
    tokensIn: 1200,
    tokensOut: 340,
    costUsdMicro: '48236',
    latencyMs: 2100,
    imageSent: false,
    consent: null,
    document: { id: 'd1', fileName: 'po-1.pdf', kind: 'pdf_text' },
    conversationId: null,
    intakeJobId: 'j1',
    error: null,
    outboundChars: 900,
    ...over,
  };
}

function detail(over: Partial<AuditDetailView> = {}): AuditDetailView {
  return {
    ...row(),
    outbound: {
      kind: 'parsed',
      system: 'You extract purchase orders.',
      messages: [{ role: 'user', content: 'أمر شراء للعميل ⟦عميل_1⟧' }],
      placeholderCount: 1,
    },
    ...over,
  };
}

function view(over: Partial<AuditListView> = {}): AuditListView {
  return {
    rows: [row()],
    nextCursor: null,
    summary: { total: 1, imageSent: 0, imageSentWithoutConsent: 0, errors: 0 },
    users: [{ npiUserId: 'u1', nameAr: 'سعد' }],
    ...over,
  };
}

// ─── auditQueryString ───────────────────────────────────────────────────────

describe('auditQueryString', () => {
  it('defaults to limit=50 with nothing else', () => {
    expect(auditQueryString({ filters: {}, cursor: null })).toBe('limit=50');
  });

  it('honours an explicit limit', () => {
    expect(auditQueryString({ filters: {}, cursor: null, limit: 20 })).toBe('limit=20');
  });

  it('encodes cursor, event, imageSent and userId in the fixed order', () => {
    const qs = auditQueryString({
      filters: { npiUserId: 'u 1', imageSent: true, event: 'extract_po' },
      cursor: '2026-10-07T08:00:00.000Z|a1',
    });
    expect(qs).toBe(
      'limit=50&cursor=2026-10-07T08%3A00%3A00.000Z%7Ca1&event=extract_po&imageSent=true&userId=u+1',
    );
  });

  it('encodes imageSent=false and omits absent filters', () => {
    expect(auditQueryString({ filters: { imageSent: false }, cursor: null })).toBe('limit=50&imageSent=false');
    expect(auditQueryString({ filters: { event: 'chat' }, cursor: null })).toBe('limit=50&event=chat');
  });
});

// ─── loadAudit ──────────────────────────────────────────────────────────────

describe('loadAudit', () => {
  it('returns the parsed view on a valid 200 and calls the endpoint with same-origin credentials', async () => {
    const fetchMock = respondWith(200, view());
    const result = await loadAudit({ filters: { event: 'extract_po' }, cursor: null });
    expect(result).toEqual({ ok: true, view: view() });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/copilot/api/audit?limit=50&event=extract_po');
    expect(init?.credentials).toBe('same-origin');
    expect(init?.method).toBe('GET');
    expect(init?.headers).toEqual({ Accept: 'application/json' });
  });

  it('accepts an image-send row with its consent, a system row and a nextCursor', async () => {
    const body = view({
      rows: [
        row({
          id: 'a2',
          imageSent: true,
          consent: { id: 'c1', decision: 'approved', createdAt: '2026-10-07T07:59:00.000Z' },
          document: { id: 'd2', fileName: 'scan.png', kind: 'image' },
        }),
        row({
          id: 'a3',
          kind: 'system',
          event: 'cap_reached',
          modelTier: null,
          modelId: null,
          tokensIn: 0,
          tokensOut: 0,
          costUsdMicro: '0',
          latencyMs: null,
          document: null,
          outboundChars: 0,
        }),
      ],
      nextCursor: '2026-10-07T07:00:00.000Z|a3',
    });
    respondWith(200, body);
    const result = await loadAudit({ filters: {}, cursor: null });
    expect(result).toEqual({ ok: true, view: body });
  });

  it('passes the cursor on', async () => {
    const fetchMock = respondWith(200, view());
    await loadAudit({ filters: {}, cursor: 'c|1' });
    expect(fetchMock.mock.calls[0][0]).toBe('/copilot/api/audit?limit=50&cursor=c%7C1');
  });

  it('treats a row missing imageSent as a server error', async () => {
    const bad: Record<string, unknown> = { ...row() };
    delete bad.imageSent;
    respondWith(200, { ...view(), rows: [bad] });
    const result = await loadAudit({ filters: {}, cursor: null });
    expect(result).toEqual({ ok: false, kind: 'server', messageAr: t('state.error') });
  });

  it('treats a numeric costUsdMicro as a server error', async () => {
    respondWith(200, { ...view(), rows: [{ ...row(), costUsdMicro: 48236 }] });
    const result = await loadAudit({ filters: {}, cursor: null });
    expect(result).toEqual({ ok: false, kind: 'server', messageAr: t('state.error') });
  });

  it('treats a non-digit costUsdMicro string as a server error', async () => {
    respondWith(200, { ...view(), rows: [{ ...row(), costUsdMicro: '-5' }] });
    const result = await loadAudit({ filters: {}, cursor: null });
    expect(result).toEqual({ ok: false, kind: 'server', messageAr: t('state.error') });
  });

  it('treats a missing summary as a server error', async () => {
    const { summary: _summary, ...rest } = view();
    respondWith(200, rest);
    const result = await loadAudit({ filters: {}, cursor: null });
    expect(result).toEqual({ ok: false, kind: 'server', messageAr: t('state.error') });
  });

  it('maps 401 to unauthenticated', async () => {
    respondWith(401, { error: 'unauthenticated' });
    expect(await loadAudit({ filters: {}, cursor: null })).toEqual({ ok: false, kind: 'unauthenticated' });
  });

  it('maps 403 to forbidden with the body message, and with the fallback', async () => {
    respondWith(403, { error: 'forbidden', messageAr: 'ممنوع' });
    expect(await loadAudit({ filters: {}, cursor: null })).toEqual({ ok: false, kind: 'forbidden', messageAr: 'ممنوع' });
    respondWith(403, { error: 'forbidden' });
    expect(await loadAudit({ filters: {}, cursor: null })).toEqual({
      ok: false,
      kind: 'forbidden',
      messageAr: t('trust.forbidden'),
    });
  });

  it('maps 400 to invalid with the body message, and with the fallback', async () => {
    respondWith(400, { error: 'bad_request', messageAr: 'طلب غير صالح' });
    expect(await loadAudit({ filters: {}, cursor: null })).toEqual({ ok: false, kind: 'invalid', messageAr: 'طلب غير صالح' });
    respondWith(400, { error: 'bad_request' });
    expect(await loadAudit({ filters: {}, cursor: null })).toEqual({
      ok: false,
      kind: 'invalid',
      messageAr: t('state.error'),
    });
  });

  it('maps 502 and 503 to npi with the body message, and with the fallback', async () => {
    respondWith(502, { error: 'npi_unreachable', messageAr: 'NPI لا يستجيب' });
    expect(await loadAudit({ filters: {}, cursor: null })).toEqual({ ok: false, kind: 'npi', messageAr: 'NPI لا يستجيب' });
    respondWith(503, undefined);
    expect(await loadAudit({ filters: {}, cursor: null })).toEqual({
      ok: false,
      kind: 'npi',
      messageAr: t('home.error.npi'),
    });
  });

  it('maps 500 to the generic server error', async () => {
    respondWith(500, { error: 'boom' });
    expect(await loadAudit({ filters: {}, cursor: null })).toEqual({
      ok: false,
      kind: 'server',
      messageAr: t('state.error'),
    });
  });

  it('maps a fetch that throws to the generic server error', async () => {
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => {
      throw new Error('network down');
    });
    expect(await loadAudit({ filters: {}, cursor: null })).toEqual({
      ok: false,
      kind: 'server',
      messageAr: t('state.error'),
    });
  });
});

// ─── loadAuditRow ───────────────────────────────────────────────────────────

describe('loadAuditRow', () => {
  it('returns a parsed outbound that carries a vision block, and asks for the id', async () => {
    const withImage = detail({
      imageSent: true,
      consent: { id: 'c1', decision: 'approved', createdAt: '2026-10-07T07:59:00.000Z' },
      outbound: {
        kind: 'parsed',
        system: 'You read scans.',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'اقرأ هذا المستند' },
              { type: 'image', mediaType: 'image/png', sizeBytes: 20480, consentEventId: 'c1' },
              { type: 'document', mediaType: 'application/pdf', sizeBytes: 1024, consentEventId: 'c1' },
            ],
          },
          { role: 'assistant', content: 'تم' },
        ],
        placeholderCount: 0,
      },
    });
    const fetchMock = respondWith(200, { row: withImage });
    const result = await loadAuditRow('a1');
    expect(result).toEqual({ ok: true, row: withImage });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/copilot/api/audit?id=a1');
    expect(init?.credentials).toBe('same-origin');
  });

  it('returns a raw outbound', async () => {
    const raw = detail({ outbound: { kind: 'raw', text: 'نص قديم غير منظّم', placeholderCount: 0 } });
    respondWith(200, { row: raw });
    expect(await loadAuditRow('a1')).toEqual({ ok: true, row: raw });
  });

  it('returns a null outbound', async () => {
    const none = detail({ outbound: null });
    respondWith(200, { row: none });
    expect(await loadAuditRow('a1')).toEqual({ ok: true, row: none });
  });

  it('treats a message with role system as a server error', async () => {
    const bad = {
      ...detail(),
      outbound: { kind: 'parsed', system: 's', messages: [{ role: 'system', content: 'x' }], placeholderCount: 0 },
    };
    respondWith(200, { row: bad });
    expect(await loadAuditRow('a1')).toEqual({ ok: false, kind: 'server', messageAr: t('state.error') });
  });

  it('treats a 200 without row as a server error', async () => {
    respondWith(200, {});
    expect(await loadAuditRow('a1')).toEqual({ ok: false, kind: 'server', messageAr: t('state.error') });
  });

  it('maps 404 to not_found with the body message, and with the fallback', async () => {
    respondWith(404, { error: 'not_found', messageAr: 'الحدث غير موجود هنا' });
    expect(await loadAuditRow('zz')).toEqual({ ok: false, kind: 'not_found', messageAr: 'الحدث غير موجود هنا' });
    respondWith(404, { error: 'not_found' });
    expect(await loadAuditRow('zz')).toEqual({ ok: false, kind: 'not_found', messageAr: t('trust.not_found') });
  });

  it('encodes the id in the query string', async () => {
    const fetchMock = respondWith(404, { error: 'not_found' });
    await loadAuditRow('a b&c');
    expect(fetchMock.mock.calls[0][0]).toBe('/copilot/api/audit?id=a+b%26c');
  });
});
