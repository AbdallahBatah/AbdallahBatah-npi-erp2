// T-32 part B (Madar copilot, M4) — the structural guard "no-bypass-llm".
// spec/madar/05 §M4 T-32, 07 G-M4-1, 02 §2 invariants I3/I4, ADR-04, ADR-27.
//
// What this file proves, without a database, a network or a model: nothing in
// the copilot can put clear text in front of an external model, or an image or
// a PDF, except through the one path the design allows.
//
//   feature -> deps.llm.complete(RedactedRequest) -> src/llm/client.ts -> provider
//   image / PDF -> requireConsent -> documentVisionBlocks -> imageBlock / pdfBlock
//
//  - src/privacy/pseudonymizer.ts is the only producer of `RedactedText` (ADR-04).
//  - src/llm/vision.ts is the only producer of `ConsentedBase64` (I4).
//  - src/llm/client.ts is the only caller of a provider and (with src/audit/log.ts)
//    the only writer of model audit rows.
//  - src/llm/providers/anthropic.ts is the only file that touches the SDK.
//
// The type system enforces most of this; this file makes it greppable and fails
// with the file and line of every hit (the house style of tests/invariants.spec.ts).
//
// Scope: apps/copilot/{src,scripts,e2e,tests,prisma}, recursively, files
// *.ts *.tsx *.mjs *.cjs *.js, minus src/generated, node_modules, .next,
// test-results and data. A comment line never counts as a hit.
//
// Rules of the file (spec/madar/08 §E.9):
//  - An allowlist is an explicit constant with a reason per entry, written only for
//    a hit the T-32 brief names. Any other hit is a finding to report, never
//    something to allowlist to make the test green.
//  - This file names the literals it looks for, so every scan that greps for such
//    a literal skips this file; the scan-itself test includes it.

import * as fs from 'node:fs';
import * as path from 'node:path';

const APP_ROOT = path.resolve(__dirname, '..');
const SELF = path.resolve(__filename);

const SCAN_DIRS = ['src', 'scripts', 'e2e', 'tests', 'prisma'];
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.cjs', '.js']);
const SKIP_DIR_NAMES = new Set(['node_modules', '.next', 'test-results', 'data']);
const GENERATED_DIR = path.join(APP_ROOT, 'src', 'generated');

// ─── helpers ────────────────────────────────────────────────────────────────

function walk(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      if (full === GENERATED_DIR) continue;
      out.push(...walk(full));
    } else if (entry.isFile() && SCAN_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out.sort();
}

function rel(file: string): string {
  return path.relative(APP_ROOT, file).split(path.sep).join('/');
}

const contentCache = new Map<string, string>();
function read(file: string): string {
  let text = contentCache.get(file);
  if (text === undefined) {
    text = fs.readFileSync(file, 'utf8');
    contentCache.set(file, text);
  }
  return text;
}

interface HitLine {
  line: number;
  text: string;
}

const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

/** Every non-comment line of `file` the regex matches (1-based). The regex is
 *  cloned without `g`/`y`, so a global regex never carries `lastIndex` between lines. */
function codeLinesMatching(file: string, regex: RegExp): HitLine[] {
  const probe = new RegExp(regex.source, regex.flags.replace(/[gy]/g, ''));
  const hits: HitLine[] = [];
  read(file)
    .split(/\r?\n/)
    .forEach((text, index) => {
      if (COMMENT_LINE.test(text)) return;
      if (probe.test(text)) hits.push({ line: index + 1, text });
    });
  return hits;
}

function at(file: string, line: number): string {
  return `${rel(file)}:${line}`;
}

/** Index of the character that closes the bracket opened at `openIndex`, skipping
 *  quoted strings. Throws when the text ends first. */
function closingIndex(text: string, openIndex: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error(`unbalanced brackets after index ${openIndex}`);
}

/** The text between the parentheses of the call whose `(` is at `openIndex`. */
function balancedArgument(text: string, openIndex: number): string {
  return text.slice(openIndex + 1, closingIndex(text, openIndex));
}

/** Splits an argument list at the commas that are outside every bracket and string. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

interface CallSite {
  file: string;
  line: number;
  /** Text of the first line of the call, trimmed. */
  text: string;
  /** Balanced argument text, verbatim. */
  arg: string;
  where: string;
}

/** Every call of `name` (a regex ending in `\(`) in `files`: comment lines and
 *  definitions (`function name(`) are skipped. */
function callSites(files: string[], name: RegExp): CallSite[] {
  const found: CallSite[] = [];
  const global = new RegExp(name.source, name.flags.includes('g') ? name.flags : `${name.flags}g`);
  for (const file of files) {
    const text = read(file);
    const lines = text.split(/\r?\n/);
    for (const m of text.matchAll(global)) {
      const start = m.index ?? 0;
      const line = text.slice(0, start).split(/\r?\n/).length;
      if (COMMENT_LINE.test(lines[line - 1])) continue;
      if (/function\s+$/.test(text.slice(0, start))) continue; // the definition
      found.push({
        file,
        line,
        text: lines[line - 1].trim(),
        arg: balancedArgument(text, start + m[0].length - 1),
        where: at(file, line),
      });
    }
  }
  return found;
}

function filesOf(sites: CallSite[]): string[] {
  return [...new Set(sites.map((s) => rel(s.file)))].sort();
}

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

const ALL_FILES = SCAN_DIRS.flatMap((d) => walk(path.join(APP_ROOT, d)));
const NON_SELF_FILES = ALL_FILES.filter((f) => f !== SELF);
const SRC_FILES = ALL_FILES.filter((f) => rel(f).startsWith('src/'));
const SCRIPT_FILES = ALL_FILES.filter((f) => rel(f).startsWith('scripts/'));
const E2E_FILES = ALL_FILES.filter((f) => rel(f).startsWith('e2e/'));
const SRC_SCRIPTS_E2E = [...SRC_FILES, ...SCRIPT_FILES, ...E2E_FILES];

const file = (relative: string): string => path.join(APP_ROOT, relative);

const PSEUDONYMIZER = file('src/privacy/pseudonymizer.ts');
const VISION = file('src/llm/vision.ts');
const LLM_CLIENT = file('src/llm/client.ts');
const PROVIDER_TYPES = file('src/llm/provider.ts');
const ANTHROPIC = file('src/llm/providers/anthropic.ts');
const NPI_CLIENT = file('src/npi/client.ts');
const INTAKE_JOB = file('src/intake/job.ts');

// ─── R10. the scan itself ───────────────────────────────────────────────────

describe('no-bypass-llm R10: the scan itself', () => {
  it('finds the tree it is meant to scan (a vacuous scan would pass everything)', () => {
    expect(ALL_FILES.length).toBeGreaterThan(100);
    expect(SRC_FILES.length).toBeGreaterThan(50);
    for (const f of [PSEUDONYMIZER, VISION, LLM_CLIENT, PROVIDER_TYPES, ANTHROPIC, SELF]) {
      expect(ALL_FILES).toContain(f);
    }
    expect(ALL_FILES.some((f) => rel(f).startsWith('src/generated/'))).toBe(false);
    expect(ALL_FILES.some((f) => f.split(path.sep).includes('node_modules'))).toBe(false);
  });
});

// ─── R1. brand cast: RedactedText ───────────────────────────────────────────

describe('no-bypass-llm R1: `RedactedText` is cast in the pseudonymizer and nowhere else', () => {
  const BRAND_CAST = /\bas\s+(?:unknown\s+as\s+)?RedactedText\b|<RedactedText>/;

  /** The five producers inside src/privacy/pseudonymizer.ts, in file order. */
  const PSEUDONYMIZER_CASTS: Array<{ text: string; reason: string }> = [
    { text: 'return text as RedactedText;', reason: 'staticPrompt(): text loaded from prompts/ or a developer constant, no user or NPI data' },
    { text: "return parts.join('') as RedactedText;", reason: 'joinRedacted(): concatenation of parts that are each already RedactedText' },
    { text: 'return text as RedactedText;', reason: 'fromModelOutput(): the model\'s own previous output echoed back to it' },
    { text: 'return this.buildOutput(text, replacements) as RedactedText;', reason: 'Pseudonymizer.redact(): the redaction itself' },
    { text: 'return JSON.stringify(mapped) as RedactedText;', reason: 'Pseudonymizer.redactJson(): the redaction of structured data' },
  ];

  it('the only casts are the five in src/privacy/pseudonymizer.ts (a new cast anywhere, inside the file too, fails)', () => {
    const outside: string[] = [];
    for (const f of NON_SELF_FILES) {
      if (f === PSEUDONYMIZER) continue;
      for (const { line, text } of codeLinesMatching(f, BRAND_CAST)) {
        outside.push(`${at(f, line)}  ${text.trim()}`);
      }
    }
    expect(outside).toEqual([]);

    const inside = codeLinesMatching(PSEUDONYMIZER, BRAND_CAST).map((h) => h.text.trim());
    expect(inside).toEqual(PSEUDONYMIZER_CASTS.map((c) => c.text));
  });
});

// ─── R2. brand cast: ConsentedBase64 ────────────────────────────────────────

describe('no-bypass-llm R2: `ConsentedBase64` is cast in src/llm/vision.ts and nowhere else', () => {
  const BRAND_CAST = /\bas\s+(?:unknown\s+as\s+)?ConsentedBase64\b|<ConsentedBase64>/;

  const VISION_CASTS: Array<{ text: string; reason: string }> = [
    { text: "return Buffer.from(bytes).toString('base64') as ConsentedBase64;", reason: 'toConsentedBase64(): the one place bytes become base64, reached only from imageBlock/pdfBlock behind a VerifiedConsent (I4)' },
  ];

  /** Test fixtures that build a vision block by hand (reviewer decision,
   *  T-32): a unit test of the client or the extraction runner needs an
   *  image block without a consent row and a stored file; the value never
   *  leaves the test process. Production code (src, scripts, e2e) gets no
   *  such entry. Keyed by file; the exact line text must still exist. */
  const TEST_FIXTURE_CASTS: Record<string, { text: string; reason: string }> = {
    'tests/consent.spec.ts': { text: "data: 'base64...' as ConsentedBase64,", reason: 'a hand-built image block for the client\'s vision pre-flight tests' },
    'tests/extract-contract.spec.ts': { text: "const data = 'AAAA' as ConsentedBase64;", reason: 'a hand-built image block for the extraction runner\'s vision-source tests' },
    'tests/extract-grn-bill.spec.ts': { text: "data: 'AAAA' as ConsentedBase64,", reason: 'a hand-built image block for the GRN/bill photo extraction tests' },
  };

  it('the only cast is the one in src/llm/vision.ts (plus the listed test fixtures)', () => {
    const outside: string[] = [];
    const seenFixtures: string[] = [];
    for (const f of NON_SELF_FILES) {
      if (f === VISION) continue;
      const fixture = TEST_FIXTURE_CASTS[rel(f)];
      for (const { line, text } of codeLinesMatching(f, BRAND_CAST)) {
        if (fixture && rel(f).startsWith('tests/') && text.trim() === fixture.text) {
          seenFixtures.push(rel(f));
          continue;
        }
        outside.push(`${at(f, line)}  ${text.trim()}`);
      }
    }
    expect(outside).toEqual([]);
    // The fixture allowlist cannot go stale: every entry must still be there, once.
    expect(seenFixtures.sort()).toEqual(Object.keys(TEST_FIXTURE_CASTS).sort());

    const inside = codeLinesMatching(VISION, BRAND_CAST).map((h) => h.text.trim());
    expect(inside).toEqual(VISION_CASTS.map((c) => c.text));
  });
});

// ─── R3. no laundering interface ────────────────────────────────────────────

describe('no-bypass-llm R3: every redact / redactJson signature returns RedactedText', () => {
  const SIGNATURE = /\bredact(?:Json)?\s*(?:<[^>]*>)?\s*\([^)]*\)\s*:\s*([A-Za-z_][\w<>\[\]| ]*)/;

  it('no signature named redact or redactJson in src returns a plain string (or anything else)', () => {
    const violations: string[] = [];
    let signatures = 0;
    for (const f of SRC_FILES.filter((x) => x.endsWith('.ts') || x.endsWith('.tsx'))) {
      for (const { line, text } of codeLinesMatching(f, SIGNATURE)) {
        const returnType = SIGNATURE.exec(text)![1].trim();
        signatures += 1;
        if (returnType !== 'RedactedText') {
          violations.push(`${at(f, line)}  returns "${returnType}": ${text.trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);
    // The two class methods, ExtractDeps (redact + redactJson) and ParseDeps.
    expect(signatures).toBeGreaterThanOrEqual(4);
  });
});

// ─── R4. one provider, behind one client ────────────────────────────────────

describe('no-bypass-llm R4: one provider, behind one client', () => {
  const SPECIFIER_RE =
    /from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/g;

  /** createAnthropicProvider( call sites allowed, with the reason. */
  const PROVIDER_CONSTRUCTION_ALLOWED: Record<string, string> = {
    'src/agents/context.ts': 'one provider per process for the chat/intake context',
    'src/app/api/setup/route.ts': 'one provider per process for the setup route',
    'scripts/eval-extract.ts': 'the extraction eval runs the real model through createLlmClient with the copilot database',
    'scripts/eval-behaviour.ts': 'the behaviour eval (06 §3 #20) hands createLlmClient a daily_usage reader that reports the cap as reached',
  };
  /** Of those, the files that must hand the provider to createLlmClient and to nothing else. */
  const MUST_FEED_CLIENT = ['src/agents/context.ts', 'src/app/api/setup/route.ts'];

  /** Files that may call `fetch(`, with the reason (path prefixes end with `/`). */
  const FETCH_ALLOWED: Record<string, string> = {
    'src/components/': 'the browser calls the copilot\'s own API routes',
    'src/app/': 'the browser calls the copilot\'s own API routes (login form)',
    'src/npi/client.ts': 'the one NPI HTTP choke point (through `fetchImpl`)',
  };

  it('(a) @anthropic-ai/sdk is imported only by src/llm/providers/anthropic.ts (src, scripts, e2e)', () => {
    const violations: string[] = [];
    let imports = 0;
    for (const f of SRC_SCRIPTS_E2E) {
      read(f)
        .split(/\r?\n/)
        .forEach((text, index) => {
          if (COMMENT_LINE.test(text)) return;
          for (const m of text.matchAll(SPECIFIER_RE)) {
            const spec = m[1] ?? m[2] ?? m[3];
            if (spec !== '@anthropic-ai/sdk' && !spec.startsWith('@anthropic-ai/')) continue;
            imports += 1;
            if (f !== ANTHROPIC) violations.push(`${at(f, index + 1)}  ${text.trim()}`);
          }
        });
    }
    expect(violations).toEqual([]);
    expect(imports).toBeGreaterThan(0); // the provider does import it
  });

  it('(b) messages.create( appears in src only in src/llm/providers/anthropic.ts', () => {
    const sites = callSites(SRC_FILES, /\bmessages\.create\s*\(/);
    expect(sites.filter((s) => s.file !== ANTHROPIC).map((s) => `${s.where}  ${s.text}`)).toEqual([]);
    expect(filesOf(sites)).toEqual(['src/llm/providers/anthropic.ts']);
  });

  it('(c) provider.complete( appears in src only in src/llm/client.ts', () => {
    const sites = callSites(SRC_FILES, /\bprovider\.complete\s*\(/);
    expect(sites.filter((s) => s.file !== LLM_CLIENT).map((s) => `${s.where}  ${s.text}`)).toEqual([]);
    expect(filesOf(sites)).toEqual(['src/llm/client.ts']);
  });

  it('(d) createAnthropicProvider( is called only where allowed, and in src only to feed createLlmClient', () => {
    const sites = callSites(SRC_SCRIPTS_E2E, /\bcreateAnthropicProvider\s*\(/);
    // The factory's own definition in the provider file is skipped by callSites.
    const violations = sites
      .filter((s) => !(rel(s.file) in PROVIDER_CONSTRUCTION_ALLOWED))
      .map((s) => `${s.where}  ${s.text}`);
    expect(violations).toEqual([]);

    // The allowlist cannot go stale: every entry must still construct a provider.
    expect(filesOf(sites)).toEqual(Object.keys(PROVIDER_CONSTRUCTION_ALLOWED).sort());

    // The provider is only ever handed to the client.
    for (const allowed of MUST_FEED_CLIENT) {
      expect(codeLinesMatching(file(allowed), /createLlmClient\(\s*\{\s*provider\b/).length).toBeGreaterThan(0);
    }
  });

  it('(e) no model host literal anywhere in scope', () => {
    const violations: string[] = [];
    for (const f of NON_SELF_FILES) {
      for (const { line, text } of codeLinesMatching(
        f,
        /api\.anthropic\.com|openai\.com|generativelanguage|openrouter|api\.cohere|api\.mistral/i,
      )) {
        violations.push(`${at(f, line)}  ${text.trim()}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('(f) fetch( appears in src only under src/components/, src/app/ and in src/npi/client.ts', () => {
    // `fetchImpl(` is the NPI client's injectable fetch, so it counts as a fetch.
    const sites = callSites(SRC_FILES, /\bfetch(?:Impl)?\s*\(/);
    const allowed = Object.keys(FETCH_ALLOWED);
    const violations = sites
      .filter((s) => !allowed.some((a) => (a.endsWith('/') ? rel(s.file).startsWith(a) : rel(s.file) === a)))
      .map((s) => `${s.where}  ${s.text}`);
    expect(violations).toEqual([]);

    // Vacuity: the NPI client really does call it, and so does the browser side.
    expect(sites.some((s) => s.file === NPI_CLIENT)).toBe(true);
    expect(sites.some((s) => rel(s.file).startsWith('src/components/'))).toBe(true);
  });
});

// ─── R5. every model call is the client's `complete` with a RedactedRequest ─

describe('no-bypass-llm R5: every model call is llm.complete(RedactedRequest)', () => {
  /** Files that call `llm.complete(`, with what each one sends. */
  const COMPLETE_CALLERS: Record<string, string> = {
    'src/agents/run.ts': 'the chat loop: assistant prompt + redacted position/memory/handover, redacted user turns, read tools',
    'src/extract/run.ts': 'document extraction and edit: static prompt, redacted text pages or consented image/PDF blocks',
    'src/memory/extract-chat.ts': 'memory extraction from one chat turn: static prompt + the redacted user text',
    'src/onboarding/parse.ts': 'the setup answer parser: static prompt + the redacted (digit-normalized) user answer',
    'src/positions/handover.ts': 'the handover narrative: static prompt + redacted position facts',
  };

  const COMPLETE_CALL = /(\w+)\s*\.complete\s*\(/;

  it('the receiver of every .complete( call is `llm` (`provider` only inside src/llm/client.ts)', () => {
    const violations: string[] = [];
    let calls = 0;
    for (const f of SRC_FILES) {
      for (const { line, text } of codeLinesMatching(f, /\.complete\s*\(/)) {
        calls += 1;
        const receiver = COMPLETE_CALL.exec(text)?.[1] ?? '(none on this line)';
        const expected = f === LLM_CLIENT ? 'provider' : 'llm';
        if (receiver !== expected) violations.push(`${at(f, line)}  receiver "${receiver}": ${text.trim()}`);
      }
    }
    expect(violations).toEqual([]);
    expect(calls).toBeGreaterThanOrEqual(6);
  });

  it('the set of files with an llm.complete( call equals the allowlist exactly', () => {
    const sites = callSites(SRC_FILES, /\bllm\.complete\s*\(/);
    expect(filesOf(sites)).toEqual(Object.keys(COMPLETE_CALLERS).sort());
  });

  it('every llm.complete( call passes a request object with purpose, system and messages (or the declared `request`)', () => {
    const violations: string[] = [];
    const sites = callSites(SRC_FILES, /\bllm\.complete\s*\(/);
    for (const s of sites) {
      const first = splitTopLevel(s.arg)[0].trim();
      if (first === 'request') {
        if (!/\bconst\s+request\s*:\s*RedactedRequest\b/.test(read(s.file))) {
          violations.push(`${s.where}  passes \`request\` but the file declares no \`const request: RedactedRequest\``);
        }
        continue;
      }
      // Shorthand properties (`system,` `messages,`) count as the property.
      const has = (name: string): boolean => new RegExp(`\\b${name}\\s*(?::|,|\\}|$)`, 'm').test(first);
      if (!first.startsWith('{') || !has('purpose') || !has('system') || !has('messages')) {
        violations.push(`${s.where}  not a request literal with purpose/system/messages: ${collapse(first).slice(0, 120)}`);
      }
    }
    expect(violations).toEqual([]);
    expect(sites.length).toBeGreaterThanOrEqual(5);
  });
});

// ─── R6. audit rows ─────────────────────────────────────────────────────────

describe('no-bypass-llm R6: model audit rows are written by the client and the audit module only', () => {
  const WRITE_AUDIT_ALLOWED: Record<string, string> = {
    'src/llm/client.ts': 'every model call, success or failure, writes its audit row here',
    'src/audit/log.ts': 'writeAuditEvent: the non-model events such as refused_confidential',
  };
  const AUDIT_CREATE_ALLOWED: Record<string, string> = {
    'src/audit/log.ts': 'writeLlmAudit itself: the one place the llmAudit table is inserted into',
    // T-33 (reviewer's decision): the trust-screen e2e seeds the rows the
    // screen must show — the table is read-only, so no product path can put a
    // known row there. The fixture writes through the real Prisma client,
    // under the DB CHECK `llm_audit_image_requires_consent_check` (I4 is still
    // enforced by Postgres), and deletes only the ids it created. Test data
    // only; never a production path.
    'e2e/fixtures/trust-db.ts': 'e2e/trust.spec.ts fixture: seeds and removes its own llm_audit rows',
  };

  it('writeLlmAudit( is called only in src/llm/client.ts and src/audit/log.ts; scripts and e2e never call it', () => {
    const sites = callSites(SRC_SCRIPTS_E2E, /\bwriteLlmAudit\s*\(/);
    expect(
      sites.filter((s) => !(rel(s.file) in WRITE_AUDIT_ALLOWED)).map((s) => `${s.where}  ${s.text}`),
    ).toEqual([]);
    expect(filesOf(sites)).toEqual(Object.keys(WRITE_AUDIT_ALLOWED).sort());
  });

  it('llmAudit.create( appears in src only in src/audit/log.ts; scripts and e2e never write rows', () => {
    const sites = callSites(SRC_SCRIPTS_E2E, /\bllmAudit\.create\s*\(/);
    expect(
      sites.filter((s) => !(rel(s.file) in AUDIT_CREATE_ALLOWED)).map((s) => `${s.where}  ${s.text}`),
    ).toEqual([]);
    expect(filesOf(sites)).toEqual(Object.keys(AUDIT_CREATE_ALLOWED).sort());
  });
});

// ─── R7. vision path (I4, ADR-27) ───────────────────────────────────────────

describe('no-bypass-llm R7: an image or a PDF reaches the model only through consent -> block builder', () => {
  /** Files that may hold an object literal `type: 'image'` / `type: 'document'`, with the reason. */
  const BLOCK_TYPE_ALLOWED: Record<string, string> = {
    'src/llm/provider.ts': 'the RedactedBlock type declaration',
    'src/llm/vision.ts': 'the producer (imageBlock / pdfBlock) and its return types',
    'src/llm/providers/anthropic.ts': 'the SDK mapping of a block to request params',
  };
  const BASE64_LITERAL_ALLOWED: Record<string, string> = {
    'src/llm/vision.ts': 'toConsentedBase64(): the one encoder',
    'src/llm/providers/anthropic.ts': 'the SDK source type `base64`',
  };

  it('(a) documentVisionBlocks( is called only in src/intake/job.ts, after requireConsent(', () => {
    const sites = callSites(SRC_FILES, /\bdocumentVisionBlocks\s*\(/);
    expect(sites.filter((s) => s.file !== INTAKE_JOB).map((s) => `${s.where}  ${s.text}`)).toEqual([]);
    expect(filesOf(sites)).toEqual(['src/intake/job.ts']);

    const consent = callSites([INTAKE_JOB], /\brequireConsent\s*\(/);
    expect(consent.length).toBeGreaterThan(0);
    expect(Math.min(...consent.map((c) => c.line))).toBeLessThan(Math.min(...sites.map((s) => s.line)));
  });

  it('(b) imageBlock( and pdfBlock( are called in src only inside src/llm/vision.ts', () => {
    const sites = callSites(SRC_FILES, /\b(?:imageBlock|pdfBlock)\s*\(/);
    expect(sites.filter((s) => s.file !== VISION).map((s) => `${s.where}  ${s.text}`)).toEqual([]);
    expect(filesOf(sites)).toEqual(['src/llm/vision.ts']); // vacuity: documentVisionBlocks does call imageBlock
  });

  it("(c) an object literal type: 'image' / type: 'document' appears in src only in the allowlisted files", () => {
    const hits = new Set<string>();
    const violations: string[] = [];
    for (const f of SRC_FILES) {
      for (const { line, text } of codeLinesMatching(f, /\btype\s*:\s*'(?:image|document)'/)) {
        hits.add(rel(f));
        if (!(rel(f) in BLOCK_TYPE_ALLOWED)) violations.push(`${at(f, line)}  ${text.trim()}`);
      }
    }
    expect(violations).toEqual([]);
    expect([...hits].sort()).toEqual(Object.keys(BLOCK_TYPE_ALLOWED).sort());
  });

  it("(d) source: { type: 'base64' appears in src only in src/llm/providers/anthropic.ts", () => {
    const violations: string[] = [];
    let hits = 0;
    for (const f of SRC_FILES) {
      for (const { line, text } of codeLinesMatching(f, /\bsource\s*:\s*\{\s*type\s*:\s*'base64'/)) {
        hits += 1;
        if (f !== ANTHROPIC) violations.push(`${at(f, line)}  ${text.trim()}`);
      }
    }
    expect(violations).toEqual([]);
    expect(hits).toBeGreaterThan(0);
  });

  it("(e) the quoted literal 'base64' appears in src only in src/llm/vision.ts and src/llm/providers/anthropic.ts", () => {
    const hits = new Set<string>();
    const violations: string[] = [];
    for (const f of SRC_FILES) {
      for (const { line, text } of codeLinesMatching(f, /'base64'/)) {
        hits.add(rel(f));
        if (!(rel(f) in BASE64_LITERAL_ALLOWED)) violations.push(`${at(f, line)}  ${text.trim()}`);
      }
    }
    expect(violations).toEqual([]);
    expect([...hits].sort()).toEqual(Object.keys(BASE64_LITERAL_ALLOWED).sort());
  });

  it('(f) consentEventId and sizeBytes never share a line with source: or data: in the provider (audit-only fields never reach the params)', () => {
    const violations: string[] = [];
    for (const { line, text } of codeLinesMatching(ANTHROPIC, /\b(?:consentEventId|sizeBytes)\b/)) {
      if (/\bsource\s*:|\bdata\s*:/.test(text)) violations.push(`${at(ANTHROPIC, line)}  ${text.trim()}`);
    }
    expect(violations).toEqual([]);
    // Vacuity: the lines that build the params exist.
    expect(codeLinesMatching(ANTHROPIC, /\bsource\s*:/).length).toBeGreaterThan(0);
  });
});

// ─── R8. model output echo ──────────────────────────────────────────────────

describe('no-bypass-llm R8: fromModelOutput( echoes the model\'s own text and nothing else', () => {
  /** file -> the exact argument allowed. */
  const FROM_MODEL_OUTPUT_ALLOWED: Record<string, string> = {
    'src/agents/run.ts': 'response.text',
  };

  it('fromModelOutput( is called in src only in src/agents/run.ts, with exactly `response.text`', () => {
    const sites = callSites(SRC_FILES, /\bfromModelOutput\s*\(/);
    const violations = sites
      .filter((s) => FROM_MODEL_OUTPUT_ALLOWED[rel(s.file)] !== collapse(s.arg))
      .map((s) => `${s.where}  fromModelOutput(${collapse(s.arg)})`);
    expect(violations).toEqual([]);
    // The allowlist cannot go stale: the call must exist.
    expect(filesOf(sites)).toEqual(Object.keys(FROM_MODEL_OUTPUT_ALLOWED).sort());
  });
});

// ─── R9. static prompts carry no user or NPI data ───────────────────────────

describe('no-bypass-llm R9: staticPrompt( takes a literal, a prompt file or a named constant', () => {
  /** Call sites allowed although their argument is not a literal or a loaded prompt. */
  const STATIC_PROMPT_ALLOWED: Array<{ file: string; arg: string; reason: string }> = [
    {
      file: 'src/onboarding/parse.ts',
      arg: 'system',
      reason:
        "built from loadPrompt('setup-parse.md') plus t() strings, the catalog pack's stepDefaults JSON and a schema hint; no user text and no NPI data",
    },
    {
      file: 'src/extract/run.ts',
      arg: 'loadPrompt(spec.promptFile) .replace(/\\{\\{our_party_hint\\}\\}/g, hint) .replace(/\\{\\{today\\}\\}/g, referenceDate)',
      reason:
        "`hint` carries the organization's own name (`user.orgNameAr` from NPI) in clear so the model does not take the firm for the customer; recorded as the open decision D-20 in PROGRESS.md (redact it through the same pseudonymizer, or keep): the guard names it so it is a conscious exception, not an oversight",
    },
  ];

  /** Named constants of src/extract/run.ts that are developer-authored strings, and the calls that build them. */
  const CONSTANT_ARGS = new Set([
    'HINT_HEADER',
    'VISION_NOTE',
    'EDIT_CURRENT_HEADER',
    'EDIT_USER_HEADER',
    'PAGE_HEADER(page.num)',
    'PAGE_HEADER(imageIndex).trim()',
  ]);

  /** `${...}` expressions a template literal may interpolate (a date and a page number). */
  const TEMPLATE_INTERPOLATIONS = new Set(['today', 'page.num', 'num']);

  /** Second arguments of `.replace(` that carry no data: a string literal or the reference date. */
  const REPLACEMENT_IDENTIFIERS = new Set(['referenceDate', 'flags.referenceDate']);

  const SINGLE_QUOTED = /^'(?:[^'\\]|\\.)*'$/;
  const DOUBLE_QUOTED = /^"(?:[^"\\]|\\.)*"$/;
  const TEMPLATE = /^`(?:[^`\\]|\\.)*`$/;

  /** Null when the argument is acceptable, otherwise the reason it is not. */
  function whyNotStatic(arg: string): string | null {
    if (CONSTANT_ARGS.has(arg)) return null;
    if (SINGLE_QUOTED.test(arg) || DOUBLE_QUOTED.test(arg)) return null;
    if (arg.startsWith('`')) {
      if (!TEMPLATE.test(arg)) return 'a template literal followed by more code';
      for (const m of arg.matchAll(/\$\{([^}]*)\}/g)) {
        if (!TEMPLATE_INTERPOLATIONS.has(m[1].trim())) return `template interpolates \${${m[1]}}`;
      }
      return null;
    }
    if (arg.startsWith('loadPrompt(')) {
      const open = arg.indexOf('(');
      const close = closingIndex(arg, open);
      if (!/^\s*(?:\.replace\s*\(|$)/.test(arg.slice(close + 1))) return 'loadPrompt(...) followed by something other than .replace(';
      for (const m of arg.matchAll(/\.replace\s*\(/g)) {
        const replaceArgs = splitTopLevel(balancedArgument(arg, (m.index ?? 0) + m[0].length - 1));
        const replacement = (replaceArgs[1] ?? '').trim();
        const ok =
          SINGLE_QUOTED.test(replacement) ||
          DOUBLE_QUOTED.test(replacement) ||
          REPLACEMENT_IDENTIFIERS.has(replacement);
        if (replaceArgs.length !== 2 || !ok) return `.replace( with a replacement that is not a literal or the reference date: ${replacement}`;
      }
      return null;
    }
    return 'neither a literal, a named constant nor loadPrompt(...)';
  }

  it('every staticPrompt( call in src passes a literal, a named constant or a loaded prompt (two documented exceptions)', () => {
    const sites = callSites(SRC_FILES, /\bstaticPrompt\s*\(/);
    const violations: string[] = [];
    const seenAllowed = new Set<number>();

    for (const s of sites) {
      const arg = collapse(s.arg).replace(/,$/, '').trim();
      const allowedAt = STATIC_PROMPT_ALLOWED.findIndex((a) => a.file === rel(s.file) && a.arg === arg);
      if (allowedAt !== -1) {
        seenAllowed.add(allowedAt);
        continue;
      }
      const why = whyNotStatic(arg);
      if (why !== null) violations.push(`${s.where}  staticPrompt(${arg})  — ${why}`);
    }

    expect(violations).toEqual([]);
    expect(sites.length).toBeGreaterThanOrEqual(15); // guard against a regex that stopped matching
    // The allowlist cannot go stale: both call sites must still exist with those exact arguments.
    expect([...seenAllowed].sort()).toEqual(STATIC_PROMPT_ALLOWED.map((_, i) => i));
  });
});
