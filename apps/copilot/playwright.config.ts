import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// The e2e run brings up its own NPI API and its own copilot on ports of
// their own, so it never collides with a developer's running servers (or
// with anything else on the machine that holds 3100 or 4000) and never
// depends on how those were started.
const API_PORT = process.env.COPILOT_E2E_API_PORT ?? '4077';
const COPILOT_PORT = process.env.COPILOT_E2E_PORT ?? '3177';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const API_BASE = `http://localhost:${API_PORT}/api`;
const COPILOT_BASE = `http://localhost:${COPILOT_PORT}`;

// T-43 (@live-demo): a deployed stack — the demo server, or a local
// production build — serves the tests; nothing is started here.
const LIVE_BASE = process.env.COPILOT_LIVE_BASE?.replace(/\/$/, '');

// `dotenv -v` puts the values on the process itself. Passing them through
// Playwright's `env` and two nested npm scripts lost them on Windows.
// The e2e api reads its own copy of NPI's database, `npi_erp_e2e`, prepared
// by packages/db/prisma/madar-e2e-db.mjs before the api starts (T-38): the
// developer's `npi_erp` is shared by every worktree of this repository, and a
// newer branch's rows (an enum value this checkout does not know) break the
// api started from here. `COPILOT_E2E_SHARED_NPI_DB=1` keeps the old
// behaviour (run against `npi_erp` itself).
const E2E_DB_SCRIPT = path.join(REPO_ROOT, 'packages', 'db', 'prisma', 'madar-e2e-db.mjs');
const npiDatabaseUrl = process.env.COPILOT_E2E_SHARED_NPI_DB ? null : e2eNpiDatabaseUrl();

/** DATABASE_URL from the repository's .env with the database swapped for the e2e copy. */
function e2eNpiDatabaseUrl(): string {
  const envFile = path.join(REPO_ROOT, '.env');
  const line = fs
    .readFileSync(envFile, 'utf8')
    .split(/\r?\n/)
    .find((l) => /^\s*DATABASE_URL\s*=/.test(l));
  if (!line) throw new Error(`playwright.config.ts: ${envFile} has no DATABASE_URL line`);
  const url = new URL(line.replace(/^\s*DATABASE_URL\s*=\s*/, '').trim().replaceAll(/^["']|["']$/g, ''));
  if (url.pathname !== '/npi_erp') throw new Error(`playwright.config.ts: DATABASE_URL names ${url.pathname.slice(1)}, expected npi_erp`);
  url.pathname = '/npi_erp_e2e';
  return url.toString();
}

const apiCommand = [
  ...(npiDatabaseUrl ? [`node "${E2E_DB_SCRIPT}" &&`] : []),
  'npx dotenv -e ../../.env',
  `-v API_PORT=${API_PORT}`,
  ...(npiDatabaseUrl ? [`-v DATABASE_URL=${npiDatabaseUrl}`] : []),
  // NPI throttles logins per IP (5 a minute). The rate-limit test has to
  // reach the copilot's own limit first.
  '-v AUTH_THROTTLE_LIMIT=1000',
  '-- npx nest start',
].join(' ');

const copilotCommand = [
  'node scripts/ensure-session-key.mjs &&',
  'npx dotenv -e ../../.env',
  `-v NPI_API_BASE=${API_BASE}`,
  `-- npx next dev -p ${COPILOT_PORT}`,
].join(' ');

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results',
  fullyParallel: false,
  // One worker: both projects share the same servers and the same
  // login-attempt and session tables.
  workers: 1,
  retries: 0,
  reporter: 'list',
  // `e2e/setup-live.spec.ts` (T-20) writes real data into a live NPI
  // organization and is never part of the default run — only
  // `npm run e2e:live-setup` (COPILOT_LIVE=1) executes it.
  grepInvert: process.env.COPILOT_LIVE ? undefined : /@live/,
  use: {
    baseURL: LIVE_BASE ?? COPILOT_BASE,
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'mobile',
      use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } },
    },
  ],
  webServer: LIVE_BASE
    ? undefined
    : [
        {
          command: apiCommand,
          cwd: path.join(REPO_ROOT, 'apps', 'api'),
          url: `${API_BASE}/health`,
          reuseExistingServer: false,
          timeout: 180_000,
        },
        {
          command: copilotCommand,
          cwd: path.join(REPO_ROOT, 'apps', 'copilot'),
          url: `${COPILOT_BASE}/copilot/login`,
          reuseExistingServer: false,
          timeout: 180_000,
        },
      ],
});
