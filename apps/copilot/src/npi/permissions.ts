// Runtime reader for NPI's permission catalog (`GET /admin/permissions`), in
// the same style as `directory.ts`: NPI's OpenAPI document does not type this
// response body, so the low-level client returns `unknown`, and every field
// read here is traced back to the exact NPI source line that puts it on the
// wire. A field this file cannot trace is not read here.
import { NpiError } from './errors';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function unexpected(detail: string): never {
  throw new NpiError({ status: 0, kind: 'unexpected', npiMessage: null, devDetail: detail });
}

export interface NpiPermissionMeta {
  key: string;
  groupAr: string;
  labelAr: string;
}

/**
 * `AdminController.permissionCatalog()`
 * (apps/api/src/modules/admin/admin.controller.ts:15-19,
 * `@Get('permissions')` / `return PERMISSION_CATALOG;`) returns NPI's
 * `PERMISSION_CATALOG` verbatim — no DTO or serializer in between — so every
 * element on the wire is exactly a `PermissionMeta`
 * (packages/shared/src/permissions.ts:70-76):
 *  - key      line 71 (`key: PermissionKey;`)
 *  - groupAr  line 72 (`groupAr: string;`)
 *  - labelAr  line 74 (`labelAr: string;`)
 *
 * `groupEn` and `labelEn` (lines 73, 75) are present on the wire too — every
 * entry is built by the `g()` helper (packages/shared/src/permissions.ts:78-82),
 * which maps each `[key, labelAr, labelEn]` row into a full bilingual
 * `PermissionMeta` — but neither is read here; the onboarding catalog only
 * needs the Arabic fields and the key itself.
 */
export function readPermissionCatalog(body: unknown): NpiPermissionMeta[] {
  if (!Array.isArray(body)) return unexpected('readPermissionCatalog: body is not an array');

  return body.map((row, index) => {
    if (!isRecord(row)) {
      return unexpected(`readPermissionCatalog[${index}]: element is not an object`);
    }
    const { key, groupAr, labelAr } = row;
    if (typeof key !== 'string' || key.length === 0) {
      return unexpected(`readPermissionCatalog[${index}]: missing/invalid "key"`);
    }
    if (typeof groupAr !== 'string') {
      return unexpected(`readPermissionCatalog[${index}]: missing/invalid "groupAr"`);
    }
    if (typeof labelAr !== 'string') {
      return unexpected(`readPermissionCatalog[${index}]: missing/invalid "labelAr"`);
    }
    return { key, groupAr, labelAr };
  });
}

/** Just the `key` of every entry, the shape `permissionGaps` (see
 *  `src/onboarding/catalog.ts`) and the pack schema's cross-checks need. */
export function permissionKeysOf(catalog: readonly NpiPermissionMeta[]): string[] {
  return catalog.map((entry) => entry.key);
}
