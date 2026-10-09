#!/usr/bin/env node
// T-39 — the performance gate (spec/madar/05 row T-39, 07 G-M5-2):
//
//   npm run perf -w apps/copilot [-- --runs 3 --api http://localhost:4000/api]
//                                [--url http://host:port] [--skip-build]
//                                [--profile desktop|mobile|both] [--out file]
//
// 1. `next build` (production), then the first-load JavaScript of every route
//    from the build manifests (gzip bytes, scripts only) against the budget.
// 2. `next start` on port 3179 against a running NPI api (default :4000, the
//    same one the eval scripts use; `--api` to point elsewhere) — or `--url`
//    to measure a copilot that is already running (no build, no start).
// 3. Headless Chromium through Playwright, two profiles with Lighthouse's
//    throttling (desktop: 10 Mbps / 40 ms RTT / 1× CPU; mobile: 1.6 Mbps /
//    150 ms RTT / 4× CPU on a Pixel 7 descriptor). Each screen is loaded
//    `--runs` times (default 3), interacted with (three Tab presses, one
//    character typed into the composer when there is one) and the page's own
//    PerformanceObservers report LCP, layout shifts, Event Timing entries,
//    TTFB and the JS bytes transferred. The median of the runs is judged.
// 4. Budgets come from next.config.js (`perfBudgets`): LCP, INP, CLS, TTFB and
//    first-load JS. Exit 0 when every median and every route is within budget,
//    1 when one is not, 2 when the run could not be set up. The full report
//    (every run, every file) is written to test-results/perf/<timestamp>.json.
//
// Credentials: the seeded administrator, read from packages/db/prisma/seed.ts
// like the e2e fixtures do — never printed. Requires a production build to be
// possible, i.e. no `next dev` writing to .next at the same time.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { chromium, devices } from 'playwright';
import lib from './perf-lib.js';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(APP, '..', '..');
const NEXT_DIR = path.join(APP, '.next');
const SEED = path.join(REPO_ROOT, 'packages', 'db', 'prisma', 'seed.ts');
const OUT_DIR = path.join(APP, 'test-results', 'perf');

const PERF_PORT = 3179;
const UNAUTH_PAGES = ['/copilot/login'];
const AUTH_PAGES = ['/copilot', '/copilot/settings', '/copilot/trust', '/copilot/metrics', '/copilot/handover', '/copilot/setup'];

// Lighthouse's default throttling (lighthouse-core/config/constants.js):
// mobile = 1.6 Mbps down, 750 kbps up, 150 ms RTT, 4× CPU; desktop = 10 Mbps,
// 40 ms RTT, no CPU slowdown. Throughputs for CDP are bytes per second.
const KBPS = 1024 / 8;
const PROFILES = {
  desktop: {
    device: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    network: { latency: 40, downloadThroughput: 10 * 1024 * KBPS, uploadThroughput: 10 * 1024 * KBPS },
    cpu: 1,
    note: 'Lighthouse desktop: 10 Mbps, 40 ms RTT, 1x CPU; 1280x800',
  },
  mobile: {
    device: devices['Pixel 7'],
    network: { latency: 150, downloadThroughput: 1.6 * 1024 * KBPS, uploadThroughput: 750 * KBPS },
    cpu: 4,
    note: 'Lighthouse mobile: 1.6 Mbps down, 750 kbps up, 150 ms RTT, 4x CPU; Pixel 7 (412x915, DPR 2.625, touch)',
  },
};

// Installed before any page script runs. Buffered observers also catch what
// happened before the observer was created.
const OBSERVER_SCRIPT = `
(() => {
  const perf = { lcp: null, lcpElement: null, shifts: [], events: [] };
  window.__madarPerf = perf;
  const describe = (node) => {
    if (!node || !node.tagName) return String(node && node.nodeName || '?');
    const id = node.id ? '#' + node.id : '';
    const testId = node.getAttribute && node.getAttribute('data-testid');
    const cls = typeof node.className === 'string' && node.className ? '.' + node.className.trim().split(/\\s+/).slice(0, 3).join('.') : '';
    return node.tagName.toLowerCase() + id + (testId ? '[' + testId + ']' : '') + cls;
  };
  const rect = (r) => (r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null);
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        perf.lcp = e.startTime;
        // The element that is the LCP candidate, its painted area and (for an image) its URL.
        perf.lcpElement = { node: describe(e.element), size: e.size, url: e.url || null, text: (e.element && e.element.textContent || '').trim().slice(0, 60) };
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {}
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.hadRecentInput) continue;
        perf.shifts.push({
          t: e.startTime,
          v: e.value,
          // Which nodes moved, from where to where — the diagnosis of a high CLS.
          src: (e.sources || []).slice(0, 4).map((s) => ({ node: describe(s.node), from: rect(s.previousRect), to: rect(s.currentRect) })),
        });
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch {}
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        perf.events.push({ d: e.duration, id: e.interactionId || 0, n: e.name, target: describe(e.target), delay: Math.round(e.processingStart - e.startTime) });
      }
    }).observe({ type: 'event', buffered: true, durationThreshold: 16 });
  } catch {}
})();
`;

function readMetricsInPage() {
  const nav = performance.getEntriesByType('navigation')[0];
  const scripts = performance
    .getEntriesByType('resource')
    .filter((r) => r.initiatorType === 'script' || /\.js(\?|$)/.test(r.name));
  const perf = window.__madarPerf ?? { lcp: null, lcpElement: null, shifts: [], events: [] };
  // Bytes by kind, so a slow LCP can be read against what the page downloaded.
  const byKind = {};
  for (const r of performance.getEntriesByType('resource')) {
    const kind = /\.(woff2?|ttf|otf)(\?|$)/.test(r.name) ? 'font' : r.initiatorType === 'link' || /\.css(\?|$)/.test(r.name) ? 'css' : r.initiatorType === 'script' || /\.js(\?|$)/.test(r.name) ? 'script' : r.initiatorType === 'fetch' || r.initiatorType === 'xmlhttprequest' ? 'fetch' : r.initiatorType === 'img' ? 'image' : 'other';
    const entry = (byKind[kind] ??= { count: 0, bytes: 0, lastEndMs: 0 });
    entry.count += 1;
    entry.bytes += r.transferSize || r.encodedBodySize || 0;
    entry.lastEndMs = Math.max(entry.lastEndMs, Math.round(r.responseEnd));
  }
  // The page's own data requests in time order (Next's route prefetches included), for reading a waterfall.
  const fetches = performance
    .getEntriesByType('resource')
    .filter((r) => r.initiatorType === 'fetch' || r.initiatorType === 'xmlhttprequest')
    .sort((a, b) => a.startTime - b.startTime)
    .slice(0, 20)
    .map((r) => ({ url: r.name.replace(location.origin, ''), startMs: Math.round(r.startTime), endMs: Math.round(r.responseEnd), bytes: r.transferSize || r.encodedBodySize || 0 }));
  return {
    lcp: perf.lcp,
    lcpElement: perf.lcpElement,
    shifts: perf.shifts,
    events: perf.events,
    ttfb: nav ? nav.responseStart : null,
    htmlBytes: nav ? nav.transferSize || nav.encodedBodySize || null : null,
    domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
    resources: byKind,
    fetches,
    jsTransferBytes: scripts.reduce((sum, r) => sum + (r.transferSize || r.encodedBodySize || 0), 0),
    scriptCount: scripts.length,
    finalPath: location.pathname + location.search,
  };
}

// ─── Setup ──────────────────────────────────────────────────────────────────

function usage() {
  console.log(
    [
      'usage: node scripts/perf.mjs [--runs N] [--api <npi api base>] [--url <copilot base>]',
      '                             [--skip-build] [--profile desktop|mobile|both] [--out <file>]',
      '',
      '  --runs N        loads per screen and profile (default 3; the median is judged)',
      '  --api URL       NPI api the started copilot talks to (default http://localhost:4000/api)',
      '  --url URL       measure a copilot that is already running; no build, no start',
      '  --skip-build    reuse the production build in .next (BUILD_ID must exist)',
      '  --profile P     desktop, mobile or both (default both)',
      '  --out FILE      where to write the JSON report (default test-results/perf/<timestamp>.json)',
      '  --pages LIST    comma-separated screens to measure (e.g. /copilot,/copilot/trust); default all',
    ].join('\n'),
  );
}

function loadBudgets() {
  const config = require(path.join(APP, 'next.config.js'));
  const budgets = config.perfBudgets;
  const keys = ['lcpMs', 'inpMs', 'cls', 'ttfbMs', 'firstLoadJsKb'];
  if (!budgets || keys.some((k) => typeof budgets[k] !== 'number' || !(budgets[k] > 0))) {
    throw new Error('next.config.js must expose perfBudgets with positive numbers for ' + keys.join(', '));
  }
  return budgets;
}

function seededAdmin() {
  const text = fs.readFileSync(SEED, 'utf8');
  const m = text.match(/Admin login\s*:\s*(\S+)\s*\/\s*([^'\s]+)/);
  if (!m) throw new Error(`${SEED}: the "Admin login" summary line was not found`);
  return { email: m[1], password: m[2] };
}

async function fetchStatus(url) {
  try {
    const res = await fetch(url, { redirect: 'manual' });
    return res.status;
  } catch {
    return 0;
  }
}

async function waitFor(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await fetchStatus(url);
    if (status >= 200 && status < 400) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${label} did not answer at ${url} within ${Math.round(timeoutMs / 1000)} s`);
}

function stop(child) {
  if (!child || child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') {
    // shell: true → the child is cmd.exe; kill the whole tree or next keeps the port.
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

function build() {
  console.log('[perf] next build …');
  const result = spawnSync('npm', ['run', 'build'], { cwd: APP, shell: true, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`next build failed (exit ${result.status})`);
}

function hasProductionBuild() {
  return fs.existsSync(path.join(NEXT_DIR, 'BUILD_ID')) && fs.existsSync(path.join(NEXT_DIR, 'app-build-manifest.json'));
}

function measureJs() {
  if (!hasProductionBuild()) throw new Error('.next holds no production build (BUILD_ID missing); run without --skip-build');
  const appManifest = JSON.parse(fs.readFileSync(path.join(NEXT_DIR, 'app-build-manifest.json'), 'utf8'));
  const buildManifest = JSON.parse(fs.readFileSync(path.join(NEXT_DIR, 'build-manifest.json'), 'utf8'));
  const cache = new Map();
  const sizeOf = (file) => {
    let size = cache.get(file);
    if (!size) {
      const buf = fs.readFileSync(path.join(NEXT_DIR, file));
      size = { raw: buf.length, gzip: zlib.gzipSync(buf).length };
      cache.set(file, size);
    }
    return size;
  };
  return lib.pageRoutes(appManifest).map((route) => lib.firstLoadJs({ appManifest, buildManifest, route, sizeOf }));
}

function startCopilot(apiBase, port, logPath) {
  const key = spawnSync(process.execPath, [path.join(HERE, 'ensure-session-key.mjs')], { stdio: 'inherit' });
  if (key.status !== 0) throw new Error('ensure-session-key.mjs failed');
  const log = fs.openSync(logPath, 'a');
  const args = ['dotenv', '-e', '../../.env', '-v', `NPI_API_BASE=${apiBase}`, '--', 'npx', 'next', 'start', '-p', String(port)];
  console.log(`[perf] next start -p ${port} (NPI api ${apiBase}); log ${path.relative(APP, logPath)}`);
  return spawn('npx', args, { cwd: APP, shell: true, stdio: ['ignore', log, log], windowsHide: true });
}

// ─── Measurement ────────────────────────────────────────────────────────────

async function interact(page) {
  for (let i = 0; i < 3; i += 1) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(120);
  }
  const textarea = page.locator('textarea').first();
  if ((await textarea.count()) > 0) {
    const clicked = await textarea
      .click({ timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (clicked) {
      await page.keyboard.type('ا');
      await page.waitForTimeout(120);
      await page.keyboard.press('Backspace');
    }
  }
  await page.waitForTimeout(200);
}

async function measureOnce(context, profile, url) {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  // Every run is a cold load (the session cookie stays; the HTTP cache does
  // not), as Lighthouse measures — a warm second run would understate LCP and
  // report zero bytes transferred.
  await cdp.send('Network.clearBrowserCache');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, ...profile.network });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu });
  const started = Date.now();
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 120_000 });
    // Interact once the screen has finished loading: network quiet, every
    // `aria-busy` loading state gone (the copilot's skeletons all carry it),
    // network quiet again (the data those states were waiting for), then an
    // idle main thread. INP then reports the handlers' own cost rather than
    // the input delay of a render still in progress — load time is the LCP
    // and JS budgets' business.
    const idle = () =>
      page.evaluate(
        () =>
          new Promise((r) =>
            'requestIdleCallback' in window ? requestIdleCallback(() => r(undefined), { timeout: 10_000 }) : setTimeout(r, 1_000),
          ),
      );
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
    await page
      .locator('[aria-busy="true"]')
      .first()
      .waitFor({ state: 'detached', timeout: 15_000 })
      .catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await idle();
    await interact(page);
    // Two frames and a pause so the last layout shift and event entries are delivered.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 600)))));
    const raw = await page.evaluate(readMetricsInPage);
    const worstEvents = [...raw.events]
      .filter((e) => e.id)
      .sort((a, b) => b.d - a.d)
      .slice(0, 3)
      .map((e) => ({ name: e.n, target: e.target, durationMs: e.d, inputDelayMs: e.delay }));
    const largestShifts = [...raw.shifts]
      .sort((a, b) => b.v - a.v)
      .slice(0, 3)
      .map((s) => ({ atMs: Math.round(s.t), value: Math.round(s.v * 1000) / 1000, sources: s.src }));
    return {
      lcpMs: raw.lcp,
      lcpElement: raw.lcpElement,
      inpMs: lib.inpFromEvents(raw.events),
      cls: lib.clsFromShifts(raw.shifts),
      ttfbMs: raw.ttfb,
      htmlBytes: raw.htmlBytes,
      domContentLoadedMs: raw.domContentLoadedMs,
      resources: raw.resources,
      fetches: raw.fetches,
      jsTransferBytes: raw.jsTransferBytes,
      scriptCount: raw.scriptCount,
      interactions: new Set(raw.events.filter((e) => e.id).map((e) => e.id)).size,
      shifts: raw.shifts.length,
      worstEvents,
      largestShifts,
      finalPath: raw.finalPath,
      wallMs: Date.now() - started,
    };
  } finally {
    await page.close();
  }
}

async function login(context, base, account) {
  const res = await context.request.post(`${base}/copilot/api/auth`, { data: account });
  if (!res.ok()) throw new Error(`login as the seeded administrator failed: HTTP ${res.status()} ${await res.text()}`);
}

function summarize(runs) {
  const med = (key) => lib.median(runs.map((r) => r[key]));
  return {
    lcpMs: med('lcpMs'),
    inpMs: med('inpMs'),
    cls: med('cls'),
    ttfbMs: med('ttfbMs'),
    jsTransferKb: med('jsTransferBytes') === null ? null : Math.round((med('jsTransferBytes') / 1024) * 10) / 10,
    finalPath: runs[runs.length - 1]?.finalPath ?? null,
  };
}

async function measureProfile(browser, name, base, runs, account, only) {
  const profile = PROFILES[name];
  const context = await browser.newContext({ ...profile.device, locale: 'ar-SA' });
  await context.addInitScript(OBSERVER_SCRIPT);
  const pages = [];
  try {
    const measurePath = async (pathName) => {
      if (only && !only.includes(pathName)) return;
      const samples = [];
      for (let i = 0; i < runs; i += 1) samples.push(await measureOnce(context, profile, `${base}${pathName}`));
      const summary = summarize(samples);
      pages.push({ path: pathName, profile: name, ...summary, runs: samples });
      console.log(
        `[perf] ${name.padEnd(7)} ${pathName.padEnd(18)} LCP ${fmt(summary.lcpMs)} ms  INP ${fmt(summary.inpMs)} ms  CLS ${fmtCls(summary.cls)}  TTFB ${fmt(summary.ttfbMs)} ms  JS ${summary.jsTransferKb ?? '—'} KB  → ${summary.finalPath}`,
      );
    };
    for (const p of UNAUTH_PAGES) await measurePath(p);
    await login(context, base, account);
    for (const p of AUTH_PAGES) await measurePath(p);
  } finally {
    await context.close();
  }
  return pages;
}

const fmt = (v) => (typeof v === 'number' ? String(Math.round(v)).padStart(5) : '    —');
const fmtCls = (v) => (typeof v === 'number' ? v.toFixed(3) : '—');

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = lib.parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return 0;
  }
  const budgets = loadBudgets();
  const account = seededAdmin();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = args.out ? path.resolve(args.out) : path.join(OUT_DIR, `${stamp}.json`);

  let base = args.url;
  let copilot = null;
  let js = [];
  let jsNote = null;
  let browser = null;
  let pages = [];

  try {
    if (base === null) {
      const health = await fetchStatus(`${args.api}/health`);
      if (health !== 200) {
        throw new Error(
          `the NPI api answered ${health || 'nothing'} at ${args.api}/health — start it (npm run dev:api) or pass --api <base>`,
        );
      }
      if (!args.skipBuild) build();
      js = measureJs();
      copilot = startCopilot(args.api, PERF_PORT, path.join(OUT_DIR, `${stamp}.server.log`));
      base = `http://localhost:${PERF_PORT}`;
      await waitFor(`${base}/copilot/login`, 120_000, 'the copilot');
    } else if (hasProductionBuild()) {
      js = measureJs();
    } else {
      jsNote = 'no production build in .next — first-load JS not measured (--url mode)';
    }

    for (const entry of js) {
      console.log(
        `[perf] build   ${entry.route.padEnd(18)} first-load JS ${(entry.gzipBytes / 1024).toFixed(1).padStart(6)} KB gzip (${(entry.rawBytes / 1024).toFixed(1)} KB raw, ${entry.files.length} files)`,
      );
    }
    if (jsNote) console.log(`[perf] ${jsNote}`);

    browser = await chromium.launch();
    for (const name of args.profiles) {
      console.log(`[perf] profile ${name}: ${PROFILES[name].note}; ${args.runs} run(s) per screen`);
      pages.push(...(await measureProfile(browser, name, base, args.runs, account, args.pages)));
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    stop(copilot);
  }

  const verdict = lib.evaluateBudgets(budgets, {
    pages: pages.map(({ path: p, profile, lcpMs, inpMs, cls, ttfbMs }) => ({ path: p, profile, lcpMs, inpMs, cls, ttfbMs })),
    js: js.map(({ route, gzipBytes }) => ({ route, gzipBytes })),
  });

  const report = {
    task: 'T-39',
    at: new Date().toISOString(),
    base,
    api: args.url ? null : args.api,
    runsPerScreen: args.runs,
    budgets,
    profiles: Object.fromEntries(args.profiles.map((n) => [n, { note: PROFILES[n].note, network: PROFILES[n].network, cpu: PROFILES[n].cpu }])),
    environment: {
      node: process.version,
      next: require('next/package.json').version,
      playwright: require('playwright/package.json').version,
      platform: `${os.platform()} ${os.release()}`,
      cpus: os.cpus().length,
      loadNote: 'local machine; other dev servers may be running — see PROGRESS.md for the run conditions',
    },
    firstLoadJs: js,
    firstLoadJsNote: jsNote,
    pages,
    verdict,
  };
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', 'utf8');

  const failures = verdict.rows.filter((r) => !r.ok);
  console.log('');
  if (failures.length === 0) {
    console.log(`[perf] PASS — ${verdict.rows.length} budget lines within budget. Report ${path.relative(APP, outPath)}`);
    return 0;
  }
  console.log(`[perf] FAIL — ${failures.length} of ${verdict.rows.length} budget lines over budget:`);
  for (const f of failures) {
    console.log(`         ${f.profile.padEnd(7)} ${f.page.padEnd(18)} ${f.metric}: ${f.value ?? 'not observed'} > ${f.budget}`);
  }
  console.log(`[perf] Report ${path.relative(APP, outPath)}`);
  return 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`[perf] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  },
);
