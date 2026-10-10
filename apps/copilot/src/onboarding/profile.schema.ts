// Zod schema for the onboarding profile-pack catalog (F-14).
//
// spec/madar/02-TECH-SPEC.md §7 (lines 89-93) sketches one JSON file per line
// of business under `catalog/profiles/<key>.json`: which NPI modules a firm
// of that kind sees, which documents it calls by its own names, what
// departments/roles/approval limits/items it starts with, and which
// (role, department) chat positions exist. spec/madar/03-DESIGN-SPEC.md §5
// gives the content for three of the six packs (T-14); the other three ship
// in T-15.
//
// This file validates SHAPE only. It deliberately does not check whether a
// permission key named in a pack is one NPI's live catalog actually serves —
// that needs NPI's live `GET /admin/permissions` response, which only exists
// at request time. See `catalog.ts`'s `permissionGaps` for that half.
import { z } from 'zod';
import type { FlowType } from '../agents/router';

// ─── Fixed vocabularies ─────────────────────────────────────────────────────

export const PROFILE_KEYS = [
  'epc',
  'om_provider',
  'ppa_operator',
  'general_contracting',
  'equipment_trading',
  'engineering_consulting',
] as const;
export type ProfileKey = (typeof PROFILE_KEYS)[number];

export const MODULE_KEYS = [
  'crm',
  'commercial',
  'projects',
  'procurement',
  'fsm',
  'finance',
  'ppa',
  'telemetry',
] as const;
export type ModuleKey = (typeof MODULE_KEYS)[number];

/** Arabic display names of the NPI modules, used by the overlays (T-15) and
 *  the setup screens (T-18). Not NPI's own menu labels — the copilot's. */
export const MODULE_NAMES_AR: Record<ModuleKey, string> = {
  crm: 'العملاء والفرص',
  commercial: 'العروض والعقود',
  projects: 'المشاريع',
  procurement: 'المشتريات والمخزون',
  fsm: 'أوامر العمل والصيانة',
  finance: 'المالية',
  ppa: 'اتفاقيات بيع الطاقة',
  telemetry: 'المراقبة والقياس',
};

// Must equal the `FlowType` union in `src/agents/router.ts:23` exactly — the
// five chat flows the copilot has (08 §E.10: "exactly five flows, no sixth").
export const FLOW_TYPES = ['customer_contract', 'pr', 'po', 'grn', 'vendor_bill'] as const;
type SchemaFlowType = (typeof FLOW_TYPES)[number];

// Compile-time-only assertion that FLOW_TYPES and router.ts's FlowType name
// exactly the same set of literals. The standard "type equality" trick: two
// conditional types (each wrapped in a distribution-blocking generic) are
// only mutually assignable when A and B contain exactly the same members —
// a flow added, renamed or removed on one side without the other makes
// `AssertFlowTypesMatchRouter` resolve to `false`, and the `true` assignment
// below stops compiling. There is no runtime cost.
type TypesAreEqual<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type AssertFlowTypesMatchRouter = TypesAreEqual<SchemaFlowType, FlowType>;
const _assertFlowTypesMatchRouter: AssertFlowTypesMatchRouter = true;
void _assertFlowTypesMatchRouter;

// packages/db/prisma/schema.prisma:1884-1892 (`enum ApprovalDocument`).
export const APPROVAL_DOCUMENT_TYPES = [
  'PURCHASE_REQUISITION',
  'PURCHASE_ORDER',
  'PROGRESS_CLAIM',
  'CHANGE_ORDER',
] as const;
export type ApprovalDocumentType = (typeof APPROVAL_DOCUMENT_TYPES)[number];

// apps/api/src/modules/commercial/dto.ts:14.
export const ITEM_CATEGORIES = ['MODULE', 'INVERTER', 'MOUNTING', 'CABLE', 'BOS', 'SPARE', 'SERVICE'] as const;
export type ItemCategory = (typeof ITEM_CATEGORIES)[number];

/** Copilot concepts a firm may rename in conversation (e.g. "عميل" →
 *  something else). Not NPI field names — NPI's own screens keep NPI's
 *  wording regardless of what a pack sets here. */
export const TERM_KEYS = [
  'customer',
  'vendor',
  'project',
  'contract',
  'requisition',
  'purchase_order',
  'receipt',
  'vendor_bill',
  'item',
  'department',
] as const;
export type TermKey = (typeof TERM_KEYS)[number];

export const FLOW_REQUIRED_MODULE: Record<FlowType, ModuleKey> = {
  customer_contract: 'commercial',
  pr: 'procurement',
  po: 'procurement',
  grn: 'procurement',
  vendor_bill: 'procurement',
};

/**
 * The NPI permission that actually lets a user call the create/receive/bill
 * route for each flow — i.e. the permission `@RequirePermissions` enforces on
 * the controller method a chat flow eventually calls through
 * `src/npi/client.ts`:
 *  - customer_contract → apps/api/src/modules/commercial/contracts.controller.ts:34
 *    (`@Post()` / `create()` → `CONTRACT_WRITE` = 'commercial.contract.write')
 *  - pr                → apps/api/src/modules/procurement/requisitions.controller.ts:51
 *    (`@Post()` / `create()` → `REQUISITION_WRITE` = 'scm.requisition.write')
 *  - po                → apps/api/src/modules/procurement/procurement.controller.ts:50
 *    (`@Post('purchase-orders')` / `createPo()` → `PROCUREMENT_WRITE` = 'scm.procurement.write')
 *  - grn               → apps/api/src/modules/procurement/procurement.controller.ts:69
 *    (`@Post('purchase-orders/:id/receive')` / `receive()` → `PROCUREMENT_WRITE`)
 *  - vendor_bill       → apps/api/src/modules/procurement/procurement.controller.ts:108
 *    (`@Post('bills')` / `createBill()` → `PROCUREMENT_WRITE`)
 */
export const FLOW_REQUIRED_PERMISSION: Record<FlowType, string> = {
  customer_contract: 'commercial.contract.write',
  pr: 'scm.requisition.write',
  po: 'scm.procurement.write',
  grn: 'scm.procurement.write',
  vendor_bill: 'scm.procurement.write',
};

/**
 * Copied from `APPROVAL_DOCUMENTS[].permission` (packages/shared/src/approvals.ts):
 * deciding an approval needs the same permission as performing the action it
 * approves (see that file's own comment on `ApprovalDocumentMeta.permission`).
 *  - PURCHASE_REQUISITION → line 41 (`permission: PERMISSIONS.PROCUREMENT_WRITE`)
 *  - PURCHASE_ORDER       → line 49 (`permission: PERMISSIONS.PROCUREMENT_WRITE`)
 *  - PROGRESS_CLAIM       → line 57 (`permission: PERMISSIONS.PROCUREMENT_WRITE`)
 *  - CHANGE_ORDER         → line 65 (`permission: PERMISSIONS.PROJECT_WRITE` = 'projects.project.write')
 */
export const APPROVAL_DOCUMENT_PERMISSION: Record<ApprovalDocumentType, string> = {
  PURCHASE_REQUISITION: 'scm.procurement.write',
  PURCHASE_ORDER: 'scm.procurement.write',
  PROGRESS_CLAIM: 'scm.procurement.write',
  CHANGE_ORDER: 'projects.project.write',
};

// ─── Format patterns (apps/api DTOs — cited next to each field below) ──────

const ROLE_KEY_RE = /^[a-z][a-z0-9_]{1,39}$/; // admin.dto.ts:73 (CreateRoleDto.key)
const DOC_TYPE_KEY_RE = /^[a-z][a-z0-9_]{1,39}$/; // same slug shape, chosen for consistency
const DEPARTMENT_CODE_RE = /^[A-Z][A-Z0-9_-]{1,19}$/; // structure.dto.ts:22 (CreateDepartmentDto.code)
const SKU_RE = /^[A-Z0-9][A-Z0-9_-]{1,29}$/;

function duplicateValues<T>(items: readonly T[], keyOf: (item: T) => string): string[] {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) dups.add(key);
    seen.add(key);
  }
  return [...dups];
}

// ─── Field schemas ──────────────────────────────────────────────────────────

export const AcceptedDocTypeSchema = z.object({
  key: z.string().regex(DOC_TYPE_KEY_RE),
  labelAr: z.string().min(2),
  // null = the firm names this document but it is entered in NPI's own
  // screens; the copilot has exactly five chat flows (08 §E.10) and never
  // invents a sixth.
  flow: z.enum(FLOW_TYPES).nullable(),
});

export const DepartmentSchema = z.object({
  code: z.string(), // format checked in superRefine, with the offending value in the message
  nameAr: z.string().min(2).max(120),
  nameEn: z.string().max(120).optional(),
});

export const RolePermissionSetSchema = z.object({
  // `02` §7 sketches `{roleKey: permissions[]}`; `nameAr` is added here
  // because NPI's `CreateRoleDto` (apps/api/src/modules/admin/dto.ts:70-91)
  // requires a display name to create a role the firm does not already have —
  // the pack cannot hand NPI's admin API a role with permissions but no name.
  nameAr: z.string().min(1).max(120),
  nameEn: z.string().max(120).optional(),
  permissions: z.array(z.string().min(1)).min(1),
});

export const ApprovalRuleDefaultSchema = z.object({
  docType: z.enum(APPROVAL_DOCUMENT_TYPES),
  minAmount: z.number(), // integer + >= 0 checked in superRefine, with the offending value
  maxAmount: z.number().nullable().optional(), // > minAmount checked in superRefine
  steps: z.array(z.string().regex(ROLE_KEY_RE)).min(1),
});

export const ItemTemplateSchema = z.object({
  sku: z.string(), // format checked in superRefine, with the offending value in the message
  nameAr: z.string().min(1),
  nameEn: z.string().min(1),
  itemCategory: z.enum(ITEM_CATEGORIES),
  uom: z.string().min(1).optional(),
  isSerialised: z.boolean().optional(),
  // unitCost deliberately absent — prices are the firm's, never the pack's.
});

export const PositionSchema = z.object({
  roleKey: z.string().regex(ROLE_KEY_RE),
  departmentCode: z.string().nullable(), // membership in defaultDepartments checked in superRefine
  titleAr: z.string().min(1).max(120),
  personaAr: z.string().min(80),
});

/** Which NPI users hold a copilot position (setup Q2). Copilot-side only:
 *  written to `position_assignments`, never to NPI (08 §E.10). */
export const PositionHolderSchema = z.object({
  roleKey: z.string().regex(ROLE_KEY_RE),
  departmentCode: z.string().nullable(),
  npiUserIds: z.array(z.string().min(1)),
});
export type PositionHolder = z.infer<typeof PositionHolderSchema>;

// ─── The pack ───────────────────────────────────────────────────────────────

export const ProfilePackSchema = z
  .object({
    key: z.enum(PROFILE_KEYS),
    titleAr: z.string().min(1),
    revenueLines: z.array(z.string().min(2)).min(1),
    // Plain strings, not `z.enum(MODULE_KEYS)`: zod aborts parsing a whole
    // array as soon as one element fails its item schema, which would skip
    // `superRefine` below entirely and lose the "which value, exactly" detail
    // this schema's cross-checks are built to report. Membership in
    // `MODULE_KEYS` is checked explicitly in `superRefine` instead, where the
    // offending value is still available to name in the message.
    visibleModules: z.array(z.string()).min(1),
    acceptedDocTypes: z.array(AcceptedDocTypeSchema).min(1),
    terminology: z.partialRecord(z.enum(TERM_KEYS), z.string().min(1)),
    defaultDepartments: z.array(DepartmentSchema).min(1),
    rolePermissionSets: z.record(z.string().regex(ROLE_KEY_RE), RolePermissionSetSchema),
    approvalRuleDefaults: z.array(ApprovalRuleDefaultSchema),
    itemTemplates: z.array(ItemTemplateSchema),
    positions: z.array(PositionSchema).min(1),
  })
  .superRefine((pack, ctx) => {
    // ── Plain uniqueness (declared in the field comments above) ────────────
    for (const value of duplicateValues(pack.revenueLines ?? [], (v) => v)) {
      ctx.addIssue({ code: 'custom', path: ['revenueLines'], message: `revenueLines has a duplicate value: "${value}"` });
    }
    for (const value of duplicateValues(pack.acceptedDocTypes ?? [], (d) => d.key)) {
      ctx.addIssue({ code: 'custom', path: ['acceptedDocTypes'], message: `acceptedDocTypes has a duplicate key: "${value}"` });
    }
    for (const value of duplicateValues(pack.acceptedDocTypes ?? [], (d) => d.labelAr)) {
      ctx.addIssue({ code: 'custom', path: ['acceptedDocTypes'], message: `acceptedDocTypes has a duplicate labelAr: "${value}"` });
    }
    for (const value of duplicateValues(pack.defaultDepartments ?? [], (d) => d.code)) {
      ctx.addIssue({ code: 'custom', path: ['defaultDepartments'], message: `defaultDepartments has a duplicate code: "${value}"` });
    }
    for (const value of duplicateValues(pack.itemTemplates ?? [], (i) => i.sku)) {
      ctx.addIssue({ code: 'custom', path: ['itemTemplates'], message: `itemTemplates has a duplicate sku: "${value}"` });
    }
    for (const value of duplicateValues(
      pack.approvalRuleDefaults ?? [],
      (r) => `${r.docType}:${r.minAmount}`,
    )) {
      ctx.addIssue({
        code: 'custom',
        path: ['approvalRuleDefaults'],
        message: `approvalRuleDefaults has a duplicate (docType, minAmount) pair: "${value}"`,
      });
    }
    for (const value of duplicateValues(
      pack.positions ?? [],
      (p) => `${p.roleKey}\u0000${p.departmentCode ?? ''}`,
    )) {
      ctx.addIssue({
        code: 'custom',
        path: ['positions'],
        message: `positions has a duplicate (roleKey, departmentCode) pair: "${value.replace('\u0000', ', ')}"`,
      });
    }
    for (const [roleKey, roleSet] of Object.entries(pack.rolePermissionSets ?? {})) {
      for (const value of duplicateValues(roleSet.permissions ?? [], (p) => p)) {
        ctx.addIssue({
          code: 'custom',
          path: ['rolePermissionSets', roleKey, 'permissions'],
          message: `rolePermissionSets.${roleKey}.permissions has a duplicate permission: "${value}"`,
        });
      }
    }

    // ── Format checks that must name the offending value ───────────────────
    for (const [index, dept] of (pack.defaultDepartments ?? []).entries()) {
      if (!DEPARTMENT_CODE_RE.test(dept.code)) {
        ctx.addIssue({
          code: 'custom',
          path: ['defaultDepartments', index, 'code'],
          message: `defaultDepartments[${index}].code must match ${DEPARTMENT_CODE_RE}: "${dept.code}"`,
        });
      }
    }
    for (const [index, item] of (pack.itemTemplates ?? []).entries()) {
      if (!SKU_RE.test(item.sku)) {
        ctx.addIssue({
          code: 'custom',
          path: ['itemTemplates', index, 'sku'],
          message: `itemTemplates[${index}].sku must match ${SKU_RE}: "${item.sku}"`,
        });
      }
    }
    for (const [index, rule] of (pack.approvalRuleDefaults ?? []).entries()) {
      if (!Number.isInteger(rule.minAmount) || rule.minAmount < 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['approvalRuleDefaults', index, 'minAmount'],
          message: `approvalRuleDefaults[${index}].minAmount must be a whole number >= 0: ${rule.minAmount}`,
        });
      }
      if (rule.maxAmount != null) {
        if (!Number.isInteger(rule.maxAmount)) {
          ctx.addIssue({
            code: 'custom',
            path: ['approvalRuleDefaults', index, 'maxAmount'],
            message: `approvalRuleDefaults[${index}].maxAmount must be a whole number: ${rule.maxAmount}`,
          });
        } else if (rule.maxAmount <= rule.minAmount) {
          ctx.addIssue({
            code: 'custom',
            path: ['approvalRuleDefaults', index, 'maxAmount'],
            message: `approvalRuleDefaults[${index}].maxAmount (${rule.maxAmount}) must be greater than minAmount (${rule.minAmount})`,
          });
        }
      }
    }
    for (const [index, value] of (pack.visibleModules ?? []).entries()) {
      if (!(MODULE_KEYS as readonly string[]).includes(value)) {
        ctx.addIssue({
          code: 'custom',
          path: ['visibleModules', index],
          message: `visibleModules[${index}] is not a known module: "${value}"`,
        });
      }
    }

    // ── Schema-level rule: visibleModules must include 'finance' ───────────
    if (!(pack.visibleModules ?? []).includes('finance')) {
      ctx.addIssue({
        code: 'custom',
        path: ['visibleModules'],
        message: `visibleModules must include "finance" (got: ${JSON.stringify(pack.visibleModules)})`,
      });
    }

    const roleKeys = new Set(Object.keys(pack.rolePermissionSets ?? {}));
    const departmentCodes = new Set((pack.defaultDepartments ?? []).map((d) => d.code));

    // ── Cross-check 4: rolePermissionSets must contain 'admin' ─────────────
    if (!roleKeys.has('admin')) {
      ctx.addIssue({
        code: 'custom',
        path: ['rolePermissionSets'],
        message: `rolePermissionSets must contain "admin" (got: ${JSON.stringify([...roleKeys])})`,
      });
    }

    // ── Cross-check 1: approval steps name a declared role that holds the
    //    approving permission for that document type ───────────────────────
    for (const [ruleIndex, rule] of (pack.approvalRuleDefaults ?? []).entries()) {
      for (const [stepIndex, roleKey] of rule.steps.entries()) {
        if (!roleKeys.has(roleKey)) {
          ctx.addIssue({
            code: 'custom',
            path: ['approvalRuleDefaults', ruleIndex, 'steps', stepIndex],
            message: `approvalRuleDefaults[${ruleIndex}].steps names an undeclared role: "${roleKey}"`,
          });
          continue;
        }
        const requiredPermission = APPROVAL_DOCUMENT_PERMISSION[rule.docType];
        const roleSet = pack.rolePermissionSets[roleKey];
        if (!roleSet.permissions.includes(requiredPermission)) {
          ctx.addIssue({
            code: 'custom',
            path: ['approvalRuleDefaults', ruleIndex, 'steps', stepIndex],
            message:
              `approvalRuleDefaults[${ruleIndex}] (${rule.docType}) names role "${roleKey}", ` +
              `which lacks the approving permission "${requiredPermission}"`,
          });
        }
      }
    }

    // ── Cross-check 2: positions name a declared role and (if any) a
    //    declared department ────────────────────────────────────────────────
    for (const [index, position] of (pack.positions ?? []).entries()) {
      if (!roleKeys.has(position.roleKey)) {
        ctx.addIssue({
          code: 'custom',
          path: ['positions', index, 'roleKey'],
          message: `positions[${index}].roleKey is not declared in rolePermissionSets: "${position.roleKey}"`,
        });
      }
      if (position.departmentCode !== null && !departmentCodes.has(position.departmentCode)) {
        ctx.addIssue({
          code: 'custom',
          path: ['positions', index, 'departmentCode'],
          message: `positions[${index}].departmentCode is not a declared department: "${position.departmentCode}"`,
        });
      }
    }

    // ── Cross-check 3: every accepted doc type with a flow points at a
    //    visible module, and some declared role can actually run that flow ──
    const visibleModuleSet = new Set(pack.visibleModules ?? []);
    for (const [index, docType] of (pack.acceptedDocTypes ?? []).entries()) {
      if (docType.flow === null) continue;
      const requiredModule = FLOW_REQUIRED_MODULE[docType.flow];
      if (!visibleModuleSet.has(requiredModule)) {
        ctx.addIssue({
          code: 'custom',
          path: ['acceptedDocTypes', index, 'flow'],
          message:
            `acceptedDocTypes[${index}] ("${docType.key}") uses flow "${docType.flow}", which needs module ` +
            `"${requiredModule}", not present in visibleModules: ${JSON.stringify(pack.visibleModules)}`,
        });
      }
      const requiredPermission = FLOW_REQUIRED_PERMISSION[docType.flow];
      const anyRoleHasIt = Object.values(pack.rolePermissionSets ?? {}).some((roleSet) =>
        roleSet.permissions.includes(requiredPermission),
      );
      if (!anyRoleHasIt) {
        ctx.addIssue({
          code: 'custom',
          path: ['acceptedDocTypes', index, 'flow'],
          message:
            `acceptedDocTypes[${index}] ("${docType.key}") uses flow "${docType.flow}", which needs permission ` +
            `"${requiredPermission}", held by no role in rolePermissionSets`,
        });
      }
    }
  });

export type ProfilePack = z.infer<typeof ProfilePackSchema>;

/** The flows a pack actually exposes (the ones among its `acceptedDocTypes`
 *  that have a non-null `flow`), deduplicated, in `FLOW_TYPES` order. */
export function visibleFlowsOf(pack: ProfilePack): FlowType[] {
  const present = new Set<FlowType>();
  for (const docType of pack.acceptedDocTypes) {
    if (docType.flow !== null) present.add(docType.flow);
  }
  return FLOW_TYPES.filter((flow): flow is FlowType => present.has(flow as FlowType));
}
