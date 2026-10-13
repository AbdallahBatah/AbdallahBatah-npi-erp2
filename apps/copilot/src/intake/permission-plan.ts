// The before/after of a permission change and the override list it writes
// (D-26, T-48b, design docs/COPILOT_D26_DESIGN_AR.md §3-ج-6). Pure: no NPI, no
// database, no model.
//
// NPI represents a user's permissions as a role plus per-user overrides, one
// GRANT or DENY per key, and `PUT /admin/users/:id/permissions` REPLACES the
// whole set. The effective set is the union of the role keys and the GRANTs
// minus the DENYs, so a DENY always wins
// (packages/shared/src/effective-permissions.ts:40-52). Hence:
//   revoke  a key the role gives          → DENY (replacing a GRANT if there is one)
//           a key held by a GRANT only    → remove the GRANT
//           a key already DENYed / absent → no change
//   grant   a key the user does not hold  → GRANT (a DENY on a role key is just removed)
//           a key already held            → no change
// The returned `overrides` is the complete new list: overrides this change does
// not touch are kept as they are, and the reason is attached only to the
// overrides this change adds.
import type { UserPermissionsValues } from '../extract/schemas/user_permissions';
import { t } from '../i18n/ar';
import { pickedId } from './resolution';
import type { FlowResolution, UserPermissionState } from './types';

export type PermissionChangeAction = 'grant' | 'revoke';

/** NPI's `PermissionOverrideDto.reason` ceiling (apps/api/src/modules/admin/dto.ts:97). */
export const OVERRIDE_REASON_MAX = 500;

export interface PlannedOverride {
  permission: string;
  effect: 'GRANT' | 'DENY';
  reason: string | null;
}

export interface PermissionChange {
  key: string;
  labelAr: string;
  /** Where the permission stands now, in Arabic. */
  beforeAr: string;
  /** Where it stands after the change, in Arabic. */
  afterAr: string;
  /** Nothing changes: the permission is already in the requested state. */
  noop: boolean;
  /** For a noop: whether the user holds the permission (selects the wording). */
  held: boolean;
}

export interface PermissionPlan {
  overrides: PlannedOverride[];
  changes: PermissionChange[];
}

export function planPermissionOverrides(
  state: UserPermissionState,
  action: PermissionChangeAction,
  keys: readonly string[],
  reason: string | null,
  labels: Readonly<Record<string, string>>,
): PermissionPlan {
  const role = new Set(state.rolePermissions);
  const overrides = new Map<string, PlannedOverride>(state.overrides.map((o) => [o.permission, { ...o }]));
  const trimmed = reason?.trim() ?? '';
  const addedReason = trimmed.length > 0 ? trimmed.slice(0, OVERRIDE_REASON_MAX) : null;
  const roleAr = state.roleAr ?? '';

  const viaRole = t('preview.permission_via_role', { role: roleAr });
  const viaGrant = t('preview.permission_via_grant');
  const denied = t('preview.permission_denied');
  const absent = t('preview.permission_absent');

  const changes: PermissionChange[] = [];
  for (const key of [...new Set(keys)]) {
    const labelAr = labels[key] ?? key;
    const existing = overrides.get(key);
    const inRole = role.has(key);
    const held = existing === undefined ? inRole : existing.effect === 'GRANT' || (inRole && existing.effect !== 'DENY');
    const heldAr = existing?.effect === 'GRANT' && !inRole ? viaGrant : viaRole;
    const stateAr = held ? heldAr : existing?.effect === 'DENY' ? denied : absent;
    const noop = (): PermissionChange => ({ key, labelAr, beforeAr: stateAr, afterAr: stateAr, noop: true, held });

    if (action === 'revoke') {
      if (existing?.effect === 'DENY' || !held) {
        changes.push(noop());
      } else if (inRole) {
        overrides.set(key, { permission: key, effect: 'DENY', reason: addedReason });
        changes.push({ key, labelAr, beforeAr: heldAr, afterAr: denied, noop: false, held });
      } else {
        // Held by a GRANT only: removing the GRANT is enough.
        overrides.delete(key);
        changes.push({ key, labelAr, beforeAr: viaGrant, afterAr: absent, noop: false, held });
      }
    } else if (held) {
      changes.push(noop());
    } else if (existing?.effect === 'DENY') {
      if (inRole) {
        // The role gives it back once the DENY is gone.
        overrides.delete(key);
        changes.push({ key, labelAr, beforeAr: denied, afterAr: viaRole, noop: false, held });
      } else {
        overrides.set(key, { permission: key, effect: 'GRANT', reason: addedReason });
        changes.push({ key, labelAr, beforeAr: denied, afterAr: viaGrant, noop: false, held });
      }
    } else {
      overrides.set(key, { permission: key, effect: 'GRANT', reason: addedReason });
      changes.push({ key, labelAr, beforeAr: absent, afterAr: viaGrant, noop: false, held });
    }
  }

  const list = [...overrides.values()].sort((a, b) => a.permission.localeCompare(b.permission, 'en'));
  return { overrides: list, changes };
}

/** «لا تغيير: «x» ممنوحة أصلاً» — the blocker text of a change that changes nothing. */
export function noopReasonAr(change: PermissionChange): string {
  return t('preview.permission_noop', {
    label: change.labelAr,
    state: t(change.held ? 'preview.permission_state.held' : 'preview.permission_state.not_held'),
  });
}

/** «التقارير المالية: ممنوحة عبر الدور «محاسب» ← محجوبة باستثناء». */
export function changeLineAr(change: PermissionChange): string {
  return t('preview.permission_change', { label: change.labelAr, before: change.beforeAr, after: change.afterAr });
}

/** What the decisions on the card amount to: the user, the key behind each
 *  written permission (null while undecided), and NPI's state of that user. */
export interface PermissionDecisions {
  userId: string | null;
  keys: (string | null)[];
  state: UserPermissionState | undefined;
}

export function permissionDecisions(
  values: Pick<UserPermissionsValues, 'permissions'>,
  resolution: FlowResolution | null,
  choices: Readonly<Record<string, string>>,
): PermissionDecisions {
  const userId = pickedId(resolution?.user, choices.user);
  return {
    userId,
    keys: values.permissions.map((_, i) => pickedId(resolution?.lines[i]?.permission, choices[`permissions.${i}.key`])),
    state: userId === null ? undefined : resolution?.current?.[userId],
  };
}

/** The plan, once the user, the state and every permission are decided; else null. */
export function permissionPlanFor(
  values: Pick<UserPermissionsValues, 'action' | 'permissions' | 'reason'>,
  resolution: FlowResolution | null,
  choices: Readonly<Record<string, string>>,
): PermissionPlan | null {
  const { state, keys } = permissionDecisions(values, resolution, choices);
  if (state === undefined || keys.some((k) => k === null)) return null;
  return planPermissionOverrides(state, values.action, keys as string[], values.reason, resolution?.permissionLabels ?? {});
}
