// Loads COPILOT_DATABASE_URL from the repository-root .env file into
// process.env, for tests that need a real database connection.
//
// Jest does not load .env automatically — only the npm scripts that wrap
// commands with `dotenv -e ../../.env --` (dev/start/migrate) do that. A
// test run via `jest` directly (e.g. `npm test -w @npi/copilot`) would
// otherwise see an empty COPILOT_DATABASE_URL, so this helper fills it in
// if — and only if — it is not already present in the environment.
//
// Never logs, throws-with, or otherwise exposes the loaded value: it
// carries a database password.
import * as fs from 'fs';
import * as path from 'path';

function parseEnvFile(contents: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/** apps/copilot/tests/helpers -> repository root (4 levels up). */
const REPO_ROOT_ENV_PATH = path.resolve(__dirname, '../../../../.env');

export function loadEnv(): void {
  if (process.env.COPILOT_DATABASE_URL && process.env.COPILOT_DATABASE_URL.trim().length > 0) {
    return;
  }

  let contents: string;
  try {
    contents = fs.readFileSync(REPO_ROOT_ENV_PATH, 'utf8');
  } catch (err) {
    throw new Error(
      `COPILOT_DATABASE_URL is not set and the repository-root .env file could not be read at ${REPO_ROOT_ENV_PATH}: ${
        (err as Error).message
      }`,
    );
  }

  const parsed = parseEnvFile(contents);
  if (parsed.COPILOT_DATABASE_URL) {
    process.env.COPILOT_DATABASE_URL = parsed.COPILOT_DATABASE_URL;
  }
}

// Run immediately on import so a test file only needs to import this module
// (for its side effect) before calling getDb().
loadEnv();
