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
