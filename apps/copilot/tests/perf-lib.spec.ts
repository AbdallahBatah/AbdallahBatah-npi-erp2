// T-39: the arithmetic of the performance gate (scripts/perf-lib.js) and the
// wiring around it — the budgets next.config.js exposes and the npm script.
import fs from 'node:fs';
import path from 'node:path';
import lib from '../scripts/perf-lib';

const APP_ROOT = path.resolve(__dirname, '..');

describe('perf-lib: median', () => {
  it('returns the middle value, the mean of the two middle values, and null for nothing', () => {
    expect(lib.median([3, 1, 2])).toBe(2);
    expect(lib.median([4, 1, 3, 2])).toBe(2.5);
    expect(lib.median([7])).toBe(7);
    expect(lib.median([])).toBeNull();
    expect(lib.median([null as unknown as number, 5, Number.NaN])).toBe(5);
  });
});

describe('perf-lib: cumulative layout shift (session windows)', () => {
  it('sums shifts that fall within one second of each other', () => {
    expect(lib.clsFromShifts([{ t: 100, v: 0.02 }, { t: 900, v: 0.03 }, { t: 1700, v: 0.01 }])).toBeCloseTo(0.06);
  });

  it('starts a new window after a gap of more than one second and keeps the largest', () => {
    const shifts = [
      { t: 100, v: 0.05 },
      { t: 200, v: 0.05 },
      { t: 3000, v: 0.02 }, // gap 2.8 s → new window
      { t: 3100, v: 0.01 },
    ];
    expect(lib.clsFromShifts(shifts)).toBeCloseTo(0.1);
  });

  it('caps a window at five seconds', () => {
    const shifts = [];
    for (let t = 0; t <= 6000; t += 500) shifts.push({ t, v: 0.01 });
    // 0…5000 is one window (11 shifts), 5500 and 6000 start another.
    expect(lib.clsFromShifts(shifts)).toBeCloseTo(0.11);
  });

  it('is zero without shifts and ignores order of arrival', () => {
    expect(lib.clsFromShifts([])).toBe(0);
    expect(lib.clsFromShifts([{ t: 900, v: 0.03 }, { t: 100, v: 0.02 }])).toBeCloseTo(0.05);
  });
});

describe('perf-lib: interaction to next paint', () => {
  it('takes the worst duration per interaction and the worst interaction when there are under fifty', () => {
    const events = [
      { d: 40, id: 1 },
      { d: 120, id: 1 }, // keyup of the same interaction
      { d: 80, id: 2 },
      { d: 300, id: 0 }, // not an interaction (no id) — ignored
    ];
    expect(lib.inpFromEvents(events)).toBe(120);
  });

  it('moves to the 98th percentile above fifty interactions', () => {
    const events = [];
    for (let id = 1; id <= 100; id += 1) events.push({ d: id * 10, id });
    // 100 interactions → index floor(100 / 50) = 2 from the top: 1000, 990, 980.
    expect(lib.inpFromEvents(events)).toBe(980);
  });

  it('is null when no interaction was observed', () => {
    expect(lib.inpFromEvents([])).toBeNull();
    expect(lib.inpFromEvents([{ d: 50, id: 0 }])).toBeNull();
  });
});

describe('perf-lib: first-load JavaScript from the build manifests', () => {
  const appManifest = {
    pages: {
      '/layout': ['static/chunks/webpack-1.js', 'static/chunks/main-app-1.js', 'static/chunks/app/layout-1.js', 'static/css/a.css'],
      '/page': ['static/chunks/webpack-1.js', 'static/chunks/main-app-1.js', 'static/chunks/app/layout-1.js', 'static/chunks/app/page-1.js'],
      '/trust/page': ['static/chunks/webpack-1.js', 'static/chunks/main-app-1.js', 'static/chunks/app/trust/page-1.js'],
      '/_not-found/page': ['static/chunks/webpack-1.js'],
      '/not-found': ['static/chunks/webpack-1.js'],
    },
  };
  const buildManifest = { rootMainFiles: ['static/chunks/webpack-1.js', 'static/chunks/main-app-1.js'] };
  const sizes: Record<string, { raw: number; gzip: number }> = {
    'static/chunks/webpack-1.js': { raw: 4000, gzip: 1000 },
    'static/chunks/main-app-1.js': { raw: 100000, gzip: 30000 },
    'static/chunks/app/layout-1.js': { raw: 20000, gzip: 6000 },
    'static/chunks/app/page-1.js': { raw: 10000, gzip: 3000 },
    'static/chunks/app/trust/page-1.js': { raw: 8000, gzip: 2500 },
  };
  const sizeOf = (file: string) => {
    const size = sizes[file];
    if (!size) throw new Error(`unexpected file ${file}`);
    return size;
  };

  it('lists the page routes only (no layouts, no not-found entries)', () => {
    expect(lib.pageRoutes(appManifest)).toEqual(['/page', '/trust/page']);
  });

  it('counts the shared chunks and the route chunks once each, scripts only', () => {
    const home = lib.firstLoadJs({ appManifest, buildManifest, route: '/page', sizeOf });
    expect(home.files).toEqual([
      'static/chunks/app/layout-1.js',
      'static/chunks/app/page-1.js',
      'static/chunks/main-app-1.js',
      'static/chunks/webpack-1.js',
    ]);
    expect(home.rawBytes).toBe(134000);
    expect(home.gzipBytes).toBe(40000);
    const trust = lib.firstLoadJs({ appManifest, buildManifest, route: '/trust/page', sizeOf });
    expect(trust.gzipBytes).toBe(33500);
  });

  it('refuses a route the manifest does not know', () => {
    expect(() => lib.firstLoadJs({ appManifest, buildManifest, route: '/nowhere/page', sizeOf })).toThrow(/no entry/);
  });
});

describe('perf-lib: budgets', () => {
  const budgets = { lcpMs: 2500, inpMs: 200, cls: 0.1, ttfbMs: 800, firstLoadJsKb: 200 };

  it('passes when every median and every route is within budget', () => {
    const verdict = lib.evaluateBudgets(budgets, {
      pages: [{ path: '/copilot', profile: 'mobile', lcpMs: 2400, inpMs: 200, cls: 0.05, ttfbMs: 300 }],
      js: [{ route: '/page', gzipBytes: 200 * 1024 }],
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.rows).toHaveLength(5);
    expect(verdict.rows.every((r) => r.ok)).toBe(true);
  });

  it('fails the one line that is over budget and names it', () => {
    const verdict = lib.evaluateBudgets(budgets, {
      pages: [{ path: '/copilot/trust', profile: 'desktop', lcpMs: 2501, inpMs: 50, cls: 0, ttfbMs: 100 }],
      js: [{ route: '/trust/page', gzipBytes: 50 * 1024 }],
    });
    expect(verdict.ok).toBe(false);
    const failed = verdict.rows.filter((r) => !r.ok);
    expect(failed).toEqual([
      { kind: 'vital', metric: 'LCP ms', page: '/copilot/trust', profile: 'desktop', value: 2501, budget: 2500, ok: false },
    ]);
  });

  it('treats a metric that was never observed as a failure, never as a pass', () => {
    const verdict = lib.evaluateBudgets(budgets, {
      pages: [{ path: '/copilot', profile: 'desktop', lcpMs: 900, inpMs: null, cls: 0, ttfbMs: 100 }],
      js: [],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.rows.find((r) => r.metric === 'INP ms')).toMatchObject({ value: null, ok: false });
  });

  describe('known limits (D-25)', () => {
    const withLimit = {
      ...budgets,
      knownLimits: [{ path: '/copilot/trust', profile: 'mobile', metric: 'inpMs', ceiling: 500, decision: 'D-25' }],
    };
    const page = (inpMs: number | null, overrides: Record<string, unknown> = {}) => ({
      path: '/copilot/trust',
      profile: 'mobile',
      lcpMs: 1000,
      inpMs,
      cls: 0,
      ttfbMs: 100,
      ...overrides,
    });

    it('keeps the gate green for the accepted line between its budget and its ceiling, marked as accepted', () => {
      const verdict = lib.evaluateBudgets(withLimit, { pages: [page(248)], js: [] });
      expect(verdict.ok).toBe(true);
      expect(verdict.rows.find((r) => r.metric === 'INP ms')).toEqual({
        kind: 'vital',
        metric: 'INP ms',
        page: '/copilot/trust',
        profile: 'mobile',
        value: 248,
        budget: 200,
        ok: true,
        accepted: { decision: 'D-25', ceiling: 500 },
      });
    });

    it('fails the accepted line beyond its ceiling, and says which ceiling', () => {
      const verdict = lib.evaluateBudgets(withLimit, { pages: [page(501)], js: [] });
      expect(verdict.ok).toBe(false);
      expect(verdict.rows.find((r) => r.metric === 'INP ms')).toMatchObject({
        value: 501,
        ok: false,
        accepted: { decision: 'D-25', ceiling: 500 },
      });
    });

    it('does not mark the line when it is within budget, and never accepts an unobserved value', () => {
      const within = lib.evaluateBudgets(withLimit, { pages: [page(48)], js: [] });
      expect(within.rows.find((r) => r.metric === 'INP ms')).toEqual(
        expect.not.objectContaining({ accepted: expect.anything() }),
      );
      const unobserved = lib.evaluateBudgets(withLimit, { pages: [page(null)], js: [] });
      expect(unobserved.ok).toBe(false);
      expect(unobserved.rows.find((r) => r.metric === 'INP ms')).toMatchObject({ value: null, ok: false });
      expect(unobserved.rows.find((r) => r.metric === 'INP ms')).not.toHaveProperty('accepted');
    });

    it('applies to that screen, profile and metric only', () => {
      const other = lib.evaluateBudgets(withLimit, {
        pages: [
          page(248, { profile: 'desktop' }),
          page(248, { path: '/copilot/metrics' }),
          page(100, { lcpMs: 2600 }),
        ],
        js: [],
      });
      expect(other.ok).toBe(false);
      const failed = other.rows.filter((r) => !r.ok).map((r) => [r.page, r.profile, r.metric]);
      expect(failed).toEqual([
        ['/copilot/trust', 'desktop', 'INP ms'],
        ['/copilot/metrics', 'mobile', 'INP ms'],
        ['/copilot/trust', 'mobile', 'LCP ms'],
      ]);
      expect(other.rows.some((r) => 'accepted' in r)).toBe(false);
    });

    it('is declared in next.config.js for the one line D-25 accepted, with a ceiling and the task that re-decides it', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { perfBudgets } = require(path.join(APP_ROOT, 'next.config.js'));
      expect(perfBudgets.knownLimits).toEqual([
        expect.objectContaining({ path: '/copilot/trust', profile: 'mobile', metric: 'inpMs', ceiling: 500, decision: 'D-25' }),
      ]);
      expect(perfBudgets.knownLimits[0].until).toMatch(/T-43/);
      expect(perfBudgets.knownLimits[0].ceiling).toBeGreaterThan(perfBudgets.inpMs);
    });
  });

  it('reports first-load JS in KB to one decimal against the per-route budget', () => {
    const verdict = lib.evaluateBudgets(budgets, { pages: [], js: [{ route: '/page', gzipBytes: 205_000 }] });
    expect(verdict.rows).toEqual([
      { kind: 'js', metric: 'first-load JS KB (gzip)', page: '/page', profile: 'build', value: 200.2, budget: 200, ok: false },
    ]);
  });
});

describe('perf-lib: command line', () => {
  it('has the documented defaults', () => {
    expect(lib.parseArgs([])).toEqual({
      runs: 3,
      api: 'http://localhost:4000/api',
      url: null,
      skipBuild: false,
      profiles: ['desktop', 'mobile'],
      out: null,
      pages: null,
      block: null,
      help: false,
    });
  });

  it('reads every flag and strips trailing slashes from addresses', () => {
    const args = lib.parseArgs([
      '--runs', '5', '--api', 'http://localhost:4077/api/', '--url', 'http://localhost:3177/', '--skip-build',
      '--profile', 'mobile', '--out', 'r.json', '--pages', '/copilot, /copilot/trust', '--block', '.woff2',
    ]);
    expect(args).toEqual({
      runs: 5,
      api: 'http://localhost:4077/api',
      url: 'http://localhost:3177',
      skipBuild: true,
      profiles: ['mobile'],
      out: 'r.json',
      pages: ['/copilot', '/copilot/trust'],
      block: '.woff2',
      help: false,
    });
  });

  it('rejects an unknown flag, a bad run count, a bad profile and a bad page list', () => {
    expect(() => lib.parseArgs(['--run', '3'])).toThrow(/unknown flag --run/);
    expect(() => lib.parseArgs(['--runs', '0'])).toThrow(/1 to 20/);
    expect(() => lib.parseArgs(['--runs'])).toThrow(/needs a value/);
    expect(() => lib.parseArgs(['--profile', 'tablet'])).toThrow(/desktop, mobile or both/);
    expect(() => lib.parseArgs(['--pages', 'copilot'])).toThrow(/starting with \//);
    expect(() => lib.parseArgs(['--block', ' '])).toThrow(/non-empty/);
  });
});

describe('perf gate wiring', () => {
  it('next.config.js exposes positive budgets for the five metrics without adding a Next option', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const config = require(path.join(APP_ROOT, 'next.config.js')) as Record<string, unknown> & {
      perfBudgets: Record<string, number> & { knownLimits: unknown[] };
    };
    expect(Object.keys(config)).not.toContain('perfBudgets');
    for (const key of ['lcpMs', 'inpMs', 'cls', 'ttfbMs', 'firstLoadJsKb']) {
      expect(typeof config.perfBudgets[key]).toBe('number');
      expect(config.perfBudgets[key]).toBeGreaterThan(0);
    }
    expect(config.perfBudgets).toMatchObject({ lcpMs: 2500, inpMs: 200, cls: 0.1, ttfbMs: 800, firstLoadJsKb: 200 });
    // The only other key is the known-limits list (D-25); every limit names a
    // decision, a ceiling above the metric's budget and the task that re-decides it.
    expect(Object.keys(config.perfBudgets).sort()).toEqual(['cls', 'firstLoadJsKb', 'inpMs', 'knownLimits', 'lcpMs', 'ttfbMs']);
    for (const limit of config.perfBudgets.knownLimits as Array<Record<string, unknown>>) {
      expect(limit).toMatchObject({ decision: expect.stringMatching(/^D-\d+$/), until: expect.stringMatching(/T-\d+/) });
      expect(limit.ceiling).toBeGreaterThan(config.perfBudgets[limit.metric as string]);
    }
  });

  it('package.json runs scripts/perf.mjs as `npm run perf`', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts.perf).toBe('node scripts/perf.mjs');
    expect(fs.existsSync(path.join(APP_ROOT, 'scripts', 'perf.mjs'))).toBe(true);
  });

  it('migration 0009_indexes creates every index schema.prisma declares for T-39, plus the two partial ones', () => {
    const sql = fs.readFileSync(path.join(APP_ROOT, 'prisma', 'migrations', '0009_indexes', 'migration.sql'), 'utf8');
    const schema = fs.readFileSync(path.join(APP_ROOT, 'prisma', 'schema.prisma'), 'utf8');
    const expected = [
      ['llm_audit', ['npiOrgId', 'event', 'ts']],
      ['llm_audit', ['npiOrgId', 'documentId', 'ts']],
      ['intake_jobs', ['npiOrgId', 'approvedAt']],
      ['handover_docs', ['positionId', 'fromUserId']],
      ['handover_docs', ['toUserId']],
      ['memory_facts', ['npiOrgId', 'sourceType', 'updatedAt']],
    ] as const;
    for (const [table, columns] of expected) {
      const name = `${table}_${columns.join('_')}_idx`;
      expect(sql).toContain(`CREATE INDEX "${name}" ON "${table}"(${columns.map((c) => `"${c}"`).join(', ')})`);
      expect(schema).toContain(`@@index([${columns.join(', ')}])`);
    }
    expect(sql).toMatch(/CREATE INDEX "llm_audit_npiOrgId_imageSent_ts_idx" ON "llm_audit"\("npiOrgId", "ts"\) WHERE "imageSent"/);
    expect(sql).toMatch(/CREATE INDEX "llm_audit_npiOrgId_error_idx" ON "llm_audit"\("npiOrgId"\) WHERE "error" IS NOT NULL/);
    expect(sql).not.toMatch(/DROP|ALTER|DELETE|UPDATE/);
  });
});
