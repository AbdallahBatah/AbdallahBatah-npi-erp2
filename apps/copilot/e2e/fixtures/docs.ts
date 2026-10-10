// Fixtures for e2e/scenarios.spec.ts (T-31, AT-01…AT-06): the eval documents
// the live scenarios upload, and the values the spec asserts against.
//
// The documents are the repository's own eval set (`eval/extract/<flow>/`),
// not copies: the spec uploads exactly the bytes `npm run eval:extract`
// measures. Every expected value comes from that flow's `expected.json` at
// run time — the spec never retypes a value the eval set already holds, so a
// changed document and its expectation can never drift apart in two places.
//
// Nothing here talks to NPI, the copilot's database or the model.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';

export type EvalFlow = 'customer_contract' | 'vendor_bill' | 'grn';

export interface EvalDoc {
  flow: EvalFlow;
  file: string;
  mime: 'application/pdf' | 'image/jpeg';
  /** Absolute path of the file under `eval/extract/<flow>/`. */
  path: string;
}

function evalDoc(flow: EvalFlow, file: string, mime: EvalDoc['mime']): EvalDoc {
  const resolved = path.resolve(__dirname, '..', '..', 'eval', 'extract', flow, file);
  if (!fs.existsSync(resolved)) {
    throw new Error(`e2e/fixtures/docs.ts: the eval document ${flow}/${file} is missing at ${resolved}`);
  }
  return { flow, file, mime, path: resolved };
}

/**
 * The four documents of the live scenarios (`06` §1):
 *  - `contract01` AT-01 (new customer, three milestones with percentages);
 *  - `contract02` AT-02 (the seeded customer, matched by VAT number, four milestones);
 *  - `bill01` AT-04 — `06` names `bill-04.jpg`, but the repository's `bill-04` is a
 *    text PDF in USD with no receipt; `bill-01.jpg` is the photo the scenario
 *    describes (D-T31-2);
 *  - `grn01` AT-05.
 * The module throws at load when a file is missing, naming the path.
 */
export const EVAL_DOCS: { contract01: EvalDoc; contract02: EvalDoc; bill01: EvalDoc; grn01: EvalDoc } = {
  contract01: evalDoc('customer_contract', 'contract-01.pdf', 'application/pdf'),
  contract02: evalDoc('customer_contract', 'contract-02.pdf', 'application/pdf'),
  bill01: evalDoc('vendor_bill', 'bill-01.jpg', 'image/jpeg'),
  grn01: evalDoc('grn', 'grn-01.jpg', 'image/jpeg'),
};

export function evalDocBytes(doc: EvalDoc): Buffer {
  return fs.readFileSync(doc.path);
}

/**
 * AT-06's file name: `src/intake/sensitivity.ts` refuses a document whose
 * NAME holds «سري» as a whole word (`-` and `_` count as word breaks), before
 * any text is read and before any model call. The one Arabic literal here.
 */
export const CONFIDENTIAL_FILE_NAME = 'عقد-سري.pdf';

// ─── expected.json ──────────────────────────────────────────────────────────

export interface EvalExpected {
  file: string;
  titleAr: string;
  fields: Record<string, string | number | null | (string | number)[]>;
  status?: Record<string, 'confirmed' | 'unconfirmed'>;
}

const cache = new Map<EvalFlow, unknown[]>();

function entriesOf(flow: EvalFlow): unknown[] {
  let entries = cache.get(flow);
  if (entries === undefined) {
    const file = path.resolve(__dirname, '..', '..', 'eval', 'extract', flow, 'expected.json');
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error(`${file}: expected a JSON array of entries`);
    entries = parsed;
    cache.set(flow, entries);
  }
  return entries;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The entry of `eval/extract/<flow>/expected.json` whose `file` is `doc.file`.
 * Entries that carry `text` instead of `file` (an eval case with no document)
 * are skipped, not errors. Throws when no entry names the file.
 */
export function evalExpected(doc: EvalDoc): EvalExpected {
  const entry = entriesOf(doc.flow).find((e) => isRecord(e) && e.file === doc.file);
  if (!isRecord(entry)) throw new Error(`eval/extract/${doc.flow}/expected.json has no entry for ${doc.file}`);
  if (typeof entry.titleAr !== 'string') throw new Error(`expected.json entry ${doc.file}: "titleAr" is not a string`);
  if (!isRecord(entry.fields)) throw new Error(`expected.json entry ${doc.file}: "fields" is not an object`);
  const status = entry.status;
  if (status !== undefined && !isRecord(status)) throw new Error(`expected.json entry ${doc.file}: "status" is not an object`);
  return {
    file: doc.file,
    titleAr: entry.titleAr,
    fields: entry.fields as EvalExpected['fields'],
    status: status as EvalExpected['status'],
  };
}

function fieldOf(e: EvalExpected, fieldPath: string): EvalExpected['fields'][string] {
  if (!(fieldPath in e.fields)) throw new Error(`expected.json entry ${e.file} has no field "${fieldPath}"`);
  return e.fields[fieldPath];
}

function describeType(value: unknown): string {
  return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
}

export function expectedString(e: EvalExpected, fieldPath: string): string {
  const value = fieldOf(e, fieldPath);
  if (typeof value !== 'string') throw new Error(`expected.json entry ${e.file}: "${fieldPath}" is ${describeType(value)}, not a string`);
  return value;
}

export function expectedNumber(e: EvalExpected, fieldPath: string): number {
  const value = fieldOf(e, fieldPath);
  if (typeof value !== 'number') throw new Error(`expected.json entry ${e.file}: "${fieldPath}" is ${describeType(value)}, not a number`);
  return value;
}

/**
 * A count: either a `*.length` field (`milestones.length`, `lines.length` —
 * stored as a number) or the length of a list-valued field
 * (`lines.0.serials`).
 */
export function expectedLength(e: EvalExpected, fieldPath: string): number {
  const value = fieldOf(e, fieldPath);
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'number' && fieldPath.endsWith('.length')) return value;
  throw new Error(`expected.json entry ${e.file}: "${fieldPath}" is ${describeType(value)}, neither a list nor a "*.length" number`);
}

// ─── Browser ────────────────────────────────────────────────────────────────

/**
 * Attaches `doc` through the composer's hidden file input (`attach-input`,
 * `src/components/chat/Composer.tsx`) — the same control a user's file picker
 * fills. `fileName` overrides the uploaded name (AT-06 uploads contract-01's
 * bytes under `CONFIDENTIAL_FILE_NAME`).
 */
export async function attachEvalDoc(page: Page, doc: EvalDoc, fileName: string = doc.file): Promise<void> {
  await page.locator('[data-testid="attach-input"]').setInputFiles({ name: fileName, mimeType: doc.mime, buffer: evalDocBytes(doc) });
}
