// Loader for the onboarding profile-pack catalog (F-14).
//
// Same safety pattern as `src/prompts/load.ts` and `src/positions/persona.ts`:
// a filesystem path is built only from a value already proven to be a member
// of the fixed `PROFILE_KEYS` tuple. Anything else throws before it ever
// reaches `fs` — there is no fallback path and no "best effort" read.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PROFILE_KEYS, ProfilePackSchema, type ProfileKey, type ProfilePack } from './profile.schema';

function isProfileKey(key: string): key is ProfileKey {
  return (PROFILE_KEYS as readonly string[]).includes(key);
}

function catalogRoot(): string {
  return process.env.COPILOT_CATALOG_DIR ?? path.join(process.cwd(), 'catalog');
}

function profilePackPath(key: ProfileKey): string {
  return path.join(catalogRoot(), 'profiles', `${key}.json`);
}

const cache = new Map<ProfileKey, ProfilePack>();

/**
 * Loads, parses and validates `catalog/profiles/<key>.json`. Throws (never
 * falls back) when:
 *  - `key` is not one of `PROFILE_KEYS` — including a hostile value like
 *    `"../x"` or a wrong case like `"EPC"` — checked before any path is built;
 *  - the file is missing, is not valid JSON, or fails `ProfilePackSchema`;
 *  - the parsed pack's own `key` field does not match the file name it was
 *    read from (a copy-paste mistake between two pack files).
 * Results are cached per key for the life of the process; `clearCatalogCache`
 * is the test-only escape hatch.
 */
export function loadProfilePack(key: string): ProfilePack {
  if (!isProfileKey(key)) {
    throw new Error(`loadProfilePack: "${key}" is not a known profile key`);
  }

  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const raw = readFileSync(profilePackPath(key), 'utf8');
  const json: unknown = JSON.parse(raw);
  const pack = ProfilePackSchema.parse(json);
  if (pack.key !== key) {
    throw new Error(`loadProfilePack: "profiles/${key}.json" declares key "${pack.key}"`);
  }

  cache.set(key, pack);
  return pack;
}

/**
 * Which of the six `PROFILE_KEYS` currently have a catalog file on disk.
 * T-14 ships only three (`epc`, `om_provider`, `ppa_operator`); T-15 adds the
 * rest. Checked with `existsSync` rather than attempting-and-catching, so a
 * pack file that exists but fails to parse still throws loudly through
 * `loadProfilePack`/`loadAllProfilePacks` instead of being silently skipped.
 */
export function listAvailableProfileKeys(): ProfileKey[] {
  return PROFILE_KEYS.filter((key) => existsSync(profilePackPath(key)));
}

/** Every available pack, in `PROFILE_KEYS` order. */
export function loadAllProfilePacks(): ProfilePack[] {
  return listAvailableProfileKeys().map((key) => loadProfilePack(key));
}

/**
 * The overlay prompt file for `key`, relative to the prompts root (consumed
 * by `loadPrompt` from T-15 on, the same way `src/positions/persona.ts` does
 * for position personas). No overlay files exist yet — this only computes the
 * path and applies the same key check as `loadProfilePack`.
 */
export function overlayFileFor(key: string): string {
  if (!isProfileKey(key)) {
    throw new Error(`overlayFileFor: "${key}" is not a known profile key`);
  }
  return `overlays/${key}.md`;
}

/** Test-only escape hatch, mirroring `clearPromptCache`. */
export function clearCatalogCache(): void {
  cache.clear();
}

/**
 * Every (role, permission) pair a pack declares that NPI's live permission
 * catalog does not list — the gap between what a pack assumes NPI can grant
 * and what it actually serves today (08 §E.10: "the catalog applies only what
 * NPI's admin API accepts; gaps are listed, never worked around"). Pure: the
 * caller supplies NPI's current keys (see `src/npi/permissions.ts`), this
 * function does no I/O of its own.
 */
export function permissionGaps(
  pack: ProfilePack,
  npiPermissionKeys: readonly string[],
): { roleKey: string; permission: string }[] {
  const known = new Set(npiPermissionKeys);
  const gaps: { roleKey: string; permission: string }[] = [];
  for (const [roleKey, roleSet] of Object.entries(pack.rolePermissionSets)) {
    for (const permission of roleSet.permissions) {
      if (!known.has(permission)) gaps.push({ roleKey, permission });
    }
  }
  return gaps;
}
