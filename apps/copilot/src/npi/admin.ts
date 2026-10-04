// Runtime readers for the NPI admin screens the onboarding apply step (T-16)
// reads before it writes: roles, approval rules, items and the department
// directory's role/active columns. Same discipline as `responses.ts` and
// `directory.ts`: NPI's OpenAPI document does not type these response bodies,
// so the low-level client returns `unknown`, and every field read here is
// traced back to the exact NPI source line that puts it on the wire. A field
// this file cannot trace is not read here.
//
// Money: NPI serializes Prisma `Decimal` columns as strings (`Decimal.toJSON`
// returns a string). The two amount columns read here are approval-rule
// band edges — configuration thresholds, not money that is summed or posted —
// so they are parsed to `number` for the band comparison the plan needs.
import { NpiError } from './errors';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function unexpected(detail: string): never {
  throw new NpiError({ status: 0, kind: 'unexpected', npiMessage: null, devDetail: detail });
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/** Decimal on the wire: a numeric string, or a plain number if NPI ever
 *  switches serialization. Anything else is rejected, not coerced to NaN. */
function readAmount(value: unknown, where: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return unexpected(`${where}: amount is neither a finite number nor a numeric string`);
}

// ─── GET /admin/roles ────────────────────────────────────────────────────────

export interface NpiRole {
  id: string;
  key: string;
  nameAr: string;
  permissions: string[];
}

/**
 * `AdminService.listRoles()` (apps/api/src/modules/admin/admin.service.ts,
 * the `listRoles` method) runs `this.prisma.role.findMany({ where, include:
 * { _count: ... }, orderBy })` with no `select`, and `AdminController`
 * (`@Get('roles')`) returns that array verbatim, so every element is NPI's
 * full `Role` row (packages/db/prisma/schema.prisma, `model Role`):
 *  - id           line 241 (`id             String   @id @default(cuid())`)
 *  - key          line 244 (`key            String`)
 *  - nameAr       line 245 (`nameAr         String`)
 *  - permissions  line 248 (`permissions    String[]`)
 * `nameEn`, timestamps and `_count` are on the wire too but not read here.
 */
export function readRoles(body: unknown): NpiRole[] {
  if (!Array.isArray(body)) return unexpected('readRoles: body is not an array');
  return body.map((row, index) => {
    if (!isRecord(row)) return unexpected(`readRoles[${index}]: element is not an object`);
    const { id, key, nameAr, permissions } = row;
    if (typeof id !== 'string') return unexpected(`readRoles[${index}]: missing/invalid "id"`);
    if (typeof key !== 'string') return unexpected(`readRoles[${index}]: missing/invalid "key"`);
    if (typeof nameAr !== 'string') return unexpected(`readRoles[${index}]: missing/invalid "nameAr"`);
    if (!isStringArray(permissions)) {
      return unexpected(`readRoles[${index}]: missing/invalid "permissions"`);
    }
    return { id, key, nameAr, permissions };
  });
}

// ─── GET /approvals/rules ────────────────────────────────────────────────────

export interface NpiApprovalRule {
  id: string;
  documentType: string;
  minAmount: number;
  maxAmount: number | null;
  isActive: boolean;
  /** Role keys in signature order (steps are returned ordered by `sequence`). */
  stepRoleKeys: string[];
  stepRoleIds: string[];
}

/**
 * `ApprovalRulesService.list()` (apps/api/src/modules/approvals/approvals.service.ts,
 * the `list` method) runs `this.prisma.approvalRule.findMany({ where, include:
 * RULE_INCLUDE, orderBy })`, and `ApprovalsController` (`@Get('rules')`)
 * returns it verbatim. Scalars come off `model ApprovalRule`
 * (packages/db/prisma/schema.prisma):
 *  - id            line 1910
 *  - documentType  line 1913 (`documentType   ApprovalDocument`)
 *  - minAmount     line 1914 (`Decimal  @default(0) @db.Decimal(18, 2)` → string on the wire)
 *  - maxAmount     line 1915 (`Decimal? @db.Decimal(18, 2)` → string or null)
 *  - isActive      line 1926
 * `RULE_INCLUDE` (approvals.service.ts, top of file) adds
 * `steps: { orderBy: { sequence: 'asc' }, include: { role: { select: { id, key, nameAr, nameEn } } } }`,
 * which is where `steps[].roleId` (schema line 1944) and `steps[].role.key`
 * (schema line 244) come from. `departmentId`, `escalationHours`, `_count`
 * are on the wire too but not read here.
 */
export function readApprovalRules(body: unknown): NpiApprovalRule[] {
  if (!Array.isArray(body)) return unexpected('readApprovalRules: body is not an array');
  return body.map((row, index) => {
    const where = `readApprovalRules[${index}]`;
    if (!isRecord(row)) return unexpected(`${where}: element is not an object`);
    const { id, documentType, minAmount, maxAmount, isActive, steps } = row;
    if (typeof id !== 'string') return unexpected(`${where}: missing/invalid "id"`);
    if (typeof documentType !== 'string') return unexpected(`${where}: missing/invalid "documentType"`);
    if (typeof isActive !== 'boolean') return unexpected(`${where}: missing/invalid "isActive"`);
    if (!Array.isArray(steps)) return unexpected(`${where}: missing/invalid "steps"`);

    const stepRoleKeys: string[] = [];
    const stepRoleIds: string[] = [];
    for (const [stepIndex, step] of steps.entries()) {
      if (!isRecord(step)) return unexpected(`${where}.steps[${stepIndex}]: not an object`);
      const { roleId, role } = step;
      if (typeof roleId !== 'string') return unexpected(`${where}.steps[${stepIndex}]: missing/invalid "roleId"`);
      if (!isRecord(role) || typeof role.key !== 'string') {
        return unexpected(`${where}.steps[${stepIndex}]: missing/invalid "role.key"`);
      }
      stepRoleIds.push(roleId);
      stepRoleKeys.push(role.key);
    }

    return {
      id,
      documentType,
      minAmount: readAmount(minAmount, `${where}.minAmount`),
      maxAmount: maxAmount === null || maxAmount === undefined ? null : readAmount(maxAmount, `${where}.maxAmount`),
      isActive,
      stepRoleKeys,
      stepRoleIds,
    };
  });
}

// ─── GET /items ──────────────────────────────────────────────────────────────

export interface NpiItem {
  id: string;
  sku: string;
  nameAr: string;
  itemCategory: string;
}

/**
 * `ItemsService.list()` (apps/api/src/modules/commercial/items.service.ts,
 * the `list` method) runs `this.prisma.item.findMany({ where, orderBy })` with
 * no `select`; `ItemsController` (`@Get()`) returns it verbatim. Fields off
 * `model Item` (packages/db/prisma/schema.prisma):
 *  - id            line 414
 *  - sku           line 417
 *  - nameAr        line 418
 *  - itemCategory  line 420 (`itemCategory   ItemCategory`)
 * `unitCost` (a Decimal string) is on the wire and deliberately not read:
 * the onboarding never reads or writes prices.
 */
export function readItems(body: unknown): NpiItem[] {
  if (!Array.isArray(body)) return unexpected('readItems: body is not an array');
  return body.map((row, index) => {
    if (!isRecord(row)) return unexpected(`readItems[${index}]: element is not an object`);
    const { id, sku, nameAr, itemCategory } = row;
    if (typeof id !== 'string') return unexpected(`readItems[${index}]: missing/invalid "id"`);
    if (typeof sku !== 'string') return unexpected(`readItems[${index}]: missing/invalid "sku"`);
    if (typeof nameAr !== 'string') return unexpected(`readItems[${index}]: missing/invalid "nameAr"`);
    if (typeof itemCategory !== 'string') {
      return unexpected(`readItems[${index}]: missing/invalid "itemCategory"`);
    }
    return { id, sku, nameAr, itemCategory };
  });
}

// ─── GET /admin/departments/directory (role + active columns) ────────────────

export interface NpiDirectoryUser {
  id: string;
  isActive: boolean;
  roleKey: string;
  nameAr: string;
}

/**
 * Same endpoint `readDirectory` (directory.ts) narrows for position
 * resolution; this reader takes the other columns the onboarding needs.
 * `DIRECTORY_SELECT` (apps/api/src/modules/admin/departments.service.ts:12-20)
 * is the exact projection:
 *  - id        line 13 (`id: true,`)
 *  - nameAr    line 14 (`nameAr: true,`)
 *  - isActive  line 17 (`isActive: true,`)
 *  - role.key  line 19 (`role: { select: { id: true, key: true, nameAr: true, nameEn: true } }`)
 * NPI's own approval-rule guard (`ApprovalRulesService.validateSteps`) refuses
 * a chain through a role with no *active* user, which is why `isActive` is
 * read and not just the role key. `nameAr` is read for T-18's position-holder
 * picker, which shows the administrator each NPI user's Arabic name.
 */
export function readDirectoryUsers(body: unknown): NpiDirectoryUser[] {
  if (!Array.isArray(body)) return unexpected('readDirectoryUsers: body is not an array');
  return body.map((row, index) => {
    const where = `readDirectoryUsers[${index}]`;
    if (!isRecord(row)) return unexpected(`${where}: element is not an object`);
    const { id, isActive, role, nameAr } = row;
    if (typeof id !== 'string') return unexpected(`${where}: missing/invalid "id"`);
    if (typeof isActive !== 'boolean') return unexpected(`${where}: missing/invalid "isActive"`);
    if (typeof nameAr !== 'string') return unexpected(`${where}: missing/invalid "nameAr"`);
    if (!isRecord(role) || typeof role.key !== 'string') {
      return unexpected(`${where}: missing/invalid "role.key"`);
    }
    return { id, isActive, roleKey: role.key, nameAr };
  });
}
