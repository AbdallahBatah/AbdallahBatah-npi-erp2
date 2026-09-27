#!/usr/bin/env node
// Regenerates apps/copilot/src/npi/types.ts from NPI's OpenAPI document.
//
// Default (no flag): fully offline. Reads the already-committed
// src/npi/openapi.json and (re)generates types.ts from it. No network call,
// no running API required — safe to run in CI or with the API down.
//
// --fetch: downloads a fresh spec from `${NPI_API_BASE}/docs-json` first,
// validates it is a real OpenAPI 3 document with a non-empty `paths`, and
// only then overwrites the committed openapi.json (pretty-printed with
// stable, alphabetized key order so diffs are minimal) before generating.
// If the download fails, 404s, or the body doesn't look like a valid spec,
// this prints a clear message and exits 1 WITHOUT touching the committed
// file — a bad fetch must never corrupt the checked-in schema.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import openapiTS, { astToString } from 'openapi-typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NPI_DIR = path.join(__dirname, '..', 'src', 'npi');
const SPEC_PATH = path.join(NPI_DIR, 'openapi.json');
const TYPES_PATH = path.join(NPI_DIR, 'types.ts');

const FETCH_FLAG = '--fetch';
const shouldFetch = process.argv.includes(FETCH_FLAG);

/** Deterministic JSON.stringify: object keys sorted recursively so a
 *  re-fetch of an unchanged spec produces a byte-identical file. */
function stableStringify(value) {
  return JSON.stringify(sortKeysDeep(value), null, 2);
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysDeep(value[key]);
    }
    return sorted;
  }
  return value;
}

function looksLikeOpenApi3(doc) {
  return (
    !!doc &&
    typeof doc === 'object' &&
    typeof doc.openapi === 'string' &&
    doc.openapi.startsWith('3') &&
    !!doc.paths &&
    typeof doc.paths === 'object' &&
    Object.keys(doc.paths).length > 0
  );
}

async function fetchSpec() {
  const base = process.env.NPI_API_BASE ?? 'http://localhost:4000/api';
  const url = `${base}/docs-json`;

  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    console.error(
      `[gen-npi-types] Could not reach ${url} (${err instanceof Error ? err.message : String(err)}).\n` +
        `The NPI API must be running with EXPOSE_API_DOCS=1 for --fetch to work.`,
    );
    process.exit(1);
  }

  if (!res.ok) {
    console.error(
      `[gen-npi-types] ${url} responded with HTTP ${res.status}.\n` +
        `The NPI API must be running with EXPOSE_API_DOCS=1 (docs-json is only exposed then).`,
    );
    process.exit(1);
  }

  let doc;
  try {
    doc = await res.json();
  } catch {
    console.error(`[gen-npi-types] ${url} did not return valid JSON.`);
    process.exit(1);
  }

  if (!looksLikeOpenApi3(doc)) {
    console.error(
      `[gen-npi-types] ${url} did not return a valid OpenAPI 3 document (missing/empty "paths" or wrong "openapi" version).`,
    );
    process.exit(1);
  }

  return doc;
}

async function main() {
  let spec;

  if (shouldFetch) {
    const doc = await fetchSpec();
    // Only touch the committed file once we know the download is good.
    await writeFile(SPEC_PATH, `${stableStringify(doc)}\n`, 'utf8');
    spec = doc;
  } else {
    const raw = await readFile(SPEC_PATH, 'utf8');
    spec = JSON.parse(raw);
  }

  const ast = await openapiTS(spec, { alphabetize: false });
  const body = astToString(ast);

  const header =
    '/**\n' +
    ' * GENERATED FILE. Do not edit by hand.\n' +
    ' * Source: apps/copilot/src/npi/openapi.json\n' +
    ` * NPI OpenAPI info.version: ${spec?.info?.version ?? 'unknown'}\n` +
    ' * Regenerate with: npm run copilot:gen-types (add --fetch to pull a fresh spec from a running API)\n' +
    ' */\n\n';

  await writeFile(TYPES_PATH, header + body, 'utf8');
  console.log(`[gen-npi-types] wrote ${path.relative(process.cwd(), TYPES_PATH)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
