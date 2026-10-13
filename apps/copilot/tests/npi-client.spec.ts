import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createNpiClient } from '../src/npi/client';
import { NpiError, mapNpiError } from '../src/npi/errors';
import { readEntityRef, readMe, readRequisitionLines } from '../src/npi/responses';

/** A minimal stand-in for the DOM `Response` the client actually reads
 *  (`.ok`, `.status`, `.text()`). */
function fakeResponse(status: number, body?: unknown): Response {
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  } as Response;
}

describe('mapNpiError — status-code mapping and Arabic messages', () => {
  const cases: Array<{
    status: number;
    kind:
      | 'unauthorized'
      | 'forbidden'
      | 'not_found'
      | 'conflict'
      | 'validation'
      | 'server'
      | 'unexpected';
    ar: string;
  }> = [
    { status: 401, kind: 'unauthorized', ar: 'انتهت جلستك في NPI. سجّل الدخول من جديد.' },
    { status: 403, kind: 'forbidden', ar: 'NPI رفض: ليست لك صلاحية تنفيذ هذا الإجراء.' },
    { status: 404, kind: 'not_found', ar: 'NPI رفض: السجل غير موجود أو لا يخص منشأتك.' },
    { status: 409, kind: 'conflict', ar: 'NPI رفض: تعارض مع حالة السجل الحالية.' },
    { status: 422, kind: 'validation', ar: 'NPI رفض: البيانات غير مقبولة.' },
    { status: 400, kind: 'validation', ar: 'NPI رفض: البيانات غير مقبولة.' },
    { status: 500, kind: 'server', ar: 'تعذر إتمام الطلب في NPI حالياً.' },
    { status: 503, kind: 'server', ar: 'تعذر إتمام الطلب في NPI حالياً.' },
    { status: 418, kind: 'unexpected', ar: 'استجابة غير متوقعة من NPI.' },
  ];

  it.each(cases)('status $status -> kind $kind with the exact Arabic message', ({ status, kind, ar }) => {
    const err = mapNpiError(status, { statusCode: status, message: 'irrelevant for this check' });
    expect(err.kind).toBe(kind);
    expect(err.messageAr.startsWith(ar)).toBe(true);
  });

  it.each(['forbidden', 'not_found', 'conflict', 'validation'] as const)(
    'appends NPI\'s own message verbatim for kind=%s',
    (kind) => {
      const statusByKind = { forbidden: 403, not_found: 404, conflict: 409, validation: 400 } as const;
      const err = mapNpiError(statusByKind[kind], {
        statusCode: statusByKind[kind],
        message: 'Vendor bill is already billed',
      });
      expect(err.npiMessage).toBe('Vendor bill is already billed');
      expect(err.messageAr.endsWith('(NPI: Vendor bill is already billed)')).toBe(true);
    },
  );

  it('does not append anything when NPI supplied no message', () => {
    const err = mapNpiError(404, {});
    expect(err.npiMessage).toBeNull();
    expect(err.messageAr).toBe('NPI رفض: السجل غير موجود أو لا يخص منشأتك.');
  });

  it('joins a class-validator style message array', () => {
    const err = mapNpiError(400, { statusCode: 400, message: ['email must be an email', 'password too short'] });
    expect(err.npiMessage).toBe('email must be an email; password too short');
  });

  it('handles a body that could not be parsed as JSON (npiMessage stays null, kind still comes from status)', () => {
    const err = mapNpiError(500, undefined);
    expect(err.kind).toBe('server');
    expect(err.npiMessage).toBeNull();
    expect(err.messageAr).toBe('تعذر إتمام الطلب في NPI حالياً.');
  });
});

describe('createNpiClient — transport behaviour', () => {
  it('sends the Bearer token on an authenticated call and no Authorization header on login', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: (init?.headers as Record<string, string>) ?? {} });
      return fakeResponse(200, { ok: true });
    }) as unknown as typeof fetch;

    const client = createNpiClient({ baseUrl: 'http://api.test/api', token: 'tkn-123', fetchImpl });

    await client.me();
    expect(calls[0].headers.Authorization).toBe('Bearer tkn-123');

    await client.login({ email: 'a@b.com', password: 'secret1' } as never);
    expect(calls[1].headers.Authorization).toBeUndefined();
  });

  it('submitRequisition sends exactly { action: "SUBMIT" } to /requisitions/{id}/actions, and includes comment when given', async () => {
    const bodies: unknown[] = [];
    const urls: string[] = [];
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      urls.push(url);
      bodies.push(init?.body ? JSON.parse(init.body as string) : undefined);
      return fakeResponse(201, { id: 'wf-1' });
    }) as unknown as typeof fetch;

    const client = createNpiClient({ baseUrl: 'http://api.test/api', token: 't', fetchImpl });

    await client.submitRequisition('req-1');
    expect(urls[0]).toBe('http://api.test/api/requisitions/req-1/actions');
    expect(bodies[0]).toEqual({ action: 'SUBMIT' });

    await client.submitRequisition('req-2', 'ready to send');
    expect(bodies[1]).toEqual({ action: 'SUBMIT', comment: 'ready to send' });
  });

  it('maps a non-2xx JSON error body to the matching NpiError', async () => {
    const fetchImpl = jest.fn(async () => fakeResponse(409, { statusCode: 409, message: 'stale version' }));
    const client = createNpiClient({
      baseUrl: 'http://api.test/api',
      token: 't',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.getPurchaseOrder('po-1')).rejects.toMatchObject({
      kind: 'conflict',
      npiMessage: 'stale version',
    });
  });

  it('times out and never retries (call count stays 1)', async () => {
    const fetchImpl = jest.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    ) as unknown as typeof fetch;

    const client = createNpiClient({
      baseUrl: 'http://api.test/api',
      token: 't',
      fetchImpl,
      timeoutMs: 20,
    });

    await expect(client.listProjects()).rejects.toMatchObject({ kind: 'timeout', status: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports a network failure as kind "network" and never retries', async () => {
    const fetchImpl = jest.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;

    const client = createNpiClient({ baseUrl: 'http://api.test/api', token: 't', fetchImpl });

    await expect(client.listVendors()).rejects.toMatchObject({ kind: 'network', status: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never re-issues a request after any other failure either (call count === 1)', async () => {
    const fetchImpl = jest.fn(async () => fakeResponse(500, { statusCode: 500, message: 'Internal server error' }));
    const client = createNpiClient({
      baseUrl: 'http://api.test/api',
      token: 't',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.listCustomers()).rejects.toMatchObject({ kind: 'server' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('createNpiClient — the writes execution adds (T-27)', () => {
  interface Call {
    url: string;
    init: RequestInit;
  }

  function recording(status = 201, body: unknown = { id: 'x-1', code: 'X-00001' }) {
    const calls: Call[] = [];
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      return fakeResponse(status, body);
    }) as unknown as typeof fetch;
    const client = createNpiClient({ baseUrl: 'http://api.test/api', token: 'tkn-123', fetchImpl });
    return { client, calls, fetchImpl };
  }

  const headersOf = (call: Call) => call.init.headers as Record<string, string>;
  const hasHeader = (call: Call, name: string) => Object.keys(headersOf(call)).some((h) => h.toLowerCase() === name.toLowerCase());

  describe('attachFile — multipart, a contract only', () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

    it('POSTs a multipart form with the file part, the Bearer token and no Content-Type of its own', async () => {
      const { client, calls, fetchImpl } = recording(201, { id: 'att-1', fileName: 'عقد.pdf' });

      const result = await client.attachFile('contract', 'con-1', { fileName: 'عقد.pdf', mime: 'application/pdf', bytes });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(calls[0].url).toBe('http://api.test/api/attachments/contract/con-1');
      expect(calls[0].init.method).toBe('POST');
      expect(headersOf(calls[0]).Authorization).toBe('Bearer tkn-123');
      // `fetch` sets the multipart boundary itself; a JSON content type would break the upload.
      expect(hasHeader(calls[0], 'Content-Type')).toBe(false);

      const body = calls[0].init.body;
      expect(body).toBeInstanceOf(FormData);
      const file = (body as FormData).get('file');
      expect(file).toBeInstanceOf(Blob);
      const part = file as File;
      expect(part.type).toBe('application/pdf');
      expect(part.name).toBe('عقد.pdf');
      expect(new Uint8Array(await part.arrayBuffer())).toEqual(bytes);
      expect([...(body as FormData).keys()]).toEqual(['file']);

      expect(readEntityRef(result)).toEqual({ id: 'att-1', code: null });
    });

    it('escapes the id, and a refusal is an NpiError that is never retried', async () => {
      const fetchImpl = jest.fn(async () => fakeResponse(403, { statusCode: 403, message: 'Insufficient permissions' }));
      const client = createNpiClient({ baseUrl: 'http://api.test/api', token: 't', fetchImpl: fetchImpl as unknown as typeof fetch });

      await expect(client.attachFile('contract', 'a/b', { fileName: 'x.pdf', mime: 'application/pdf', bytes })).rejects.toMatchObject({
        kind: 'forbidden',
        npiMessage: 'Insufficient permissions',
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe('http://api.test/api/attachments/contract/a%2Fb');
    });
  });

  it('createVendor POSTs the vendor as JSON to /procurement/vendors', async () => {
    const { client, calls } = recording(201, { id: 'ven-9', code: 'VEN-00009' });
    const dto = { nameAr: 'شركة الخليج للألواح الشمسية', nameEn: 'Gulf Solar Panels Co.', vatNumber: '311111111111113' };

    const result = await client.createVendor(dto as never);

    expect(calls[0].url).toBe('http://api.test/api/procurement/vendors');
    expect(calls[0].init.method).toBe('POST');
    expect(headersOf(calls[0])['Content-Type']).toBe('application/json');
    expect(headersOf(calls[0]).Authorization).toBe('Bearer tkn-123');
    expect(JSON.parse(calls[0].init.body as string)).toEqual(dto);
    expect(readEntityRef(result)).toEqual({ id: 'ven-9', code: 'VEN-00009' });
  });

  it('getRequisition GETs /requisitions/{id} with no body', async () => {
    const { client, calls } = recording(200, { id: 'req-1', lines: [] });

    await client.getRequisition('req-1');

    expect(calls[0].url).toBe('http://api.test/api/requisitions/req-1');
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.body).toBeUndefined();
    expect(headersOf(calls[0]).Authorization).toBe('Bearer tkn-123');
  });

  it('convertRequisition POSTs the conversion (vendor and prices by requisition line) to /requisitions/{id}/convert', async () => {
    const { client, calls } = recording(201, { id: 'po-9', code: 'PO-00009' });
    const dto = { vendorId: 'ven-1', prices: [{ requisitionLineId: 'prl-1', unitPrice: 320 }] };

    const result = await client.convertRequisition('req-1', dto as never);

    expect(calls[0].url).toBe('http://api.test/api/requisitions/req-1/convert');
    expect(calls[0].init.method).toBe('POST');
    expect(headersOf(calls[0])['Content-Type']).toBe('application/json');
    expect(JSON.parse(calls[0].init.body as string)).toEqual(dto);
    expect(readEntityRef(result)).toEqual({ id: 'po-9', code: 'PO-00009' });
  });

  it('none of the new writes is ever re-sent after a failure', async () => {
    const fetchImpl = jest.fn(async () => fakeResponse(500, { statusCode: 500, message: 'Internal server error' }));
    const client = createNpiClient({ baseUrl: 'http://api.test/api', token: 't', fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.createVendor({ nameAr: 'م', nameEn: 'V' } as never)).rejects.toMatchObject({ kind: 'server' });
    await expect(client.convertRequisition('req-1', { vendorId: 'ven-1' } as never)).rejects.toMatchObject({ kind: 'server' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('createNpiClient — the pick lists intake matches against (ADR-02 §3-3)', () => {
  it.each([
    ['lookupItems', 'http://api.test/api/reference/lookups/items'],
    ['lookupProjects', 'http://api.test/api/reference/lookups/projects'],
  ] as const)('%s GETs %s with the Bearer token and no body, and returns the bare array', async (method, url) => {
    const rows = [{ id: 'x-1', code: 'X-00001', nameAr: 'س' }];
    const fetchImpl = jest.fn(async () => fakeResponse(200, rows));
    const client = createNpiClient({ baseUrl: 'http://api.test/api', token: 'tkn-123', fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await client[method]();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(calledUrl).toBe(url);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tkn-123');
    expect(result).toEqual(rows);
  });

  it.each(['lookupItems', 'lookupProjects'] as const)('%s: a caller with no key of the list gets a forbidden NpiError, never retried', async (method) => {
    const fetchImpl = jest.fn(async () => fakeResponse(403, { statusCode: 403, message: 'Forbidden resource' }));
    const client = createNpiClient({ baseUrl: 'http://api.test/api', token: 't', fetchImpl: fetchImpl as unknown as typeof fetch });

    const error = await client[method]().then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(NpiError);
    expect(error).toMatchObject({ kind: 'forbidden', status: 403 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('client.ts guard — approvals and deletes must never appear', () => {
  it('contains none of the forbidden action/endpoint markers', () => {
    const src = readFileSync(path.join(__dirname, '..', 'src', 'npi', 'client.ts'), 'utf8');
    const forbidden = ["/decide", "/approve", "/match", "/send", "'APPROVE'", "'REJECT'", "'RETURN'", "method: 'DELETE'"];
    for (const marker of forbidden) {
      expect(src.includes(marker)).toBe(false);
    }
  });
});

describe('responses.ts readers', () => {
  it('readMe accepts a realistic /auth/me body', () => {
    const body = {
      id: 'user-1',
      email: 'buyer@npi.sa',
      nameAr: 'مشتري',
      nameEn: 'Buyer',
      locale: 'ar',
      roleKey: 'PROCUREMENT_OFFICER',
      roleNameAr: 'موظف مشتريات',
      roleNameEn: 'Procurement Officer',
      permissions: ['procurement.read', 'procurement.write'],
      organization: { id: 'org-1', nameAr: 'م', nameEn: 'Co', baseCurrency: 'SAR' },
    };
    expect(readMe(body)).toEqual({
      id: 'user-1',
      nameAr: 'مشتري',
      roleKey: 'PROCUREMENT_OFFICER',
      roleNameAr: 'موظف مشتريات',
      permissions: ['procurement.read', 'procurement.write'],
      organizationId: 'org-1',
      orgNameAr: 'م',
    });
  });

  it('readMe rejects a malformed body', () => {
    expect(() => readMe({ id: 'user-1' })).toThrow(NpiError);
    expect(() => readMe(null)).toThrow(NpiError);
    expect(() => readMe({ id: 1, roleKey: 'X', permissions: [], organization: { id: 'o' } })).toThrow(NpiError);
  });

  it('readEntityRef accepts a realistic created-document body', () => {
    expect(readEntityRef({ id: 'cust-1', code: 'CUST-0001', nameAr: 'x' })).toEqual({
      id: 'cust-1',
      code: 'CUST-0001',
    });
  });

  it('readEntityRef tolerates a missing code but rejects a missing/invalid id', () => {
    expect(readEntityRef({ id: 'cust-1' })).toEqual({ id: 'cust-1', code: null });
    expect(() => readEntityRef({ code: 'CUST-0001' })).toThrow(NpiError);
    expect(() => readEntityRef({ id: 42 })).toThrow(NpiError);
  });

  it('readEntityRef reads the created attachment, which has no code', () => {
    expect(readEntityRef({ id: 'att-1', fileName: 'عقد.pdf', mime: 'application/pdf' })).toEqual({ id: 'att-1', code: null });
  });
});

describe('responses.ts — readRequisitionLines (GET /requisitions/{id})', () => {
  // The shape of `get()`: the requisition row with `lines` included in full (item and WBS selects as well), then the workflow.
  const body = {
    id: 'req-12',
    code: 'PR-00012',
    status: 'APPROVED',
    justification: 'استكمال أعمال التركيب في المشروع',
    lines: [
      { id: 'prl-1', requisitionId: 'req-12', itemId: 'itm-550', qty: '40', estimatedUnitPrice: '320', item: { id: 'itm-550', sku: 'MOD-550', nameAr: 'لوح شمسي 550 واط' }, wbsElement: null },
      { id: 'prl-2', requisitionId: 'req-12', itemId: 'itm-inv', qty: '1', estimatedUnitPrice: '6500', item: { id: 'itm-inv', sku: 'INV-50K', nameAr: 'عاكس 50 كيلوواط' }, wbsElement: { id: 'wbs-1', code: 'WBS-01' } },
    ],
    workflow: null,
    pendingApproval: null,
  };

  it('accepts the get() include shape and keeps the line id and the item id', () => {
    expect(readRequisitionLines(body)).toEqual([
      { id: 'prl-1', itemId: 'itm-550' },
      { id: 'prl-2', itemId: 'itm-inv' },
    ]);
  });

  it('a requisition with no lines is an empty list', () => {
    expect(readRequisitionLines({ ...body, lines: [] })).toEqual([]);
  });

  it.each<[string, unknown]>([
    ['a line without itemId', { ...body, lines: [{ id: 'prl-1' }] }],
    ['a line without id', { ...body, lines: [{ itemId: 'itm-550' }] }],
    ['a numeric itemId', { ...body, lines: [{ id: 'prl-1', itemId: 550 }] }],
    ['an empty id', { ...body, lines: [{ id: '', itemId: 'itm-550' }] }],
    ['a line that is not an object', { ...body, lines: ['prl-1'] }],
    ['no lines', { id: 'req-12' }],
    ['lines that are not a list', { ...body, lines: { id: 'prl-1' } }],
    ['a body that is not an object', 'nope'],
    ['null', null],
  ])('rejects %s as an unexpected NPI response', (_name, input) => {
    let caught: unknown = null;
    try {
      readRequisitionLines(input);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NpiError);
    expect((caught as NpiError).kind).toBe('unexpected');
  });
});

describe('createNpiClient — setUserPermissions (D-26, T-48b)', () => {
  const dto = {
    overrides: [
      { permission: 'finance.report.read', effect: 'DENY' as const, reason: 'انتقل إلى قسم آخر' },
      { permission: 'scm.requisition.read', effect: 'GRANT' as const },
    ],
  };

  function recording(status = 200, body: unknown = { roles: [], overrides: [], effective: [] }) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      return fakeResponse(status, body);
    }) as unknown as typeof fetch;
    return { client: createNpiClient({ baseUrl: 'http://api.test/api', token: 'tkn-123', fetchImpl }), calls, fetchImpl };
  }

  it('PUTs the body as given to /admin/users/<id>/permissions with the Bearer token', async () => {
    const { client, calls } = recording();
    await client.setUserPermissions('usr 1/ä', dto);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`http://api.test/api/admin/users/${encodeURIComponent('usr 1/ä')}/permissions`);
    expect(calls[0].init.method).toBe('PUT');
    expect(JSON.parse(calls[0].init.body as string)).toEqual(dto);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tkn-123');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('an empty list is sent as is (it clears the exceptions)', async () => {
    const { client, calls } = recording();
    await client.setUserPermissions('usr-1', { overrides: [] });
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ overrides: [] });
  });

  it('maps a 400 (the last administrator) to a validation NpiError carrying NPI’s message, and never retries', async () => {
    const { client, fetchImpl } = recording(400, { statusCode: 400, message: 'Cannot remove the last active administrator' });
    await expect(client.setUserPermissions('usr-1', dto)).rejects.toMatchObject({
      kind: 'validation',
      status: 400,
      npiMessage: 'Cannot remove the last active administrator',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('maps a 403 to forbidden', async () => {
    const { client } = recording(403, { statusCode: 403, message: 'Insufficient permissions' });
    await expect(client.setUserPermissions('usr-1', dto)).rejects.toMatchObject({ kind: 'forbidden' });
  });
});
