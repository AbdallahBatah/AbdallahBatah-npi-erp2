import path from 'node:path';
import { readFileSync } from 'node:fs';

// Point the catalog loader at the real `apps/copilot/catalog` folder before
// anything under test imports it — `catalogRoot()` is resolved lazily (on
// each call), so setting the env var here is enough, the same pattern
// `tests/positions.spec.ts` uses for `COPILOT_PROMPTS_DIR`.
process.env.COPILOT_CATALOG_DIR = path.join(__dirname, '..', 'catalog');

import {
  loadProfilePack,
  loadAllProfilePacks,
  listAvailableProfileKeys,
  overlayFileFor,
  clearCatalogCache,
  permissionGaps,
} from '../src/onboarding/catalog';
import {
  ProfilePackSchema,
  visibleFlowsOf,
  type ProfilePack,
} from '../src/onboarding/profile.schema';
import { readPermissionCatalog, permissionKeysOf } from '../src/npi/permissions';
import { t } from '../src/i18n/ar';
// Relative import straight into the monorepo package (not through
// `@npi/shared`'s build output): `permissions.ts` has no imports of its own
// (see packages/shared/src/permissions.ts:1-5), so ts-jest's per-file,
// isolated-modules compilation handles it with no extra project wiring.
import { PERMISSION_CATALOG } from '../../../packages/shared/src/permissions';

// ─── Fixture: a deep clone of the real "epc" pack, for the negative cases ──

function loadEpcPlain(): ProfilePack {
  // Re-read from disk rather than `loadProfilePack`, so later tests that call
  // `clearCatalogCache` cannot make this fixture stale.
  const raw = readFileSync(path.join(__dirname, '..', 'catalog', 'profiles', 'epc.json'), 'utf8');
  return JSON.parse(raw);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

// ─── Latin-text rule ────────────────────────────────────────────────────────
//
// 08 §E.8 / src/i18n/ar.ts:13-15: no visible Arabic string may carry a Latin
// letter except a short list of tokens NPI treats as codes (NPI itself, and
// — per ar.ts's own docstring — EPC/PPA/CSV). The T-14 brief asked this test
// to allow only "NPI", but `profile.epc` in src/i18n/ar.ts:81 is itself
// 'مقاول EPC (تصميم وتوريد وتركيب)', and 03-DESIGN-SPEC.md §5's own doc-type
// column for epc lists "عقد EPC" — titleAr must equal the former verbatim,
// and the design's own table mandates the latter. Both are therefore
// unavoidable, so this test widens the allow-list to match the precedent
// already established in src/i18n/ar.ts, instead of silently failing on the
// package's own canonical strings. See the T-14 report for this deviation.
const ALLOWED_LATIN_RUNS = new Set(['NPI', 'EPC']);

function assertNoDisallowedLatin(label: string, text: string): void {
  const runs = text.match(/[A-Za-z]+/g) ?? [];
  const disallowed = runs.filter((run) => !ALLOWED_LATIN_RUNS.has(run));
  expect({ label, disallowed }).toEqual({ label, disallowed: [] });
}

function assertNoLatinInPack(pack: ProfilePack): void {
  assertNoDisallowedLatin('titleAr', pack.titleAr);
  for (const line of pack.revenueLines) assertNoDisallowedLatin('revenueLines[]', line);
  for (const doc of pack.acceptedDocTypes) assertNoDisallowedLatin(`acceptedDocTypes.${doc.key}.labelAr`, doc.labelAr);
  for (const value of Object.values(pack.terminology ?? {})) assertNoDisallowedLatin('terminology[]', value);
  for (const dept of pack.defaultDepartments) assertNoDisallowedLatin(`defaultDepartments.${dept.code}.nameAr`, dept.nameAr);
  for (const [roleKey, roleSet] of Object.entries(pack.rolePermissionSets)) {
    assertNoDisallowedLatin(`rolePermissionSets.${roleKey}.nameAr`, roleSet.nameAr);
  }
  for (const item of pack.itemTemplates) assertNoDisallowedLatin(`itemTemplates.${item.sku}.nameAr`, item.nameAr);
  for (const position of pack.positions) {
    assertNoDisallowedLatin(`positions.${position.roleKey}.titleAr`, position.titleAr);
    assertNoDisallowedLatin(`positions.${position.roleKey}.personaAr`, position.personaAr);
  }
}

// ─── 1. Shape of every pack currently on disk ──────────────────────────────

describe('profile packs on disk', () => {
  const packs = loadAllProfilePacks();
  const keys = listAvailableProfileKeys();

  it('ships exactly the three T-14 packs for now', () => {
    expect(keys).toEqual(['epc', 'om_provider', 'ppa_operator']);
  });

  it.each(keys)('pack "%s" parses and its key matches its file name', (key) => {
    const pack = loadProfilePack(key);
    expect(pack.key).toBe(key);
  });

  it.each(keys)('pack "%s" titleAr equals t(\'profile.%s\')', (key) => {
    const pack = loadProfilePack(key);
    expect(pack.titleAr).toBe(t(`profile.${key}` as Parameters<typeof t>[0]));
  });

  it.each(keys)('pack "%s" has no disallowed Latin letters', (key) => {
    assertNoLatinInPack(loadProfilePack(key));
  });

  it.each(keys)('pack "%s": every personaAr mentions «اعتمد»', (key) => {
    const pack = loadProfilePack(key);
    for (const position of pack.positions) {
      expect(position.personaAr.includes('اعتمد')).toBe(true);
    }
  });

  it('all three packs load together via loadAllProfilePacks() in PROFILE_KEYS order', () => {
    expect(packs.map((p) => p.key)).toEqual(['epc', 'om_provider', 'ppa_operator']);
  });
});

// ─── 2. G-M2-1: every permission a pack names is one NPI actually serves ───

describe('G-M2-1: packs only name permissions NPI\'s live catalog serves', () => {
  // `02` §7 says NPI's permission surface has 35 keys; a previous draft of
  // this brief said the live catalog had 37, which was a miscount corrected
  // before this file was written — `PERMISSION_CATALOG`
  // (packages/shared/src/permissions.ts:84-132) and the seed's own
  // `ALL_PERMISSIONS` (packages/db/prisma/seed.ts:18-34) both list exactly 35.
  it('NPI\'s permission catalog has exactly 35 keys', () => {
    expect(PERMISSION_CATALOG).toHaveLength(35);
  });

  const npiKeys = permissionKeysOf(readPermissionCatalog(PERMISSION_CATALOG));

  it.each(listAvailableProfileKeys())('pack "%s" has no permission gap against NPI', (key) => {
    const pack = loadProfilePack(key);
    expect(permissionGaps(pack, npiKeys)).toEqual([]);
  });
});

// ─── 3. Negative cases: one violation at a time, on a clone of "epc" ───────

describe('ProfilePackSchema rejects one violation at a time', () => {
  it('unknown module in visibleModules', () => {
    const bad = clone(loadEpcPlain());
    bad.visibleModules.push('unknown_module');
    expect(() => ProfilePackSchema.parse(bad)).toThrow(/unknown_module/);
  });

  it('visibleModules without finance', () => {
    const bad = clone(loadEpcPlain());
    bad.visibleModules = bad.visibleModules.filter((m: string) => m !== 'finance');
    expect(() => ProfilePackSchema.parse(bad)).toThrow(/finance/);
  });

  it('approval step names a role not declared in rolePermissionSets', () => {
    const bad = clone(loadEpcPlain());
    bad.approvalRuleDefaults[0].steps.push('warehouse_keeper');
    expect(() => ProfilePackSchema.parse(bad)).toThrow(/warehouse_keeper/);
  });

  it('approval step names a declared role lacking the approving permission', () => {
    const bad = clone(loadEpcPlain());
    // "sales" is declared in epc's rolePermissionSets but holds no
    // scm.procurement.write, which PURCHASE_ORDER's approval needs.
    bad.approvalRuleDefaults[1].steps.push('sales');
    expect(() => ProfilePackSchema.parse(bad)).toThrow(/sales/);
  });

  it('position names an unknown department code', () => {
    const bad = clone(loadEpcPlain());
    bad.positions[0].departmentCode = 'NOPE';
    expect(() => ProfilePackSchema.parse(bad)).toThrow(/NOPE/);
  });

  it('doc type uses a flow whose required module is hidden', () => {
    const bad = clone(loadEpcPlain());
    bad.visibleModules = bad.visibleModules.filter((m: string) => m !== 'procurement');
    expect(() => ProfilePackSchema.parse(bad)).toThrow(/procurement/);
  });

  it('doc type uses a flow whose permission no declared role holds', () => {
    const bad = clone(loadEpcPlain());
    for (const roleSet of Object.values(bad.rolePermissionSets) as { permissions: string[] }[]) {
      roleSet.permissions = roleSet.permissions.filter((p) => p !== 'scm.requisition.write');
    }
    expect(() => ProfilePackSchema.parse(bad)).toThrow(/scm\.requisition\.write/);
  });

  it('duplicate sku in itemTemplates', () => {
    const bad = clone(loadEpcPlain());
    bad.itemTemplates[1].sku = bad.itemTemplates[0].sku;
    expect(() => ProfilePackSchema.parse(bad)).toThrow(new RegExp(bad.itemTemplates[0].sku));
  });

  it('lowercase department code', () => {
    const bad = clone(loadEpcPlain());
    bad.defaultDepartments[0].code = bad.defaultDepartments[0].code.toLowerCase();
    expect(() => ProfilePackSchema.parse(bad)).toThrow(new RegExp(bad.defaultDepartments[0].code));
  });

  it('decimal minAmount', () => {
    const bad = clone(loadEpcPlain());
    bad.approvalRuleDefaults[0].minAmount = 10000.5;
    expect(() => ProfilePackSchema.parse(bad)).toThrow(/10000\.5/);
  });

  it('maxAmount <= minAmount', () => {
    const bad = clone(loadEpcPlain());
    bad.approvalRuleDefaults[0].maxAmount = bad.approvalRuleDefaults[0].minAmount;
    expect(() => ProfilePackSchema.parse(bad)).toThrow(/maxAmount/);
  });

  it('missing admin role', () => {
    const bad = clone(loadEpcPlain());
    delete bad.rolePermissionSets.admin;
    expect(() => ProfilePackSchema.parse(bad)).toThrow(/admin/);
  });
});

// ─── 4. catalog.ts behaviour ────────────────────────────────────────────────

describe('loadProfilePack', () => {
  afterEach(() => clearCatalogCache());

  it.each(['../x', 'EPC', ''])('rejects an unknown/hostile key "%s"', (key) => {
    expect(() => loadProfilePack(key)).toThrow();
  });

  it('listAvailableProfileKeys() returns exactly the three T-14 packs', () => {
    expect(listAvailableProfileKeys()).toEqual(['epc', 'om_provider', 'ppa_operator']);
  });

  it('overlayFileFor rejects an unknown key and builds the path for a known one', () => {
    expect(overlayFileFor('epc')).toBe('overlays/epc.md');
    expect(() => overlayFileFor('nope')).toThrow();
  });

  it('visibleFlowsOf(epc) returns epc\'s flows in FLOW_TYPES order', () => {
    const epc = loadProfilePack('epc');
    // epc's acceptedDocTypes are customer_contract, po, grn, vendor_bill, pr
    // (catalog/profiles/epc.json) — FLOW_TYPES order is customer_contract,
    // pr, po, grn, vendor_bill (src/agents/router.ts:23).
    expect(visibleFlowsOf(epc)).toEqual(['customer_contract', 'pr', 'po', 'grn', 'vendor_bill']);
  });

  it('permissionGaps reports a pair when a key is removed from the given NPI list', () => {
    const epc = loadProfilePack('epc');
    const allKeys = permissionKeysOf(readPermissionCatalog(PERMISSION_CATALOG));
    const withoutContractWrite = allKeys.filter((k) => k !== 'commercial.contract.write');

    const gaps = permissionGaps(epc, withoutContractWrite);

    expect(gaps).toEqual(
      expect.arrayContaining([{ roleKey: 'admin', permission: 'commercial.contract.write' }]),
    );
    expect(gaps.length).toBeGreaterThan(0);
  });
});

// ─── 5. src/npi/permissions.ts ──────────────────────────────────────────────

describe('readPermissionCatalog', () => {
  it('rejects a non-array body', () => {
    expect(() => readPermissionCatalog({ not: 'an array' })).toThrow();
  });

  it('rejects an element missing "key"', () => {
    expect(() => readPermissionCatalog([{ groupAr: 'g', labelAr: 'l' }])).toThrow();
  });

  it('accepts the real PERMISSION_CATALOG and returns every key', () => {
    const result = readPermissionCatalog(PERMISSION_CATALOG);
    expect(result).toHaveLength(PERMISSION_CATALOG.length);
    expect(permissionKeysOf(result)).toEqual(PERMISSION_CATALOG.map((p) => p.key));
  });
});
