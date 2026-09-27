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

// `dotenv -v` puts the values on the process itself. Passing them through
// Playwright's `env` and two nested npm scripts lost them on Windows.
const apiCommand = [
  'npx dotenv -e ../../.env',
  `-v API_PORT=${API_PORT}`,
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
  use: {
    baseURL: COPILOT_BASE,
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
  webServer: [
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
