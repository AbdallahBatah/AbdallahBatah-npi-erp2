// Resolves the copilot "position" (role + department, inside one NPI
// organization — see `spec/madar/01-PRD.md` §2, BR-07) for the logged-in
// user, creating the `Position`/`PositionAssignment` rows on first sight.
//
// NPI's `/auth/me` never returns a department id (see the NOT-read note on
// `NpiMe` in `src/npi/responses.ts`), and the two endpoints that do carry
// one — `/admin/departments` and `/admin/departments/directory` — require
// the NPI permission `admin.department.manage`, which an ordinary employee
// does not hold. This file is the one place that works around that gap: it
// never guesses a department from a role name, and it never fails a login
// because the department could not be read — a user without that
// permission (or one for whom the read failed) simply gets a position with
// no department (`departmentId: null`).
import type { Position, PositionAssignment } from '../generated/prisma';
import { NpiError } from '../npi/errors';
import { readDepartments, readDirectory } from '../npi/directory';
import type { NpiMe } from '../npi/responses';
import { buildTitleAr, loadPersona } from './persona';

export type PositionSource = 'assignment' | 'npi_directory' | 'role_only';

export interface ResolvedPosition {
  positionId: string;
  roleKey: string;
  departmentId: string | null;
  departmentNameAr: string | null;
  titleAr: string;
  personaAr: string;
  source: PositionSource;
}

/** The exact (org, role, department) key a `Position` row is unique on —
 *  see the `@@unique([npiOrgId, roleKey, departmentId])` in
 *  `apps/copilot/prisma/schema.prisma`. */
interface PositionKey {
  npiOrgId: string;
  roleKey: string;
  departmentId: string | null;
}

/**
 * The minimal subset of the Prisma client `resolvePosition` calls. Typed
 * structurally (not `import`ed from `@prisma/client`/the generated client at
 * runtime) so that both the real `PrismaClient` (from `src/generated/prisma`)
 * and a small in-memory fake in tests satisfy it.
 */
export interface PositionsDb {
  position: {
    findFirst(args: { where: PositionKey }): Promise<Position | null>;
    create(args: {
      data: PositionKey & { titleAr: string; personaAr: string };
    }): Promise<Position>;
  };
  positionAssignment: {
    findFirst(args: {
      where: {
        npiUserId: string;
        endedAt: null;
        positionId?: string;
        position?: { npiOrgId: string; roleKey: string };
      };
      include?: { position: true };
    }): Promise<(PositionAssignment & { position?: Position }) | null>;
    create(args: { data: { positionId: string; npiUserId: string } }): Promise<PositionAssignment>;
  };
}

/** The subset of `NpiClient` this file calls — both gated behind
 *  `admin.department.manage` in NPI (see `src/npi/directory.ts`). */
export interface PositionsNpi {
  listDepartments(): Promise<unknown>;
  listDepartmentDirectory(): Promise<unknown>;
}

const DEPARTMENT_PERMISSION = 'admin.department.manage';

/** Prisma's unique-constraint-violation error code — the shape a create can
 *  fail with when another request created the same row first. Checked
 *  structurally (no `@prisma/client` import) since this file must not
 *  import the runtime Prisma client. */
function isUniqueConstraintError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

async function findOrCreatePosition(
  db: PositionsDb,
  key: PositionKey,
  roleNameAr: string,
  departmentNameAr: string | null,
): Promise<Position> {
  const existing = await db.position.findFirst({ where: key });
  if (existing) return existing;

  try {
    return await db.position.create({
      data: {
        ...key,
        titleAr: buildTitleAr(roleNameAr, departmentNameAr),
        personaAr: loadPersona(key.roleKey),
      },
    });
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    // A concurrent request created the same (org, role, department) position
    // first — re-read rather than fail.
    const created = await db.position.findFirst({ where: key });
    if (created) return created;
    throw err;
  }
}

async function ensureAssignment(db: PositionsDb, positionId: string, npiUserId: string): Promise<void> {
  const existing = await db.positionAssignment.findFirst({
    where: { positionId, npiUserId, endedAt: null },
  });
  if (existing) return;
  await db.positionAssignment.create({ data: { positionId, npiUserId } });
}

/**
 * Step 2 of resolution: only attempted when the caller holds
 * `admin.department.manage`. Calls `listDepartmentDirectory()` to find this
 * user's `departmentId`, then (only if non-null) `listDepartments()` for its
 * Arabic name. Per the design, either call failing with an `NpiError` (of
 * any kind, including a malformed body from `readDirectory`/`readDepartments`)
 * falls through to "no department known" as a single unit — a login must
 * never fail because NPI's department screen could not be read. A
 * non-`NpiError` is rethrown.
 */
async function lookupDepartmentViaNpi(
  npi: PositionsNpi,
  me: NpiMe,
): Promise<{ departmentId: string | null; departmentNameAr: string | null } | null> {
  if (!me.permissions.includes(DEPARTMENT_PERMISSION)) return null;

  try {
    const directory = readDirectory(await npi.listDepartmentDirectory());
    const entry = directory.find((row) => row.id === me.id);
    const departmentId = entry?.departmentId ?? null;

    let departmentNameAr: string | null = null;
    if (departmentId !== null) {
      const departments = readDepartments(await npi.listDepartments());
      departmentNameAr = departments.find((d) => d.id === departmentId)?.nameAr ?? null;
    }
    return { departmentId, departmentNameAr };
  } catch (err) {
    if (!(err instanceof NpiError)) throw err;
    return null;
  }
}

/**
 * Resolves (and persists, on first sight) the caller's position.
 *
 * 1. **Active assignment** — an assignment with `npiUserId = me.id`,
 *    `endedAt = null`, whose position is in the caller's org and matches
 *    `me.roleKey`. Found → `source: 'assignment'`; no NPI call is made. An
 *    active assignment whose position has a *different* role (the user's
 *    NPI role changed since) is ignored here — left untouched for T-30 — and
 *    resolution continues below.
 * 2. **NPI directory** — see `lookupDepartmentViaNpi`. `source: 'npi_directory'`.
 * 3. **Role only** — `departmentId: null`. `source: 'role_only'`.
 *
 * For steps 2 and 3, the `Position` row for (org, role, department) is
 * found or created (`titleAr`/`personaAr` generated only on create — an
 * existing row's stored values win, since an admin may have customized
 * them during setup), and an active assignment for this user on it is
 * created if one does not already exist.
 */
export async function resolvePosition(
  deps: { db: PositionsDb; npi: PositionsNpi; now?: () => Date },
  me: NpiMe,
): Promise<ResolvedPosition> {
  // Filtered by organization and role in the query itself: a user whose NPI
  // role changed keeps a stale open assignment on the old position (left for
  // T-30), and that row must not hide the current one.
  const active = await deps.db.positionAssignment.findFirst({
    where: {
      npiUserId: me.id,
      endedAt: null,
      position: { npiOrgId: me.organizationId, roleKey: me.roleKey },
    },
    include: { position: true },
  });

  if (
    active?.position &&
    active.position.npiOrgId === me.organizationId &&
    active.position.roleKey === me.roleKey
  ) {
    const position = active.position;
    return {
      positionId: position.id,
      roleKey: position.roleKey,
      departmentId: position.departmentId,
      departmentNameAr: null,
      titleAr: position.titleAr,
      personaAr: position.personaAr,
      source: 'assignment',
    };
  }

  const viaNpi = await lookupDepartmentViaNpi(deps.npi, me);
  const source: PositionSource = viaNpi ? 'npi_directory' : 'role_only';
  const departmentId = viaNpi?.departmentId ?? null;
  const departmentNameAr = viaNpi?.departmentNameAr ?? null;

  const position = await findOrCreatePosition(
    deps.db,
    { npiOrgId: me.organizationId, roleKey: me.roleKey, departmentId },
    me.roleNameAr,
    departmentNameAr,
  );

  await ensureAssignment(deps.db, position.id, me.id);

  return {
    positionId: position.id,
    roleKey: position.roleKey,
    departmentId: position.departmentId,
    departmentNameAr,
    titleAr: position.titleAr,
    personaAr: position.personaAr,
    source,
  };
}
