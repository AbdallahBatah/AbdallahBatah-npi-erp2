// The arithmetic behind scripts/perf.mjs (T-39), kept free of I/O so
// tests/perf-lib.spec.ts can check it. CommonJS on purpose: Jest loads it
// without a transform and perf.mjs imports it as a default export.
'use strict';

/** Median of a non-empty list of numbers; null for an empty one. */
function median(values) {
  const sorted = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Cumulative Layout Shift as web-vitals defines it: layout-shift entries
 * without recent input are grouped into session windows (a new window when
 * the gap to the previous shift exceeds 1 s or the window would exceed 5 s),
 * and CLS is the largest window's sum. `shifts` = [{ t: startTime ms, v: value }].
 */
function clsFromShifts(shifts) {
  const sorted = [...shifts].sort((a, b) => a.t - b.t);
  let best = 0;
  let sum = 0;
  let windowStart = -Infinity;
  let previous = -Infinity;
  for (const shift of sorted) {
    const startsNewWindow = shift.t - previous > 1000 || shift.t - windowStart > 5000;
    if (startsNewWindow) {
      sum = 0;
      windowStart = shift.t;
    }
    sum += shift.v;
    previous = shift.t;
    if (sum > best) best = sum;
  }
  return best;
}

/**
 * Interaction to Next Paint from Event Timing entries: the longest duration
 * per interaction (entries sharing an `interactionId`), then the worst
 * interaction when there are fewer than fifty and the 98th percentile above
 * that. Entries without an interaction id (plain events) do not count.
 * `events` = [{ d: duration ms, id: interactionId }]. Null when none.
 */
function inpFromEvents(events) {
  const worstById = new Map();
  for (const event of events) {
    if (!event.id) continue;
    const seen = worstById.get(event.id) ?? 0;
    if (event.d > seen) worstById.set(event.id, event.d);
  }
  if (worstById.size === 0) return null;
  const durations = [...worstById.values()].sort((a, b) => b - a);
  const index = Math.min(Math.floor(durations.length / 50), durations.length - 1);
  return durations[index];
}

/**
 * The JavaScript a route downloads on first load, from Next's build manifests:
 * the chunks every route shares (`build-manifest.json` rootMainFiles) plus the
 * route's own entry in `app-build-manifest.json`, scripts only, each file
 * counted once. `sizeOf(file)` returns { raw, gzip } in bytes for a file path
 * relative to `.next/`.
 */
function firstLoadJs({ appManifest, buildManifest, route, sizeOf }) {
  const pageFiles = appManifest.pages?.[route];
  if (!pageFiles) throw new Error(`app-build-manifest has no entry for ${route}`);
  const files = [...new Set([...(buildManifest.rootMainFiles ?? []), ...pageFiles])].filter((f) => /\.js$/.test(f)).sort();
  let raw = 0;
  let gzip = 0;
  for (const file of files) {
    const size = sizeOf(file);
    raw += size.raw;
    gzip += size.gzip;
  }
  return { route, files, rawBytes: raw, gzipBytes: gzip };
}

/** The app-router routes of the manifest that render a page (not layouts, not the 404s). */
function pageRoutes(appManifest) {
  return Object.keys(appManifest.pages ?? {})
    .filter((route) => route.endsWith('/page') && !/not-found/.test(route))
    .sort();
}

/**
 * Every budget line of a run: one row per (page, profile, metric) for the
 * web vitals and one per route for the first-load JavaScript. `ok` is false
 * when the measured value exceeds its budget; a null measurement (nothing
 * observed) is reported as its own row with ok = false, so a silent observer
 * can never pass the gate.
 *
 * pages: [{ path, profile, lcpMs, inpMs, cls, ttfbMs }]
 * js:    [{ route, gzipBytes }]
 */
function evaluateBudgets(budgets, { pages, js }) {
  const rows = [];
  const vitals = [
    ['lcpMs', 'LCP ms'],
    ['inpMs', 'INP ms'],
    ['cls', 'CLS'],
    ['ttfbMs', 'TTFB ms'],
  ];
  for (const page of pages) {
    for (const [key, label] of vitals) {
      const budget = budgets[key];
      if (typeof budget !== 'number') continue;
      const value = page[key];
      rows.push({
        kind: 'vital',
        metric: label,
        page: page.path,
        profile: page.profile,
        value,
        budget,
        ok: typeof value === 'number' && value <= budget,
      });
    }
  }
  if (typeof budgets.firstLoadJsKb === 'number') {
    for (const entry of js) {
      const kb = entry.gzipBytes / 1024;
      rows.push({
        kind: 'js',
        metric: 'first-load JS KB (gzip)',
        page: entry.route,
        profile: 'build',
        value: Math.round(kb * 10) / 10,
        budget: budgets.firstLoadJsKb,
        ok: kb <= budgets.firstLoadJsKb,
      });
    }
  }
  return { ok: rows.every((r) => r.ok), rows };
}

/**
 * Command line of scripts/perf.mjs. Unknown flags are an error, so a typo
 * never silently runs the default.
 */
function parseArgs(argv) {
  const out = {
    runs: 3,
    api: 'http://localhost:4000/api',
    url: null,
    skipBuild: false,
    profiles: ['desktop', 'mobile'],
    out: null,
    pages: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--runs': {
        const n = Number(next());
        if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error('--runs takes a whole number from 1 to 20');
        out.runs = n;
        break;
      }
      case '--api':
        out.api = next().replace(/\/+$/, '');
        break;
      case '--url':
        out.url = next().replace(/\/+$/, '');
        break;
      case '--skip-build':
        out.skipBuild = true;
        break;
      case '--profile': {
        const p = next();
        if (!['desktop', 'mobile', 'both'].includes(p)) throw new Error('--profile takes desktop, mobile or both');
        out.profiles = p === 'both' ? ['desktop', 'mobile'] : [p];
        break;
      }
      case '--out':
        out.out = next();
        break;
      case '--pages': {
        const list = next()
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean);
        if (list.length === 0 || list.some((p) => !p.startsWith('/'))) throw new Error('--pages takes comma-separated paths starting with /');
        out.pages = list;
        break;
      }
      case '--help':
      case '-h':
        out.help = true;
        break;
      default:
        throw new Error(`unknown flag ${arg}`);
    }
  }
  return out;
}

module.exports = { median, clsFromShifts, inpFromEvents, firstLoadJs, pageRoutes, evaluateBudgets, parseArgs };
