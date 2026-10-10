// T-42 (Madar copilot, M5) — the owner's documents. spec/madar/05 §M5 T-42,
// acceptance «Arabic-only outside code spans»; spec/madar/08 §E.8 (the owner
// reads Arabic only).
//
// What this file proves for docs/COPILOT_RUN_AR.md and docs/COPILOT_CHANGELOG.md:
//
//  1. Language. Once fenced code blocks, inline code spans and link URLs are
//     removed, no Latin word is left except the proper nouns and acronyms
//     declared in ALLOWED_WORDS below, document codes (T-42, D-22, G-M5-3…) and
//     version tags. A failure names the file, the line and the token. Commands,
//     paths, environment names and URLs therefore have to sit in code.
//  2. Shape. The run guide has its seven sections in order; the changelog has
//     exactly one heading per tag, newest first, and its newest section says
//     what is not done yet (spec/madar/08 §E.9: never present unfinished work
//     as finished).
//  3. Truth. Every variable of apps/copilot/.env.example is explained in the
//     guide, every `npm run` script it names exists, and every repository path
//     it names in a code span exists.
//
// Pure file reads; no database, no network, no model.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const APP_ROOT = path.resolve(__dirname, '..');

const DOCS = {
  run: path.join(REPO_ROOT, 'docs', 'COPILOT_RUN_AR.md'),
  changelog: path.join(REPO_ROOT, 'docs', 'COPILOT_CHANGELOG.md'),
};

/**
 * The Latin words that may appear in Arabic prose without a code span. Each is
 * a proper noun or an acronym an Arabic reader meets in Latin letters in the
 * products themselves; anything else (commands, paths, variable names, English
 * terms) belongs in backticks.
 */
const ALLOWED_WORDS: Readonly<Record<string, string>> = {
  NPI: 'the ERP the copilot sits on; its name is Latin on every screen',
  Anthropic: 'the model provider, named in the consent policy',
  Docker: 'the container runtime, a product name',
  Caddy: 'the reverse proxy, a product name',
  Postgres: 'the database server, a product name',
  PostgreSQL: 'the same product, long form',
  Prisma: 'the database toolkit, a product name',
  Hetzner: 'the demo server host, a company name',
  Ubuntu: 'the server operating system, a product name',
  PDF: 'a file format, written Latin everywhere',
  HEIC: 'a phone photo format',
  JPEG: 'an image format',
  JPG: 'an image format',
  PNG: 'an image format',
  CSV: 'the metrics export format',
  HTTPS: 'a protocol acronym',
  HTTP: 'a protocol acronym',
  URL: 'an acronym for an address',
  API: 'an acronym for a programming interface',
  JWT: 'an acronym for the sign-in token format',
  SSH: 'a protocol acronym',
  IP: 'an acronym for a network address',
  ID: 'an acronym for an identifier',
  Windows: 'an operating system, a product name',
  PowerShell: 'a shell, a product name',
  Playwright: 'the browser test tool, a product name',
  Jest: 'the unit test tool, a product name',
  Node: 'the JavaScript runtime, a product name',
  'Next.js': 'the web framework, a product name',
  ZATCA: 'the Saudi e-invoicing authority, an acronym',
  PDPL: 'the Saudi personal data protection law, an acronym',
  Lighthouse: 'the performance measurement tool, a product name',
  Chrome: 'a browser, a product name',
  Safari: 'a browser, a product name',
  Firefox: 'a browser, a product name',
  Android: 'a phone operating system, a product name',
  iOS: 'a phone operating system, a product name',
  Google: 'a company name, the speech service owner in Chrome',
  Apple: 'a company name, the speech service owner in Safari',
  OWASP: 'the web security body, an acronym',
  CSP: 'an acronym for the content security policy header',
  Madar: 'the product name, for the rare place the Arabic form cannot stand',
};

/** Document codes: T-42, D-22, AT-17, G-M5-3, R-02, PRJ-2, M5 … (must carry a digit). */
const CODE_PREFIX = '(?:T|D|AT|F|G|R|M|PR|PRJ|CTR|INV|PO|GRN|BILL)';
const CODE_RE = new RegExp(`^${CODE_PREFIX}-?(?=[A-Za-z0-9.-]*\\d)[A-Za-z0-9.-]*$`);
const VERSION_RE = /^v?\d+\.\d+\.\d+$/;
const TAG_RE = /^copilot-v\d+\.\d+\.\d+$/;

/** A Latin word, with the joiners that keep `Next.js`, `G-M5-3` and `copilot-v0.5.0` whole. */
const LATIN_TOKEN_RE = /[A-Za-z][A-Za-z0-9]*(?:[._+-][A-Za-z0-9]+)*/g;

function isAllowed(token: string): boolean {
  return (
    Object.prototype.hasOwnProperty.call(ALLOWED_WORDS, token) ||
    CODE_RE.test(token) ||
    VERSION_RE.test(token) ||
    TAG_RE.test(token)
  );
}

interface Line {
  /** 1-based line number in the file. */
  no: number;
  text: string;
  /** True for a line inside (or delimiting) a fenced code block. */
  fenced: boolean;
}

function readLines(file: string): Line[] {
  const raw = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const lines: Line[] = [];
  let inFence = false;
  raw.forEach((text, i) => {
    const isFenceMarker = /^\s*```/.test(text);
    if (isFenceMarker) {
      inFence = !inFence;
      lines.push({ no: i + 1, text, fenced: true });
      return;
    }
    lines.push({ no: i + 1, text, fenced: inFence });
  });
  return lines;
}

/** A prose line with inline code and link/autolink URLs blanked out. */
function proseOf(text: string): string {
  return text
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\]\((?:https?:)[^)\s]*\)/g, '] ')
    .replace(/<https?:[^>\s]*>/g, ' ');
}

function latinOffenders(file: string): string[] {
  const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
  const out: string[] = [];
  for (const line of readLines(file)) {
    if (line.fenced) continue;
    const prose = proseOf(line.text);
    if (prose.includes('`')) {
      out.push(`${rel}:${line.no}: an unclosed backtick (inline code must open and close on one line)`);
      continue;
    }
    for (const m of prose.matchAll(LATIN_TOKEN_RE)) {
      if (!isAllowed(m[0])) out.push(`${rel}:${line.no}: Latin outside a code span «${m[0]}»`);
    }
  }
  return out;
}

function headingsOf(file: string): { no: number; text: string }[] {
  return readLines(file)
    .filter((l) => !l.fenced && /^##\s+/.test(l.text))
    .map((l) => ({ no: l.no, text: l.text.replace(/^##\s+/, '') }));
}

// ─── 0. The tooling of the test itself ─────────────────────────────────────

describe('the language checker', () => {
  it('lets code spans, fenced blocks, URLs, codes, tags and declared names through', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-spec-'));
    const file = path.join(dir, 'sample.md');
    fs.writeFileSync(
      file,
      [
        'نص عربي مع `npm run copilot:dev` ومع NPI و T-42 و D-22 و G-M5-3 و PR-00025 و copilot-v0.5.0 و v1.2.3 و Next.js.',
        '[رابط](https://example.com/a) و <https://example.com/b> و `docker compose`.',
        '```bash',
        'sh deploy/deploy.sh --dry-run',
        '```',
        'سطر أخير.',
      ].join('\n'),
      'utf8',
    );
    try {
      expect(latinOffenders(file)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names the file, line and token of a Latin word left outside code', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-spec-'));
    const file = path.join(dir, 'sample.md');
    fs.writeFileSync(
      file,
      ['سطر نظيف.', 'هذا rollback خارج الكود و COPILOT_PORT كذلك و `rollback` داخله.', 'وهذا `مفتوح'].join('\n'),
      'utf8',
    );
    try {
      const found = latinOffenders(file);
      expect(found).toHaveLength(3);
      expect(found[0]).toMatch(/sample\.md:2: Latin outside a code span «rollback»/);
      expect(found[1]).toMatch(/sample\.md:2: Latin outside a code span «COPILOT_PORT»/);
      expect(found[2]).toMatch(/sample\.md:3: an unclosed backtick/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a bare English word, a lowercase code and a code without a digit', () => {
    expect(isAllowed('rollback')).toBe(false);
    expect(isAllowed('docker')).toBe(false); // the declared name is «Docker»
    expect(isAllowed('Docker')).toBe(true);
    expect(isAllowed('TOKEN')).toBe(false); // starts like T- but carries no digit and no dash
    expect(isAllowed('T-42')).toBe(true);
    expect(isAllowed('G-M5-3')).toBe(true);
    expect(isAllowed('copilot-v0.5.0')).toBe(true);
    expect(isAllowed('copilot-latest')).toBe(false);
  });
});

// ─── 1. Arabic-only outside code spans ─────────────────────────────────────

describe('T-42 acceptance: Arabic-only outside code spans', () => {
  it.each(Object.entries(DOCS))('%s document exists and is not empty', (_name, file) => {
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf8').trim().length).toBeGreaterThan(500);
  });

  it('docs/COPILOT_RUN_AR.md has no Latin word outside code', () => {
    expect(latinOffenders(DOCS.run)).toEqual([]);
  });

  it('docs/COPILOT_CHANGELOG.md has no Latin word outside code', () => {
    expect(latinOffenders(DOCS.changelog)).toEqual([]);
  });

  it('the allowlist is declared with a reason for every entry', () => {
    for (const [word, reason] of Object.entries(ALLOWED_WORDS)) {
      expect(reason.trim().length).toBeGreaterThan(10);
      expect(word).toMatch(/^[A-Za-z][A-Za-z.]*$/);
    }
  });
});

// ─── 2. Shape ───────────────────────────────────────────────────────────────

describe('docs/COPILOT_RUN_AR.md: the seven sections, in order', () => {
  const SECTIONS: { name: string; words: string }[] = [
    { name: 'local run', words: 'التشغيل محلياً' },
    { name: 'deploy', words: 'النشر' },
    { name: 'backup and restore', words: 'النسخ الاحتياطي' },
    { name: 'nightly reset', words: 'التصفير' },
    { name: 'consent policy', words: 'الموافقة' },
    { name: 'when NPI rejects', words: 'يرفض NPI' },
    { name: 'where to look', words: 'مشكلة' },
  ];

  it('has one heading for each, in the order the brief gives', () => {
    const headings = headingsOf(DOCS.run);
    let last = -1;
    for (const s of SECTIONS) {
      const idx = headings.findIndex((h) => h.text.includes(s.words));
      expect({ section: s.name, found: idx >= 0 }).toEqual({ section: s.name, found: true });
      expect({ section: s.name, afterPrevious: idx > last }).toEqual({ section: s.name, afterPrevious: true });
      last = idx;
    }
  });

  it('numbers its headings with Arabic-Indic digits like the other owner documents', () => {
    const headings = headingsOf(DOCS.run);
    expect(headings).toHaveLength(7);
    headings.forEach((h, i) => {
      expect(h.text.startsWith(`${'١٢٣٤٥٦٧'[i]}.`)).toBe(true);
    });
  });

  it('quotes the consent policy line verbatim from the interface strings', () => {
    const ar = fs.readFileSync(path.join(APP_ROOT, 'src', 'i18n', 'ar.ts'), 'utf8');
    const m = ar.match(/'consent\.policy_line':\s*'([^']+)'/);
    expect(m).not.toBeNull();
    expect(fs.readFileSync(DOCS.run, 'utf8')).toContain(m![1]);
  });

  it('quotes every message of the NPI error table verbatim', () => {
    const src = fs.readFileSync(path.join(APP_ROOT, 'src', 'npi', 'errors.ts'), 'utf8');
    const block = src.match(/const AR_MESSAGES[^{]*\{([\s\S]*?)\n\};/);
    expect(block).not.toBeNull();
    const messages = [...block![1].matchAll(/:\s*'([^']+)'/g)].map((m) => m[1]);
    expect(messages).toHaveLength(9);
    const guide = fs.readFileSync(DOCS.run, 'utf8');
    for (const message of messages) expect(guide).toContain(message);
  });
});

describe('docs/COPILOT_CHANGELOG.md: one section per tag, newest first', () => {
  const TAGS = ['copilot-v0.5.0', 'copilot-v0.4.0', 'copilot-v0.3.0', 'copilot-v0.2.0', 'copilot-v0.1.0'];

  it('has exactly one heading per tag, in descending order, then Phase 0', () => {
    const headings = headingsOf(DOCS.changelog);
    const indexes = TAGS.map((tag) => {
      const hits = headings.filter((h) => h.text.includes(tag));
      expect({ tag, headings: hits.length }).toEqual({ tag, headings: 1 });
      return headings.indexOf(hits[0]);
    });
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
    const phase0 = headings.findIndex((h) => h.text.includes('المرحلة ٠'));
    expect(phase0).toBeGreaterThan(indexes[indexes.length - 1]);
  });

  it('every tag section lists its tasks as code spans (4 to 10 bullets, one sentence each)', () => {
    const lines = readLines(DOCS.changelog);
    const sections = new Map<string, string[]>();
    let current: string | null = null;
    for (const l of lines) {
      if (l.fenced) continue;
      if (/^##\s+/.test(l.text)) {
        current = TAGS.find((t) => l.text.includes(t)) ?? null;
        if (current) sections.set(current, []);
        continue;
      }
      if (current && /^- /.test(l.text)) sections.get(current)!.push(l.text);
    }
    for (const tag of TAGS) {
      const bullets = sections.get(tag) ?? [];
      // v0.5.0 also carries the «not done yet» bullets; every section stays within the brief's range.
      expect({ tag, ok: bullets.length >= 4 && bullets.length <= 12 }).toEqual({ tag, ok: true });
      for (const b of bullets) expect(b).toMatch(/`(?:T|D|G)-[0-9a-z]+/);
    }
  });

  it('the newest section is "in preparation" and says what is NOT done yet', () => {
    const text = fs.readFileSync(DOCS.changelog, 'utf8');
    const start = text.indexOf('## `copilot-v0.5.0`');
    const end = text.indexOf('## `copilot-v0.4.0`');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const section = text.slice(start, end);
    expect(section).toContain('قيد الإعداد');
    expect(section).toContain('لم يُنفَّذ بعد');
    // The unfinished tasks sit AFTER that marker, each named as a code span.
    const afterMarker = section.slice(section.indexOf('لم يُنفَّذ بعد'));
    for (const task of ['T-43', 'T-46']) expect(afterMarker).toContain(`\`${task}\``);
    // and none of them is claimed as delivered before it.
    // (the heading itself names the whole range T-38…T-46, so it is skipped)
    const beforeMarker = section.slice(section.indexOf('\n'), section.indexOf('لم يُنفَّذ بعد'));
    // T-43's local half, T-44 and T-45 are done (2026-10-09): only T-46 may not appear above the marker.
    for (const task of ['T-46']) expect(beforeMarker).not.toContain(`\`${task}\``);
  });
});

// ─── 3. Truth against the repository ───────────────────────────────────────

describe('docs/COPILOT_RUN_AR.md: names what the repository really has', () => {
  const guide = (): string => fs.readFileSync(DOCS.run, 'utf8');

  it('explains every variable of apps/copilot/.env.example', () => {
    const example = fs.readFileSync(path.join(APP_ROOT, '.env.example'), 'utf8');
    const keys = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThanOrEqual(11);
    const text = guide();
    for (const key of keys) expect({ key, mentioned: text.includes(`\`${key}\``) }).toEqual({ key, mentioned: true });
  });

  it('names only npm scripts that exist (root or apps/copilot)', () => {
    const root = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    const app = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    const known = new Set([...Object.keys(root.scripts), ...Object.keys(app.scripts)]);
    const named = new Set<string>();
    for (const line of readLines(DOCS.run)) {
      for (const m of line.text.matchAll(/npm run ([a-z0-9:-]+)/g)) named.add(m[1]);
    }
    expect(named.size).toBeGreaterThanOrEqual(8);
    for (const script of named) expect({ script, exists: known.has(script) }).toEqual({ script, exists: true });
  });

  it('names only repository paths that exist', () => {
    // Paths the guide mentions on purpose although they are not in a clean checkout.
    const NOT_IN_CHECKOUT = new Set(['deploy/.env', 'apps/copilot/.env', 'apps/copilot/perf-results/']);
    const PATH_RE = /^(?:(?:deploy|apps|docs|packages|spec|scripts)\/[A-Za-z0-9_./-]+|docker-compose[A-Za-z0-9_.-]*\.yml)$/;
    const missing: string[] = [];
    let checked = 0;
    for (const file of Object.values(DOCS)) {
      for (const line of readLines(file)) {
        if (line.fenced) continue;
        for (const m of line.text.matchAll(/`([^`\n]+)`/g)) {
          const candidate = m[1];
          if (!PATH_RE.test(candidate) || NOT_IN_CHECKOUT.has(candidate)) continue;
          checked += 1;
          if (!fs.existsSync(path.join(REPO_ROOT, candidate))) missing.push(`${path.basename(file)}:${line.no}: ${candidate}`);
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(20);
    expect(missing).toEqual([]);
  });
});
