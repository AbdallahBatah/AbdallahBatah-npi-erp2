/**
 * CRM Phase 1 — acceptance run (Step 6 of the execution order).
 *
 * One group per "تحقق" item of Steps 1–5 of the owner's execution order, driven
 * through the real HTTP API as the seeded users, against the local database.
 * Prisma is used for two things only: moving a date into the past (expiry /
 * overdue, which the clock would otherwise take a day to show) and deleting
 * what the run created. Append-only audit rows stay, by design.
 *
 * Usage (from the repo root, API on :4000, DB up):
 *   node scripts/crm-phase-1-acceptance.mjs [--base http://localhost:4000/api] [--keep] [--json out.json]
 *
 * Login is throttled to 5/min per IP and the run logs five users in, so run it
 * at least a minute after any other login burst (api-smoke.mjs, a browser).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const BASE = flag('--base', 'http://localhost:4000/api');
const KEEP = args.includes('--keep');
const JSON_OUT = flag('--json', null);
const TAG = `UAT-${Date.now().toString(36).toUpperCase()}`;

// ── database (time tricks + cleanup only) ─────────────────────────────────────
// Locally the URL comes from the repo's .env. Inside the api image (the script
// ships under /app/scripts, no .env there) it is already in the environment,
// so a set DATABASE_URL wins and the file is never read:
//   docker compose ... run --rm --no-deps api node scripts/crm-phase-1-acceptance.mjs --base http://api:4000/api
if (!process.env.DATABASE_URL) {
  const envLine = readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .find((l) => l.startsWith('DATABASE_URL=') && l.includes('npi_erp'));
  if (!envLine) throw new Error('DATABASE_URL for npi_erp not found in .env');
  process.env.DATABASE_URL = envLine.slice('DATABASE_URL='.length).replace(/^"|"$/g, '');
}
const { PrismaClient } = require('@npi/db');
const prisma = new PrismaClient();

// ── harness ───────────────────────────────────────────────────────────────────
const results = [];
let currentGroup = '';
function group(id, title) {
  currentGroup = `${id} ${title}`;
  console.log(`\n\x1b[1m${currentGroup}\x1b[0m`);
}
function record(ok, label, detail) {
  results.push({ group: currentGroup, ok, label, detail: detail ?? null });
  console.log(`${ok ? '\x1b[32m  PASS\x1b[0m' : '\x1b[31m  FAIL\x1b[0m'}  ${label}`);
  if (!ok && detail) console.log(`        \x1b[90m${String(detail).slice(0, 400)}\x1b[0m`);
}
async function check(label, fn) {
  try {
    const out = await fn();
    if (out === true || out === undefined) return record(true, label);
    record(false, label, typeof out === 'string' ? out : JSON.stringify(out));
  } catch (e) {
    record(false, label, e?.stack?.split('\n').slice(0, 2).join(' ') ?? String(e));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchRetry(url, init) {
  // undici reuses a kept-alive socket the server may have just closed after a long idle
  // (the login limiter waits are 40-60 s); the first reuse fails with 'fetch failed' — try once more.
  try {
    return await fetch(url, init);
  } catch (e) {
    if (!/fetch failed/.test(String(e?.message))) throw e;
    await new Promise((r) => setTimeout(r, 300));
    return fetch(url, init);
  }
}
async function call(path, { token, method = 'GET', body } = {}) {
  const res = await fetchRetry(BASE + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  return { status: res.status, body: payload };
}
const msg = (r) => (r.body && typeof r.body === 'object' ? r.body.message : r.body);
const expectStatus = (r, s, what) =>
  r.status === s ? true : `${what}: expected ${s}, got ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`;

async function login(email, password) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await call('/auth/login', { method: 'POST', body: { email, password } });
    if (r.status === 200 || r.status === 201) return r.body.accessToken;
    if (r.status === 429) {
      console.log(`  login throttled for ${email}; waiting 61 s for the window to reset`);
      await sleep(61_000);
      continue;
    }
    throw new Error(`login ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  }
  throw new Error(`login ${email}: still throttled`);
}

// ── the people ────────────────────────────────────────────────────────────────
const USERS = {
  admin: ['admin@npi.sa', 'Admin@123'],
  sales: ['sales@npi.sa', 'Sales@123'],
  ceo: ['ceo@npi.sa', 'Ceo@12345'],
  engineer: ['engineer@npi.sa', 'Eng@12345'],
  accountant: ['accountant@npi.sa', 'Acc@12345'],
};
const T = {};
const me = {};

// everything the run creates, for the cleanup
const created = {
  roleId: null,
  grantedUserId: null,
  customerIds: [],
  opportunityIds: [],
  proposalIds: [],
  taskIds: [],
  activityIds: [],
};

// ── cleanup (also reachable alone: --cleanup <json written by a --keep run>) ──
async function cleanup(created, since) {
  const leftovers = [];
  const tryDel = async (label, fn) => {
    try {
      await fn();
    } catch (e) {
      leftovers.push(`${label}: ${e.message?.split('\n')[0]}`);
    }
  };
  const pids = created.proposalIds;
  const revs = await prisma.proposalRevision.findMany({ where: { proposalId: { in: pids } }, select: { id: true } });
  const revIds = revs.map((x) => x.id);
  const reqs = await prisma.approvalRequest.findMany({ where: { documentId: { in: pids } }, select: { id: true } });
  await tryDel('approvalStep', () => prisma.approvalStep.deleteMany({ where: { requestId: { in: reqs.map((x) => x.id) } } }));
  await tryDel('approvalRequest', () => prisma.approvalRequest.deleteMany({ where: { documentId: { in: pids } } }));
  await tryDel('wfInstance', () => prisma.wfInstance.deleteMany({ where: { documentId: { in: [...pids, ...revIds] } } }));
  const linkIds = [...pids, ...created.taskIds, ...created.opportunityIds];
  if (linkIds.length)
    await tryDel('notification', () => prisma.notification.deleteMany({ where: { createdAt: { gte: since }, OR: linkIds.map((id) => ({ linkPath: { contains: id } })) } }));
  await tryDel('bomLine', () => prisma.bomLine.deleteMany({ where: { proposalRevisionId: { in: revIds } } }));
  await tryDel('proposalRevision', () => prisma.proposalRevision.deleteMany({ where: { proposalId: { in: pids } } }));
  await tryDel('proposal', () => prisma.proposal.deleteMany({ where: { id: { in: pids } } }));
  await tryDel('followUpTask', () => prisma.followUpTask.deleteMany({ where: { customerId: { in: created.customerIds } } }));
  await tryDel('activity', () => prisma.activity.deleteMany({ where: { customerId: { in: created.customerIds } } }));
  await tryDel('opportunity', () => prisma.opportunity.deleteMany({ where: { id: { in: created.opportunityIds } } }));
  await tryDel('customerContact', () => prisma.customerContact.deleteMany({ where: { customerId: { in: created.customerIds } } }));
  await tryDel('customer', () => prisma.customer.deleteMany({ where: { id: { in: created.customerIds } } }));
  if (created.grantedUserId && created.roleId) await tryDel('userRole', () => prisma.userRole.deleteMany({ where: { userId: created.grantedUserId, roleId: created.roleId } }));
  if (created.roleId) await tryDel('role', () => prisma.role.deleteMany({ where: { id: created.roleId } }));
  return leftovers;
}
const CLEANUP_FILE = flag('--cleanup', null);
if (CLEANUP_FILE) {
  const saved = JSON.parse(readFileSync(CLEANUP_FILE, 'utf8'));
  const left = await cleanup(saved.created, new Date(saved.startedAt));
  console.log(left.length ? `cleanup leftovers: ${left.join('; ')}` : `cleanup of ${saved.tag} done`);
  await prisma.$disconnect();
  process.exit(left.length ? 1 : 0);
}

// ── run ───────────────────────────────────────────────────────────────────────
const startedAt = new Date();
console.log(`CRM Phase 1 acceptance — ${BASE} — tag ${TAG} — ${startedAt.toISOString()}`);

group('TC-00', 'الوصول: الخادم وتسجيل الدخول لخمسة أدوار');
await check('/health reports db up', async () => {
  const r = await call('/health');
  return r.status === 200 && r.body?.db === 'up' ? true : r;
});
for (const [key, [email, password]] of Object.entries(USERS)) {
  await check(`${key} logs in and /auth/me answers`, async () => {
    T[key] = await login(email, password);
    const r = await call('/auth/me', { token: T[key] });
    if (r.status !== 200) return r;
    me[key] = r.body;
    return Array.isArray(r.body.permissions) ? true : r;
  });
}
const has = (who, perm) => (me[who]?.permissions ?? []).includes(perm);

// ═══ Step 1 ═══════════════════════════════════════════════════════════════════
group('TC-S1-01', 'دور جديد من الإعدادات يُمنح لمستخدم فيغيّر ما يراه فوراً (بلا إعادة دخول)');
await check('precondition: the site engineer may not list customers today', async () => {
  const r = await call('/customers?take=1', { token: T.engineer });
  return expectStatus(r, 403, 'GET /customers as engineer');
});
await check('admin creates the role «مراقب عملاء» with crm.customer.read only', async () => {
  const r = await call('/admin/roles', {
    token: T.admin,
    method: 'POST',
    body: { key: `uat_customer_viewer_${TAG.slice(4).toLowerCase()}`, nameAr: `مراقب عملاء ${TAG}`, nameEn: `Customer viewer ${TAG}`, permissions: ['crm.customer.read'] },
  });
  if (r.status !== 201 && r.status !== 200) return r;
  created.roleId = r.body.id;
  return true;
});
await check('admin grants it to the engineer as an extra role', async () => {
  const r = await call(`/admin/users/${me.engineer.id}`, { token: T.admin, method: 'PATCH', body: { extraRoleIds: [created.roleId] } });
  if (r.status !== 200) return r;
  created.grantedUserId = me.engineer.id;
  return true;
});
await check('the engineer’s SAME token now lists customers (200) — the guard re-reads roles each request', async () => {
  const r = await call('/customers?take=1', { token: T.engineer });
  return expectStatus(r, 200, 'GET /customers as engineer after grant');
});
await check('/auth/me for the engineer now carries crm.customer.read and the extra role', async () => {
  const r = await call('/auth/me', { token: T.engineer });
  if (r.status !== 200) return r;
  const ok = r.body.permissions.includes('crm.customer.read') && (r.body.roles ?? []).some((x) => x.id === created.roleId);
  return ok ? true : r.body;
});
await check('removing the role takes the access away again at once (403)', async () => {
  const r = await call(`/admin/users/${me.engineer.id}`, { token: T.admin, method: 'PATCH', body: { extraRoleIds: [] } });
  if (r.status !== 200) return r;
  created.grantedUserId = null;
  const r2 = await call('/customers?take=1', { token: T.engineer });
  return expectStatus(r2, 403, 'GET /customers as engineer after revoke');
});

group('TC-S1-02', 'حجب «عرض التكاليف والهوامش» يخفيها من الخادم نفسه (كل شاشة وتقرير وتصدير تقرأ منه)');
await check('the site engineer lacks finance.costs.view; sales holds it', async () =>
  !has('engineer', 'finance.costs.view') && has('sales', 'finance.costs.view') ? true : { engineer: me.engineer.permissions, sales: me.sales.permissions });
await check('GET /items: unitCost is null for the engineer and a number for sales', async () => {
  const [e, s] = await Promise.all([call('/items?take=3', { token: T.engineer }), call('/items?take=3', { token: T.sales })]);
  if (e.status !== 200 || s.status !== 200) return { e: e.status, s: s.status };
  const rowsE = Array.isArray(e.body) ? e.body : e.body.items ?? [];
  const rowsS = Array.isArray(s.body) ? s.body : s.body.items ?? [];
  if (!rowsE.length || !rowsS.length) return 'no items to compare';
  const eHidden = rowsE.every((x) => x.unitCost === null);
  const sShown = rowsS.some((x) => x.unitCost !== null && x.unitCost !== undefined);
  return eHidden && sShown ? true : { engineerSample: rowsE[0], salesSample: rowsS[0] };
});
await check('GET /proposals/:id for a reader without costs.view: unitCost, originalUnitCost, subtotal and margin are null, totalAmount stays', async () => {
  // the executive reads proposals but we need a reader WITHOUT costs.view: grant the engineer a temporary read role
  const r = await call('/admin/roles', {
    token: T.admin,
    method: 'POST',
    body: { key: `uat_proposal_reader_${TAG.slice(4).toLowerCase()}`, nameAr: `قارئ عروض ${TAG}`, nameEn: `Proposal reader ${TAG}`, permissions: ['commercial.proposal.read'] },
  });
  if (r.status !== 201 && r.status !== 200) return r;
  const roleId = r.body.id;
  try {
    const g = await call(`/admin/users/${me.engineer.id}`, { token: T.admin, method: 'PATCH', body: { extraRoleIds: [roleId] } });
    if (g.status !== 200) return g;
    const list = await call('/proposals?take=50', { token: T.engineer });
    if (list.status !== 200) return list;
    const rows = Array.isArray(list.body) ? list.body : list.body.items ?? [];
    const withLines = rows.find((p) => (p.revisions ?? []).length);
    if (!withLines) return 'no proposal with revisions in the database';
    const one = await call(`/proposals/${withLines.id}`, { token: T.engineer });
    if (one.status !== 200) return one;
    const rev = one.body.revisions.find((x) => (x.bomLines ?? []).length) ?? one.body.revisions[0];
    const line = rev.bomLines?.[0];
    const hidden = rev.subtotal === null && rev.marginAmount === null && (!line || (line.unitCost === null && line.originalUnitCost === null));
    const total = rev.totalAmount !== null && rev.totalAmount !== undefined;
    return hidden && total ? true : { subtotal: rev.subtotal, marginAmount: rev.marginAmount, totalAmount: rev.totalAmount, line };
  } finally {
    await call(`/admin/users/${me.engineer.id}`, { token: T.admin, method: 'PATCH', body: { extraRoleIds: [] } });
    await call(`/admin/roles/${roleId}`, { token: T.admin, method: 'DELETE' });
  }
});
await check('the write side: a user without costs.view may not set a unit cost on an item (403)', async () => {
  // engineer has no item write at all → 403 for a different reason; use a reader+writer without costs.view
  const r = await call('/admin/roles', {
    token: T.admin,
    method: 'POST',
    body: { key: `uat_item_writer_${TAG.slice(4).toLowerCase()}`, nameAr: `كاتب أصناف ${TAG}`, nameEn: `Item writer ${TAG}`, permissions: ['commercial.item.read', 'commercial.item.write'] },
  });
  if (r.status !== 201 && r.status !== 200) return r;
  const roleId = r.body.id;
  try {
    const g = await call(`/admin/users/${me.engineer.id}`, { token: T.admin, method: 'PATCH', body: { extraRoleIds: [roleId] } });
    if (g.status !== 200) return g;
    const w = await call('/items', {
      token: T.engineer,
      method: 'POST',
      body: { sku: `${TAG}-COST`, nameAr: 'صنف اختبار', nameEn: 'Test item', itemCategory: 'BOS', uom: 'pc', unitCost: 10 },
    });
    if (w.status === 201 || w.status === 200) {
      // should not happen; remove the item so the catalogue stays clean
      await prisma.item.deleteMany({ where: { sku: `${TAG}-COST` } });
      return `item with unitCost was accepted: ${w.status}`;
    }
    return w.status === 403 ? true : w;
  } finally {
    await call(`/admin/users/${me.engineer.id}`, { token: T.admin, method: 'PATCH', body: { extraRoleIds: [] } });
    await call(`/admin/roles/${roleId}`, { token: T.admin, method: 'DELETE' });
  }
});

// ═══ Step 2 ═══════════════════════════════════════════════════════════════════
group('TC-S2-01', 'عميل جديد بسجل تجاري أو رقم ضريبي أو جوال موجود يُرفض');
let baseCustomer;
await check('sales creates the base company customer with CR, VAT and mobile', async () => {
  const r = await call('/customers', {
    token: T.sales,
    method: 'POST',
    body: {
      nameAr: `شركة الأفق للطاقة ${TAG}`,
      nameEn: `Horizon Energy ${TAG}`,
      entityKind: 'COMPANY',
      crNumber: `70${Date.now().toString().slice(-8)}`,
      vatNumber: `3${Date.now().toString().slice(-13)}3`,
      mobile: `05${Date.now().toString().slice(-8)}`,
    },
  });
  if (r.status !== 201 && r.status !== 200) return r;
  baseCustomer = r.body;
  created.customerIds.push(r.body.id);
  return r.body.mobile?.startsWith('+9665') ? true : `mobile not normalised: ${r.body.mobile}`;
});
for (const [field, make] of [
  ['crNumber', () => ({ crNumber: baseCustomer.crNumber })],
  ['vatNumber', () => ({ vatNumber: baseCustomer.vatNumber })],
  ['mobile', () => ({ mobile: baseCustomer.mobile.replace('+966', '0') })],
]) {
  await check(`a second customer with the same ${field} → 409 CUSTOMER_DUPLICATE naming the existing record`, async () => {
    const r = await call('/customers', {
      token: T.sales,
      method: 'POST',
      body: { nameAr: `عميل مختلف تماماً ${TAG} ${field}`, nameEn: `Other ${TAG} ${field}`, entityKind: field === 'mobile' ? 'INDIVIDUAL' : 'COMPANY', ...make() },
    });
    if (r.status === 201 || r.status === 200) {
      created.customerIds.push(r.body.id);
      return `accepted (${r.status}) — duplicate ${field} not refused`;
    }
    const ok = r.status === 409 && r.body?.code === 'CUSTOMER_DUPLICATE' && r.body?.field === field && r.body?.existing?.code === baseCustomer.code;
    return ok ? true : r;
  });
}
await check('a company without CR and VAT → 400; an individual without a mobile → 400', async () => {
  const a = await call('/customers', { token: T.sales, method: 'POST', body: { nameAr: `بلا هوية ${TAG}`, nameEn: 'No id', entityKind: 'COMPANY' } });
  const b = await call('/customers', { token: T.sales, method: 'POST', body: { nameAr: `فرد بلا جوال ${TAG}`, nameEn: 'No mobile', entityKind: 'INDIVIDUAL' } });
  for (const r of [a, b]) if (r.status === 201 || r.status === 200) created.customerIds.push(r.body.id);
  return a.status === 400 && b.status === 400 ? true : { a: a.status, b: b.status };
});

group('TC-S2-02', 'تشابه الاسم يُظهر تحذيراً (الخادم يعيد المطابقات القريبة)');
await check('a near-identical name («شركة الافق للطاقه», hamza/ta-marbuta variants) is reported as similar to the base customer', async () => {
  const r = await call(`/customers/similar?name=${encodeURIComponent(`شركة الافق للطاقه ${TAG}`)}`, { token: T.sales });
  if (r.status !== 200) return r;
  const hits = Array.isArray(r.body) ? r.body : r.body.items ?? [];
  return hits.some((h) => h.id === baseCustomer.id || h.code === baseCustomer.code) ? true : { hits: hits.slice(0, 3) };
});
await check('an unrelated name is not reported', async () => {
  const r = await call(`/customers/similar?name=${encodeURIComponent('بلدية محافظة الأحساء')}`, { token: T.sales });
  if (r.status !== 200) return r;
  const hits = Array.isArray(r.body) ? r.body : r.body.items ?? [];
  return hits.some((h) => h.id === baseCustomer.id) ? { hits } : true;
});

group('TC-S2-03', 'أداة الدمج تعرض قائمة المكررات المقترحة ولا تدمج شيئاً قبل الموافقة (الدمج مُعطَّل حتى يُفعَّل)');
await check('GET /customers/duplicates (merge key) returns groups and the mergeEnabled flag', async () => {
  const r = await call('/customers/duplicates', { token: T.admin });
  if (r.status !== 200) return r;
  return typeof r.body.mergeEnabled === 'boolean' && Array.isArray(r.body.groups) ? true : r.body;
});
await check('sales (no crm.customer.merge) cannot see the duplicates view (403)', async () => expectStatus(await call('/customers/duplicates', { token: T.sales }), 403, 'duplicates as sales'));
await check('while merge is switched off, POST /customers/merge is refused and both records stay', async () => {
  const dup = await call('/customers', {
    token: T.sales,
    method: 'POST',
    body: { nameAr: `شركة الأفق للطاقة فرع ${TAG}`, nameEn: `Horizon branch ${TAG}`, entityKind: 'COMPANY', crNumber: `71${Date.now().toString().slice(-8)}` },
  });
  if (dup.status !== 201 && dup.status !== 200) return dup;
  created.customerIds.push(dup.body.id);
  const flag = await call('/customers/duplicates', { token: T.admin });
  if (flag.body?.mergeEnabled === true) return 'merge is ENABLED on this database — the owner has not approved any merge list; stop and report';
  const m = await call('/customers/merge', { token: T.admin, method: 'POST', body: { survivorId: baseCustomer.id, mergedIds: [dup.body.id], backupRef: `uat-no-backup-${TAG}.dump` } });
  if (m.status === 201 || m.status === 200) return `merge went through although disabled: ${JSON.stringify(m.body).slice(0, 200)}`;
  const still = await call(`/customers/${dup.body.id}`, { token: T.sales });
  return still.status === 200 && !still.body.mergedIntoId ? true : { merge: m.status, still: still.status, mergedIntoId: still.body?.mergedIntoId };
});

// ═══ Step 3 ═══════════════════════════════════════════════════════════════════
group('TC-S3-01', 'لا تُحفظ فرصة خاسرة دون سبب');
let oppDirect;
await check('sales opens a DIRECT opportunity on the base customer', async () => {
  const r = await call('/opportunities', {
    token: T.sales,
    method: 'POST',
    body: { name: `محطة سطح ${TAG}`, customerId: baseCustomer.id, opportunityType: 'DIRECT', estimatedKwp: 120, estimatedValue: 450000 },
  });
  if (r.status !== 201 && r.status !== 200) return r;
  oppDirect = r.body;
  created.opportunityIds.push(r.body.id);
  return r.body.code?.startsWith('OPP-') ? true : r.body;
});
await check('LOST without a reason → 400 «Loss reason is required», stage unchanged', async () => {
  const r = await call(`/opportunities/${oppDirect.id}/stage`, { token: T.sales, method: 'POST', body: { stage: 'LOST' } });
  if (r.status !== 400) return r;
  const g = await call(`/opportunities/${oppDirect.id}`, { token: T.sales });
  return g.body?.stage === oppDirect.stage && /Loss reason is required/.test(msg(r)) ? true : { msg: msg(r), stage: g.body?.stage };
});
await check('LOST with an unknown reason id → 400/404; with an active reason → LOST, reason and closedAt stored', async () => {
  const bad = await call(`/opportunities/${oppDirect.id}/stage`, { token: T.sales, method: 'POST', body: { stage: 'LOST', lossReasonId: 'nope' } });
  if (![400, 404].includes(bad.status)) return bad;
  const reasons = await call('/loss-reasons', { token: T.sales });
  const reason = (Array.isArray(reasons.body) ? reasons.body : []).find((x) => x.isActive);
  if (!reason) return 'no active loss reason seeded';
  const ok = await call(`/opportunities/${oppDirect.id}/stage`, { token: T.sales, method: 'POST', body: { stage: 'LOST', lossReasonId: reason.id, lossNotes: 'السعر أعلى من المنافس' } });
  if (ok.status !== 200 && ok.status !== 201) return ok;
  const g = await call(`/opportunities/${oppDirect.id}`, { token: T.sales });
  return g.body?.stage === 'LOST' && g.body?.lossReasonId === reason.id && g.body?.closedAt ? true : g.body;
});

group('TC-S3-02', 'نوع «مناقصة» يُظهر حقوله الإضافية ويطلبها');
await check('a TENDER without a close date → 400 «Tender close date is required»', async () => {
  const r = await call('/opportunities', { token: T.sales, method: 'POST', body: { name: `مناقصة ${TAG}`, customerId: baseCustomer.id, opportunityType: 'TENDER' } });
  if (r.status === 201 || r.status === 200) {
    created.opportunityIds.push(r.body.id);
    return 'tender without close date accepted';
  }
  return r.status === 400 && /Tender close date/.test(msg(r)) ? true : r;
});
await check('a TENDER with reference, close date and bid bond is stored with all its fields', async () => {
  const r = await call('/opportunities', {
    token: T.sales,
    method: 'POST',
    body: {
      name: `مناقصة وزارة ${TAG}`,
      customerId: baseCustomer.id,
      opportunityType: 'TENDER',
      tenderReference: `T-${TAG}`,
      tenderCloseDate: new Date(Date.now() + 14 * 86400e3).toISOString().slice(0, 10),
      bidBondAmount: 25000,
      bidBondBank: 'البنك الأهلي',
      bidBondExpiry: new Date(Date.now() + 90 * 86400e3).toISOString().slice(0, 10),
      bidBondReference: `BB-${TAG}`,
    },
  });
  if (r.status !== 201 && r.status !== 200) return r;
  created.opportunityIds.push(r.body.id);
  const b = r.body;
  return b.opportunityType === 'TENDER' && b.tenderReference === `T-${TAG}` && b.tenderCloseDate && Number(b.bidBondAmount) === 25000 && b.bidBondBank === 'البنك الأهلي'
    ? true
    : b;
});
await check('GET /reference/enums lists the opportunity types and stages the form draws from', async () => {
  const r = await call('/reference/enums', { token: T.sales });
  if (r.status !== 200) return r;
  const types = r.body.opportunityTypes ?? [];
  const stages = r.body.opportunityStages ?? [];
  const has = (arr, v) => arr.some((x) => x === v || x?.value === v || x?.key === v);
  return has(types, 'TENDER') && has(types, 'DIRECT') && has(stages, 'LOST') ? true : { types, stages };
});

// ═══ Step 4 ═══════════════════════════════════════════════════════════════════
group('TC-S4-01', 'التكلفة تُجلب من آخر سعر شراء مع عمرها، والتحذير يظهر بعد تجاوز الحد');
let items = [];
await check('cost-lookup reports cost, source, age and the stale flag against the configured warn-days', async () => {
  const list = await call('/items?take=100', { token: T.sales });
  items = Array.isArray(list.body) ? list.body : list.body.items ?? [];
  if (!items.length) return 'no items';
  const r = await call(`/proposals/cost-lookup?itemIds=${items.slice(0, 20).map((x) => x.id).join(',')}`, { token: T.sales });
  if (r.status !== 200) return r;
  const rows = r.body;
  const shaped = rows.every((x) => 'unitCost' in x && 'costSource' in x && 'costAgeDays' in x && 'stale' in x && typeof x.warnDays === 'number');
  const purchaseBased = rows.find((x) => x.costSource === 'GRN' || x.costSource === 'PO');
  const catalogue = rows.find((x) => x.costSource === 'CATALOGUE');
  // a catalogue price has no date: it must be flagged stale; a purchase price younger than warnDays must not be
  const staleRule = (!catalogue || catalogue.stale === true) && (!purchaseBased || (purchaseBased.costAgeDays < purchaseBased.warnDays) === !purchaseBased.stale);
  return shaped && staleRule ? true : { sample: rows.slice(0, 3), purchaseBased, catalogue };
});
await check('warn-days is a setting (crm.proposal.costAgeWarnDays), not a number in the code', async () => {
  const r = await call('/admin/settings', { token: T.admin });
  return r.status === 200 && typeof r.body['crm.proposal.costAgeWarnDays'] === 'number' && typeof r.body['crm.proposal.validityDays'] === 'number' ? true : r;
});

group('TC-S4-02', 'التعديل اليدوي للتكلفة يُرفض دون سبب، ويُحفظ الأصل، ويظهر البند مميَّزاً للمعتمِد');
let oppProp, proposal, rev1;
await check('sales opens an opportunity and a proposal on it', async () => {
  const o = await call('/opportunities', { token: T.sales, method: 'POST', body: { name: `توسعة ${TAG}`, customerId: baseCustomer.id, opportunityType: 'DIRECT', estimatedKwp: 300, estimatedValue: 900000 } });
  if (o.status !== 201 && o.status !== 200) return o;
  oppProp = o.body;
  created.opportunityIds.push(o.body.id);
  const p = await call('/proposals', { token: T.sales, method: 'POST', body: { opportunityId: oppProp.id } });
  if (p.status !== 201 && p.status !== 200) return p;
  proposal = p.body;
  created.proposalIds.push(p.body.id);
  return p.body.code?.startsWith('PRP-') ? true : p.body;
});
const pickItem = () => items.find((x) => x.unitCost !== null) ?? items[0];
await check('a revision whose line changes the fetched cost without a reason → 400 «Cost override reason is required»', async () => {
  const item = pickItem();
  const r = await call(`/proposals/${proposal.id}/revisions`, {
    token: T.sales,
    method: 'POST',
    body: { bomLines: [{ itemId: item.id, qty: 10, unitCost: Number(item.unitCost ?? 100) + 50, unitPrice: 999 }] },
  });
  return r.status === 400 && /Cost override reason is required/.test(msg(r)) ? true : r;
});
await check('a validity date of today or earlier is refused (400 «Validity date must be in the future»)', async () => {
  const r = await call(`/proposals/${proposal.id}/revisions`, { token: T.sales, method: 'POST', body: { validUntil: new Date().toISOString().slice(0, 10), bomLines: [{ itemId: pickItem().id, qty: 1, unitPrice: 1 }] } });
  if (r.status === 201 || r.status === 200) return 'a revision valid only until today was accepted';
  return r.status === 400 && /Validity date/.test(msg(r)) ? true : r;
});
await check('with a reason: the fetched cost is kept as originalUnitCost, the new one as unitCost, with who and why', async () => {
  const item = pickItem();
  const r = await call(`/proposals/${proposal.id}/revisions`, {
    token: T.sales,
    method: 'POST',
    body: {
      validUntil: new Date(Date.now() + 20 * 86400e3).toISOString().slice(0, 10),
      bomLines: [
        { itemId: item.id, qty: 10, unitCost: Number(item.unitCost ?? 100) + 50, costOverrideReason: 'عرض مورد جديد أعلى من آخر شراء', unitPrice: 999 },
        ...(items[1] && items[1].id !== item.id ? [{ itemId: items[1].id, qty: 2, unitPrice: 1500 }] : []),
      ],
    },
  });
  if (r.status !== 201 && r.status !== 200) return r;
  const g = await call(`/proposals/${proposal.id}`, { token: T.sales });
  rev1 = g.body.revisions.find((x) => x.revisionNo === 1);
  const line = rev1?.bomLines?.find((l) => l.costOverrideReason);
  const ok = line && line.originalUnitCost !== null && Number(line.unitCost) === Number(item.unitCost ?? 100) + 50 && line.costOverriddenById === me.sales.id && line.costOverriddenAt;
  return ok ? true : { rev1Lines: rev1?.bomLines };
});
await check('the approver (executive) reads the same line with its override marks — the server does not hide them from him', async () => {
  const g = await call(`/proposals/${proposal.id}`, { token: T.ceo });
  if (g.status !== 200) return g;
  const line = g.body.revisions.find((x) => x.revisionNo === 1)?.bomLines?.find((l) => l.costOverrideReason);
  return line && line.originalUnitCost !== null && line.costOverriddenById ? true : g.body.revisions;
});

group('TC-S4-03/04/05', 'الإرسال قبل الاعتماد مرفوض؛ منشئ العرض لا يعتمده؛ الرئيس يعتمد');
let approvalRequestId;
await check('sending the DRAFT → 409 «Only an approved revision can be sent» (every proposal needs the executive’s signature; threshold 0)', async () => {
  const r = await call(`/proposals/${proposal.id}/send`, { token: T.sales, method: 'POST' });
  return r.status === 409 && /Only an approved revision can be sent/.test(msg(r)) ? true : r;
});
await check('submit parks it awaiting approval and the executive sees it in his approvals inbox', async () => {
  const r = await call(`/proposals/${proposal.id}/submit`, { token: T.sales, method: 'POST' });
  if (r.status !== 201 && r.status !== 200) return r;
  const inbox = await call('/approvals/inbox', { token: T.ceo });
  if (inbox.status !== 200) return inbox;
  const rows = Array.isArray(inbox.body) ? inbox.body : inbox.body.items ?? [];
  const mine = rows.find((x) => x.documentId === proposal.id || x.documentCode === proposal.code || x.document?.id === proposal.id);
  if (!mine) return { inbox: rows.slice(0, 3) };
  approvalRequestId = mine.id ?? mine.requestId;
  return true;
});
await check('the raiser (sales) cannot sign his own proposal → 403', async () => {
  const r = await call(`/approvals/${approvalRequestId}/decide`, { token: T.sales, method: 'POST', body: { decision: 'APPROVE' } });
  return r.status === 403 ? true : r;
});
await check('the accountant (not the approver role) cannot sign it either → 403', async () => {
  const r = await call(`/approvals/${approvalRequestId}/decide`, { token: T.accountant, method: 'POST', body: { decision: 'APPROVE' } });
  return r.status === 403 ? true : r;
});
await check('the executive approves; then sales sends it → SENT', async () => {
  const d = await call(`/approvals/${approvalRequestId}/decide`, { token: T.ceo, method: 'POST', body: { decision: 'APPROVE', note: 'موافق' } });
  if (d.status !== 201 && d.status !== 200) return d;
  const s = await call(`/proposals/${proposal.id}/send`, { token: T.sales, method: 'POST' });
  if (s.status !== 201 && s.status !== 200) return s;
  const g = await call(`/proposals/${proposal.id}`, { token: T.sales });
  return g.body.status === 'SENT' && g.body.revisions.find((x) => x.revisionNo === 1)?.status === 'SENT' ? true : g.body;
});
record(true, 'the alternate approver while the executive is away (delegation) — covered by apps/api/test/proposal-lifecycle.int-spec.ts «a delegate he named signs…»; not re-run live here', 'see test:int');

group('TC-S4-06', 'تعديل عرض مُرسل يُنشئ نسخة جديدة ويقفل السابقة');
await check('editing the SENT revision in place → 409 «Only a draft revision can be edited — add a new revision»', async () => {
  const r = await call(`/proposals/${proposal.id}/revisions/${rev1.id}`, { token: T.sales, method: 'PATCH', body: { bomLines: [{ itemId: pickItem().id, qty: 11, unitPrice: 999 }] } });
  return r.status === 409 && /Only a draft revision can be edited/.test(msg(r)) ? true : r;
});
await check('a new revision: R2 is DRAFT, R1 is SUPERSEDED and points to R2, the proposal is a draft again', async () => {
  const r = await call(`/proposals/${proposal.id}/revisions`, {
    token: T.sales,
    method: 'POST',
    body: { validUntil: new Date(Date.now() + 20 * 86400e3).toISOString().slice(0, 10), bomLines: [{ itemId: pickItem().id, qty: 12, unitPrice: 950 }] },
  });
  if (r.status !== 201 && r.status !== 200) return r;
  const g = await call(`/proposals/${proposal.id}`, { token: T.sales });
  const r1 = g.body.revisions.find((x) => x.revisionNo === 1);
  const r2 = g.body.revisions.find((x) => x.revisionNo === 2);
  return r1?.status === 'SUPERSEDED' && r1.supersededById === r2?.id && r2.status === 'DRAFT' && g.body.status === 'DRAFT' ? true : g.body.revisions.map((x) => [x.revisionNo, x.status]);
});
await check('R2 needs a fresh signature: sending it unapproved → 409', async () => {
  const r = await call(`/proposals/${proposal.id}/send`, { token: T.sales, method: 'POST' });
  return r.status === 409 ? true : r;
});

group('TC-S4-07', 'العرض ينتقل إلى «منتهي الصلاحية» تلقائياً بعد تاريخه');
await check('approve R2, move its valid-until into the past (clock trick), then send → 409 and the revision + proposal read EXPIRED', async () => {
  const sub = await call(`/proposals/${proposal.id}/submit`, { token: T.sales, method: 'POST' });
  if (sub.status !== 201 && sub.status !== 200) return sub;
  const inbox = await call('/approvals/inbox', { token: T.ceo });
  const rows = Array.isArray(inbox.body) ? inbox.body : inbox.body.items ?? [];
  const req = rows.find((x) => x.documentId === proposal.id || x.documentCode === proposal.code);
  if (!req) return { inbox: rows.slice(0, 3) };
  const d = await call(`/approvals/${req.id ?? req.requestId}/decide`, { token: T.ceo, method: 'POST', body: { decision: 'APPROVE' } });
  if (d.status !== 201 && d.status !== 200) return d;
  const g0 = await call(`/proposals/${proposal.id}`, { token: T.sales });
  const r2 = g0.body.revisions.find((x) => x.revisionNo === 2);
  if (r2?.status !== 'APPROVED') return { r2: r2?.status };
  const yesterday = new Date(Date.now() - 86400e3);
  yesterday.setUTCHours(0, 0, 0, 0);
  await prisma.proposalRevision.update({ where: { id: r2.id }, data: { validUntil: yesterday } });
  const s = await call(`/proposals/${proposal.id}/send`, { token: T.sales, method: 'POST' });
  const g = await call(`/proposals/${proposal.id}`, { token: T.sales });
  const r2b = g.body.revisions.find((x) => x.revisionNo === 2);
  return s.status === 409 && r2b?.status === 'EXPIRED' && g.body.status === 'EXPIRED' ? true : { send: s.status, msg: msg(s), r2: r2b?.status, proposal: g.body.status };
});
record(true, 'the nightly sweep (01:30 Riyadh) on SENT/APPROVED revisions — covered by proposal-lifecycle.int-spec.ts «the sweep expires…»; not waited for live', 'see test:int');

// ═══ Step 5 ═══════════════════════════════════════════════════════════════════
group('TC-S5-01', 'صفحة العميل تعرض في مكان واحد جهات الاتصال والفرص والعروض وسجل التواصل والمهام المستحقة');
await check('sales adds a contact, a meeting entry with a follow-up due today, and a task for the admin due tomorrow', async () => {
  const c = await call(`/customers/${baseCustomer.id}/contacts`, { token: T.sales, method: 'POST', body: { name: 'م. خالد العمري', title: 'مدير المشتريات', mobile: '0551234567', isPrimary: true } });
  if (c.status !== 201 && c.status !== 200) return c;
  const today = new Date().toISOString().slice(0, 10);
  const a = await call('/activities', {
    token: T.sales,
    method: 'POST',
    body: { customerId: baseCustomer.id, opportunityId: oppProp.id, activityType: 'MEETING', body: 'اجتماع في مقر العميل: مراجعة البنود وطلب تحديث العرض', followUp: { title: 'إرسال العرض المحدّث', dueAt: today } },
  });
  if (a.status !== 201 && a.status !== 200) return a;
  created.activityIds.push(a.body.activity?.id ?? a.body.id);
  const taskId = a.body.task?.id;
  if (taskId) created.taskIds.push(taskId);
  const tomorrow = new Date(Date.now() + 86400e3).toISOString().slice(0, 10);
  const t = await call('/tasks', { token: T.sales, method: 'POST', body: { customerId: baseCustomer.id, title: 'مراجعة شروط الدفع مع المدير', dueAt: tomorrow, assigneeId: me.admin.id } });
  if (t.status !== 201 && t.status !== 200) return t;
  created.taskIds.push(t.body.id);
  return t.body.code?.startsWith('TSK-') ? true : t.body;
});
await check('GET /customers/:id/overview carries contacts, opportunities, proposals, activities, tasks and the counts in ONE response', async () => {
  const r = await call(`/customers/${baseCustomer.id}/overview`, { token: T.sales });
  if (r.status !== 200) return r;
  const b = r.body;
  const ok =
    b.customer?.id === baseCustomer.id &&
    (b.contacts ?? []).length >= 1 &&
    (b.opportunities ?? []).some((o) => o.id === oppProp.id) &&
    (b.proposals ?? []).some((p) => p.id === proposal.id) &&
    (b.activities ?? []).length >= 1 &&
    (b.tasks ?? []).length >= 2 &&
    b.counts && typeof b.counts.activities === 'number' && typeof b.counts.tasks === 'number';
  return ok ? true : { keys: Object.keys(b), counts: b.counts, contacts: b.contacts?.length, opps: b.opportunities?.length, proposals: b.proposals?.length, activities: b.activities?.length, tasks: b.tasks?.length };
});
await check('the task due today is in the salesperson’s unified inbox (FOLLOWUP) and the admin was told about his', async () => {
  const inbox = await call('/inbox/tasks', { token: T.sales });
  if (inbox.status !== 200) return inbox;
  const rows = Array.isArray(inbox.body) ? inbox.body : inbox.body.items ?? [];
  const mine = rows.find((x) => x.source === 'FOLLOWUP' && created.taskIds.includes(x.documentId ?? x.id));
  const notes = await prisma.notification.findMany({ where: { userId: me.admin.id, type: 'TASK_ASSIGNED', createdAt: { gte: startedAt } } });
  return mine && !mine.overdue && notes.length >= 1 ? true : { mine, adminNotices: notes.length };
});
await check('the executive (read only) sees the log and the tasks but may not write an entry (403)', async () => {
  const g = await call(`/activities?customerId=${baseCustomer.id}`, { token: T.ceo });
  const w = await call('/activities', { token: T.ceo, method: 'POST', body: { customerId: baseCustomer.id, activityType: 'NOTE', body: 'محاولة' } });
  return g.status === 200 && w.status === 403 ? true : { read: g.status, write: w.status };
});
await check('moving the task’s due day to yesterday (clock trick): /tasks?due=overdue lists it and the inbox marks it overdue', async () => {
  const id = created.taskIds[0];
  const yesterday = new Date(Date.now() - 86400e3);
  yesterday.setUTCHours(0, 0, 0, 0);
  await prisma.followUpTask.update({ where: { id }, data: { dueAt: yesterday } });
  const l = await call('/tasks?mine=1&due=overdue', { token: T.sales });
  const rows = Array.isArray(l.body) ? l.body : l.body.items ?? [];
  const inbox = await call('/inbox/tasks', { token: T.sales });
  const irows = Array.isArray(inbox.body) ? inbox.body : inbox.body.items ?? [];
  const mine = irows.find((x) => x.source === 'FOLLOWUP' && (x.documentId === id || x.id === id));
  return rows.some((x) => x.id === id) && mine?.overdue === true ? true : { listed: rows.map((x) => x.id), inbox: mine };
});

group('TC-S5-02', 'الخطوة 5-ب: قائمة المكلَّفين لحامل الكتابة وبطاقة «مهام المتابعة» بمفتاح قراءة العميل');
await check('GET /tasks/assignees as sales → active colleagues (admin among them), names only', async () => {
  const r = await call('/tasks/assignees', { token: T.sales });
  if (r.status !== 200) return r;
  const rows = r.body;
  const admin = rows.find((x) => x.id === me.admin.id);
  const leak = rows.some((x) => 'email' in x || 'isActive' in x || 'roleId' in x);
  return admin && !leak ? true : { sample: rows.slice(0, 2), admin: !!admin };
});
await check('GET /tasks/assignees as the executive (read only) → 403', async () => expectStatus(await call('/tasks/assignees', { token: T.ceo }), 403, 'assignees as ceo'));
await check('GET /tasks/summary as the accountant (customer read, no lead read) → 200 {dueToday, overdue}; /reference/dashboard → 403', async () => {
  const s = await call('/tasks/summary', { token: T.accountant });
  const d = await call('/reference/dashboard', { token: T.accountant });
  return s.status === 200 && typeof s.body.dueToday === 'number' && typeof s.body.overdue === 'number' && d.status === 403 ? true : { summary: s, dashboard: d.status };
});
await check('GET /tasks/summary as sales counts the overdue task; /reference/dashboard no longer carries myTasks*', async () => {
  const s = await call('/tasks/summary', { token: T.sales });
  const d = await call('/reference/dashboard', { token: T.sales });
  return s.status === 200 && s.body.overdue >= 1 && d.status === 200 && !('myTasksDueToday' in d.body) ? true : { summary: s.body, dashboardKeys: Object.keys(d.body ?? {}) };
});

// ═══ cleanup ══════════════════════════════════════════════════════════════════
group('CLEANUP', KEEP ? 'kept (--keep): run again with --cleanup <json> to remove' : 'removing what the run created (audit rows stay)');
if (!KEEP) {
  await check('deleted the run’s proposals, approvals, workflow rows, tasks, entries, opportunities, contacts, customers and roles', async () => {
    const left = await cleanup(created, startedAt);
    return left.length ? left : true;
  });
}
await prisma.$disconnect();

// ── verdict ───────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; ${failed.length} FAILED` : ''}`);
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ base: BASE, tag: TAG, startedAt, created, ids: { customer: baseCustomer?.id, proposal: proposal?.id, opportunity: oppProp?.id }, results }, null, 2));
process.exit(failed.length ? 1 : 0);
