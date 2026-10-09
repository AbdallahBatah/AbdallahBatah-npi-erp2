// T-39 performance budgets, judged by `npm run perf` (scripts/perf.mjs) on the
// median of its runs under Lighthouse's throttling. spec/madar/02 §10 defers
// to package 2.0 §11, which is not in the repository (PROGRESS.md D-7), so the
// figures are web.dev's Core Web Vitals «good» thresholds (the p75 bounds that
// Lighthouse applies under the same throttling) plus a first-load JavaScript
// ceiling per route — a regression guard, not a target to grow into.
const PERF_BUDGETS = {
  lcpMs: 2500, // largest contentful paint
  inpMs: 200, // interaction to next paint (the worst interaction of a run)
  cls: 0.1, // cumulative layout shift (largest session window)
  ttfbMs: 800, // time to first byte — the server side: queries and indexes (migration 0009)
  firstLoadJsKb: 200, // JavaScript a route downloads on first load, gzip, from the build manifests
  // Lines the owner accepted as a known limit of the lab profile (PROGRESS.md
  // decisions). Such a line may sit between its budget and the ceiling without
  // failing the gate — it is still printed and recorded as over budget, never
  // as a pass — and beyond the ceiling it fails like any other line, so a real
  // regression on it is still caught. Each entry names the decision that
  // allows it and the task that re-decides it.
  knownLimits: [
    {
      path: '/copilot/trust',
      profile: 'mobile',
      metric: 'inpMs',
      ceiling: 500, // the top of web.dev's «needs improvement» band; «poor» above it
      decision: 'D-25',
      reason:
        'the arrival of the eight web-font files on the throttled link occupies the main thread once per cold visit (INP 48 with the fonts blocked); on this screen alone it coincides with the gate\'s key presses',
      until: 'T-43 — the live gate on the demo server re-measures this line',
    },
  ],
};

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  basePath: '/copilot',
  // Lint is available separately via `next lint`; it does not block the build.
  eslint: { ignoreDuringBuilds: true },
  // Docker builds set NEXT_OUTPUT=standalone; local dev/build stays untouched.
  ...(process.env.NEXT_OUTPUT === 'standalone' ? { output: 'standalone' } : {}),
  // pdfjs' own worker file and @napi-rs/canvas' native binding must be
  // loaded by Node from node_modules at runtime, not bundled by webpack.
  experimental: { serverComponentsExternalPackages: ['pdf-parse', 'pdfjs-dist', '@napi-rs/canvas', 'heic-convert'] },
};

module.exports = nextConfig;
// Read by scripts/perf.mjs. Not a Next option: kept off the config object's
// enumerable keys so Next's option validation does not report it as unknown.
Object.defineProperty(module.exports, 'perfBudgets', { value: PERF_BUDGETS, enumerable: false });
