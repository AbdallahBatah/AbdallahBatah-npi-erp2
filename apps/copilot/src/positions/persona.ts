// Position persona: which prompt file speaks for a given NPI role, and the
// Arabic title shown for a (role, department) position. See
// `apps/copilot/prompts/positions/*.md` for the persona texts themselves and
// `spec/madar/01-PRD.md` §2 for the five named roles.
import { loadPrompt } from '../prompts/load';

/** The five NPI roles this package ships a dedicated persona for. Any other
 *  `roleKey` — including one NPI adds later — falls back to `default.md`.
 *  Role keys come from NPI data, so they are never used to build a path
 *  beyond this fixed, known set. */
export const KNOWN_ROLE_KEYS = ['admin', 'sales', 'pm', 'accountant', 'site_engineer'] as const;

export type KnownRoleKey = (typeof KNOWN_ROLE_KEYS)[number];

function isKnownRoleKey(roleKey: string): roleKey is KnownRoleKey {
  return (KNOWN_ROLE_KEYS as readonly string[]).includes(roleKey);
}

/**
 * The persona file for `roleKey`, relative to the prompts root. Never builds
 * a path out of an unrecognized `roleKey` — an unknown or hostile value
 * (e.g. one that isn't in `KNOWN_ROLE_KEYS`) always resolves to
 * `positions/default.md`.
 */
export function personaFileFor(roleKey: string): string {
  return isKnownRoleKey(roleKey) ? `positions/${roleKey}.md` : 'positions/default.md';
}

/** Loads (and caches, via `loadPrompt`) the persona text for `roleKey`. */
export function loadPersona(roleKey: string): string {
  return loadPrompt(personaFileFor(roleKey));
}

/** `"<role> — <department>"`, or just `"<role>"` when there is no department
 *  (either the position has none, or NPI would not tell us one — see
 *  `src/positions/resolve.ts`). */
export function buildTitleAr(roleNameAr: string, departmentNameAr: string | null): string {
  return departmentNameAr ? `${roleNameAr} — ${departmentNameAr}` : roleNameAr;
}
