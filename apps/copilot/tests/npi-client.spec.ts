import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createNpiClient } from '../src/npi/client';
import { NpiError, mapNpiError } from '../src/npi/errors';
import { readEntityRef, readMe } from '../src/npi/responses';

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

describe('client.ts guard — approvals and deletes must never appear', () => {
  it('contains none of the forbidden action/endpoint markers', () => {
    const src = readFileSync(path.join(__dirname, '..', 'src', 'npi', 'client.ts'), 'utf8');
    const forbidden = ["/decide", "/approve", "'APPROVE'", "'REJECT'", "'RETURN'", "method: 'DELETE'"];
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
      roleKey: 'PROCUREMENT_OFFICER',
      permissions: ['procurement.read', 'procurement.write'],
      organizationId: 'org-1',
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
});
