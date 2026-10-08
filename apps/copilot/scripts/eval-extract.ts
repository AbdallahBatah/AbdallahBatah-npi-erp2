// `npm run eval:extract -- [flow ...]` — field-accuracy evaluation of the
// extraction pipeline against the documents under `eval/extract/<flow>/`
// (T-23 for customer_contract; T-24 adds pr and po; T-25 adds grn and
// vendor_bill: five flows in all; T-36 runs the full set). Real model, real audit: every call goes through
// `createLlmClient` with the copilot database, so each run leaves its
// `llm_audit` rows and one `eval_runs` row like any other model traffic.
//
// Each `expected.json` entry names a PDF or a photo (`.jpg`/`.jpeg`/`.png`) —
// or, for the sentence-driven flows (pr, po, grn, vendor_bill), carries the
// employee's `text` and no document (`pages: []`, the sentence goes in as the
// user hint). Text PDFs go in as redacted page text. Photos and scanned PDFs go
// through the real T-22 intake path under a real consent event of
// `org_madar_eval`: `uploadDocument` -> `recordConsent` (approved) ->
// `requireConsent` -> `documentVisionBlocks` -> `runExtraction` with a vision
// source; the ConsentCard remains the only UI path to that consent. Photo
// files are rendered by `scripts/eval-extract-photos.ts` from the Word PDFs. `referenceDate` pins «today» so relative
// dates in a sentence («قبل الخميس», «خلال أسبوعين») resolve deterministically.
// An entry holds the plain values expected per
// dotted field path (`src/extract/run.ts flattenFields`), and optionally the
// status («confirmed»/«unconfirmed») a few fields must end up with. The
// score is correct fields / expected fields across the flow's documents;
// the gate is ≥ 0.90 (05 T-23). «confirmed but wrong» is reported on its
// own: it is the one outcome a preview card cannot protect the user from.
//
// Needs `ANTHROPIC_API_KEY` and `COPILOT_DATABASE_URL` in the root `.env`
// (dotenv is applied by the npm script). Vision entries also leave a
// `document` row and a `consent_event` row for `org_madar_eval`, and the
// stored copies under `test-results/extract/docs`.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getDb } from '../src/db';
import { FLOWS, flattenFields, isRegisteredFlow, runExtraction, type ExtractFailure, type ExtractionResult, type ExtractSource } from '../src/extract/run';
import { ConsentRequiredError, recordConsent, requireConsent } from '../src/intake/consent';
import { analyzePdf } from '../src/intake/pdf';
import { createFsStorage, uploadDocument, type DocumentStorage, type UploadCaller } from '../src/intake/upload';
import { createLlmClient } from '../src/llm/client';
import type { RedactedBlock } from '../src/llm/provider';
import { documentVisionBlocks, VisionInputError } from '../src/llm/vision';
import { createAnthropicProvider } from '../src/llm/providers/anthropic';
import { Pseudonymizer } from '../src/privacy/pseudonymizer';
import { normalizeArabic } from '../src/text/normalize';
import type { FlowType } from '../src/agents/router';

const GATE = 0.9;
const EVAL_ORG = 'org_madar_eval';
const EVAL_USER = 'eval:extract';
/** The firm the eval documents name as «our» party (the demo seed's organization). */
const OUR_PARTY_AR = 'شركة NPI للطاقة الشمسية';

interface ExpectedDoc {
  /** PDF (`.pdf`) or photo (`.jpg`/`.jpeg`/`.png`) under the flow directory. Exactly one of `file` / `text` is present. */
  file?: string;
  /** A sentence input (no document). */
  text?: string;
  /** YYYY-MM-DD pinned as «today» for relative dates; the runner defaults to the real date. */
  referenceDate?: string;
  titleAr: string;
  /** Expected value per dotted path; an array value is compared element by element. */
  fields: Record<string, string | number | null | (string | number)[]>;
  /** How `scripts/eval-extract-photos.ts` renders a `.jpg` entry (tilt in degrees, JPEG quality 1-100). */
  photo?: { rotateDeg?: number; quality?: number };
  /** How `scripts/eval-extract-scans.ts` builds a scanned (image-only) PDF from a text PDF of the same flow (T-36). */
  scan?: { source: string; rotateDeg?: number; quality?: number };
  status?: Record<string, 'confirmed' | 'unconfirmed'>;
}

interface FieldOutcome {
  path: string;
  expected: unknown;
  got: unknown;
  correct: boolean;
  status: 'confirmed' | 'unconfirmed' | 'absent';
}

interface DocOutcome {
  file: string;
  titleAr: string;
  /** How the document reached the model: page text, a typed sentence, or images under a consent event. */
  input: 'text' | 'sentence' | 'vision';
  ok: boolean;
  failure?: { reason: string; detail: string | null };
  pages: number;
  textChars: number;
  fields: FieldOutcome[];
  correct: number;
  total: number;
  confirmedWrong: number;
  statusMismatches: { path: string; expected: string; got: string }[];
  usage: { tokensIn: number; tokensOut: number; latencyMs: number; modelId: string } | null;
}

/** Letter folding plus whitespace removed: a Word PDF's text layer splits
 *  «6مم» into «6 مم» and the model copies what it sees (T-24, pr-08); the
 *  item is the same and so is the resolution. */
function textKey(s: string): string {
  return normalizeArabic(s).replace(/\s+/g, '');
}

function sameValue(expected: unknown, got: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(got) && got.length === expected.length && expected.every((e, i) => sameValue(e, got[i]));
  if (expected === null || expected === undefined) return got === null || got === undefined;
  if (typeof expected === 'number') return typeof got === 'number' && Math.abs(got - expected) <= 0.5;
  if (typeof expected === 'string') return typeof got === 'string' && textKey(got) === textKey(expected);
  return false;
}

function readFieldValue(result: ExtractionResult, pathKey: string): { value: unknown; status: FieldOutcome['status'] } {
  if (pathKey.endsWith('.length')) {
    const arrayPath = pathKey.slice(0, -'.length'.length);
    // A leaf that holds an array («lines.0.serials») counts its elements.
    const leaf = result.fields[arrayPath];
    if (leaf && Array.isArray(leaf.value)) return { value: leaf.value.length, status: leaf.status };
    const count = Object.keys(result.fields).filter((k) => k.startsWith(`${arrayPath}.`)).map((k) => Number(k.slice(arrayPath.length + 1).split('.')[0]));
    const length = count.length === 0 ? 0 : Math.max(...count) + 1;
    return { value: length, status: 'confirmed' };
  }
  const field = result.fields[pathKey];
  if (!field) return { value: null, status: 'absent' };
  return { value: field.value, status: field.status };
}

type VisionSource =
  | { ok: true; blocks: RedactedBlock[]; documentId: string }
  | { ok: false; reason: string; detail: string | null };

/** Images and scanned PDFs reach the model only through the T-22 intake and
 *  consent path: the file is uploaded (type-checked, deduplicated per
 *  organization), the eval user's approval is recorded as a real consent
 *  event, and the vision blocks are built from the verified consent. */
async function visionSource(
  db: ReturnType<typeof getDb>,
  storage: DocumentStorage,
  caller: UploadCaller,
  fileName: string,
  bytes: Uint8Array,
): Promise<VisionSource> {
  const upload = await uploadDocument({ db, storage }, caller, { fileName, bytes });
  if (upload.status === 'refused') return { ok: false, reason: 'upload_refused', detail: upload.detail ? `${upload.reason}: ${upload.detail}` : upload.reason };
  const row = await db.document.findFirst({ where: { id: upload.document.id, npiOrgId: caller.npiOrgId, npiUserId: caller.npiUserId } });
  if (!row) return { ok: false, reason: 'upload_refused', detail: 'document row not found after upload' };
  if (upload.status === 'existing' && (await storage.read(row.storagePath)) === null) {
    // test-results was cleaned since the first run: an image is restored from
    // the file itself; a scanned PDF's page PNGs are not recoverable here.
    if (row.kind !== 'image') {
      return { ok: false, reason: 'storage_missing', detail: `stored pages of ${fileName} are gone — delete the document rows of ${caller.npiOrgId} and run again` };
    }
    await storage.write(row.storagePath, bytes);
  }
  const consentOutcome = await recordConsent(db, caller, { documentId: row.id, decision: 'approved' });
  if (consentOutcome.status !== 'recorded') return { ok: false, reason: `consent_${consentOutcome.status}`, detail: null };
  try {
    const consent = await requireConsent(db, caller, row.id);
    const blocks = await documentVisionBlocks(consent, storage, row);
    return { ok: true, blocks, documentId: row.id };
  } catch (err) {
    if (err instanceof ConsentRequiredError) return { ok: false, reason: `consent_${err.reason}`, detail: null };
    if (err instanceof VisionInputError) return { ok: false, reason: `vision_${err.kind}`, detail: err.message };
    throw err;
  }
}

async function evaluateFlow(flow: FlowType): Promise<{ flow: FlowType; score: number; passed: boolean; docs: DocOutcome[] }> {
  if (!isRegisteredFlow(flow)) throw new Error(`flow ${flow} has no extraction spec yet`);
  const dir = path.join(process.cwd(), 'eval', 'extract', flow);
  const expected = JSON.parse(readFileSync(path.join(dir, 'expected.json'), 'utf8')) as ExpectedDoc[];
  const present = new Set(readdirSync(dir));

  const db = getDb();
  const llm = createLlmClient({ provider: createAnthropicProvider(), db });
  const storage = createFsStorage(path.join(process.cwd(), 'test-results', 'extract', 'docs'));
  const caller: UploadCaller = { npiOrgId: EVAL_ORG, npiUserId: EVAL_USER };
  const docs: DocOutcome[] = [];

  for (const [index, doc] of expected.entries()) {
    if ((doc.file === undefined) === (doc.text === undefined)) throw new Error(`expected.json entry ${index + 1} of ${flow}: exactly one of "file" or "text" is required`);
    const outcome: DocOutcome = { file: doc.file ?? `sentence-${index + 1}`, titleAr: doc.titleAr, input: doc.text !== undefined ? 'sentence' : 'text', ok: false, pages: 0, textChars: 0, fields: [], correct: 0, total: Object.keys(doc.fields).length, confirmedWrong: 0, statusMismatches: [], usage: null };
    docs.push(outcome);
    let source: ExtractSource = { kind: 'text', pages: [] };
    let documentId: string | undefined;
    let userHint: string | undefined;
    if (doc.text !== undefined) {
      userHint = doc.text;
      outcome.textChars = doc.text.length;
    } else {
      const file = doc.file as string;
      if (!present.has(file)) {
        outcome.failure = { reason: 'missing_file', detail: `${file} is not in ${dir} — run scripts/eval-extract-docs.ps1 (and eval-extract-photos.ts for photos)` };
        continue;
      }
      const bytes = new Uint8Array(readFileSync(path.join(dir, file)));
      const isPdf = /\.pdf$/i.test(file);
      if (!isPdf && !/\.(jpe?g|png)$/i.test(file)) {
        outcome.failure = { reason: 'unsupported_file', detail: `${file}: expected .pdf, .jpg, .jpeg or .png` };
        continue;
      }
      let scanned = !isPdf;
      if (isPdf) {
        const analysis = await analyzePdf(bytes);
        outcome.pages = analysis.pageCount;
        if (analysis.kind === 'pdf_text') {
          outcome.textChars = analysis.textChars;
          source = { kind: 'text', pages: analysis.pages };
        } else {
          scanned = true;
        }
      }
      if (scanned) {
        outcome.input = 'vision';
        const vision = await visionSource(db, storage, caller, file, bytes);
        if (!vision.ok) {
          outcome.failure = { reason: vision.reason, detail: vision.detail };
          continue;
        }
        source = { kind: 'vision', blocks: vision.blocks };
        documentId = vision.documentId;
        outcome.pages = vision.blocks.filter((b) => b.type === 'image' || b.type === 'document').length;
      }
    }

    const pseudonymizer = new Pseudonymizer([]);
    const result = await runExtraction(
      { llm, pseudonymizer },
      { flow, source, userHint, ourPartyNameAr: OUR_PARTY_AR, referenceDate: doc.referenceDate },
      { ...caller, documentId },
    );
    if (!result.ok) {
      const failure = result as ExtractFailure;
      outcome.failure = { reason: failure.reason, detail: failure.detail };
      outcome.usage = failure.usage;
      continue;
    }
    outcome.ok = true;
    outcome.usage = result.usage;
    for (const [pathKey, expectedValue] of Object.entries(doc.fields)) {
      const { value, status } = readFieldValue(result, pathKey);
      const correct = sameValue(expectedValue, value);
      outcome.fields.push({ path: pathKey, expected: expectedValue, got: value, correct, status });
      if (correct) outcome.correct += 1;
      else if (status === 'confirmed') outcome.confirmedWrong += 1;
    }
    for (const [pathKey, expectedStatus] of Object.entries(doc.status ?? {})) {
      const { status } = readFieldValue(result, pathKey);
      if (status !== expectedStatus) outcome.statusMismatches.push({ path: pathKey, expected: expectedStatus, got: status });
    }
    // Keep the full assessment in the report for inspection.
    (outcome as DocOutcome & { assessed?: unknown }).assessed = flattenFields(result.assessed);
  }

  const correct = docs.reduce((n, d) => n + d.correct, 0);
  const total = docs.reduce((n, d) => n + d.total, 0);
  const score = total === 0 ? 0 : correct / total;
  return { flow, score, passed: score >= GATE && docs.every((d) => d.ok), docs };
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const requested = process.argv.slice(2).filter((a) => !a.startsWith('-')) as FlowType[];
  const flows = requested.length > 0 ? requested : (Object.keys(FLOWS) as FlowType[]);
  const startedAt = new Date();
  let allPassed = true;

  for (const flow of flows) {
    const run = await evaluateFlow(flow);
    allPassed = allPassed && run.passed;

    console.log(`\n== تقييم الاستخراج — ${flow} ==`);
    for (const d of run.docs) {
      if (!d.ok) {
        console.log(`  ✗ ${d.file}: ${d.failure?.reason} ${d.failure?.detail ?? ''}`);
        continue;
      }
      const wrong = d.fields.filter((f) => !f.correct);
      console.log(`  ${d.file}: ${d.correct}/${d.total} صحيح، مؤكد وخاطئ ${d.confirmedWrong}، حالات مخالفة ${d.statusMismatches.length}، ${d.pages} صفحة، ${d.usage?.latencyMs} مللي ثانية، ${d.usage?.tokensIn}/${d.usage?.tokensOut} رمزاً — ${d.titleAr}`);
      for (const f of wrong) console.log(`      ✗ ${f.path}: متوقع ${JSON.stringify(f.expected)} — وجد ${JSON.stringify(f.got)} (${f.status})`);
      for (const s of d.statusMismatches) console.log(`      ~ ${s.path}: الحالة المتوقعة ${s.expected} — الفعلية ${s.got}`);
    }
    const confirmedWrong = run.docs.reduce((n, d) => n + d.confirmedWrong, 0);
    console.log(`  النتيجة: ${pct(run.score)} (الحد ${pct(GATE)}) — ${run.passed ? 'نجح' : 'لم ينجح'}؛ مؤكد وخاطئ: ${confirmedWrong}`);

    const outDir = path.join(process.cwd(), 'test-results', 'extract');
    mkdirSync(outDir, { recursive: true });
    const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
    const reportPath = path.join(outDir, `${flow}-${stamp}.json`);
    writeFileSync(reportPath, JSON.stringify({ flow, startedAt, score: run.score, gate: GATE, passed: run.passed, docs: run.docs }, null, 2));
    console.log(`  التقرير: ${reportPath}`);

    await getDb().evalRun.create({
      data: {
        kind: `extract:${flow}`,
        startedAt,
        finishedAt: new Date(),
        score: run.score,
        passed: run.passed,
        detailsJson: {
          gate: GATE,
          confirmedWrong,
          docs: run.docs.map((d) => ({ file: d.file, input: d.input, ok: d.ok, correct: d.correct, total: d.total, confirmedWrong: d.confirmedWrong, statusMismatches: d.statusMismatches.length, usage: d.usage, failure: d.failure ?? null })),
          reportPath,
        },
      },
    });
  }

  await getDb().$disconnect();
  process.exitCode = allPassed ? 0 : 1;
}

main().catch(async (err) => {
  console.error(err);
  try {
    await getDb().$disconnect();
  } catch {
    // nothing to release
  }
  process.exitCode = 1;
});
