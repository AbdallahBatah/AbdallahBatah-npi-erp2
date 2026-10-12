import type { Prisma } from '@npi/db';

/**
 * "Holds `permission` effectively", as a Prisma filter on User: the SQL twin of
 * `effectivePermissions` in @npi/shared (ADR-02 hard rule 1) for the questions
 * asked of many users at once — the lockout guard, the notification fan-out,
 * the proposal's other-approver check, the task assignee list:
 *
 *     (primary role has it OR an extra role has it OR a GRANT override names it)
 *     AND NOT a DENY override names it
 *
 * It says nothing about `isActive` or the organization; callers add both.
 * Compose it under `AND: [...]` rather than spreading it: it carries its own
 * `OR`, and a spread next to another `OR` would silently drop one of them.
 */
export function holdsEffectively(permission: string): Prisma.UserWhereInput {
  return {
    OR: [
      { role: { permissions: { has: permission } } },
      { extraRoles: { some: { role: { permissions: { has: permission } } } } },
      { permissionOverrides: { some: { permission, effect: 'GRANT' } } },
    ],
    permissionOverrides: { none: { permission, effect: 'DENY' } },
  };
}

/**
 * Holds `roleId` as the primary role or as an extra one — a seat in the
 * approval matrix. Overrides never give a seat (ADR-02 hard rule 2), so this
 * stays a role check.
 */
export function holdsRole(roleId: string): Prisma.UserWhereInput {
  return { OR: [{ roleId }, { extraRoles: { some: { roleId } } }] };
}
