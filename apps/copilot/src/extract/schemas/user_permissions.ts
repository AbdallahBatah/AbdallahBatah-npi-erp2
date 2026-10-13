// Permission-change extraction schema (D-26, T-48b, spec 02 §5.5, ADR-28).
//
// An administrator writes one sentence («شيل صلاحية التقارير المالية من أحمد»);
// the model's JSON names who, whether to grant or revoke, and which
// permissions — as written. Nothing here knows NPI's permission keys: the
// resolution (`src/intake/resolution.ts`) maps the user's name to a directory
// entry and each written name to a key of NPI's own catalog, and
// `src/intake/permission-plan.ts` turns the decision into the override list
// `PUT /admin/users/:id/permissions` replaces the old one with.
//
// NPI facts the rules follow (apps/api/src/modules/admin/dto.ts:82-105):
//   reason   optional, at most 500 characters
//   a user's overrides are one GRANT or DENY per permission key
import { z } from 'zod';
import { assessField, fromWire, type AssessedField, type WireField } from './field';
import { textField, wire, NO_FLAGS, type AssessFlags } from './common';

export const PermissionNameOutputSchema = z.object({
  name: wire('اسم الصلاحية كما كُتبت بلا كلمة «صلاحية»'),
});

/** Exactly what the model must return. */
export const UserPermissionsOutputSchema = z.object({
  userName: wire('اسم المستخدم كما ورد، أو العنصر النائب ⟦موظف_n⟧ حرفياً'),
  action: wire('grant أو revoke'),
  permissions: z.array(PermissionNameOutputSchema),
  reason: wire('السبب إن ذُكر، وإلا «»'),
});

export type UserPermissionsOutput = z.infer<typeof UserPermissionsOutputSchema>;

// ─── Plain values ───────────────────────────────────────────────────────────

export const PERMISSION_ACTIONS = ['grant', 'revoke'] as const;
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

export interface UserPermissionsValues {
  userName: string;
  action: PermissionAction;
  permissions: { name: string }[];
  reason: string | null;
}

export interface AssessedUserPermissions {
  userName: AssessedField<string>;
  action: AssessedField<PermissionAction>;
  permissions: { name: AssessedField<string> }[];
  reason: AssessedField<string>;
}

/** `enumField` of common.ts upper-cases the text before matching (NPI's enums
 *  are upper-case); this flow's two actions are the lower-case words the
 *  prompt and the card use. Anything else is dropped and flagged. */
function actionField(w: WireField): AssessedField<PermissionAction> {
  const { field, unreadable } = fromWire<PermissionAction>(w, (text) => {
    const word = text.trim().toLowerCase();
    return PERMISSION_ACTIONS.find((a) => a === word) ?? null;
  });
  return assessField(field, unreadable ? ['extract.warn.enum'] : []);
}

/** NPI's `PermissionOverrideDto.reason` ceiling (admin/dto.ts:97, `@MaxLength(500)`). */
export const REASON_MAX = 500;

// ─── Server-side validation and confidence (02 §5.5) ───────────────────────

/**
 * Turns the model's output into assessed fields and plain values:
 *  - the user's name is kept as written (a placeholder the pseudonymizer could
 *    not restore stays verbatim and is flagged);
 *  - the action must be `grant` or `revoke`, anything else is dropped and flagged;
 *  - `values.permissions` keeps only the entries with a name (in order);
 *    `assessed.permissions` keeps all, so the card can show the empty one;
 *  - the reason is cut to NPI's 500 characters.
 * `values` is null when the user, the action or every permission is missing.
 */
export function assessUserPermissions(
  out: UserPermissionsOutput,
  _flags: AssessFlags = NO_FLAGS,
): { assessed: AssessedUserPermissions; values: UserPermissionsValues | null } {
  const reasonRaw = textField(out.reason);
  const reason =
    reasonRaw.value !== null && reasonRaw.value.length > REASON_MAX
      ? assessField<string>({ value: reasonRaw.value.slice(0, REASON_MAX), confidence: reasonRaw.confidence, evidence: reasonRaw.evidence, page: reasonRaw.page }, reasonRaw.warnings)
      : reasonRaw;

  const assessed: AssessedUserPermissions = {
    userName: textField(out.userName),
    action: actionField(out.action),
    permissions: out.permissions.map((p) => ({ name: textField(p.name) })),
    reason,
  };

  const names = assessed.permissions.flatMap((p) => (p.name.value === null ? [] : [{ name: p.name.value }]));
  const { userName, action } = assessed;
  const values: UserPermissionsValues | null =
    userName.value === null || action.value === null || names.length === 0
      ? null
      : { userName: userName.value, action: action.value, permissions: names, reason: reason.value };

  return { assessed, values };
}
