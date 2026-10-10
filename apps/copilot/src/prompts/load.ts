// Shared loader for every prompt file under `apps/copilot/prompts/` — persona
// files today (T-06), extraction and other prompt templates later. Every
// file on disk is checked-in, trusted content, but the relative path handed
// to `loadPrompt` can be built from data (e.g. an NPI role key — see
// `src/positions/persona.ts`), so this loader is the one place that refuses
// a path shaped like an escape attempt rather than trusting every caller to
// get that right.
import { readFileSync } from 'node:fs';
import path from 'node:path';

const cache = new Map<string, string>();

function promptsRoot(): string {
  return process.env.COPILOT_PROMPTS_DIR ?? path.join(process.cwd(), 'prompts');
}

/**
 * Reads `<promptsRoot>/<relPath>` as UTF-8 and caches the result by `relPath`
 * for the life of the process. Throws (does not return) for:
 *  - an absolute path,
 *  - a path containing a `..` segment (either separator),
 *  - a path that does not end in `.md`.
 * These three checks run before the cache lookup and before touching the
 * filesystem, so a hostile `relPath` never reaches `fs.readFileSync`.
 */
export function loadPrompt(relPath: string): string {
  if (path.isAbsolute(relPath)) {
    throw new Error(`loadPrompt: expected a relative path, got an absolute one: "${relPath}"`);
  }
  if (!relPath.endsWith('.md')) {
    throw new Error(`loadPrompt: expected a ".md" path, got "${relPath}"`);
  }
  if (relPath.split(/[\\/]/).includes('..')) {
    throw new Error(`loadPrompt: path must not contain "..", got "${relPath}"`);
  }

  const cached = cache.get(relPath);
  if (cached !== undefined) return cached;

  const fullPath = path.join(promptsRoot(), relPath);
  const content = readFileSync(fullPath, 'utf8');
  cache.set(relPath, content);
  return content;
}

/** Test-only escape hatch: clears the module-level cache so a test can
 *  reload a file (e.g. after pointing `COPILOT_PROMPTS_DIR` elsewhere). */
export function clearPromptCache(): void {
  cache.clear();
}
