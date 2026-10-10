#!/usr/bin/env node
/**
 * Dev-only: gives the copilot's Playwright run its own NPI database,
 * `npi_erp_e2e`, copied from the developer's `npi_erp` and stripped of rows
 * this checkout's Prisma client cannot read.
 *
 * Why (T-38 finding): the local `npi_erp` is shared by every worktree of this
 * repository. A branch that adds a value to an enum and writes a row with it
 * (the CRM worktree's migration 0027 added an `ApprovalRule` for `PROPOSAL`)
 * makes the NPI api of an OLDER branch fail every read of that table
 * («Value 'PROPOSAL' not found in enum 'ApprovalDocument'»), and the copilot's
 * e2e run — which starts that api from this checkout — fails with it. The e2e
 * api therefore reads a copy that matches this checkout's schema.
 *
 * What it does (idempotent):
 *   1. reads DATABASE_URL from the repository's `.env`; refuses anything that is
 *      not a local `npi_erp` (never a server);
 *   2. if `npi_erp_e2e` is missing (or `--refresh` is given): drops it, creates
 *      it and copies `npi_erp` into it with `pg_dump | psql`, through the
 *      `npi-erp-postgres` container (docker-compose.yml); the copy keeps the
 *      same ids as `npi_erp`, so the copilot's own `npi_copilot` rows
 *      (positions, firm config, memory) still line up with it;
 *   3. deletes approval rules and requests whose `documentType` is not in
 *      this checkout's `ApprovalDocument` enum (parsed from schema.prisma) — the
 *      only rows a newer branch writes that an older client refuses to read.
 *
 * Usage:
 *   node packages/db/prisma/madar-e2e-db.mjs             # create when missing
 *   node packages/db/prisma/madar-e2e-db.mjs --refresh   # drop and copy again
 *
 * `apps/copilot/playwright.config.ts` runs this before starting the e2e api and
 * points the api at the copy. Nothing here touches `npi_erp` except to read it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const SCHEMA = resolve(HERE, 'schema.prisma');
const ENV_FILE = resolve(REPO_ROOT, '.env');
const CONTAINER = process.env.NPI_PG_CONTAINER ?? 'npi-erp-postgres';
export const SOURCE_DB = 'npi_erp';
export const E2E_DB = 'npi_erp_e2e';

function fail(message) {
  console.error(`madar-e2e-db: ${message}`);
  process.exit(1);
}

/** The repository's NPI connection URL, parsed; refuses a non-local one. */
export function readLocalNpiUrl() {
  if (!existsSync(ENV_FILE)) fail(`${ENV_FILE} not found`);
  const line = readFileSync(ENV_FILE, 'utf8')
    .split(/\r?\n/)
    .find((l) => /^\s*DATABASE_URL\s*=/.test(l));
  if (!line) fail('.env has no DATABASE_URL line');
  const raw = line.replace(/^\s*DATABASE_URL\s*=\s*/, '').trim().replace(/^["']|["']$/g, '');
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail('DATABASE_URL is not a URL');
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) fail('DATABASE_URL is not a postgres URL');
  if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    fail(`DATABASE_URL host is ${url.hostname}; this script only ever runs against a local database`);
  }
  if (url.pathname !== `/${SOURCE_DB}`) fail(`DATABASE_URL names ${url.pathname.slice(1)}, expected ${SOURCE_DB}`);
  return url;
}

/** The same URL with the database swapped for the e2e copy. */
export function e2eNpiUrl(url = readLocalNpiUrl()) {
  const copy = new URL(url.toString());
  copy.pathname = `/${E2E_DB}`;
  return copy.toString();
}

/** The values of `enum ApprovalDocument` in this checkout's schema. */
function approvalDocumentValues() {
  const schema = readFileSync(SCHEMA, 'utf8');
  const match = schema.match(/enum ApprovalDocument \{([\s\S]*?)\}/);
  if (!match) fail('schema.prisma has no enum ApprovalDocument');
  const values = match[1]
    .split(/\r?\n/)
    .map((l) => l.replace(/\/\/.*$/, '').trim())
    .filter((l) => /^[A-Z_]+$/.test(l));
  if (values.length === 0) fail('enum ApprovalDocument has no values');
  return values;
}

function docker(args, input) {
  return execFileSync('docker', ['exec', '-i', CONTAINER, ...args], {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
    maxBuffer: 1024 * 1024 * 256,
  });
}

function psql(user, db, sql) {
  return docker(['psql', '-U', user, '-d', db, '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql]);
}

function databaseExists(user, name) {
  return psql(user, 'postgres', `SELECT 1 FROM pg_database WHERE datname = '${name}'`).trim() === '1';
}

export function ensureE2eDatabase({ refresh = false } = {}) {
  const url = readLocalNpiUrl();
  const user = decodeURIComponent(url.username);
  if (!user) fail('DATABASE_URL has no user');

  if (refresh && databaseExists(user, E2E_DB)) {
    psql(user, 'postgres', `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${E2E_DB}'`);
    psql(user, 'postgres', `DROP DATABASE "${E2E_DB}"`);
    console.log(`madar-e2e-db: dropped ${E2E_DB}`);
  }

  if (!databaseExists(user, E2E_DB)) {
    psql(user, 'postgres', `CREATE DATABASE "${E2E_DB}"`);
    // One shell inside the container: dump the source straight into the copy.
    docker(['sh', '-c', `pg_dump -U ${user} ${SOURCE_DB} | psql -U ${user} -d ${E2E_DB} -q -v ON_ERROR_STOP=0 > /dev/null`]);
    console.log(`madar-e2e-db: copied ${SOURCE_DB} into ${E2E_DB}`);
  }

  // Strip what this checkout's client cannot read (see the file comment).
  const known = approvalDocumentValues().map((v) => `'${v}'`).join(', ');
  const steps = psql(
    user,
    E2E_DB,
    `DELETE FROM "ApprovalRuleStep" WHERE "ruleId" IN (SELECT "id" FROM "ApprovalRule" WHERE "documentType"::text NOT IN (${known}))`,
  );
  const rules = psql(user, E2E_DB, `DELETE FROM "ApprovalRule" WHERE "documentType"::text NOT IN (${known})`);
  const requests = psql(user, E2E_DB, `DELETE FROM "ApprovalRequest" WHERE "documentType"::text NOT IN (${known})`);
  const count = (out) => Number((out.match(/DELETE (\d+)/) ?? [0, 0])[1]);
  const removed = count(steps) + count(rules) + count(requests);
  console.log(
    `madar-e2e-db: ${E2E_DB} ready (ApprovalDocument = ${approvalDocumentValues().join(', ')}; ${removed} foreign row(s) removed)`,
  );
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  ensureE2eDatabase({ refresh: process.argv.includes('--refresh') });
}
