// Position persona: which prompt file speaks for a given NPI role, and the
// Arabic title shown for a (role, department) position. See
// `apps/copilot/prompts/positions/*.md` for the persona texts themselves and
// `spec/madar/01-PRD.md` §2 for the five named roles.
import { loadPrompt } from '../prompts/load';

/** The five NPI roles this package ships a dedicated persona for. Any other
 *  `roleKey` — including one NPI adds later — falls back to `default.md`,
 *  unless `BORROWED_PERSONAS` below lends it one of the five.
 *  Role keys come from NPI data, so they are never used to build a path
 *  beyond this fixed, known set. */
export const KNOWN_ROLE_KEYS = ['admin', 'sales', 'pm', 'accountant', 'site_engineer'] as const;

export type KnownRoleKey = (typeof KNOWN_ROLE_KEYS)[number];

function isKnownRoleKey(roleKey: string): roleKey is KnownRoleKey {
  return (KNOWN_ROLE_KEYS as readonly string[]).includes(roleKey);
}

/**
 * Role keys of NPI's company role presets (ADR-02 §3-4) that have no persona
 * file of their own and speak with the closest of the five rather than with
 * `default.md`:
 *  - `finance_manager` «الإدارة المالية» records vendor bills against their
 *    purchase order and receipt — the accountant's persona;
 *  - `warehouse_keeper` «أمين المستودع» receives goods, serial numbers and
 *    quantity differences included — the site engineer's persona.
 * `technical_office` «المكتب الفني» (proposals, items, purchase orders, no
 * requisitions) fits none of the five and stays on `default.md`, as does
 * `executive`. The borrowed texts name no role title: the position line
 * above the persona carries NPI's own role name.
 */
export const BORROWED_PERSONAS: ReadonlyMap<string, KnownRoleKey> = new Map<string, KnownRoleKey>([
  ['finance_manager', 'accountant'],
  ['warehouse_keeper', 'site_engineer'],
]);

/**
 * The persona file for `roleKey`, relative to the prompts root. Never builds
 * a path out of an unrecognized `roleKey` — an unknown or hostile value
 * (one that is neither in `KNOWN_ROLE_KEYS` nor in `BORROWED_PERSONAS`)
 * always resolves to `positions/default.md`.
 */
export function personaFileFor(roleKey: string): string {
  const persona = isKnownRoleKey(roleKey) ? roleKey : BORROWED_PERSONAS.get(roleKey);
  return persona === undefined ? 'positions/default.md' : `positions/${persona}.md`;
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
