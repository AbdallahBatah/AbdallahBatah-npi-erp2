// user_permissions flow (D-26, T-48b): one step, `permissions_set` — the whole
// new list of the user's per-user overrides, written with NPI's
// `PUT /admin/users/:id/permissions` after the administrator's own «اعتمد».
// NPI keeps its rules (the last administrator cannot be locked out, 400) and
// writes the audit row; a refusal is the step's failure, never retried.
// The user, their role and their password are never touched.
import type { UserPermissionsValues } from '../../extract/schemas/user_permissions';
import { t } from '../../i18n/ar';
import { noopReasonAr, permissionDecisions, planPermissionOverrides } from '../../intake/permission-plan';
import type { CreatedEntity } from '../../intake/types';
import { driftError, labelled, PlanError, type PlannedStep, type PlanInput } from '../plan';
import type { PerformContext } from '../run';

export function planUserPermissions(input: PlanInput, labels: string[]): PlannedStep[] {
  const values = input.values as UserPermissionsValues;
  const resolution = input.resolution;
  const decisions = permissionDecisions(values, resolution, input.choices);

  const { userId } = decisions;
  if (userId === null) {
    throw new PlanError(t('exec.error.plan', { reason: t('exec.reason.entity_undecided', { entity: t('exec.kind.user') }) }));
  }
  const keys = decisions.keys.map((key, i) => {
    if (key === null) throw new PlanError(t('exec.error.plan', { reason: t('preview.permission_required', { name: values.permissions[i]?.name ?? String(i + 1) }) }));
    return key;
  });
  // The state the preview was built from; without it the before/after (and so
  // the list to write) cannot be recomputed.
  const { state } = decisions;
  if (state === undefined) throw driftError();

  const plan = planPermissionOverrides(state, values.action, keys, values.reason, resolution?.permissionLabels ?? {});
  const noop = plan.changes.find((c) => c.noop);
  if (plan.changes.every((c) => c.noop)) {
    throw new PlanError(t('exec.error.plan', { reason: noopReasonAr(noop ?? plan.changes[0]) }));
  }

  const pick = resolution?.user;
  const userLabelAr =
    pick?.kind === 'matched' ? pick.labelAr : pick?.kind === 'candidates' ? (pick.candidates.find((c) => c.id === userId)?.labelAr ?? values.userName) : values.userName;
  return labelled(labels, [{ kind: 'permissions_set', userId, userLabelAr, overrides: plan.overrides }]);
}

export async function performUserPermissions(step: PlannedStep, ctx: PerformContext): Promise<{ entity: CreatedEntity | null }> {
  switch (step.kind) {
    case 'permissions_set':
      // The full list: NPI replaces the user's overrides with exactly this.
      await ctx.npi.setUserPermissions(step.userId, { overrides: step.overrides });
      return { entity: { kind: 'user_permissions', id: step.userId, code: step.userLabelAr, npiPath: '/admin' } };
    default:
      throw new Error(`performUserPermissions: unexpected step kind ${step.kind}`);
  }
}
