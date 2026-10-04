// What the onboarding cannot do, named precisely (F-14, spec/madar/02 §7;
// 08 §E.10: "the catalog applies only what NPI's admin API accepts; gaps are
// listed, never worked around").
//
// Two different things are kept apart here on purpose:
//
//  - A **gap** is something a profile pack asks for that NPI's admin API has
//    no way to accept today. It is recorded in `firm_config.npiApiGapsJson`
//    and shown under «لا تتيحه واجهة NPI حالياً». The only computed gap so far
//    is a permission key a pack names that NPI's live catalog does not serve;
//    the role is still created with the keys NPI does serve, and the missing
//    key is listed.
//  - A **blocked** step is something NPI *can* do but will refuse right now
//    for this caller or this organization's current data (the caller lacks the
//    permission, a role in a chain has no active user, a band overlaps an
//    existing rule). It is reported with NPI's own rule quoted in Arabic so
//    the administrator can fix the precondition in NPI and re-run the step.
//
// Everything a pack sets that lives only in the copilot (visible modules,
// accepted document types, terminology, positions) is neither — it is the
// "ما سأضبطه في المحادثة" half of the Q7 summary, carried on the plan itself.
import type { NpiPermissionMeta } from '../npi/permissions';

// ─── Gaps ───────────────────────────────────────────────────────────────────

export type NpiApiGap = {
  kind: 'permission_unknown';
  roleKey: string;
  permission: string;
};

/** Arabic line for one gap. Visible in the setup UI (T-18); no Latin except
 *  NPI itself and the raw permission key, which is a code. */
export function describeGapAr(gap: NpiApiGap, roleNameAr: string): string {
  switch (gap.kind) {
    case 'permission_unknown':
      return `الصلاحية «${gap.permission}» المطلوبة للدور «${roleNameAr}» لا تتيحها واجهة NPI حالياً، فلن تُمنح.`;
  }
}

// ─── Blocked reasons ────────────────────────────────────────────────────────

export type BlockedReason =
  | { code: 'missing_permission'; permission: string }
  | { code: 'npi_state_unreadable'; permission: string }
  | { code: 'role_without_active_user'; roleKey: string; roleNameAr: string }
  | { code: 'band_overlap'; min: number; max: number | null }
  | { code: 'depends_on_blocked_role'; roleKey: string }
  | { code: 'depends_on_blocked_department'; departmentCode: string };

/**
 * Arabic text for a blocked step. `permissionLabel` resolves an NPI
 * permission key to its Arabic label from NPI's own catalog
 * (`GET /admin/permissions`, `labelAr`) when that catalog could be read;
 * otherwise the key itself is shown, as a code.
 */
export function describeBlockedAr(
  reason: BlockedReason,
  permissionLabel: (key: string) => string = (key) => key,
): string {
  switch (reason.code) {
    case 'missing_permission':
      return `تحتاج صلاحية «${permissionLabel(reason.permission)}» في NPI لتنفيذ هذه الخطوة.`;
    case 'npi_state_unreadable':
      return `تعذر قراءة الوضع الحالي من NPI لهذه الخطوة (تلزم صلاحية «${permissionLabel(reason.permission)}»).`;
    case 'role_without_active_user':
      return (
        `الدور «${reason.roleNameAr}» ليس له مستخدم نشط في NPI، ولن تقبل NPI سلسلة اعتماد تمر به. ` +
        'عيّن مستخدماً لهذا الدور من شاشة NPI ثم أعد هذه الخطوة.'
      );
    case 'band_overlap':
      return `نطاق المبلغ يتداخل مع قاعدة قائمة في NPI (${formatBand(reason.min, reason.max)}).`;
    case 'depends_on_blocked_role':
      return `تعتمد هذه الخطوة على الدور «${reason.roleKey}» الذي لم يُنشأ في NPI.`;
    case 'depends_on_blocked_department':
      return `تعتمد هذه الخطوة على القسم «${reason.departmentCode}» الذي لم يُنشأ في NPI.`;
  }
}

export function formatBand(min: number, max: number | null): string {
  return max === null ? `من ${min} فأكثر` : `من ${min} إلى أقل من ${max}`;
}

/** Builds the `permissionLabel` resolver `describeBlockedAr` takes, from the
 *  catalog `readPermissionCatalog` returns. */
export function permissionLabelResolver(
  catalog: readonly NpiPermissionMeta[] | null,
): (key: string) => string {
  const byKey = new Map((catalog ?? []).map((entry) => [entry.key, entry.labelAr]));
  return (key) => byKey.get(key) ?? key;
}

// ─── Which NPI permission each step needs ───────────────────────────────────

/**
 * The `@RequirePermissions` guard on the NPI route each step calls:
 *  - department   apps/api/src/modules/admin/departments.controller.ts (`@Post()` → DEPARTMENT_MANAGE)
 *  - role         apps/api/src/modules/admin/admin.controller.ts (`@Post('roles')`, `@Patch('roles/:id')` → USER_MANAGE)
 *  - approval_rule apps/api/src/modules/approvals/approvals.controller.ts (`@Post('rules')`, `@Patch('rules/:id')` → APPROVAL_MANAGE)
 *  - item         apps/api/src/modules/commercial/items.controller.ts (`@Post()` → ITEM_WRITE)
 */
export const STEP_WRITE_PERMISSION = {
  department: 'admin.department.manage',
  role: 'admin.user.manage',
  approval_rule: 'admin.approval.manage',
  item: 'commercial.item.write',
} as const;

/**
 * The reads the plan needs before it can diff, and their guards:
 *  - permissions  `GET /admin/permissions`           → admin.user.manage
 *  - roles        `GET /admin/roles`                 → admin.user.manage
 *  - departments  `GET /admin/departments`           → admin.department.manage
 *  - directory    `GET /admin/departments/directory` → admin.department.manage
 *  - rules        `GET /approvals/rules`             → admin.approval.manage
 *  - items        `GET /items`                       → commercial.item.read
 */
export const SNAPSHOT_READ_PERMISSION = {
  permissions: 'admin.user.manage',
  roles: 'admin.user.manage',
  departments: 'admin.department.manage',
  directory: 'admin.department.manage',
  rules: 'admin.approval.manage',
  items: 'commercial.item.read',
} as const;
