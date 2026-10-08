#!/usr/bin/env node
/**
 * NPI Solar ERP — API invariant suite.
 *
 * Non-destructive by design: every check is either a read, or a write the
 * server is expected to REJECT. Nothing here creates or mutates a record, so
 * it is safe to run against a dataset someone is about to demo.
 *
 * Node 18+ (uses global fetch). No dependencies — deliberately, so it runs
 * from a bare checkout and sidesteps the Windows argv encoding that corrupts
 * Arabic in inline `curl -d` arguments.
 *
 *   node .claude/skills/npi-erp-testing/scripts/api-smoke.mjs [--base URL] [--skip-throttle]
 */

const args = process.argv.slice(2);
const BASE = valueOf('--base') ?? 'http://localhost:4000/api';
const SKIP_THROTTLE = args.includes('--skip-throttle');

function valueOf(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

// ── seeded accounts ────────────────────────────────────────────────────────
const ACCOUNTS = [
  { key: 'admin', email: 'admin@npi.sa', password: 'Admin@123' },
  { key: 'sales', email: 'sales@npi.sa', password: 'Sales@123' },
  { key: 'accountant', email: 'accountant@npi.sa', password: 'Acc@12345' },
  { key: 'pm', email: 'pm@npi.sa', password: 'Pm@123456' },
  { key: 'engineer', email: 'engineer@npi.sa', password: 'Eng@12345' },
];

/**
 * Read routes and the permission each one declares on the server.
 *
 * Expectations are NOT hardcoded per role. For each role we read its own
 * permission list from /auth/me and predict 200-or-403 from that. This asserts
 * the guard wiring still matches the declaration, and it keeps passing when
 * the seed's permission sets change — which they do, every time a package
 * adds a screen.
 */
const GUARDED_ROUTES = [
  ['/leads', 'crm.lead.read'],
  ['/customers', 'crm.customer.read'],
  ['/opportunities', 'crm.opportunity.read'],
  ['/tasks', 'crm.customer.read'],
  ['/tasks/summary', 'crm.customer.read'],
  ['/tasks/assignees', 'crm.customer.write'],
  ['/reference/dashboard', 'crm.lead.read'],
  ['/proposals', 'commercial.proposal.read'],
  ['/contracts', 'commercial.contract.read'],
  ['/items', 'commercial.item.read'],
  ['/finance/invoices', 'finance.invoice.read'],
  ['/finance/summary', 'finance.invoice.read'],
  ['/finance/reports/trial-balance', 'finance.ledger.read'],
  ['/finance/reports/income-statement', 'finance.ledger.read'],
  ['/finance/reports/balance-sheet', 'finance.ledger.read'],
  ['/finance/reports/vat-return', 'finance.ledger.read'],
  ['/finance/payables/outstanding', 'finance.payment.read'],
  ['/projects', 'projects.project.read'],
  ['/procurement/vendors', 'scm.procurement.read'],
  ['/procurement/purchase-orders', 'scm.procurement.read'],
  ['/procurement/serial-units', 'assets.serialunit.read'],
  ['/fsm/work-orders', 'fsm.workorder.read'],
  ['/fsm/work-orders/summary', 'fsm.workorder.read'],
  ['/telemetry/dashboard', 'fsm.workorder.read'],
  ['/admin/users', 'admin.user.manage'],
  ['/admin/roles', 'admin.user.manage'],
  ['/admin/audit', 'admin.audit.read'],
];

// ── tiny harness ───────────────────────────────────────────────────────────
const results = [];
let currentGroup = '';

function group(name) {
  currentGroup = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

function record(ok, label, detail) {
  results.push({ group: currentGroup, ok, label, detail });
  const mark = ok ? '\x1b[32m  PASS\x1b[0m' : '\x1b[31m  FAIL\x1b[0m';
  console.log(`${mark}  ${label}`);
  if (!ok && detail) console.log(`        \x1b[90m${detail}\x1b[0m`);
}

/** Assert, but never let one thrown check abort the run. */
async function check(label, fn) {
  try {
    const out = await fn();
    if (out === true || out === undefined) return record(true, label);
    record(false, label, typeof out === 'string' ? out : JSON.stringify(out));
  } catch (e) {
    record(false, label, e?.message ?? String(e));
  }
}

async function call(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let payload = null;
  const text = await res.text();
  if (text) { try { payload = JSON.parse(text); } catch { payload = text; } }
  return { status: res.status, body: payload };
}

const num = (v) => Number(v ?? 0);
const near = (a, b, tol = 0.01) => Math.abs(num(a) - num(b)) < tol;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * `/auth/login` is throttled to 5 per minute per IP (bcrypt makes it a
 * credential-stuffing target). This suite needs exactly five logins for the
 * five seeded roles, which is the entire budget — so every later check that
 * touches the login endpoint has to wait the window out or it reads a 429 as
 * a product failure. `loginWindowOpensAt` tracks when that is safe again.
 */
let firstLoginAt = 0;
const LOGIN_WINDOW_MS = 61_000;

async function waitForLoginWindow(why) {
  if (!firstLoginAt) return;
  const remaining = firstLoginAt + LOGIN_WINDOW_MS - Date.now();
  if (remaining <= 0) return;
  console.log(`\x1b[90m        waiting ${Math.ceil(remaining / 1000)}s for the login rate-limit window to reset (${why})…\x1b[0m`);
  await sleep(remaining);
  firstLoginAt = 0;
}

/** Log in, waiting out the limiter once if a previous session already ate the budget. */
async function login(email, password) {
  let r = await call('/auth/login', { method: 'POST', body: { email, password } });
  if (r.status === 429) {
    console.log('\x1b[90m        login limiter already engaged (a browser session, or a previous run) — waiting it out once…\x1b[0m');
    await sleep(LOGIN_WINDOW_MS);
    firstLoginAt = 0;
    r = await call('/auth/login', { method: 'POST', body: { email, password } });
  }
  if (!firstLoginAt) firstLoginAt = Date.now();
  return r;
}

// ── the run ────────────────────────────────────────────────────────────────
const tokens = {};
const perms = {};

async function main() {
  console.log(`\x1b[1mNPI Solar ERP — API invariants\x1b[0m  →  ${BASE}`);

  // A. Reachability ────────────────────────────────────────────────────────
  group('A. Reachability');
  let reachable = false;
  await check('GET /health reports ok + database up', async () => {
    const r = await call('/health');
    reachable = r.status === 200;
    if (r.status !== 200) return `status ${r.status}`;
    if (r.body?.db !== 'up') return `db is "${r.body?.db}", expected "up"`;
    return true;
  });
  if (!reachable) {
    console.log('\n\x1b[31mAPI unreachable — nothing else can be tested. Is `npm run dev:api` running?\x1b[0m');
    return finish();
  }

  // B. Auth ────────────────────────────────────────────────────────────────
  group('B. Authentication & seeded roles');
  for (const acct of ACCOUNTS) {
    await check(`${acct.key} logs in and /auth/me returns permissions`, async () => {
      const res = await login(acct.email, acct.password);
      if (res.status !== 201 && res.status !== 200) return `login status ${res.status}: ${JSON.stringify(res.body)}`;
      const token = res.body?.accessToken;
      if (!token) return 'no accessToken in response';
      tokens[acct.key] = token;
      const me = await call('/auth/me', { token });
      if (me.status !== 200) return `/auth/me status ${me.status}`;
      const list = me.body?.permissions ?? me.body?.role?.permissions;
      if (!Array.isArray(list) || list.length === 0) return 'no permission list on /auth/me';
      perms[acct.key] = list;
      return true;
    });
  }

  // C. Permission enforcement ──────────────────────────────────────────────
  group('C. Permission enforcement (expectations derived per role from /auth/me)');
  for (const acct of ACCOUNTS) {
    const token = tokens[acct.key];
    const held = perms[acct.key];
    if (!token || !held) { record(false, `${acct.key}: skipped, no session`); continue; }

    const mismatches = [];
    for (const [path, perm] of GUARDED_ROUTES) {
      const shouldPass = held.includes(perm);
      const r = await call(path, { token });
      const allowed = r.status !== 403;
      if (allowed !== shouldPass) {
        mismatches.push(`${path} (needs ${perm}) → ${r.status}, expected ${shouldPass ? 'not 403' : '403'}`);
      }
    }
    await check(
      `${acct.key}: all ${GUARDED_ROUTES.length} guarded routes match its own permission list`,
      async () => (mismatches.length === 0 ? true : mismatches.join(' | ')),
    );
  }

  const admin = tokens.admin;
  if (!admin) {
    console.log('\n\x1b[31mNo admin session — skipping accounting, ZATCA and guard checks.\x1b[0m');
    return finish();
  }

  // D. Accounting invariants ───────────────────────────────────────────────
  group('D. Accounting invariants');

  await check('trial balance reports isBalanced and debits equal credits', async () => {
    const r = await call('/finance/reports/trial-balance', { token: admin });
    if (r.status !== 200) return `status ${r.status}`;
    const tb = r.body;
    if (tb?.isBalanced !== true) return `isBalanced=${tb?.isBalanced}`;
    const d = num(tb?.totals?.debit ?? tb?.totalDebit);
    const c = num(tb?.totals?.credit ?? tb?.totalCredit);
    if (!near(d, c)) return `debit ${d} != credit ${c}`;
    return true;
  });

  await check('balance sheet balances (assets = liabilities + equity)', async () => {
    const r = await call('/finance/reports/balance-sheet', { token: admin });
    if (r.status !== 200) return `status ${r.status}`;
    if (r.body?.isBalanced !== true) {
      const t = r.body?.totals ?? {};
      return `isBalanced=${r.body?.isBalanced} (assets ${t.assets}, liabilities ${t.liabilities}, equity ${t.equity})`;
    }
    return true;
  });

  await check('every journal entry balances individually', async () => {
    const r = await call('/finance/journal?take=500', { token: admin });
    if (r.status !== 200) return `status ${r.status}`;
    const entries = Array.isArray(r.body) ? r.body : (r.body?.rows ?? []);
    if (entries.length === 0) return 'no journal entries found — dataset empty?';
    const bad = [];
    for (const e of entries) {
      const lines = e.lines ?? [];
      if (lines.length === 0) continue;
      const d = lines.reduce((s, l) => s + num(l.debit), 0);
      const c = lines.reduce((s, l) => s + num(l.credit), 0);
      if (!near(d, c)) bad.push(`${e.code ?? e.id}: Dr ${d.toFixed(2)} / Cr ${c.toFixed(2)}`);
    }
    return bad.length === 0 ? true : `${bad.length} unbalanced of ${entries.length}: ${bad.slice(0, 4).join(', ')}`;
  });

  await check('income statement responds with a period', async () => {
    const r = await call('/finance/reports/income-statement', { token: admin });
    return r.status === 200 ? true : `status ${r.status}: ${JSON.stringify(r.body)}`;
  });

  // E. ZATCA hash chain ────────────────────────────────────────────────────
  group('E. ZATCA e-invoice chain');
  await check('PIH chain links: each document points at its predecessor', async () => {
    const list = await call('/finance/invoices', { token: admin });
    if (list.status !== 200) return `invoice list status ${list.status}`;
    const rows = Array.isArray(list.body) ? list.body : (list.body?.rows ?? []);
    const docs = [];
    for (const inv of rows) {
      const full = await call(`/finance/invoices/${inv.id}`, { token: admin });
      const e = full.body?.eInvoice;
      if (e?.invoiceHash) docs.push({ code: full.body.code, submittedAt: e.submittedAt, hash: e.invoiceHash, pih: e.previousInvoiceHash });
    }
    if (docs.length === 0) return 'no signed e-invoices in this dataset — chain not exercised';
    docs.sort((a, b) => new Date(a.submittedAt) - new Date(b.submittedAt));
    const breaks = [];
    for (let i = 1; i < docs.length; i++) {
      if (docs[i].pih !== docs[i - 1].hash) {
        breaks.push(`${docs[i].code}: PIH ${String(docs[i].pih).slice(0, 12)}… != ${docs[i - 1].code} hash ${String(docs[i - 1].hash).slice(0, 12)}…`);
      }
    }
    return breaks.length === 0 ? true : `${breaks.length} break(s) across ${docs.length} documents: ${breaks.join(' | ')}`;
  });

  // F. Business-rule guards (rejections — nothing is written) ───────────────
  group('F. Business-rule guards (server must refuse; nothing is written)');

  await check('illegal project stage transition is refused with 400', async () => {
    const list = await call('/projects', { token: admin });
    const rows = Array.isArray(list.body) ? list.body : (list.body?.rows ?? []);
    const p = rows[0];
    if (!p) return 'no project in dataset — guard not exercised';
    // CLOSED is never one step forward from anything but COMMISSIONING, and the
    // rule allows exactly one step. Pick a stage that cannot be legal.
    const illegal = p.stage === 'CLOSED' ? 'PLANNING' : 'CLOSED';
    const r = await call(`/projects/${p.id}/stage`, { token: admin, method: 'POST', body: { stage: illegal } });
    if (r.status === 400) return true;
    if (r.status === 201 || r.status === 200) return `ACCEPTED an illegal ${p.stage}→${illegal} transition — the lifecycle guard is not enforcing`;
    return `status ${r.status}, expected 400`;
  });

  await check('unknown record id returns 404, not 500', async () => {
    const r = await call('/projects/cxxxxxxxxxxxxxxxxxxxxxxxx', { token: admin });
    return r.status === 404 ? true : `status ${r.status}, expected 404`;
  });

  await check('reversed report date range is refused with 400', async () => {
    const r = await call('/finance/reports/trial-balance?from=2026-12-31&to=2026-01-01', { token: admin });
    return r.status === 400 ? true : `status ${r.status}, expected 400`;
  });

  await check('vendor payment over the outstanding balance is refused', async () => {
    const out = await call('/finance/payables/outstanding', { token: admin });
    const rows = Array.isArray(out.body) ? out.body : (out.body?.rows ?? []);
    const target = rows.find((r) => num(r.outstanding) > 0);
    if (!target) return 'no outstanding payable — guard not exercised';
    const r = await call('/finance/payables/payments', {
      token: admin, method: 'POST',
      body: {
        vendorId: target.vendorId,
        amount: num(target.outstanding) * 1000 + 1_000_000,
        method: 'BANK_TRANSFER',
        allocations: [{ documentType: target.kind, documentId: target.id, amount: num(target.outstanding) * 1000 + 1_000_000 }],
      },
    });
    if (r.status === 400) return true;
    if (r.status === 201) return 'ACCEPTED an over-allocated payment — this writes a bad journal';
    // 404/422 also mean "refused"; only a 2xx is a real failure here.
    return r.status < 300 ? `status ${r.status} (accepted)` : true;
  });

  // G. Security ────────────────────────────────────────────────────────────
  group('G. Security');

  await check('unauthenticated request is refused with 401', async () => {
    const r = await call('/finance/reports/trial-balance');
    return r.status === 401 ? true : `status ${r.status}, expected 401`;
  });

  // The five role logins above used the whole 5/min budget. Wait it out rather
  // than reading the resulting 429 as "the password check is broken".
  await waitForLoginWindow('the wrong-password check needs a real 401, not a 429');

  await check('wrong password does not authenticate', async () => {
    const r = await call('/auth/login', { method: 'POST', body: { email: 'admin@npi.sa', password: 'WrongPassword@9' } });
    if (!firstLoginAt) firstLoginAt = Date.now();
    if (r.status === 401) return true;
    if (r.status < 300) return 'AUTHENTICATED with a wrong password';
    return `status ${r.status}, expected 401`;
  });

  if (SKIP_THROTTLE) {
    record(true, 'login rate limiter — skipped via --skip-throttle');
  } else {
    await check('sixth login attempt in a minute is throttled with 429', async () => {
      let last = 0;
      for (let i = 0; i < 8; i++) {
        const r = await call('/auth/login', { method: 'POST', body: { email: 'nobody@npi.sa', password: 'Whatever@123' } });
        last = r.status;
        if (r.status === 429) return true;
      }
      return `never throttled after 8 attempts (last status ${last}) — brute-force limiter is not engaging`;
    });
    console.log('\x1b[90m        note: the login limiter is now tripped for ~1 minute.\x1b[0m');
  }

  finish();
}

function finish() {
  const failed = results.filter((r) => !r.ok);
  const total = results.length;
  console.log('\n' + '─'.repeat(66));
  if (failed.length === 0) {
    console.log(`\x1b[32m\x1b[1mAll ${total} checks passed.\x1b[0m`);
  } else {
    console.log(`\x1b[31m\x1b[1m${failed.length} of ${total} checks failed:\x1b[0m`);
    for (const f of failed) console.log(`  \x1b[31m•\x1b[0m [${f.group}] ${f.label}\n    ${f.detail ?? ''}`);
  }
  console.log('─'.repeat(66));
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\x1b[31mSuite crashed:\x1b[0m', e);
  process.exit(2);
});
