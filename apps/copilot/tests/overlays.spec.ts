import path from 'node:path';
import { readFileSync } from 'node:fs';

// Same two-env-var setup `tests/positions.spec.ts` and `tests/catalog.spec.ts`
// use, so both the prompt loader and the catalog loader resolve against the
// real `apps/copilot` folders before anything under test imports them.
process.env.COPILOT_PROMPTS_DIR = path.join(__dirname, '..', 'prompts');
process.env.COPILOT_CATALOG_DIR = path.join(__dirname, '..', 'catalog');

import { loadPrompt } from '../src/prompts/load';
import { overlayFileFor, loadProfilePack } from '../src/onboarding/catalog';
import { PROFILE_KEYS, MODULE_KEYS, MODULE_NAMES_AR } from '../src/onboarding/profile.schema';

const PROMPTS_ROOT = path.join(__dirname, '..', 'prompts');

// ─── Latin-text rule — copied, not imported, from catalog.spec.ts's
// `assertNoDisallowedLatin` per the brief: the overlay allow-list is NPI,
// EPC and PPA (catalog.spec.ts's is narrower, NPI/EPC only). ───────────────
const ALLOWED_LATIN_RUNS = new Set(['NPI', 'EPC', 'PPA']);

function assertNoDisallowedLatin(label: string, text: string): void {
  const runs = text.match(/[A-Za-z]+/g) ?? [];
  const disallowed = runs.filter((run) => !ALLOWED_LATIN_RUNS.has(run));
  expect({ label, disallowed }).toEqual({ label, disallowed: [] });
}

describe('prompts/overlays/<key>.md', () => {
  it.each(PROFILE_KEYS)('overlayFileFor(%s) resolves to overlays/%s.md and loadPrompt reads it from disk', (key) => {
    expect(overlayFileFor(key)).toBe(`overlays/${key}.md`);
    const onDisk = readFileSync(path.join(PROMPTS_ROOT, 'overlays', `${key}.md`), 'utf8');
    expect(loadPrompt(overlayFileFor(key))).toBe(onDisk);
  });

  it.each(PROFILE_KEYS)('overlay "%s" trimmed length is between 500 and 1500 characters', (key) => {
    const text = readFileSync(path.join(PROMPTS_ROOT, 'overlays', `${key}.md`), 'utf8');
    const length = text.trim().length;
    expect(length).toBeGreaterThanOrEqual(500);
    expect(length).toBeLessThanOrEqual(1500);
  });

  it.each(PROFILE_KEYS)('overlay "%s" has no Markdown markers', (key) => {
    const text = readFileSync(path.join(PROMPTS_ROOT, 'overlays', `${key}.md`), 'utf8');
    expect(text).not.toMatch(/^\s*(#|-|\*|>|\||\d+[.)])\s/m);
    expect(text).not.toMatch(/\*\*/);
    expect(text).not.toMatch(/`/);
  });

  it.each(PROFILE_KEYS)('overlay "%s" has no disallowed Latin letters', (key) => {
    const text = readFileSync(path.join(PROMPTS_ROOT, 'overlays', `${key}.md`), 'utf8');
    assertNoDisallowedLatin(`overlays/${key}.md`, text);
  });

  it.each(PROFILE_KEYS)('overlay "%s" contains «اعتمد»', (key) => {
    const text = readFileSync(path.join(PROMPTS_ROOT, 'overlays', `${key}.md`), 'utf8');
    expect(text.includes('اعتمد')).toBe(true);
  });

  it.each(PROFILE_KEYS)('overlay "%s" contains every acceptedDocTypes.labelAr and every terminology value', (key) => {
    const text = readFileSync(path.join(PROMPTS_ROOT, 'overlays', `${key}.md`), 'utf8');
    const pack = loadProfilePack(key);
    for (const docType of pack.acceptedDocTypes) {
      expect(text.includes(docType.labelAr)).toBe(true);
    }
    for (const value of Object.values(pack.terminology ?? {})) {
      expect(text.includes(value as string)).toBe(true);
    }
  });

  it.each(PROFILE_KEYS)('overlay "%s" names every hidden module by its MODULE_NAMES_AR value', (key) => {
    const text = readFileSync(path.join(PROMPTS_ROOT, 'overlays', `${key}.md`), 'utf8');
    const pack = loadProfilePack(key);
    const visible = new Set(pack.visibleModules);
    for (const moduleKey of MODULE_KEYS) {
      if (visible.has(moduleKey)) continue;
      expect(text.includes(MODULE_NAMES_AR[moduleKey])).toBe(true);
    }
  });
});

describe('MODULE_NAMES_AR', () => {
  it('has exactly the keys of MODULE_KEYS', () => {
    expect(Object.keys(MODULE_NAMES_AR).sort()).toEqual([...MODULE_KEYS].sort());
  });

  it('no value contains a Latin letter', () => {
    for (const [moduleKey, nameAr] of Object.entries(MODULE_NAMES_AR)) {
      expect({ moduleKey, hasLatin: /[A-Za-z]/.test(nameAr) }).toEqual({ moduleKey, hasLatin: false });
    }
  });
});
