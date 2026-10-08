/**
 * CRM Phase 1 — the browser side of the acceptance (Step 6).
 *
 * Drives the real web app (Next dev server on :3000, API on :4000) with Playwright
 * for the "تحقق" items that are promises about a SCREEN, not about the server:
 * the cost column hidden from a role, the similar-name warning while typing, the
 * tender fields appearing only for «مناقصة», the overridden line highlighted for
 * the approver, the customer page with everything in one place, the dashboard
 * card and the assignee picker of Step 5-b — and the skill's screen sweep for
 * five roles. Saves screenshots to docs/crm-phase-1/screenshots/step-6-*.jpg.
 *
 * Needs the data a `--keep` run of crm-phase-1-acceptance.mjs left behind:
 *   node scripts/crm-phase-1-ui-acceptance.mjs --data <that run's --json file> [--web http://localhost:3000] [--api http://localhost:4000/api]
 *
 * Playwright is resolved from C:\dev\npi-erp\node_modules (NODE_PATH) when not
 * installed here. Login is throttled to 5/min per IP: this script logs in five
 * users, so start it a minute after any other login burst.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { readFileSync as rf } from 'node:fs';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require('C:/dev/npi-erp/node_modules/playwright'));
}

const args = process.argv.slice(2);
const flag = (n, d) => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : d);
const WEB = flag('--web', 'http://localhost:3000');
const API = flag('--api', 'http://localhost:4000/api');
const DATA = JSON.parse(readFileSync(flag('--data'), 'utf8'));
const JSON_OUT = flag('--json', null);
const ONLY = flag('--only', null); // run only the groups whose id starts with this (e.g. UI-S4)
const SHOT_FROM = Number(flag('--shot-from', 1));
const SHOTS = new URL('../docs/crm-phase-1/screenshots/', import.meta.url);
mkdirSync(SHOTS, { recursive: true });
const SWEEP_SRC = rf(new URL('../.claude/skills/npi-erp-testing/scripts/ui-sweep.js', import.meta.url), 'utf8');

const USERS = {
  admin: ['admin@npi.sa', 'Admin@123'],
  sales: ['sales@npi.sa', 'Sales@123'],
  ceo: ['ceo@npi.sa', 'Ceo@12345'],
  engineer: ['engineer@npi.sa', 'Eng@12345'],
  accountant: ['accountant@npi.sa', 'Acc@12345'],
};

const results = [];
let currentGroup = '';
const group = (id, title) => {
  currentGroup = `${id} ${title}`;
  console.log(`\n\x1b[1m${currentGroup}\x1b[0m`);
};
const record = (ok, label, detail) => {
  results.push({ group: currentGroup, ok, label, detail: detail ?? null });
  console.log(`${ok ? '\x1b[32m  PASS\x1b[0m' : '\x1b[31m  FAIL\x1b[0m'}  ${label}`);
  if (!ok && detail) console.log(`        \x1b[90m${String(detail).slice(0, 500)}\x1b[0m`);
};
async function check(label, fn) {
  if (ONLY && !currentGroup.startsWith(ONLY)) return;
  try {
    const out = await fn();
    if (out === true || out === undefined) return record(true, label);
    record(false, label, typeof out === 'string' ? out : JSON.stringify(out));
  } catch (e) {
    record(false, label, e?.message?.split('\n')[0] ?? String(e));
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
const tokens = {};
async function token(key) {
  if (tokens[key]) return tokens[key];
  const [email, password] = USERS[key];
  for (let i = 0; i < 4; i++) {
    let r;
    try {
      r = await fetchRetry(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    } catch (e) {
      console.log(`  login fetch failed (${e.cause?.code ?? e.message}); retrying in 3 s`);
      await sleep(3000);
      continue;
    }
    if (r.status === 200 || r.status === 201) return (tokens[key] = (await r.json()).accessToken);
    if (r.status === 429) {
      console.log(`  login throttled (${email}); waiting 61 s`);
      await sleep(61_000);
      continue;
    }
    throw new Error(`login ${email}: ${r.status}`);
  }
  throw new Error(`login ${email}: throttled`);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'ar-SA' });
const page = await context.newPage();
page.setDefaultTimeout(20_000);

/** Open the app as a role: token straight into localStorage, then a full load of the path. */
async function openAs(key, path) {
  const tok = await token(key);
  await page.goto(`${WEB}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => localStorage.setItem('npi_token', t), tok);
  await page.goto(`${WEB}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('h1', { timeout: 30_000 });
  await settle();
}
/** Wait until the page's fetches have drawn: no skeleton bars for 400 ms. */
async function settle(maxMs = 10_000) {
  const until = Date.now() + maxMs;
  while (Date.now() < until) {
    const busy = await page.evaluate(() => document.querySelectorAll('.animate-pulse, [aria-busy="true"]').length);
    if (!busy) {
      await sleep(400);
      const again = await page.evaluate(() => document.querySelectorAll('.animate-pulse, [aria-busy="true"]').length);
      if (!again) return;
    }
    await sleep(200);
  }
}
let shotNo = SHOT_FROM - 1;
async function shot(name) {
  shotNo += 1;
  const file = new URL(`step-6-${String(shotNo).padStart(2, '0')}-${name}.jpg`, SHOTS);
  await page.screenshot({ path: fileURLToPath(file), type: 'jpeg', quality: 80, fullPage: false });
  return fileURLToPath(file).split(/[\/]/).pop();
}
const bodyText = () => page.evaluate(() => document.body.innerText);

// ═══ Step 1 — cost column ════════════════════════════════════════════════════
group('UI-S1', 'حجب «عرض التكاليف والهوامش»: عمود التكلفة يغيب عن شاشة الأصناف لمن لا يحمله');
await check('the site engineer’s /items has no cost column; no load-error card', async () => {
  await openAs('engineer', '/items');
  const heads = await page.$$eval('th', (ths) => ths.map((x) => x.innerText.trim()));
  const txt = await bodyText();
  const err = /تعذّر تحميل|Failed to load/.test(txt);
  const costCol = heads.some((h) => /تكلفة|cost/i.test(h));
  const s = await shot('items-engineer-no-cost');
  return !costCol && !err && heads.length ? true : { heads, err, shot: s };
});
await check('sales sees the cost column on the same screen', async () => {
  await openAs('sales', '/items');
  const heads = await page.$$eval('th', (ths) => ths.map((x) => x.innerText.trim()));
  return heads.some((h) => /تكلفة|cost/i.test(h)) ? true : { heads };
});

// ═══ Step 2 — similar-name warning ═══════════════════════════════════════════
group('UI-S2', 'تشابه الاسم يُظهر تحذيراً أثناء الكتابة في نموذج العميل الجديد');
await check('typing a near-duplicate of the seeded «مصنع الرياض للصناعات» shows the similar-customers box', async () => {
  await openAs('sales', '/customers');
  await page.getByRole('button', { name: /عميل جديد/ }).first().click();
  const name = page.locator('input[name="nameAr"]');
  await name.waitFor();
  await name.pressSequentially('مصنع الرياض للصناعه', { delay: 40 });
  await page.waitForFunction(() => /يوجد عملاء بأسماء مشابهة/.test(document.body.innerText), null, { timeout: 8000 });
  const txt = await bodyText();
  const s = await shot('customer-similar-warning');
  return /يوجد عملاء بأسماء مشابهة/.test(txt) && /مصنع الرياض للصناعات/.test(txt) ? true : { shot: s };
});

// ═══ Step 3 — tender fields ══════════════════════════════════════════════════
group('UI-S3', 'نوع «مناقصة» يُظهر حقوله الإضافية في نموذج الفرصة، وتختفي مع «مباشرة»');
await check('the tender block appears only while TENDER is selected', async () => {
  await openAs('sales', '/opportunities');
  await page.getByRole('button', { name: /فرصة جديدة/ }).first().click();
  const sel = page.locator('select[name="opportunityType"]');
  await sel.waitFor();
  const before = /بيانات المناقصة/.test(await bodyText());
  await sel.selectOption('TENDER');
  await sleep(200);
  const during = /بيانات المناقصة/.test(await bodyText()) && (await page.locator('text=تاريخ إقفال المناقصة').count()) > 0;
  const s = await shot('opportunity-tender-fields');
  await sel.selectOption('DIRECT');
  await sleep(200);
  const after = /بيانات المناقصة/.test(await bodyText());
  return !before && during && !after ? true : { before, during, after, shot: s };
});

// ═══ Step 4 — the approver sees the manual cost flagged ══════════════════════
group('UI-S4', 'البند المعدَّل يدوياً يظهر مميَّزاً للمعتمِد، وحالة العرض بعد انتهاء الصلاحية');
await check('the executive opens the kept proposal: the overridden line is highlighted with its badge and the proposal reads expired', async () => {
  await openAs('ceo', `/proposals/${DATA.ids.proposal}`);
  await page.waitForFunction(() => /PRP-/.test(document.body.innerText), null, { timeout: 60000 });
  await settle();
  // every revision is rendered on the page, so the R1 line with the manual cost is visible without switching
    await settle();
  // revision 1 (the one with the manual cost) is folded under the current one: open it, as the approver would
  const r1 = page.getByText(/مراجعة #1/).first();
  if (await r1.count()) await r1.click();
  await settle();
  const flagged = await page.$$eval('tr', (rows) => rows.filter((r) => /warning/.test(r.className) && r.offsetParent !== null).length);
  const badge = await page.locator('text=تكلفة معدَّلة يدوياً').first().isVisible().catch(() => false);
  const txt = await bodyText();
  const expired = /منتهي الصلاحية|Expired/.test(txt);
  const s = await shot('proposal-override-approver-view');
  return flagged > 0 && badge && expired ? true : { flagged, badge, expired, shot: s };
});

// ═══ Step 5 — the customer page ══════════════════════════════════════════════
group('UI-S5', 'صفحة العميل تعرض في مكان واحد جهات الاتصال والفرص والعروض وسجل التواصل والمهام المستحقة');
await check('all five tabs are present on the kept customer, with counts, and the tasks tab shows the overdue task in red', async () => {
  await openAs('sales', `/customers/${DATA.ids.customer}`);
  const tabs = await page.$$eval('main button, button[aria-current]', (els) => els.map((e) => e.innerText.trim()).filter(Boolean));
  const need = ['جهات الاتصال', 'الفرص', 'العروض', 'سجل التواصل', 'المهام'];
  const missing = need.filter((n) => !tabs.some((t) => t.includes(n)));
  const s1 = await shot('customer-page-tabs');
  const tasksTab = page.locator('[role="tab"], button').filter({ hasText: 'المهام' }).first();
  await tasksTab.click();
  await settle();
  await page.waitForFunction(() => /TSK-/.test(document.body.innerText), null, { timeout: 10000 });
  const txt = await bodyText();
  const overdue = /متأخرة/.test(txt);
  const s2 = await shot('customer-page-tasks-overdue');
  const logTab = page.locator('[role="tab"], button').filter({ hasText: 'سجل التواصل' }).first();
  await logTab.click();
  await settle();
  const log = /اجتماع في مقر العميل/.test(await bodyText());
  const s3 = await shot('customer-page-log');
  return missing.length === 0 && overdue && log ? true : { tabs, missing, overdue, log, shots: [s1, s2, s3] };
});

// ═══ Step 5-b — dashboard card and assignee picker ═══════════════════════════
group('UI-S5b', 'بطاقة «مهام المتابعة» لحامل قراءة العميل فقط، وقائمة المكلَّفين للمندوب');
await check('the accountant’s dashboard shows the follow-up card and no load-error card', async () => {
  await openAs('accountant', '/dashboard');
  await page.waitForFunction(() => /مهام المتابعة/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
  const txt = await bodyText();
  const s = await shot('dashboard-accountant-tasks-card');
  return /مهام المتابعة/.test(txt) && !/تعذّر تحميل|Failed to load/.test(txt) ? true : { shot: s, hasCard: /مهام المتابعة/.test(txt) };
});
await check('the salesperson’s new-task form offers colleagues as assignees (more than «أنا»)', async () => {
  await openAs('sales', `/customers/${DATA.ids.customer}?tab=tasks`);
  await page.waitForFunction(() => /TSK-/.test(document.body.innerText), null, { timeout: 60000 });
  await page.getByRole('button', { name: /مهمة جديدة/ }).first().click({ timeout: 30000 });
  const sel = page.locator('select[name="assigneeId"]');
  await sel.waitFor();
  await page.waitForFunction(() => document.querySelector('select[name="assigneeId"]')?.options.length > 1, null, { timeout: 8000 }).catch(() => {});
  const opts = await sel.evaluate((s) => [...s.options].map((o) => o.text));
  const s = await shot('task-form-assignees');
  return opts.length > 1 ? true : { opts, shot: s };
});

// ═══ the skill's screen sweep, five roles ════════════════════════════════════
group('SWEEP', 'مسح الشاشات لكل دور (سكربت المهارة ui-sweep.js): لا بطاقة «تعذّر تحميل»، لا رموز تعبيرية، لا تمرير أفقي');
const sweeps = {};
for (const key of ['admin', 'sales', 'ceo', 'accountant', 'engineer']) {
  await check(`${key}: every sidebar screen renders`, async () => {
    await openAs(key, '/dashboard');
    await page.waitForFunction(() => document.querySelectorAll('aside a[href^="/"]').length > 0, null, { timeout: 30000 });
    const out = await page.evaluate(SWEEP_SRC);
    sweeps[key] = out;
    const screens = out.screens ?? out.results ?? out;
    const bad = (Array.isArray(screens) ? screens : []).filter((s) => !s.arrived || s.loadError || s.emoji?.length || s.hOverflow);
    return bad.length === 0 ? true : { bad: bad.map((b) => ({ href: b.href, arrived: b.arrived, loadError: b.loadError, emoji: b.emoji, hOverflow: b.hOverflow })) };
  });
}
await check('the engineer sees fewer sidebar links than the admin (the sidebar gate holds)', async () => {
  const n = (k) => (sweeps[k]?.screens ?? sweeps[k]?.results ?? []).length;
  return n('engineer') > 0 && n('engineer') < n('admin') ? true : { engineer: n('engineer'), admin: n('admin') };
});

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} UI checks passed${failed.length ? `; ${failed.length} FAILED` : ''}`);
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ web: WEB, results, sweeps }, null, 2));
process.exit(failed.length ? 1 : 0);
