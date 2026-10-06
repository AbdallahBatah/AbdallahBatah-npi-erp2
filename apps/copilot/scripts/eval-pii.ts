// `npm run eval:pii` — evaluation of the redaction gate (T-32, F-16;
// spec/madar/05 §M4 row T-32, 06 AT-09, 07 G-M4-1, 09 §4.4).
//
// It measures the gate, not the model: the only call on this path is
// `new Pseudonymizer(dictionary).redact(text)` (D-T32-1). There is no model
// call, no NPI call and no network; the only database use is the one
// `eval_runs` row written at the end.
//
// `eval/pii-sentences.json` holds NPI's demo dictionary (36 entries, verbatim)
// and 100 Arabic sentences in NPI's own vocabulary, each with the surfaces that
// must vanish (`expect`, the real names and identifiers as written) and the
// words that must survive (`keep`, report-only). An expectation stays true even
// when the gate leaks it: a leak is a finding, never a reason to edit the data.
//
// A FRESH Pseudonymizer is built for every sentence (D-T32-2): no state carries
// over, so the measurement is of what the gate catches cold, without the
// session learning of an earlier sentence.
//
// Scoring (D-T32-6), with `out = redact(text)`:
//   - name:        leaked when normalizeArabic(out) contains normalizeArabic(value)
//   - structured:  leaked when compact(out) contains compact(value), where
//                  compact(s) = normalizeArabic(s) without spaces and dashes
//   - keep:        over-redacted when normalizeArabic(out) lacks normalizeArabic(value)
// Gates: names >= 90 %, structured identifiers >= 95 %. Reported and never
// gated: keep over-redactions, a round trip that does not give the sentence
// back (`rehydrate(out) !== text`), a malformed placeholder, and a value that
// was redacted under another label than the one expected.
//
// Needs `COPILOT_DATABASE_URL` in the root `.env` (dotenv is applied by the npm
// script) for the `eval_runs` row.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getDb } from '../src/db';
import { Pseudonymizer, type DictionaryEntry } from '../src/privacy/pseudonymizer';
import { normalizeArabic } from '../src/text/normalize';

const GATE_NAMES = 0.9;
const GATE_STRUCTURED = 0.95;
const SENTENCE_COUNT = 100;
const DICTIONARY_COUNT = 36;
const WELL_FORMED_PLACEHOLDER = /^⟦[^\s⟦⟧]+_[0-9]+⟧$/;

interface Expectation {
  kind: 'name' | 'structured';
  value: string;
  label?: string;
}

interface Sentence {
  id: string;
  text: string;
  expect: Expectation[];
  keep?: string[];
  note?: string;
}

interface PiiFile {
  dictionary: DictionaryEntry[];
  sentences: Sentence[];
}

interface ExpectationOutcome {
  kind: 'name' | 'structured';
  value: string;
  label: string | null;
  redacted: boolean;
  /** The label of the placeholder that replaced the value, when one did. */
  foundLabel: string | null;
}

interface KeepOutcome {
  value: string;
  kept: boolean;
}

interface SentenceOutcome {
  id: string;
  text: string;
  out: string;
  expectations: ExpectationOutcome[];
  keep: KeepOutcome[];
  roundTrip: boolean;
  malformed: string[];
}

type Db = ReturnType<typeof getDb>;

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function ratio(part: number, whole: number): number {
  return whole === 0 ? 1 : part / whole;
}

function compact(s: string): string {
  return normalizeArabic(s).replace(/[\s-]/g, '');
}

function placeholdersIn(out: string): string[] {
  return out.match(/⟦[^⟦⟧]*⟧/g) ?? [];
}

function labelOfPlaceholder(token: string): string {
  const m = /^⟦(.+)_[0-9]+⟧$/.exec(token);
  return m ? m[1] : token;
}

/** The fixture must be sound before anything is measured; a defect is a thrown
 *  error naming the entry (a broken fixture, not a failed score). */
function loadData(): PiiFile {
  const data = JSON.parse(readFileSync(path.join(process.cwd(), 'eval', 'pii-sentences.json'), 'utf8')) as PiiFile;
  const { dictionary, sentences } = data;
  if (dictionary.length !== DICTIONARY_COUNT) {
    throw new Error(`eval/pii-sentences.json: expected ${DICTIONARY_COUNT} dictionary entries, found ${dictionary.length}`);
  }
  const kinds = new Set(['customer', 'vendor', 'project', 'employee']);
  for (const entry of dictionary) {
    if (!kinds.has(entry.kind)) throw new Error(`eval/pii-sentences.json: dictionary entry ${entry.npiId} has kind ${entry.kind}`);
  }
  if (sentences.length !== SENTENCE_COUNT) {
    throw new Error(`eval/pii-sentences.json: expected ${SENTENCE_COUNT} sentences, found ${sentences.length}`);
  }
  const ids = new Set<string>();
  const texts = new Set<string>();
  for (const s of sentences) {
    if (ids.has(s.id)) throw new Error(`eval/pii-sentences.json: duplicate id ${s.id}`);
    ids.add(s.id);
    if (texts.has(s.text)) throw new Error(`eval/pii-sentences.json: ${s.id} repeats the text of another sentence`);
    texts.add(s.text);
    if (s.expect.length === 0) throw new Error(`eval/pii-sentences.json: ${s.id} has no expectation`);
    for (const e of s.expect) {
      if (e.kind !== 'name' && e.kind !== 'structured') throw new Error(`eval/pii-sentences.json: ${s.id} has an expectation of kind ${String(e.kind)}`);
      if (!s.text.includes(e.value)) throw new Error(`eval/pii-sentences.json: ${s.id} expects «${e.value}», which is not in its text`);
    }
    for (const k of s.keep ?? []) {
      if (!s.text.includes(k)) throw new Error(`eval/pii-sentences.json: ${s.id} keeps «${k}», which is not in its text`);
    }
  }
  return data;
}

function isLeaked(e: Expectation, out: string): boolean {
  return e.kind === 'name'
    ? normalizeArabic(out).includes(normalizeArabic(e.value))
    : compact(out).includes(compact(e.value));
}

/** The label of the placeholder in `out` that replaced `value`: found by
 *  rehydrating every placeholder and comparing text. A placeholder that holds
 *  the whole value wins (the shortest such one); failing that, one that holds
 *  a part of it. */
function findLabel(pseudonymizer: Pseudonymizer, out: string, e: Expectation): string | null {
  const norm = (s: string): string => (e.kind === 'name' ? normalizeArabic(s) : compact(s));
  const wanted = norm(e.value);
  let whole: { label: string; length: number } | null = null;
  let part: { label: string; length: number } | null = null;
  for (const token of new Set(placeholdersIn(out))) {
    const original = norm(pseudonymizer.rehydrate(token));
    if (original === norm(token)) continue; // not a placeholder this instance knows
    if (original.includes(wanted)) {
      if (whole === null || original.length < whole.length) whole = { label: labelOfPlaceholder(token), length: original.length };
    } else if (original.length >= 3 && wanted.includes(original)) {
      if (part === null || original.length > part.length) part = { label: labelOfPlaceholder(token), length: original.length };
    }
  }
  return (whole ?? part)?.label ?? null;
}

function measure(dictionary: DictionaryEntry[], s: Sentence): SentenceOutcome {
  const pseudonymizer = new Pseudonymizer(dictionary);
  const out = pseudonymizer.redact(s.text) as string;
  const expectations: ExpectationOutcome[] = s.expect.map((e) => {
    const redacted = !isLeaked(e, out);
    return {
      kind: e.kind,
      value: e.value,
      label: e.label ?? null,
      redacted,
      foundLabel: redacted ? findLabel(pseudonymizer, out, e) : null,
    };
  });
  const normalizedOut = normalizeArabic(out);
  const keep: KeepOutcome[] = (s.keep ?? []).map((value) => ({
    value,
    kept: normalizedOut.includes(normalizeArabic(value)),
  }));
  return {
    id: s.id,
    text: s.text,
    out,
    expectations,
    keep,
    roundTrip: pseudonymizer.rehydrate(out) !== s.text,
    malformed: placeholdersIn(out).filter((p) => !WELL_FORMED_PLACEHOLDER.test(p)),
  };
}

async function writeEvalRun(
  db: Db,
  startedAt: Date,
  score: number,
  passed: boolean,
  details: Record<string, unknown>,
): Promise<void> {
  await db.evalRun.create({
    data: {
      kind: 'pii',
      startedAt,
      finishedAt: new Date(),
      score,
      passed,
      detailsJson: details as never,
    },
  });
}

async function main(): Promise<void> {
  const startedAt = new Date();
  const { dictionary, sentences } = loadData();
  const outcomes = sentences.map((s) => measure(dictionary, s));

  const names = outcomes.flatMap((o) => o.expectations.filter((e) => e.kind === 'name'));
  const structured = outcomes.flatMap((o) => o.expectations.filter((e) => e.kind === 'structured'));
  const redactedNames = names.filter((e) => e.redacted).length;
  const redactedStructured = structured.filter((e) => e.redacted).length;
  const keepAll = outcomes.flatMap((o) => o.keep);
  const keptCount = keepAll.filter((k) => k.kept).length;
  const roundTripFailures = outcomes.filter((o) => o.roundTrip);
  const malformedOutcomes = outcomes.filter((o) => o.malformed.length > 0);
  const labelMismatches = outcomes.flatMap((o) =>
    o.expectations
      .filter((e) => e.redacted && e.label !== null && e.foundLabel !== null && e.foundLabel !== e.label)
      .map((e) => ({ id: o.id, value: e.value, expected: e.label as string, found: e.foundLabel as string })),
  );

  const rateNames = ratio(redactedNames, names.length);
  const rateStructured = ratio(redactedStructured, structured.length);
  const passed = rateNames >= GATE_NAMES && rateStructured >= GATE_STRUCTURED;
  const score = ratio(redactedNames + redactedStructured, names.length + structured.length);

  console.log('\n== تقييم بوابة الإخفاء ==');
  const leaks: { id: string; kind: string; value: string }[] = [];
  const overRedactions: { id: string; value: string }[] = [];
  for (const o of outcomes) {
    for (const e of o.expectations) {
      if (e.redacted) continue;
      leaks.push({ id: o.id, kind: e.kind, value: e.value });
      console.log(`  ✗ ${o.id} [${e.kind === 'name' ? 'اسم' : 'معرّف'}] «${e.value}» بقي ظاهراً — الناتج: ${o.out}`);
    }
    for (const k of o.keep) {
      if (k.kept) continue;
      overRedactions.push({ id: o.id, value: k.value });
      console.log(`  ~ ${o.id} [إبقاء] «${k.value}» أُخفي — الناتج: ${o.out}`);
    }
    if (o.roundTrip) console.log(`  ~ ${o.id} [رحلة ذهاب وإياب] إعادة النص من الناتج لا تطابق الأصل — الناتج: ${o.out}`);
    for (const m of o.malformed) console.log(`  ~ ${o.id} [وسم مشوّه] ${m} — الناتج: ${o.out}`);
  }
  for (const m of labelMismatches) {
    console.log(`  ~ ${m.id} [وسم] «${m.value}» أُخفي تحت «${m.found}» والمتوقع «${m.expected}»`);
  }

  console.log(`  الأسماء: ${redactedNames}/${names.length} (${pct(rateNames)}) — الحد ${Math.round(GATE_NAMES * 100)}%`);
  console.log(`  المعرّفات المهيكلة: ${redactedStructured}/${structured.length} (${pct(rateStructured)}) — الحد ${Math.round(GATE_STRUCTURED * 100)}%`);
  console.log(`  إبقاء: ${keptCount}/${keepAll.length}`);
  console.log(`  رحلة الذهاب والإياب: ${outcomes.length - roundTripFailures.length}/${outcomes.length}`);
  console.log(`  وسوم مشوّهة: ${malformedOutcomes.length}`);
  console.log(`  وسوم بغير المتوقع: ${labelMismatches.length}`);
  console.log(`  النتيجة: ${passed ? 'نجح' : 'لم ينجح'}`);

  const counts = {
    sentences: outcomes.length,
    totalNames: names.length,
    redactedNames,
    totalStructured: structured.length,
    redactedStructured,
    keepTotal: keepAll.length,
    keepKept: keptCount,
    overRedactions: overRedactions.length,
    roundTripFailures: roundTripFailures.length,
    malformed: malformedOutcomes.length,
    labelMismatches: labelMismatches.length,
  };
  const gates = { names: GATE_NAMES, structured: GATE_STRUCTURED };
  const rates = { names: rateNames, structured: rateStructured };

  const outDir = path.join(process.cwd(), 'test-results', 'pii');
  mkdirSync(outDir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(outDir, `${stamp}.json`);
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        startedAt,
        gates,
        rates,
        counts,
        passed,
        labelMismatches,
        sentences: outcomes.map((o) => ({
          id: o.id,
          text: o.text,
          out: o.out,
          expectations: o.expectations.map((e) => ({
            kind: e.kind,
            value: e.value,
            label: e.label,
            redacted: e.redacted,
            foundLabel: e.foundLabel,
          })),
          keep: o.keep,
          roundTrip: o.roundTrip,
          malformed: o.malformed,
        })),
      },
      null,
      2,
    ),
  );
  console.log(`  التقرير: ${reportPath}`);

  const db = getDb();
  await writeEvalRun(db, startedAt, score, passed, {
    gates,
    rates,
    counts,
    leaks,
    overRedactions,
    roundTripFailures: roundTripFailures.map((o) => o.id),
    reportPath,
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
