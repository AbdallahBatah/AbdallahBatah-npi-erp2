#!/usr/bin/env node
// T-45 / T-43 — a browser look at the Content-Security-Policy (T-44) of a
// RUNNING copilot (production build locally, or the demo server):
//
//   node scripts/csp-sweep.mjs [http://localhost:3179]
//
// Opens the login screen, logs in as the seeded administrator through the
// copilot's own API (read from packages/db/prisma/seed.ts like perf.mjs — never
// printed), then every screen plus one unknown path, on a desktop viewport and
// on a Pixel 7; presses Tab, types one character into the composer where there
// is one, and records every console error/warning, every page error and the
// CSP header of the home page. Exit 1 when a console line mentions a refusal or
// a CSP violation, or when the policy carries 'unsafe-eval' (the `next dev`
// policy — the sweep must run against `next start` or the server); 0 otherwise.
// The one expected line is the 404 of the unknown path.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';

const BASE = (process.argv[2] ?? 'http://localhost:3179').replace(/\/$/, '');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const SEED = path.join(REPO_ROOT, 'packages', 'db', 'prisma', 'seed.ts');
const UNAUTH_PAGES = ['/copilot/login'];
const AUTH_PAGES = ['/copilot', '/copilot/settings', '/copilot/trust', '/copilot/metrics', '/copilot/handover', '/copilot/setup', '/copilot/does-not-exist'];

function seedAccount() {
  const text = fs.readFileSync(SEED, 'utf8');
  const m = text.match(/Admin login\s*:\s*(\S+)\s*\/\s*([^'\s]+)/);
  if (!m) throw new Error(`${SEED}: the "Admin login" summary line was not found`);
  return { email: m[1], password: m[2] };
}

const findings = [];
let cspHome = null;
let violations = 0;

async function sweep(profile, contextOptions) {
  const browser = await chromium.launch();
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const note = (kind, text) => findings.push({ profile, url: page.url(), kind, text: text.slice(0, 300) });
  page.on('console', (msg) => {
    const text = msg.text();
    const bad = /Refused to|Content Security Policy|CSP|violat/i.test(text);
    if (bad) violations += 1;
    if (bad || msg.type() === 'error' || msg.type() === 'warning') note(`console.${msg.type()}`, text);
  });
  page.on('pageerror', (err) => note('pageerror', String(err)));
  page.on('response', (res) => {
    const header = res.headers()['content-security-policy'];
    if (header && res.request().resourceType() === 'document' && new URL(res.url()).pathname === '/copilot') cspHome = header;
  });

  for (const p of UNAUTH_PAGES) {
    await page.goto(BASE + p, { waitUntil: 'networkidle' });
    await page.keyboard.press('Tab');
  }
  const res = await context.request.post(`${BASE}/copilot/api/auth`, { data: seedAccount() });
  if (!res.ok()) throw new Error(`login as the seeded administrator failed: HTTP ${res.status()}`);
  for (const p of AUTH_PAGES) {
    await page.goto(BASE + p, { waitUntil: 'networkidle' });
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    const composer = page.locator('textarea').first();
    if (await composer.count()) {
      await composer.click();
      await page.keyboard.type('م');
    }
    await page.waitForTimeout(500);
  }
  await browser.close();
}

await sweep('desktop', { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } });
await sweep('mobile', { ...devices['Pixel 7'] });

const unsafeEval = cspHome ? /unsafe-eval/.test(cspHome) : null;
console.log(`[csp] ${BASE}`);
console.log(`[csp] policy on /copilot: ${cspHome ?? '(no Content-Security-Policy header seen)'}`);
console.log(`[csp] 'unsafe-eval' present: ${unsafeEval}`);
console.log(`[csp] console/page findings: ${findings.length}`);
for (const f of findings) console.log(`  [${f.profile}] ${f.kind} @ ${f.url}: ${f.text}`);
console.log(`[csp] refusals/violations: ${violations}`);
const ok = violations === 0 && unsafeEval === false;
console.log(ok ? '[csp] PASS' : '[csp] FAIL');
process.exit(ok ? 0 : 1);
