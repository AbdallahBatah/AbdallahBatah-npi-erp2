// Runtime readers for NPI response bodies.
//
// NPI's OpenAPI document does not type most response bodies (see
// apps/copilot/src/npi/openapi.json — request DTOs are typed, responses
// mostly come back as `{ type: object }` or are missing from the spec
// entirely). The low-level client therefore returns `unknown` for every
// response, and this file is the one place that narrows specific shapes —
// only the ones M1 actually needs, and only fields this file can trace back
// to the exact NPI source line that puts them on the wire. A field this file
// cannot trace is not read here; see the T-04 report for the list.
//
// No zod, no new dependency: every reader below is a small hand-written
// type guard, matching the brief for this task.
import { NpiError } from './errors';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function unexpected(detail: string): never {
  throw new NpiError({ status: 0, kind: 'unexpected', npiMessage: null, devDetail: detail });
}

// ─── /auth/me — the user object also embedded in /auth/login's response ───

export interface NpiMe {
  id: string;
  organizationId: string;
  /** Arabic display name of the user (greeting, shell header). */
  nameAr: string;
  roleKey: string;
  /** Arabic display name of the role (position title). */
  roleNameAr: string;
  /** Bilingual role permission keys, as stored on the role — NPI does not
   *  document the element type further than `string[]`. */
  permissions: string[];
  /** Arabic legal name of the user's organization (`organization.nameAr` of
   *  `/auth/me`), null when NPI does not send one. The extraction prompts use it
   *  so the firm's own name is not mistaken for the customer. */
  orgNameAr: string | null;
}

/**
 * Fields and their source:
 *  - id            apps/api/src/modules/auth/auth.service.ts:104 (`id: user.id,`)
 *  - nameAr        apps/api/src/modules/auth/auth.service.ts:106 (`nameAr: user.nameAr,`)
 *  - roleKey       apps/api/src/modules/auth/auth.service.ts:109 (`roleKey: user.role.key,`)
 *  - roleNameAr    apps/api/src/modules/auth/auth.service.ts:110 (`roleNameAr: user.role.nameAr,`)
 *  - permissions   apps/api/src/modules/auth/auth.service.ts:112 (`permissions: user.role.permissions,`)
 *  - organizationId apps/api/src/modules/auth/auth.service.ts:114 (`organization: { id: user.organization.id, ... }`)
 *  - orgNameAr     apps/api/src/modules/auth/auth.service.ts:116 (`nameAr: user.organization.legalNameAr`)
 *
 * NOT read here: a department id. `AuthService.me()` (auth.service.ts:98-120)
 * builds its return object field-by-field and never includes one — there is
 * no `departmentId` (or similar) anywhere in that object, so this reader
 * cannot honestly report one. See the T-04 report.
 */
export function readMe(body: unknown): NpiMe {
  if (!isRecord(body)) return unexpected('readMe: body is not an object');

  const { id, nameAr, roleKey, roleNameAr, permissions, organization } = body;
  if (typeof id !== 'string') return unexpected('readMe: missing/invalid "id"');
  if (typeof nameAr !== 'string') return unexpected('readMe: missing/invalid "nameAr"');
  if (typeof roleKey !== 'string') return unexpected('readMe: missing/invalid "roleKey"');
  if (typeof roleNameAr !== 'string') return unexpected('readMe: missing/invalid "roleNameAr"');
  if (!Array.isArray(permissions) || !permissions.every((p) => typeof p === 'string')) {
    return unexpected('readMe: missing/invalid "permissions"');
  }
  if (!isRecord(organization) || typeof organization.id !== 'string') {
    return unexpected('readMe: missing/invalid "organization.id"');
  }

  return {
    id,
    nameAr,
    roleKey,
    roleNameAr,
    permissions,
    organizationId: organization.id,
    orgNameAr: typeof organization.nameAr === 'string' && organization.nameAr.trim().length > 0 ? organization.nameAr : null,
  };
}

// ─── /auth/login ────────────────────────────────────────────────────────────

export interface NpiLogin {
  accessToken: string;
  user: NpiMe;
}

/**
 * Fields and their source (apps/api/src/modules/auth/auth.service.ts, the
 * `login` method):
 *  - accessToken    line 57 (`accessToken: token,`)
 *  - user.id        line 59
 *  - user.nameAr    line 61
 *  - user.roleKey   line 64 (`roleKey: user.role.key,`)
 *  - user.roleNameAr line 65
 *  - user.permissions line 67
 *  - user.organizationId line 69 (`organization: { id: user.organization.id, ... }`)
 *
 * Same NOT-read caveat as `readMe`: no department id is ever put on this
 * object either.
 */
export function readLogin(body: unknown): NpiLogin {
  if (!isRecord(body)) return unexpected('readLogin: body is not an object');

  const { accessToken, user } = body;
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    return unexpected('readLogin: missing/invalid "accessToken"');
  }
  return { accessToken, user: readMe(user) };
}

// ─── created-document references (customer, contract, PO, GRN, bill, PR) ──

export interface NpiEntityRef {
  id: string;
  code: string | null;
}

/**
 * Every "create" endpoint in this client returns NPI's raw Prisma record for
 * the created row (no DTO/serializer in between), so `id` and `code` are the
 * model's own primary key and generated business code:
 *
 *  - Customer            apps/api/src/modules/crm/customers.service.ts:72 (`return customer;`)
 *                         id/code: packages/db/prisma/schema.prisma:336,339
 *  - Contract             apps/api/src/modules/commercial/contracts.service.ts:145 (`return contract;`)
 *                         id/code: packages/db/prisma/schema.prisma:533,536
 *  - PurchaseOrder        apps/api/src/modules/procurement/procurement.service.ts:242 (`return po;`)
 *                         id/code: packages/db/prisma/schema.prisma:952,955
 *  - GoodsReceipt (from   apps/api/src/modules/procurement/procurement.service.ts:696 (`return grn;`)
 *    receiveOnPurchaseOrder) id/code: packages/db/prisma/schema.prisma:1001,1004
 *  - VendorBill            apps/api/src/modules/procurement/procurement.service.ts:777 (`return bill;`)
 *                         id/code: packages/db/prisma/schema.prisma:1669,1672
 *  - PurchaseRequisition   apps/api/src/modules/procurement/requisitions.service.ts:192 (`return pr;`)
 *                         id/code: packages/db/prisma/schema.prisma:2274,2277
 *
 * `code` is read as optional-but-typed: every model above does have a `code`
 * column, but this reader tolerates its absence rather than fail a caller
 * that only needs the id (e.g. a differently-shaped success body NPI adds
 * later for one of these routes).
 */
export function readEntityRef(body: unknown): NpiEntityRef {
  if (!isRecord(body)) return unexpected('readEntityRef: body is not an object');

  const { id, code } = body;
  if (typeof id !== 'string' || id.length === 0) {
    return unexpected('readEntityRef: missing/invalid "id"');
  }
  if (code !== undefined && typeof code !== 'string') {
    return unexpected('readEntityRef: "code" present but not a string');
  }
  return { id, code: code ?? null };
}

// ─── paginated / plain lists ────────────────────────────────────────────────

/**
 * Two shapes are in real use:
 *  - A plain array — every list in this client except requisitions:
 *    apps/api/src/modules/crm/customers.service.ts:17 (`findMany`), items.service.ts:11,
 *    apps/api/src/modules/projects/projects.service.ts:44,
 *    apps/api/src/modules/commercial/contracts.service.ts:23,
 *    apps/api/src/modules/procurement/procurement.service.ts:91 (vendors) and :133 (purchase orders)
 *    all return the `findMany(...)` result directly — a bare JSON array.
 *  - `{ total, rows }` — GET /requisitions only:
 *    apps/api/src/modules/procurement/requisitions.service.ts:105 (`return { total, rows };`),
 *    with `total` from the `count()` at line 90 and `rows` from the `findMany()` at line 91.
 */
export function readList(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (isRecord(body) && Array.isArray(body.rows)) return body.rows;
  return unexpected('readList: body is neither an array nor an envelope with "rows"');
}
