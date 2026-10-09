// T-44 (Madar copilot, M5) — security. spec/madar/05 §M5 T-44, 02 §10, 06 §2
// (A01, A03, A05, A08). Four blocks: the CSP and the headers around it, no
// admin or service credential anywhere the copilot is configured, the database
// guard, and uploads typed by their bytes. No database, network or model.
//
// Rules of the file (spec/madar/08 §E.9): the forbidden names below are built
// from parts, so this file does not contain the literals that
// tests/invariants.spec.ts looks for in `tests/`.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { NextRequest } from 'next/server';
import { SESSION_COOKIE_NAME } from '../src/auth/cookie';
import { assertCopilotDatabaseUrl } from '../src/db';
import { detectFileType, MAX_UPLOAD_BYTES, uploadDocument, type DocumentStorage, type IntakeDb } from '../src/intake/upload';
import { middleware } from '../src/middleware';
import { contentSecurityPolicy, generateNonce, securityHeaders } from '../src/security/headers';

const APP_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..', '..');

// ─── 1. CSP and the other headers ───────────────────────────────────────────

describe('security headers: Content-Security-Policy', () => {
  const NONCE = 'AbCdEfGhIjKlMnOpQrStUw==';
  const prod = { nonce: NONCE, isDev: false, isHttps: false };
  const dev = { nonce: NONCE, isDev: true, isHttps: false };

  function directive(policy: string, name: string): string | undefined {
    return policy.split('; ').find((d) => d === name || d.startsWith(`${name} `));
  }

  it('emits exactly the production policy, nonce included', () => {
    expect(contentSecurityPolicy(prod)).toBe(
      [
        "default-src 'self'",
        `script-src 'self' 'nonce-${NONCE}' 'strict-dynamic'`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self'",
        "connect-src 'self'",
        "media-src 'self' blob:",
        "worker-src 'self' blob:",
        "frame-ancestors 'none'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join('; '),
    );
  });

  it('never allows inline or eval scripts in production', () => {
    const scriptSrc = directive(contentSecurityPolicy(prod), 'script-src');
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(contentSecurityPolicy(prod)).not.toContain('ws:');
  });

  it("adds 'unsafe-eval' and the websocket schemes in development only, and still no 'unsafe-inline' for scripts", () => {
    const policy = contentSecurityPolicy(dev);
    const scriptSrc = directive(policy, 'script-src')!;
    expect(scriptSrc).toContain("'unsafe-eval'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(directive(policy, 'connect-src')).toBe("connect-src 'self' ws: wss:");
  });

  it('forbids framing, plugins, a foreign base and a foreign form target', () => {
    const policy = contentSecurityPolicy(prod);
    expect(directive(policy, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive(policy, 'object-src')).toBe("object-src 'none'");
    expect(directive(policy, 'base-uri')).toBe("base-uri 'self'");
    expect(directive(policy, 'form-action')).toBe("form-action 'self'");
    expect(directive(policy, 'default-src')).toBe("default-src 'self'");
  });

  it('carries the other headers, and Strict-Transport-Security only over HTTPS', () => {
    const plain = securityHeaders(prod);
    expect(plain['Content-Security-Policy']).toBe(contentSecurityPolicy(prod));
    expect(plain['X-Content-Type-Options']).toBe('nosniff');
    expect(plain['X-Frame-Options']).toBe('DENY');
    expect(plain['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(plain['Permissions-Policy']).toBe('camera=(self), microphone=(self), geolocation=(), payment=()');
    expect(plain['Cross-Origin-Opener-Policy']).toBe('same-origin');
    expect(plain['Strict-Transport-Security']).toBeUndefined();

    expect(securityHeaders({ ...prod, isHttps: true })['Strict-Transport-Security']).toBe('max-age=31536000');
  });

  it('generates a distinct base64 nonce of 16 bytes each time', () => {
    const nonces = Array.from({ length: 50 }, () => generateNonce());
    expect(new Set(nonces).size).toBe(50);
    for (const nonce of nonces) {
      expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
      expect(Buffer.from(nonce, 'base64')).toHaveLength(16);
    }
  });
});

describe('security headers: the middleware', () => {
  const originalEnv = process.env.NODE_ENV;
  const setNodeEnv = (value: string | undefined) => {
    (process.env as Record<string, string | undefined>).NODE_ENV = value;
  };
  afterEach(() => setNodeEnv(originalEnv));

  // Inside Next the middleware sees the path without the basePath; a bare
  // NextRequest only does when it is told the basePath, as Next tells it.
  const request = (url: string, init: ConstructorParameters<typeof NextRequest>[1] = {}) =>
    new NextRequest(url, { ...init, nextConfig: { basePath: '/copilot' } });

  function expectHeaders(response: Response): string {
    const csp = response.headers.get('content-security-policy');
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/]{22}==' 'strict-dynamic'/);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(response.headers.get('permissions-policy')).toContain('camera=(self)');
    expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    return csp!;
  }

  it('puts the policy on a public page, with a different nonce per request', () => {
    const first = middleware(request('http://localhost:3100/copilot/login'));
    const second = middleware(request('http://localhost:3100/copilot/login'));
    expect(first.status).toBe(200);
    expect(expectHeaders(first)).not.toBe(expectHeaders(second));
    expect(first.headers.get('strict-transport-security')).toBeNull();
  });

  it('hands the same nonce to the page render as a request header', () => {
    const response = middleware(request('http://localhost:3100/copilot/login'));
    const nonce = /'nonce-([^']+)'/.exec(response.headers.get('content-security-policy')!)![1];
    expect(response.headers.get('x-middleware-override-headers')).toEqual(
      expect.stringContaining('x-nonce'),
    );
    expect(response.headers.get('x-middleware-request-x-nonce')).toBe(nonce);
    expect(response.headers.get('x-middleware-request-content-security-policy')).toBe(
      response.headers.get('content-security-policy'),
    );
  });

  it('puts the policy on the 401 of an API call without a session', async () => {
    const response = middleware(request('http://localhost:3100/copilot/api/chat'));
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ error: 'unauthenticated' });
    expectHeaders(response);
  });

  it('puts the policy on the redirect of a page without a session', () => {
    const response = middleware(request('http://localhost:3100/copilot'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/login');
    expectHeaders(response);
  });

  it('passes a request with a cookie through, with the policy', () => {
    const withCookie = request('http://localhost:3100/copilot', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=anything` },
    });
    const response = middleware(withCookie);
    expect(response.status).toBe(200);
    expectHeaders(response);
  });

  it('sets Strict-Transport-Security behind the proxy that says it served HTTPS', () => {
    const response = middleware(
      request('http://localhost:3100/copilot/login', { headers: { 'x-forwarded-proto': 'https' } }),
    );
    expect(response.headers.get('strict-transport-security')).toBe('max-age=31536000');
  });

  it("allows eval only when NODE_ENV is not 'production'", () => {
    setNodeEnv('production');
    const prod = middleware(request('http://localhost:3100/copilot/login'));
    expect(prod.headers.get('content-security-policy')).not.toContain("'unsafe-eval'");
    setNodeEnv('development');
    const dev = middleware(request('http://localhost:3100/copilot/login'));
    expect(dev.headers.get('content-security-policy')).toContain("'unsafe-eval'");
  });
});

// ─── 2. No admin or service token ───────────────────────────────────────────

describe('security: no admin token or service credential', () => {
  // Built from parts so this file does not hold the literal names that
  // tests/invariants.spec.ts looks for in `tests/`.
  const FORBIDDEN_NAMES = ['NPI_ADMIN_TOKEN', 'SERVICE_TOKEN', 'ADMIN_JWT', ['JWT', 'SECRET'].join('_')];
  const FORBIDDEN = new RegExp(FORBIDDEN_NAMES.join('|'));

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'generated' || entry.name === 'node_modules') continue;
        out.push(...walk(full));
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
    return out;
  }

  function hits(file: string, text: string): string[] {
    return text
      .split(/\r?\n/)
      .flatMap((line, i) => (FORBIDDEN.test(line) ? [`${path.relative(REPO_ROOT, file)}:${i + 1}  ${line.trim()}`] : []));
  }

  /** The `copilot:` service of docker-compose.prod.yml: from its key to the next two-space-indented key. */
  function copilotServiceBlock(): string {
    const lines = fs.readFileSync(path.join(REPO_ROOT, 'docker-compose.prod.yml'), 'utf8').split(/\r?\n/);
    const start = lines.findIndex((l) => l === '  copilot:');
    expect(start).toBeGreaterThan(-1);
    const end = lines.findIndex((l, i) => i > start && /^ {2}\S/.test(l));
    return lines.slice(start, end === -1 ? undefined : end).join('\n');
  }

  it('src/ never names an admin, service or JWT-signing credential', () => {
    const files = walk(path.join(APP_ROOT, 'src'));
    expect(files.length).toBeGreaterThan(50);
    expect(files.flatMap((f) => hits(f, fs.readFileSync(f, 'utf8')))).toEqual([]);
  });

  it("the copilot's production service and .env.example do not either", () => {
    const block = copilotServiceBlock();
    expect(block).toContain('COPILOT_SESSION_KEY');
    expect(hits(path.join(REPO_ROOT, 'docker-compose.prod.yml'), block)).toEqual([]);

    const envExample = path.join(APP_ROOT, '.env.example');
    const text = fs.readFileSync(envExample, 'utf8');
    expect(text).toContain('COPILOT_DATABASE_URL');
    expect(hits(envExample, text)).toEqual([]);
  });

  it('the forbidden-name pattern does detect each name (the scan is not vacuous)', () => {
    for (const name of FORBIDDEN_NAMES) expect(FORBIDDEN.test(`X=${name}`)).toBe(true);
  });
});

// ─── 3. Database guard ──────────────────────────────────────────────────────

describe("security: the copilot cannot be pointed at NPI's database", () => {
  const base = 'postgresql://u:p@localhost:5432';

  it.each(['npi_erp', 'npi', 'npi_copilot_x', 'xnpi_copilot'])('rejects %s', (name) => {
    expect(() => assertCopilotDatabaseUrl(`${base}/${name}`)).toThrow();
  });

  it('accepts npi_copilot', () => {
    expect(assertCopilotDatabaseUrl(`${base}/npi_copilot`)).toBe(`${base}/npi_copilot`);
  });
});

// ─── 4. Uploads are typed by their bytes ────────────────────────────────────

describe('security: uploads are validated by magic bytes', () => {
  const bytes = (...values: number[]) => Uint8Array.from(values);
  const text = (s: string) => new TextEncoder().encode(s);
  const PNG_HEAD = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  const caller = { npiOrgId: 'org-1', npiUserId: 'user-1' };

  /** A database that fails the test if an upload reaches it. */
  const untouchedDb = new Proxy(
    {},
    {
      get() {
        throw new Error('the database must not be reached');
      },
    },
  ) as unknown as IntakeDb;

  function fakeStorage() {
    const write = jest.fn(async () => undefined);
    const storage: DocumentStorage = { write, read: async () => null };
    return { storage, write };
  }

  it('refuses an HTML document, an SVG, a Windows executable and a ZIP', () => {
    expect(detectFileType(text('<!DOCTYPE html><html><script>alert(1)</script></html>'))).toBeNull();
    expect(detectFileType(text('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'))).toBeNull();
    expect(detectFileType(bytes(0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00))).toBeNull();
    expect(detectFileType(bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00))).toBeNull();
  });

  it('takes the type from the bytes: PNG bytes are a PNG whatever the file is called', () => {
    expect(detectFileType(PNG_HEAD)).toEqual({ mime: 'image/png', ext: 'png', family: 'image' });
  });

  it('uploadDocument refuses an unknown type before touching storage or the database', async () => {
    const analyzePdf = jest.fn();
    const { storage, write } = fakeStorage();
    const outcome = await uploadDocument({ db: untouchedDb, storage, analyzePdf }, caller, {
      fileName: 'report.pdf',
      bytes: text('<!DOCTYPE html><html></html>'),
    });
    expect(outcome).toEqual({ status: 'refused', reason: 'unsupported_type' });
    expect(analyzePdf).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('uploadDocument stores PNG bytes named invoice.pdf as a PNG and never analyses them as a PDF', async () => {
    const analyzePdf = jest.fn();
    const create = jest.fn(async (args: { data: Record<string, unknown> }) => ({
      ...args.data,
      id: 'd1',
      createdAt: new Date(),
    }));
    const db = { document: { findUnique: jest.fn(async () => null), create } } as unknown as IntakeDb;
    const { storage } = fakeStorage();

    const outcome = await uploadDocument({ db, storage, analyzePdf }, caller, { fileName: 'invoice.pdf', bytes: PNG_HEAD });

    expect(outcome.status).toBe('created');
    expect(analyzePdf).not.toHaveBeenCalled();
    expect(create.mock.calls[0][0].data).toMatchObject({ mime: 'image/png', kind: 'image' });
  });

  it('caps an upload at 10 MiB and refuses one byte more before any analysis', async () => {
    expect(MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
    const analyzePdf = jest.fn();
    const { storage, write } = fakeStorage();
    const overByOne = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    overByOne.set(text('%PDF-1.7\n'));

    const outcome = await uploadDocument({ db: untouchedDb, storage, analyzePdf }, caller, {
      fileName: 'big.pdf',
      bytes: overByOne,
    });

    expect(outcome).toEqual({ status: 'refused', reason: 'too_large' });
    expect(analyzePdf).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});
