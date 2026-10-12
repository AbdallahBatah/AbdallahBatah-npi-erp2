/**
 * A user's effective permission set (ADR-02 hard rule 1):
 *
 *     (union of the keys of all their roles ∪ GRANT overrides) − DENY overrides
 *
 * computed here and nowhere else. A DENY beats every grant — from the primary
 * role, an extra role or a GRANT override alike. Nothing is implied: holding a
 * `.write` key does not bring its `.read`, and losing a `.read` does not take
 * away the `.write`. Nothing else happens inside the evaluation either: data
 * scope, approval-matrix seats and delegations are separate checks made
 * where they belong.
 *
 * ADR-02 task 5 (P1-7) points `JwtStrategy.validate` (every request) and the
 * `/auth/login` and `/auth/me` responses at this one function, so the guard,
 * the web app and Madar read the same list. With no overrides its result
 * must equal today's expression in both places
 * (apps/api/src/modules/auth/jwt.strategy.ts and auth.service.ts):
 *
 *     [...new Set(roles.flatMap((r) => r.permissions))].sort((a, b) => a.localeCompare(b, 'en'))
 *
 * which apps/api/src/common/effective-permissions.spec.ts pins, so the switch
 * changes no response.
 *
 * Keys are plain strings rather than `PermissionKey`: a role's permissions are
 * a `text[]` column, and whatever it holds passes through as it does today.
 */

export type PermissionEffect = 'GRANT' | 'DENY';

export interface PermissionOverrideInput {
  permission: string;
  effect: PermissionEffect;
}

/**
 * `roleSets` is the primary role's keys first, then each extra role's. Inputs
 * are not modified; the result is deduplicated and sorted with
 * `localeCompare(…, 'en')`.
 */
export function effectivePermissions(
  roleSets: ReadonlyArray<readonly string[]>,
  overrides: readonly PermissionOverrideInput[] = [],
): string[] {
  const held = new Set(roleSets.flat());
  for (const o of overrides) {
    if (o.effect === 'GRANT') held.add(o.permission);
  }
  // Denials last, so no grant can come after them.
  for (const o of overrides) {
    if (o.effect === 'DENY') held.delete(o.permission);
  }
  return [...held].sort((a, b) => a.localeCompare(b, 'en'));
}
