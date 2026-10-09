// T-28 (Madar copilot, M3) — static invariants. spec/madar/05 §M3 T-28, 06 AT-07.
//
// What this file proves, without a database, a network or a model: the copilot
// cannot reach NPI's database, holds no admin or service credential, sends every
// NPI call as the logged-in user through one choke point, and contains no
// approve / decide / delete call. It only reads files (`fs`) and fails with the
// file and line of every hit.
//
// Scope: apps/copilot/{src,scripts,e2e,tests,prisma}, recursively, files
// *.ts *.tsx *.mjs *.cjs *.js *.prisma, minus src/generated, node_modules, .next,
// test-results and data.
//
// Rules of the file (spec/madar/08 §E.9):
//  - An allowlist is an explicit constant with a reason per entry. A hit that is
//    not on an allowlist is a finding to report, never something to allowlist to
//    make the test green.
//  - This file names the forbidden strings it looks for, so the two scans that
//    search for those literal names (test 2 and the JWT part of test 3) skip this
//    file; every other scan includes it.

import * as fs from 'node:fs';
import * as path from 'node:path';

const APP_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..', '..');
const SELF = path.resolve(__filename);

const SCAN_DIRS = ['src', 'scripts', 'e2e', 'tests', 'prisma'];
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.cjs', '.js', '.prisma']);
const SKIP_DIR_NAMES = new Set(['node_modules', '.next', 'test-results', 'data']);
const GENERATED_DIR = path.join(APP_ROOT, 'src', 'generated');

// ─── helpers ────────────────────────────────────────────────────────────────

function walk(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      if (full === GENERATED_DIR) continue;
      out.push(...walk(full));
    } else if (entry.isFile() && SCAN_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out.sort();
}

function rel(file: string): string {
  return path.relative(APP_ROOT, file).split(path.sep).join('/');
}

const contentCache = new Map<string, string>();
function read(file: string): string {
  let text = contentCache.get(file);
  if (text === undefined) {
    text = fs.readFileSync(file, 'utf8');
    contentCache.set(file, text);
  }
  return text;
}

interface HitLine {
  line: number;
  text: string;
}

/** Every line of `file` the regex matches (1-based). The regex is cloned without
 *  the `g`/`y` flags, so a global regex never carries `lastIndex` between lines. */
function linesMatching(file: string, regex: RegExp): HitLine[] {
  const probe = new RegExp(regex.source, regex.flags.replace(/[gy]/g, ''));
  const hits: HitLine[] = [];
  read(file)
    .split(/\r?\n/)
    .forEach((text, index) => {
      if (probe.test(text)) hits.push({ line: index + 1, text });
    });
  return hits;
}

function at(file: string, line: number): string {
  return `${rel(file)}:${line}`;
}

const ALL_FILES = SCAN_DIRS.flatMap((d) => walk(path.join(APP_ROOT, d)));
const SRC_FILES = ALL_FILES.filter((f) => rel(f).startsWith('src/'));
const NON_SELF_FILES = ALL_FILES.filter((f) => f !== SELF);

const NPI_CLIENT = path.join(APP_ROOT, 'src', 'npi', 'client.ts');
const EXECUTE_RUN = path.join(APP_ROOT, 'src', 'execute', 'run.ts');
const AGENT_CONTEXT = path.join(APP_ROOT, 'src', 'agents', 'context.ts');
const LLM_CLIENT = path.join(APP_ROOT, 'src', 'llm', 'client.ts');
const PROVIDERS_DIR = path.join(APP_ROOT, 'src', 'llm', 'providers');

describe('invariants: the scan itself', () => {
  it('finds the tree it is meant to scan (a vacuous scan would pass everything)', () => {
    expect(ALL_FILES.length).toBeGreaterThan(100);
    expect(SRC_FILES.length).toBeGreaterThan(50);
    expect(ALL_FILES).toContain(NPI_CLIENT);
    expect(ALL_FILES).toContain(SELF);
    expect(ALL_FILES.some((f) => rel(f).startsWith('src/generated/'))).toBe(false);
    expect(ALL_FILES.some((f) => f.split(path.sep).includes('node_modules'))).toBe(false);
  });
});

// ─── 1. Prisma client ───────────────────────────────────────────────────────

describe('invariant 1: the only Prisma client is the copilot\'s own generated one', () => {
  const SPECIFIER_RE =
    /from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/g;

  function specifiersOf(file: string): Array<{ line: number; spec: string }> {
    const found: Array<{ line: number; spec: string }> = [];
    read(file)
      .split(/\r?\n/)
      .forEach((text, index) => {
        for (const m of text.matchAll(SPECIFIER_RE)) {
          found.push({ line: index + 1, spec: m[1] ?? m[2] ?? m[3] });
        }
      });
    return found;
  }

  /** True when a relative (or `@/`) specifier lands on src/generated/prisma. */
  function resolvesToGeneratedClient(file: string, spec: string): boolean {
    let target: string | null = null;
    if (spec.startsWith('.')) target = path.resolve(path.dirname(file), spec);
    else if (spec.startsWith('@/')) target = path.join(APP_ROOT, 'src', spec.slice(2));
    if (target === null) return false;
    const generated = path.join(APP_ROOT, 'src', 'generated', 'prisma');
    return target === generated || target.startsWith(generated + path.sep);
  }

  it('every import/require/dynamic import mentioning prisma resolves to src/generated/prisma; nothing reaches @prisma/client, @npi/db or packages/db', () => {
    const violations: string[] = [];
    let prismaSpecifiers = 0;
    for (const file of ALL_FILES) {
      for (const { line, spec } of specifiersOf(file)) {
        const where = at(file, line);
        if (spec === '@prisma/client' || spec.startsWith('@prisma/')) {
          violations.push(`${where}  imports "${spec}" (bare Prisma package; the client is src/generated/prisma)`);
          continue;
        }
        if (spec.includes('packages/db') || spec.includes('@npi/db')) {
          violations.push(`${where}  imports "${spec}" (NPI's database package)`);
          continue;
        }
        if (/prisma/i.test(spec)) {
          prismaSpecifiers += 1;
          if (!resolvesToGeneratedClient(file, spec)) {
            violations.push(`${where}  imports "${spec}", which does not resolve to src/generated/prisma`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
    // Guard against a regex that silently stopped matching.
    expect(prismaSpecifiers).toBeGreaterThan(5);
  });

  it('prisma/schema.prisma: one datasource on COPILOT_DATABASE_URL, generator output ../src/generated/prisma', () => {
    const schema = read(path.join(APP_ROOT, 'prisma', 'schema.prisma'));

    const datasources = [...schema.matchAll(/^\s*datasource\s+\w+\s*\{([^}]*)\}/gm)];
    expect(datasources).toHaveLength(1);
    const datasourceBody = datasources[0][1];
    expect(datasourceBody).toMatch(/^\s*url\s*=\s*env\("COPILOT_DATABASE_URL"\)\s*$/m);
    // No second connection (directUrl, shadowDatabaseUrl, ...) hiding in the block.
    expect([...datasourceBody.matchAll(/env\("([^"]+)"\)/g)].map((m) => m[1])).toEqual([
      'COPILOT_DATABASE_URL',
    ]);

    const generators = [...schema.matchAll(/^\s*generator\s+\w+\s*\{([^}]*)\}/gm)];
    expect(generators.length).toBeGreaterThanOrEqual(1);
    for (const g of generators) {
      expect(g[1]).toMatch(/^\s*output\s*=\s*"\.\.\/src\/generated\/prisma"\s*$/m);
    }
  });

  it('apps/copilot/package.json depends on no @npi/db (and nothing from packages/db)', () => {
    const pkg = JSON.parse(read(path.join(APP_ROOT, 'package.json'))) as Record<string, unknown>;
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const deps = (pkg[field] ?? {}) as Record<string, string>;
      expect(Object.keys(deps)).not.toContain('@npi/db');
      for (const [name, version] of Object.entries(deps)) {
        expect(`${field}: ${name}@${version}`).not.toMatch(/packages\/db|@npi\/db/);
      }
    }
  });
});

// ─── 2. No NPI database URL ─────────────────────────────────────────────────

describe('invariant 2: no NPI database URL anywhere', () => {
  /** Files that may contain an NPI connection string, with the reason. */
  const NPI_DB_URL_ALLOWED_FILES: Record<string, string> = {
    'tests/db-guard.spec.ts':
      'feeds NPI\'s own database URL to the copilot\'s guard (assertCopilotDatabaseUrl) to prove it is rejected',
  };

  it('every DATABASE_URL is part of COPILOT_DATABASE_URL', () => {
    const violations: string[] = [];
    for (const file of NON_SELF_FILES) {
      for (const { line, text } of linesMatching(file, /DATABASE_URL/)) {
        for (const m of text.matchAll(/DATABASE_URL/g)) {
          const start = m.index ?? 0;
          if (text.slice(Math.max(0, start - 'COPILOT_'.length), start) !== 'COPILOT_') {
            violations.push(`${at(file, line)}  ${text.trim()}`);
            break;
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('no postgres connection URL names npi_erp (NPI\'s database)', () => {
    const violations: string[] = [];
    for (const file of NON_SELF_FILES) {
      if (rel(file) in NPI_DB_URL_ALLOWED_FILES) continue;
      for (const { line, text } of linesMatching(file, /postgres(?:ql)?:\/\/[^\s'"`]*\/npi_erp/)) {
        violations.push(`${at(file, line)}  ${text.trim()}`);
      }
    }
    expect(violations).toEqual([]);

    // The allowlist cannot go stale: its file must still contain such a URL.
    for (const allowed of Object.keys(NPI_DB_URL_ALLOWED_FILES)) {
      const file = path.join(APP_ROOT, allowed);
      expect(linesMatching(file, /postgres(?:ql)?:\/\/[^\s'"`]*\/npi_erp/).length).toBeGreaterThan(0);
    }
  });

  it('.env.example declares no DATABASE_URL, no JWT_SECRET and no admin/service credential', () => {
    const text = read(path.join(APP_ROOT, '.env.example'));
    const keys = [...text.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)=/gm)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(5);
    expect(keys).toContain('COPILOT_DATABASE_URL');
    expect(keys).not.toContain('DATABASE_URL');
    expect(keys).not.toContain('JWT_SECRET');
    const credentialLike = keys.filter((k) => /(ADMIN|SERVICE).*(TOKEN|KEY|SECRET)|_TOKEN$/.test(k));
    expect(credentialLike).toEqual([]);
  });
});

// ─── 3. No admin/service token, no NPI secret ───────────────────────────────

describe('invariant 3: the environment the copilot reads is an exact, justified set', () => {
  /**
   * Every environment variable name read anywhere in scope (src, scripts, e2e,
   * tests), found by regex over the tree. The set must equal this map exactly:
   * a new name fails the test until someone justifies it here.
   */
  const ALLOWED_ENV: Record<string, string> = {
    ANTHROPIC_API_KEY: 'the model provider key (src/llm/providers/anthropic.ts); the copilot\'s own, not an NPI credential',
    COPILOT_CATALOG_DIR: 'override for the onboarding catalogue directory (src/onboarding/catalog.ts; tests point it at fixtures)',
    COPILOT_DAILY_TOKEN_CAP: 'the daily model-token budget (src/llm/client.ts) — a count of LLM tokens, not a credential',
    COPILOT_DATABASE_URL: 'the copilot\'s own database (src/db.ts, guarded to npi_copilot); tests/helpers/load-env.ts fills it for Jest',
    COPILOT_DOCS_DIR: 'where uploaded documents are stored (docsRoot(env) in src/intake/upload.ts; tests/intake.spec.ts overrides it)',
    COPILOT_E2E_API_PORT: 'port of the e2e run\'s NPI api, used by e2e fixtures to log in (e2e/*)',
    COPILOT_LIVE: 'switches on the @live e2e (e2e/setup-live.spec.ts); real-model runs only',
    COPILOT_MODEL_ADVANCED: 'model id for the advanced tier (modelIdForTier in src/llm/client.ts)',
    COPILOT_MODEL_ECONOMY: 'model id for the economy tier (modelIdForTier in src/llm/client.ts)',
    COPILOT_PORT: 'the port `next dev/start` listens on (scripts/run-next.mjs)',
    COPILOT_PROMPTS_DIR: 'override for the prompts directory (src/prompts/load.ts; tests point it at the real prompts)',
    COPILOT_SESSION_KEY: 'the AEAD key that encrypts the stored NPI token at rest (src/auth/session.ts, src/agents/context.ts, src/app/api/auth/route.ts) — the copilot\'s own secret, not an NPI one',
    MADAR_PROVIDER: 'provider selector in src/llm/client.ts; only "anthropic" is accepted (see invariant 6)',
    NEXT_PUBLIC_NPI_WEB_URL: 'public base URL of NPI\'s web app, for links only (src/npi/web-url.ts)',
    NODE_ENV: 'standard Node/Next mode flag (src/auth/cookie.ts, src/npi/web-url.ts)',
    NPI_API_BASE: 'NPI\'s HTTP API base URL — an address, not a credential (src/npi/client.ts; scripts/gen-npi-types.mjs)',
  };

  /** Names allowed to match CREDENTIAL_LIKE although they are not credentials. */
  const CREDENTIAL_LIKE_EXCEPTIONS: Record<string, string> = {
    COPILOT_DAILY_TOKEN_CAP: 'a budget of LLM tokens, not an auth token',
  };

  const CREDENTIAL_LIKE = /JWT|SECRET|ADMIN|SERVICE|_TOKEN/;

  // A read of the process environment by name, whether through the global object
  // or through a parameter holding it (docsRoot(env), createLlmClient({ env })).
  const ENV_NAME_RE = /(?:^|[^\w$])env\.([A-Z][A-Z0-9_]*)/g;

  function collectEnvNames(): Map<string, string[]> {
    const found = new Map<string, string[]>();
    for (const file of ALL_FILES) {
      read(file)
        .split(/\r?\n/)
        .forEach((text, index) => {
          for (const m of text.matchAll(ENV_NAME_RE)) {
            const list = found.get(m[1]) ?? [];
            list.push(at(file, index + 1));
            found.set(m[1], list);
          }
        });
    }
    return found;
  }

  it('the set of environment names read equals the allowlist exactly', () => {
    const found = collectEnvNames();
    const names = [...found.keys()].sort();
    const unexpected = names
      .filter((n) => !(n in ALLOWED_ENV))
      .map((n) => `${n}  first seen at ${found.get(n)![0]}`);
    const missing = Object.keys(ALLOWED_ENV)
      .filter((n) => !found.has(n))
      .sort();
    expect({ unexpected, missing }).toEqual({ unexpected: [], missing: [] });
    expect(names).toEqual(Object.keys(ALLOWED_ENV).sort());
  });

  it('the environment is only ever read by a plain, greppable name', () => {
    const violations: string[] = [];
    for (const file of ALL_FILES) {
      for (const { line, text } of linesMatching(file, /(?:^|[^\w$])env\s*\[/)) {
        violations.push(`${at(file, line)}  bracket access hides the name: ${text.trim()}`);
      }
      for (const { line, text } of linesMatching(file, /\{[^}]*\}\s*=\s*(?:process\.)?env\b/)) {
        violations.push(`${at(file, line)}  destructuring hides the names: ${text.trim()}`);
      }
      for (const { line, text } of linesMatching(file, /process\.env\.(?![A-Z])/)) {
        violations.push(`${at(file, line)}  non-uppercase name: ${text.trim()}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('no name read looks like a JWT, secret, admin or service credential', () => {
    const found = collectEnvNames();
    const offenders = [...found.keys()]
      .filter((n) => CREDENTIAL_LIKE.test(n) && !(n in CREDENTIAL_LIKE_EXCEPTIONS))
      .map((n) => `${n}  at ${found.get(n)![0]}`);
    expect(offenders).toEqual([]);
    // The exception list cannot go stale either.
    for (const name of Object.keys(CREDENTIAL_LIKE_EXCEPTIONS)) {
      expect(found.has(name)).toBe(true);
    }
  });

  it('JWT_SECRET appears nowhere in scope', () => {
    const violations: string[] = [];
    for (const file of NON_SELF_FILES) {
      for (const { line, text } of linesMatching(file, /JWT_SECRET/)) {
        violations.push(`${at(file, line)}  ${text.trim()}`);
      }
    }
    expect(violations).toEqual([]);
  });
});

// ─── 4. Every NPI call carries the session JWT through the choke point ──────

describe('invariant 4: every NPI call goes through src/npi/client.ts with the user\'s own token', () => {
  /** createNpiClient call sites allowed to pass an empty token, with the reason. */
  const EMPTY_TOKEN_ALLOWED: Record<string, { argText: string; reason: string }> = {
    'src/app/api/auth/route.ts': {
      argText: "{ token: '' }",
      reason: 'the login client: the user has no token yet; it is only used for npi.login(), the one call that sends no Authorization header',
    },
  };

  const srcOutsideClient = SRC_FILES.filter((f) => f !== NPI_CLIENT);

  it('(a) the string "Authorization" appears in src only in src/npi/client.ts, once, behind the skipAuth guard', () => {
    const violations: string[] = [];
    for (const file of srcOutsideClient) {
      for (const { line, text } of linesMatching(file, /authorization/i)) {
        violations.push(`${at(file, line)}  ${text.trim()}`);
      }
    }
    expect(violations).toEqual([]);

    const inClient = linesMatching(NPI_CLIENT, /authorization/i);
    expect(inClient.map((h) => h.text.trim())).toEqual([
      'if (!opts.skipAuth) headers.Authorization = `Bearer ${ctx.token}`;',
    ]);

    // The one unauthenticated call is the login itself.
    const skip = linesMatching(NPI_CLIENT, /skipAuth\s*:\s*true/);
    expect(skip).toHaveLength(1);
    expect(skip[0].text).toContain("'/auth/login'");
    for (const file of srcOutsideClient) {
      expect(linesMatching(file, /skipAuth/).map((h) => at(file, h.line))).toEqual([]);
    }
  });

  it('(b) NPI_API_BASE appears in src only in src/npi/client.ts', () => {
    const violations: string[] = [];
    for (const file of srcOutsideClient) {
      for (const { line, text } of linesMatching(file, /NPI_API_BASE/)) {
        violations.push(`${at(file, line)}  ${text.trim()}`);
      }
    }
    expect(violations).toEqual([]);
    expect(linesMatching(NPI_CLIENT, /NPI_API_BASE/).length).toBeGreaterThan(0);
  });

  /** The text between the parentheses of the call that opens at `openIndex`. */
  function balancedArgument(text: string, openIndex: number): string {
    let depth = 0;
    for (let i = openIndex; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) return text.slice(openIndex + 1, i);
      }
    }
    throw new Error('unbalanced parentheses after createNpiClient(');
  }

  const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

  it('(c) every createNpiClient( call site passes the user\'s token, never an environment value or a literal', () => {
    const violations: string[] = [];
    const seenEmpty: string[] = [];
    let callSites = 0;

    for (const file of SRC_FILES) {
      const text = read(file);
      const lines = text.split(/\r?\n/);
      for (const m of text.matchAll(/createNpiClient\s*\(/g)) {
        const start = m.index ?? 0;
        const lineNo = text.slice(0, start).split(/\r?\n/).length;
        if (COMMENT_LINE.test(lines[lineNo - 1])) continue;
        if (/function\s+$/.test(text.slice(0, start))) continue; // the definition
        callSites += 1;

        const where = at(file, lineNo);
        const arg = balancedArgument(text, start + m[0].length - 1).replace(/\s+/g, ' ').trim();

        if (/\btoken\s*:\s*(?:process\.env|['"`][^'"`]+['"`])/.test(arg)) {
          violations.push(`${where}  token taken from the environment or a literal: createNpiClient(${arg})`);
          continue;
        }
        if (/\btoken\s*:\s*(['"`])\1/.test(arg)) {
          const allowed = EMPTY_TOKEN_ALLOWED[rel(file)];
          if (allowed && allowed.argText === arg) {
            seenEmpty.push(rel(file));
            continue;
          }
          violations.push(`${where}  empty token outside the allowlist: createNpiClient(${arg})`);
          continue;
        }
        if (!/\btoken\b\s*(?::|,|\}|$)/.test(arg)) {
          violations.push(`${where}  no token passed: createNpiClient(${arg})`);
        }
      }
    }

    expect(violations).toEqual([]);
    expect(callSites).toBeGreaterThanOrEqual(8); // guard against a regex that stopped matching
    // The allowlist cannot go stale: its call site must still exist.
    expect(seenEmpty.sort()).toEqual(Object.keys(EMPTY_TOKEN_ALLOWED).sort());
  });
});

// ─── 5. No approval / decision / delete call anywhere in src ────────────────

describe('invariant 5: the copilot has no approve, decide or delete call', () => {
  /** Generated OpenAPI types legitimately list every path NPI has. */
  const GENERATED_TYPES = path.join(APP_ROOT, 'src', 'npi', 'types.ts');

  const FORBIDDEN_LITERALS = [
    "'/decide'",
    "/decide'",
    "/approve'",
    '/approve`',
    "/reject'",
    "/match'",
    "/send'",
    "/inspect'",
    "/accept'",
    "/activate'",
    "method: 'DELETE'",
    "'DELETE'",
    '"DELETE"',
    "'APPROVE'",
    "'REJECT'",
    "'RETURN'",
    "/users'",
    '/password',
  ];

  it('none of the forbidden endpoint / verb literals appears in any src .ts/.tsx file', () => {
    const files = SRC_FILES.filter(
      (f) => (f.endsWith('.ts') || f.endsWith('.tsx')) && f !== GENERATED_TYPES,
    );
    expect(files.length).toBeGreaterThan(50);

    const violations: string[] = [];
    for (const file of files) {
      read(file)
        .split(/\r?\n/)
        .forEach((text, index) => {
          const matched = FORBIDDEN_LITERALS.filter((lit) => text.includes(lit));
          if (matched.length > 0) {
            violations.push(`${at(file, index + 1)}  [${matched.join(' ')}]  ${text.trim()}`);
          }
        });
    }
    expect(violations).toEqual([]);
  });

  function clientMethodNames(): string[] {
    const text = read(NPI_CLIENT);
    const start = text.indexOf('export function createNpiClient');
    expect(start).toBeGreaterThan(-1);
    const returnAt = text.indexOf('return {', start);
    expect(returnAt).toBeGreaterThan(start);
    const end = text.indexOf('\n  };\n}', returnAt);
    expect(end).toBeGreaterThan(returnAt);
    const body = text.slice(returnAt, end);
    return [...body.matchAll(/^\s{4}(\w+)\(/gm)].map((m) => m[1]);
  }

  it('src/npi/client.ts exposes no method named for approving, deciding, rejecting, deleting, matching, sending, inspecting, accepting, passwords or activation', () => {
    const names = clientMethodNames();
    expect(names).toEqual(expect.arrayContaining(['login', 'me', 'createRequisition', 'submitRequisition']));
    expect(names.length).toBeGreaterThan(20);
    const offenders = names.filter((n) =>
      /approve|decide|reject|delete|match|send|inspect|accept|password|activate/i.test(n),
    );
    expect(offenders).toEqual([]);
  });

  it('src/npi/client.ts can only submit a requisition: the sole workflow action code in the file is SUBMIT', () => {
    const codes = [...read(NPI_CLIENT).matchAll(/\baction\s*:\s*'([A-Za-z_]+)'/g)].map((m) => m[1]);
    expect(codes).toEqual(['SUBMIT']);
  });

  it('src/execute/run.ts: ExecutionNpi is exactly the eleven creation/submission/read methods', () => {
    const text = read(EXECUTE_RUN);
    const m = text.match(/export type ExecutionNpi\s*=\s*Pick<\s*NpiClient,([\s\S]*?)>;/);
    expect(m).not.toBeNull();
    const members = [...m![1].matchAll(/\|\s*'(\w+)'/g)].map((x) => x[1]).sort();
    expect(members).toEqual(
      [
        'createCustomer',
        'createContract',
        'createRequisition',
        'submitRequisition',
        'createVendor',
        'createPurchaseOrder',
        'getRequisition',
        'convertRequisition',
        'receiveOnPurchaseOrder',
        'createBill',
        'attachFile',
      ].sort(),
    );
  });
});

// ─── 6. Provider ────────────────────────────────────────────────────────────

describe('invariant 6: one model provider, Anthropic', () => {
  it('src/agents/context.ts constructs createAnthropicProvider()', () => {
    expect(linesMatching(AGENT_CONTEXT, /createAnthropicProvider\(\s*\)/).length).toBeGreaterThan(0);
  });

  it('src/llm/providers/ holds anthropic.ts and nothing else', () => {
    expect(fs.readdirSync(PROVIDERS_DIR).sort()).toEqual(['anthropic.ts']);
  });

  it('MADAR_PROVIDER is read only in src/llm/client.ts, defaults to anthropic, and anything else is refused', () => {
    // Reads outside tests: tests/llm.spec.ts feeds "openai" on purpose to prove the refusal.
    const readers = ALL_FILES.filter((f) => !rel(f).startsWith('tests/') && linesMatching(f, /MADAR_PROVIDER/).length > 0).map(rel);
    expect(readers).toEqual(['src/llm/client.ts']);

    const text = read(LLM_CLIENT);
    const readLine = linesMatching(LLM_CLIENT, /env\.MADAR_PROVIDER\?\.trim\(\)/);
    expect(readLine).toHaveLength(1);
    expect(readLine[0].text).toContain("|| 'anthropic'");

    // Every literal the provider value is compared with is 'anthropic'.
    const compared = [...text.matchAll(/\bprovider\s*[!=]==\s*['"]([^'"]*)['"]/g)].map((m) => m[1]);
    expect(compared.length).toBeGreaterThan(0);
    expect(new Set(compared)).toEqual(new Set(['anthropic']));
    expect(text).toMatch(/if \(provider !== 'anthropic'\) \{\s*throw new LlmError\('not_configured'/);
  });

  it('.env.example sets MADAR_PROVIDER to anthropic', () => {
    const text = read(path.join(APP_ROOT, '.env.example'));
    const m = text.match(/^MADAR_PROVIDER=([^\s#]*)/m);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('anthropic');
  });
});

// ─── 7. Deploy does not hand the copilot NPI's secrets ──────────────────────

describe('invariant 7: docker-compose.prod.yml gives the copilot none of NPI\'s secrets', () => {
  const COMPOSE = path.join(REPO_ROOT, 'docker-compose.prod.yml');

  /** The lines of the top-level `services:` section. */
  function servicesSection(lines: string[]): string[] {
    const start = lines.findIndex((l) => /^services:\s*$/.test(l));
    if (start === -1) return [];
    const section: string[] = [];
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^\S/.test(lines[i])) break; // next top-level key
      section.push(lines[i]);
    }
    return section;
  }

  it('the copilot service, if there is one, has no DATABASE_URL and no JWT_SECRET in its environment', () => {
    const lines = fs.readFileSync(COMPOSE, 'utf8').split(/\r?\n/);
    const services = servicesSection(lines);
    expect(services.length).toBeGreaterThan(0);

    const start = services.findIndex((l) => /^ {2}copilot:\s*$/.test(l));
    const hasCopilotService = start !== -1;

    // T-40 (2026-10-09) added the service; this assertion was flipped from
    // `false` then, as its original comment asked, so the file was revisited.
    expect(hasCopilotService).toBe(true);

    if (hasCopilotService) {
      const block: string[] = [];
      for (let i = start + 1; i < services.length; i += 1) {
        if (/^ {2}\S/.test(services[i])) break; // next service
        block.push(services[i]);
      }
      // No `env_file:` either — in development the process sees NPI's secrets
      // through the shared root .env (Known limits); the deployed service must
      // name every variable it gets, so a shared file can never hand them over.
      expect(block.filter((l) => /^ {4}env_file:/.test(l))).toEqual([]);
      const envAt = block.findIndex((l) => /^ {4}environment:/.test(l));
      const envBlock: string[] = [];
      if (envAt !== -1) {
        for (let i = envAt + 1; i < block.length; i += 1) {
          if (/^ {4}\S/.test(block[i])) break; // next key at 4-space indent
          envBlock.push(block[i]);
        }
      }
      const offenders = envBlock.filter(
        (l) => /(?<!COPILOT_)DATABASE_URL\b/.test(l) || /JWT_SECRET\b/.test(l),
      );
      expect(offenders).toEqual([]);
    }
  });
});
