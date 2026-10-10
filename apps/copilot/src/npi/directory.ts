// Runtime readers for NPI's department admin screens
// (`GET /admin/departments` and `GET /admin/departments/directory`), in the
// same style as `responses.ts`: NPI's OpenAPI document does not type these
// response bodies, so the low-level client returns `unknown`, and every
// field read here is traced back to the exact NPI source line that puts it
// on the wire. A field this file cannot trace is not read here.
//
// Both endpoints require the NPI permission `admin.department.manage` — an
// ordinary employee gets a 403 from NPI itself, which the caller (see
// `src/positions/resolve.ts`) must treat as "the department is unknown",
// never as a reason to fail. This file only narrows the body; it has no
// opinion on permissions or on what happens when a call fails.
import { NpiError } from './errors';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function unexpected(detail: string): never {
  throw new NpiError({ status: 0, kind: 'unexpected', npiMessage: null, devDetail: detail });
}

// ─── GET /admin/departments ─────────────────────────────────────────────────

export interface NpiDepartment {
  id: string;
  code: string;
  nameAr: string;
  isActive: boolean;
}

/**
 * `DepartmentsService.list()` (apps/api/src/modules/admin/departments.service.ts:51-57)
 * runs `this.prisma.department.findMany({ where: ..., include: DEPARTMENT_INCLUDE, ... })`
 * with no `select`, so the controller (departments.controller.ts:24,
 * `return this.departments.list(user);`) serializes NPI's full `Department`
 * row for every element. The scalar columns read here come straight off the
 * model (packages/db/prisma/schema.prisma, `model Department`):
 *  - id        line 2207 (`id             String   @id @default(cuid())`)
 *  - code      line 2210 (`code           String`)
 *  - nameAr    line 2211 (`nameAr         String`)
 *  - isActive  line 2218 (`isActive       Boolean  @default(true)`)
 *
 * `DEPARTMENT_INCLUDE` (departments.service.ts:22-26) only adds `manager`,
 * `parent` and `_count` — none of those are read here, and their absence
 * does not affect the four fields above.
 */
export function readDepartments(body: unknown): NpiDepartment[] {
  if (!Array.isArray(body)) return unexpected('readDepartments: body is not an array');

  return body.map((row, index) => {
    if (!isRecord(row)) return unexpected(`readDepartments[${index}]: element is not an object`);
    const { id, code, nameAr, isActive } = row;
    if (typeof id !== 'string') return unexpected(`readDepartments[${index}]: missing/invalid "id"`);
    if (typeof code !== 'string') return unexpected(`readDepartments[${index}]: missing/invalid "code"`);
    if (typeof nameAr !== 'string') return unexpected(`readDepartments[${index}]: missing/invalid "nameAr"`);
    if (typeof isActive !== 'boolean') {
      return unexpected(`readDepartments[${index}]: missing/invalid "isActive"`);
    }
    return { id, code, nameAr, isActive };
  });
}

// ─── GET /admin/departments/directory ───────────────────────────────────────

export interface NpiDirectoryEntry {
  id: string;
  departmentId: string | null;
}

/**
 * `DepartmentsService.directory()` (departments.service.ts:65-71) runs
 * `this.prisma.user.findMany({ where: ..., select: DIRECTORY_SELECT, ... })`,
 * and the controller (departments.controller.ts:31,
 * `return this.departments.directory(user);`) returns that array verbatim.
 * `DIRECTORY_SELECT` (departments.service.ts:12-20) is the exact projection
 * that puts these two fields on the wire:
 *  - id            line 13 (`id: true,`)
 *  - departmentId  line 18 (`departmentId: true,`)
 *
 * Every other key in `DIRECTORY_SELECT` (nameAr, nameEn, email, isActive,
 * role) is present on the wire too but not read here — only what M1 needs
 * for position resolution (T-06) is narrowed.
 */
export function readDirectory(body: unknown): NpiDirectoryEntry[] {
  if (!Array.isArray(body)) return unexpected('readDirectory: body is not an array');

  return body.map((row, index) => {
    if (!isRecord(row)) return unexpected(`readDirectory[${index}]: element is not an object`);
    const { id, departmentId } = row;
    if (typeof id !== 'string') return unexpected(`readDirectory[${index}]: missing/invalid "id"`);
    if (departmentId !== null && typeof departmentId !== 'string') {
      return unexpected(`readDirectory[${index}]: "departmentId" present but not string/null`);
    }
    return { id, departmentId: departmentId ?? null };
  });
}
