// `npm run eval:memory [-- --live]` — evaluation of the memory derived from
// NPI's own data (T-29, F-12; spec/madar/02 §8, 06 AT-10, 07 G-M3-7).
//
// It measures the memory, not the model: there is no model call anywhere on
// this path (D-T29-1). Two checks, one score:
//
//   1. Derivation. `eval/memory-npi-snapshot.json` is an NPI-shaped snapshot
//      built around the demo seed. `deriveNpiFacts` must produce each of the 50
//      facts of `eval/memory-facts.json`, and every `mustContain` value (the
//      name, the code, the number — computed by hand from the snapshot) must be
//      inside the derived sentence, compared after `normalizeArabic` on both
//      sides. A derived fact nobody expects is reported as an «extra», not failed.
//   2. Retrieval. The derived facts are stored for the evaluation organization
//      (`sourceType 'npi'`, company scope) and the 50 questions of
//      `eval/memory-questions.json` are asked through `retrieveFacts` with the
//      chat's own defaults (limit 3, minScore 0.35, no use counting). A question
//      is answered when its `expectKey` is among the hits; «الأول» counts the
//      ones where it is the first hit.
//
// Score = answered / 50, gate 0.85. The run passes when the score reaches the
// gate and every expected fact derived. One `eval_runs` row (`kind: 'memory'`)
// and one report under `test-results/memory/`. The evaluation organization's
// `npi` rows stay in place afterwards (the next run deletes them first).
//
// `--live` is a wire-shape check, not a score: it logs in to the local NPI as
// the seeded demo admin, loads a real snapshot through the same readers the
// refresh uses, and prints each source's outcome and every derived sentence. It
// writes nothing to any database and does not touch the report or `eval_runs`.
//
// Needs `COPILOT_DATABASE_URL` in the root `.env` (dotenv is applied by the
// npm script) for the default mode; `--live` needs a running NPI.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getDb } from '../src/db';
import { createNpiClient } from '../src/npi/client';
import { NpiError } from '../src/npi/errors';
import { readLogin } from '../src/npi/responses';
import { deriveNpiFacts } from '../src/memory/extract-npi';
import { buildSearchText } from '../src/memory/fts';
import type { DerivedFact, NpiMemorySnapshot } from '../src/memory/npi-facts';
import { loadNpiMemorySnapshot } from '../src/memory/npi-snapshot';
import { retrieveFacts } from '../src/memory/retrieve';
import { normalizeArabic } from '../src/text/normalize';
import { readAdminCredentials } from '../e2e/fixtures/accounts';

const GATE = 0.85;
const EVAL_ORG = 'org_madar_eval';
const EXPECTED_COUNT = 50;

interface ExpectedFact {
  key: string;
  kind: string;
  entityType: string;
  npiEntityId: string;
  titleAr: string;
  mustContain: string[];
}

interface Question {
  id: string;
  questionAr: string;
  expectKey: string;
}

interface DerivationMiss {
  key: string;
  titleAr: string;
  reason: 'not_derived' | 'missing_text';
  missing: string[];
  derived: string | null;
}

interface RetrievalOutcome {
  id: string;
  questionAr: string;
  expectKey: string;
  answered: boolean;
  top1: boolean;
  hits: { key: string | null; score: number }[];
}

type Db = ReturnType<typeof getDb>;

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(path.join(process.cwd(), 'eval', file), 'utf8')) as T;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function keyOf(valueJson: unknown): string | null {
  if (typeof valueJson === 'object' && valueJson !== null && 'key' in valueJson) {
    const key = (valueJson as { key?: unknown }).key;
    return typeof key === 'string' ? key : null;
  }
  return null;
}

/** The three data files must line up before anything is measured; a mismatch
 *  is a thrown error naming the entry (a broken fixture, not a failed score). */
function loadData(): { snapshot: NpiMemorySnapshot; expected: ExpectedFact[]; questions: Question[] } {
  const snapshot = readJson<NpiMemorySnapshot>('memory-npi-snapshot.json');
  const expected = readJson<ExpectedFact[]>('memory-facts.json');
  const questions = readJson<Question[]>('memory-questions.json');
  if (expected.length !== EXPECTED_COUNT) throw new Error(`eval/memory-facts.json: expected ${EXPECTED_COUNT} facts, found ${expected.length}`);
  if (questions.length !== EXPECTED_COUNT) throw new Error(`eval/memory-questions.json: expected ${EXPECTED_COUNT} questions, found ${questions.length}`);
  const keys = new Set<string>();
  for (const fact of expected) {
    if (keys.has(fact.key)) throw new Error(`eval/memory-facts.json: duplicate key ${fact.key}`);
    keys.add(fact.key);
    if (fact.mustContain.length < 2 || fact.mustContain.length > 4) throw new Error(`eval/memory-facts.json: ${fact.key} has ${fact.mustContain.length} mustContain values (2-4 required)`);
  }
  const asked = new Set<string>();
  for (const q of questions) {
    if (!keys.has(q.expectKey)) throw new Error(`eval/memory-questions.json: ${q.id} expects ${q.expectKey}, which is not in memory-facts.json`);
    if (asked.has(q.expectKey)) throw new Error(`eval/memory-questions.json: ${q.id} repeats ${q.expectKey}`);
    asked.add(q.expectKey);
  }
  return { snapshot, expected, questions };
}

function checkDerivation(expected: ExpectedFact[], derived: DerivedFact[]): { misses: DerivationMiss[]; extras: string[] } {
  const byKey = new Map(derived.map((d) => [d.key, d]));
  const misses: DerivationMiss[] = [];
  for (const fact of expected) {
    const got = byKey.get(fact.key);
    if (!got) {
      misses.push({ key: fact.key, titleAr: fact.titleAr, reason: 'not_derived', missing: [], derived: null });
      continue;
    }
    const text = normalizeArabic(got.factAr);
    const missing = fact.mustContain.filter((value) => !text.includes(normalizeArabic(value)));
    if (missing.length > 0) misses.push({ key: fact.key, titleAr: fact.titleAr, reason: 'missing_text', missing, derived: got.factAr });
  }
  const expectedKeys = new Set(expected.map((f) => f.key));
  return { misses, extras: derived.filter((d) => !expectedKeys.has(d.key)).map((d) => d.key) };
}

/** Writes the derived facts the way `refreshNpiMemory`'s upsert creates a row:
 *  company scope, no position, `sourceType 'npi'`, `searchText` from
 *  `buildSearchText(factAr)`, `valueJson` and `confidence` as derived. The
 *  evaluation organization's earlier `npi` rows are deleted first, so every run
 *  retrieves from exactly this set. */
async function storeDerived(db: Db, npiOrgId: string, facts: DerivedFact[]): Promise<void> {
  await db.memoryFact.deleteMany({ where: { npiOrgId, sourceType: 'npi' } });
  for (const fact of facts) {
    await db.memoryFact.create({
      data: {
        npiOrgId,
        scope: 'company',
        positionId: null,
        entityType: fact.entityType,
        npiEntityId: fact.npiEntityId,
        factAr: fact.factAr,
        searchText: buildSearchText(fact.factAr),
        valueJson: fact.valueJson as never,
        sourceType: 'npi',
        confidence: fact.confidence,
      },
    });
  }
}

async function runLive(): Promise<boolean> {
  const baseUrl = process.env.NPI_API_BASE ?? 'http://localhost:4000/api';
  const { email, password } = readAdminCredentials();
  let accessToken: string;
  let permissions: string[];
  try {
    const login = readLogin(await createNpiClient({ token: '' }).login({ email, password }));
    accessToken = login.accessToken;
    permissions = login.user.permissions;
  } catch (err) {
    if (err instanceof NpiError && (err.kind === 'network' || err.kind === 'timeout')) {
      console.log(`NPI غير متاح على ${baseUrl}`);
      return false;
    }
    throw err;
  }
  const { snapshot, sources } = await loadNpiMemorySnapshot(createNpiClient({ token: accessToken }), { permissions });
  console.log(`\n== الذاكرة من NPI — فحص حي على ${baseUrl} ==`);
  for (const [source, outcome] of Object.entries(sources)) {
    console.log(`  ${source}: ${outcome.status === 'read' ? `قُرئ ${outcome.rows} صف` : `تُخطّي (${outcome.reason})`}`);
  }
  const derived = deriveNpiFacts(snapshot);
  console.log(`  الحقائق المشتقة: ${derived.length}`);
  for (const fact of derived) console.log(`    [${fact.key}] ${fact.factAr}`);
  return true;
}

async function main(): Promise<void> {
  if (process.argv.includes('--live')) {
    process.exitCode = (await runLive()) ? 0 : 1;
    return;
  }

  const startedAt = new Date();
  const { snapshot, expected, questions } = loadData();
  const derived = deriveNpiFacts(snapshot);
  const { misses: derivationMisses, extras } = checkDerivation(expected, derived);

  const db = getDb();
  await storeDerived(db, EVAL_ORG, derived);

  const outcomes: RetrievalOutcome[] = [];
  for (const q of questions) {
    const hits = await retrieveFacts(db, { npiOrgId: EVAL_ORG, positionId: null, query: q.questionAr, countUse: false });
    const keys = hits.map((h) => keyOf(h.valueJson));
    outcomes.push({
      id: q.id,
      questionAr: q.questionAr,
      expectKey: q.expectKey,
      answered: keys.includes(q.expectKey),
      top1: keys[0] === q.expectKey,
      hits: hits.map((h) => ({ key: keyOf(h.valueJson), score: Number(h.score.toFixed(3)) })),
    });
  }

  const answered = outcomes.filter((o) => o.answered).length;
  const top1 = outcomes.filter((o) => o.top1).length;
  const retrievalMisses = outcomes.filter((o) => !o.answered);
  const score = answered / questions.length;
  const passed = score >= GATE && derivationMisses.length === 0;

  console.log('\n== تقييم الذاكرة من بيانات NPI ==');
  for (const m of derivationMisses) {
    console.log(`  ✗ اشتقاق ${m.key}: ${m.reason === 'not_derived' ? 'لم يُشتق' : `ناقص ${JSON.stringify(m.missing)}`}${m.derived ? ` — الجملة: ${m.derived}` : ''}`);
  }
  for (const key of extras) console.log(`  ~ حقيقة مشتقة لا يتوقعها أحد: ${key}`);
  for (const o of retrievalMisses) {
    const got = o.hits.length === 0 ? 'لا نتائج' : o.hits.map((h) => `${h.key ?? '؟'} (${h.score})`).join('، ');
    console.log(`  ✗ ${o.id} «${o.questionAr}» — متوقع ${o.expectKey} — وجد ${got}`);
  }
  console.log(`  الاشتقاق: ${expected.length - derivationMisses.length}/${expected.length}`);
  console.log(`  الاسترجاع: ${answered}/${questions.length} (الأول: ${top1}/${questions.length})`);
  console.log(`  النتيجة: ${pct(score)} (الحد ${pct(GATE)}) — ${passed ? 'نجح' : 'لم ينجح'}`);

  const outDir = path.join(process.cwd(), 'test-results', 'memory');
  mkdirSync(outDir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(outDir, `${stamp}.json`);
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        startedAt,
        gate: GATE,
        score,
        passed,
        derivation: { expected: expected.length, derived: derived.length, misses: derivationMisses, extras },
        retrieval: { answered, top1, questions: outcomes },
      },
      null,
      2,
    ),
  );
  console.log(`  التقرير: ${reportPath}`);

  await db.evalRun.create({
    data: {
      kind: 'memory',
      startedAt,
      finishedAt: new Date(),
      score,
      passed,
      detailsJson: {
        gate: GATE,
        derivation: { expected: expected.length, derived: derived.length, misses: derivationMisses },
        retrieval: { answered, top1, misses: retrievalMisses },
        reportPath,
      } as never,
    },
  });

  await db.$disconnect();
  process.exitCode = passed ? 0 : 1;
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
