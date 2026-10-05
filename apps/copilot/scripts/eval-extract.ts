// `npm run eval:extract -- [flow ...]` — field-accuracy evaluation of the
// extraction pipeline against the documents under `eval/extract/<flow>/`
// (T-23 for customer_contract; T-24/T-25 add pr, po, grn, vendor_bill;
// T-36 runs the full set). Real model, real audit: every call goes through
// `createLlmClient` with the copilot database, so each run leaves its
// `llm_audit` rows and one `eval_runs` row like any other model traffic.
//
// Each `expected.json` entry names a PDF, the plain values expected per
// dotted field path (`src/extract/run.ts flattenFields`), and optionally the
// status («confirmed»/«unconfirmed») a few fields must end up with. The
// score is correct fields / expected fields across the flow's documents;
// the gate is ≥ 0.90 (05 T-23). «confirmed but wrong» is reported on its
// own: it is the one outcome a preview card cannot protect the user from.
//
// Needs `ANTHROPIC_API_KEY` and `COPILOT_DATABASE_URL` in the root `.env`
// (dotenv is applied by the npm script). Scanned/image documents are
// skipped here: they need a consent event, which belongs to the live
// Playwright scenarios (T-31), not to a script.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getDb } from '../src/db';
import { FLOWS, flattenFields, isRegisteredFlow, runExtraction, type ExtractFailure, type ExtractionResult } from '../src/extract/run';
import { analyzePdf } from '../src/intake/pdf';
import { createLlmClient } from '../src/llm/client';
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
  file: string;
  titleAr: string;
  fields: Record<string, string | number | null>;
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

function sameValue(expected: unknown, got: unknown): boolean {
  if (expected === null || expected === undefined) return got === null || got === undefined;
  if (typeof expected === 'number') return typeof got === 'number' && Math.abs(got - expected) <= 0.5;
  if (typeof expected === 'string') return typeof got === 'string' && normalizeArabic(got) === normalizeArabic(expected);
  return false;
}

function readFieldValue(result: ExtractionResult, pathKey: string): { value: unknown; status: FieldOutcome['status'] } {
  if (pathKey.endsWith('.length')) {
    const arrayPath = pathKey.slice(0, -'.length'.length);
    const count = Object.keys(result.fields).filter((k) => k.startsWith(`${arrayPath}.`)).map((k) => Number(k.slice(arrayPath.length + 1).split('.')[0]));
    const length = count.length === 0 ? 0 : Math.max(...count) + 1;
    return { value: length, status: 'confirmed' };
  }
  const field = result.fields[pathKey];
  if (!field) return { value: null, status: 'absent' };
  return { value: field.value, status: field.status };
}

async function evaluateFlow(flow: FlowType): Promise<{ flow: FlowType; score: number; passed: boolean; docs: DocOutcome[] }> {
  if (!isRegisteredFlow(flow)) throw new Error(`flow ${flow} has no extraction spec yet`);
  const dir = path.join(process.cwd(), 'eval', 'extract', flow);
  const expected = JSON.parse(readFileSync(path.join(dir, 'expected.json'), 'utf8')) as ExpectedDoc[];
  const present = new Set(readdirSync(dir));

  const db = getDb();
  const llm = createLlmClient({ provider: createAnthropicProvider(), db });
  const docs: DocOutcome[] = [];

  for (const doc of expected) {
    const outcome: DocOutcome = { file: doc.file, titleAr: doc.titleAr, ok: false, pages: 0, textChars: 0, fields: [], correct: 0, total: Object.keys(doc.fields).length, confirmedWrong: 0, statusMismatches: [], usage: null };
    docs.push(outcome);
    if (!present.has(doc.file)) {
      outcome.failure = { reason: 'missing_file', detail: `${doc.file} is not in ${dir} — run scripts/eval-extract-docs.ps1` };
      continue;
    }
    const bytes = new Uint8Array(readFileSync(path.join(dir, doc.file)));
    const analysis = await analyzePdf(bytes);
    outcome.pages = analysis.pageCount;
    if (analysis.kind !== 'pdf_text') {
      outcome.failure = { reason: 'not_text', detail: 'scanned document — needs a consent event (T-31 live scenarios)' };
      continue;
    }
    outcome.textChars = analysis.textChars;

    const pseudonymizer = new Pseudonymizer([]);
    const result = await runExtraction(
      { llm, pseudonymizer },
      { flow, source: { kind: 'text', pages: analysis.pages }, ourPartyNameAr: OUR_PARTY_AR },
      { npiOrgId: EVAL_ORG, npiUserId: EVAL_USER },
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
          docs: run.docs.map((d) => ({ file: d.file, ok: d.ok, correct: d.correct, total: d.total, confirmedWrong: d.confirmedWrong, statusMismatches: d.statusMismatches.length, usage: d.usage, failure: d.failure ?? null })),
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
