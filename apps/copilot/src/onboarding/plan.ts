// Onboarding plan (F-14, spec/madar/02 §7): a profile pack plus the
// administrator's answers to the seven setup questions, diffed against what
// NPI holds right now, become an ordered list of NPI admin-API steps and a
// copilot-side configuration. This file is pure — no I/O, no clock — so the
// same inputs always give the same plan, and the dry-run shown to the
// administrator («هذا ما سأضبطه في NPI») is byte-for-byte the plan
// `apply.ts` later executes.
//
// Order of the steps is fixed and dependency-driven:
//   departments → roles → approval rules → items
// Approval rules need role ids (created in the role steps); items depend on
// nothing but come last so a failure there never shadows a governance step.
//
// Every step carries one of four actions. `create`/`update` are writes;
// `skip` means NPI already holds exactly this (re-running a finished setup
// is a no-op — the idempotency the task requires); `blocked` means NPI would
// refuse the write today, with the reason NPI itself would give (see
// `gaps.ts`). Nothing here ever works around a refusal.
import { z, type ZodError } from 'zod';
import type { FlowType } from '../agents/router';
import type { NpiApprovalRule, NpiDirectoryUser, NpiItem, NpiRole } from '../npi/admin';
import type { NpiDepartment } from '../npi/directory';
import type { NpiPermissionMeta } from '../npi/permissions';
import {
  describeBlockedAr,
  describeGapAr,
  formatBand,
  permissionLabelResolver,
  SNAPSHOT_READ_PERMISSION,
  STEP_WRITE_PERMISSION,
  WORKFLOW_DEFINITIONS_GAP,
  type BlockedReason,
  type NpiApiGap,
} from './gaps';
import {
  ApprovalRuleDefaultSchema,
  DepartmentSchema,
  ItemTemplateSchema,
  MODULE_NAMES_AR,
  PositionHolderSchema,
  PositionSchema,
  PROFILE_KEYS,
  ProfilePackSchema,
  RolePermissionSetSchema,
  TERM_KEYS,
  visibleFlowsOf,
  type ApprovalDocumentType,
  type ItemCategory,
  type ModuleKey,
  type PositionHolder,
  type ProfileKey,
  type ProfilePack,
  type TermKey,
} from './profile.schema';

// ─── Answers (what T-17's parser produces, what T-18's screens edit) ────────

/** Where one step's answer came from (T-47a, automatic setup): read from NPI,
 *  the profile pack's own default, a rule-based guess the administrator
 *  confirms (step 1 only), or typed/edited by the administrator. */
export const SETUP_SOURCES = ['npi', 'pack-default', 'heuristic', 'manual'] as const;
export type SetupSource = (typeof SETUP_SOURCES)[number];

/**
 * The administrator's answers, Q1–Q6. Every field but `profileKey` is
 * optional: an absent answer means "take the pack's default". A present
 * answer *replaces* the pack's list wholesale (it is the edited list the
 * screen showed), except `terminology`, which is merged over the pack's.
 * Q7 is the summary, not an answer.
 */
export const SetupAnswersSchema = z.object({
  /** Q1 */
  profileKey: z.enum(PROFILE_KEYS),
  revenueLines: z.array(z.string().min(2)).min(1).optional(),
  /** Q2 */
  departments: z.array(DepartmentSchema).min(1).optional(),
  positions: z.array(PositionSchema).min(1).optional(),
  /** Q2 — which NPI users hold each position, copilot-side only. */
  holders: z.array(PositionHolderSchema).optional(),
  /** Q3 */
  approvalRules: z.array(ApprovalRuleDefaultSchema).optional(),
  /** Q4 — keys of the pack's `acceptedDocTypes` to keep. */
  acceptedDocTypeKeys: z.array(z.string().min(1)).min(1).optional(),
  /** Q5 */
  items: z.array(ItemTemplateSchema).optional(),
  /** Q6 */
  terminology: z.partialRecord(z.enum(TERM_KEYS), z.string().min(1)).optional(),
  /**
   * T-47a — present only when the answers were discovered from NPI. The
   * organization's own roles (key -> Arabic name + permissions) stand in for
   * the pack's `rolePermissionSets`, so positions, approval chains and doc
   * types are validated against what NPI really has, and the plan never
   * proposes to rewrite a role (a role NPI already holds is `skip`).
   */
  npiRoleSets: z.record(z.string(), RolePermissionSetSchema).optional(),
  /** T-47a — where each step's answer came from, keyed by the step number. */
  sources: z.partialRecord(z.enum(['1', '2', '3', '4', '5', '6']), z.enum(SETUP_SOURCES)).optional(),
});
export type SetupAnswers = z.infer<typeof SetupAnswersSchema>;

/** Thrown when the answers, laid over the pack, no longer form a valid pack
 *  (e.g. a position names a department the administrator removed). Carries
 *  the zod issues so the setup screen can point at the field. */
export class PlanError extends Error {
  readonly issues: { path: string; message: string }[];
  constructor(message: string, issues: { path: string; message: string }[]) {
    super(message);
    this.name = 'PlanError';
    this.issues = issues;
  }
}

function issuesOf(error: ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message }));
}

/**
 * The pack as the administrator finally wants it. Validated with the full
 * `ProfilePackSchema`, so every cross-check T-14 wrote (steps name roles that
 * hold the approving permission, positions name declared departments, doc
 * types point at visible modules, …) applies to the edited answers too.
 */
export function effectivePack(pack: ProfilePack, answers: SetupAnswers): ProfilePack {
  if (answers.profileKey !== pack.key) {
    throw new PlanError(`answers.profileKey "${answers.profileKey}" does not match pack "${pack.key}"`, [
      { path: 'profileKey', message: `expected "${pack.key}"` },
    ]);
  }

  let acceptedDocTypes = pack.acceptedDocTypes;
  if (answers.acceptedDocTypeKeys) {
    const known = new Set(pack.acceptedDocTypes.map((d) => d.key));
    const unknown = answers.acceptedDocTypeKeys.filter((key) => !known.has(key));
    if (unknown.length > 0) {
      throw new PlanError(`acceptedDocTypeKeys names unknown keys: ${unknown.join(', ')}`, [
        { path: 'acceptedDocTypeKeys', message: `unknown: ${unknown.join(', ')}` },
      ]);
    }
    const keep = new Set(answers.acceptedDocTypeKeys);
    acceptedDocTypes = pack.acceptedDocTypes.filter((d) => keep.has(d.key));
  }

  const candidate = {
    ...pack,
    revenueLines: answers.revenueLines ?? pack.revenueLines,
    acceptedDocTypes,
    terminology: { ...pack.terminology, ...(answers.terminology ?? {}) },
    defaultDepartments: answers.departments ?? pack.defaultDepartments,
    approvalRuleDefaults: answers.approvalRules ?? pack.approvalRuleDefaults,
    itemTemplates: answers.items ?? pack.itemTemplates,
    positions: answers.positions ?? pack.positions,
    rolePermissionSets: answers.npiRoleSets ?? pack.rolePermissionSets,
  };

  const parsed = ProfilePackSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new PlanError('answers do not form a valid profile', issuesOf(parsed.error));
  }

  // A holder is a convenience over the position list, not a contract of its
  // own: it must name a position that actually exists in the final pack, and
  // each (roleKey, departmentCode) may be named by at most one holder entry.
  if (answers.holders) {
    const positionKeys = new Set(parsed.data.positions.map((p) => `${p.roleKey}\u0000${p.departmentCode ?? ''}`));
    const seen = new Set<string>();
    const issues: { path: string; message: string }[] = [];
    answers.holders.forEach((holder, index) => {
      const key = `${holder.roleKey}\u0000${holder.departmentCode ?? ''}`;
      const label = `("${holder.roleKey}", ${holder.departmentCode === null ? 'null' : `"${holder.departmentCode}"`})`;
      if (!positionKeys.has(key)) {
        issues.push({ path: `holders.${index}`, message: `no position (roleKey, departmentCode) = ${label} in the profile` });
      } else if (seen.has(key)) {
        issues.push({ path: `holders.${index}`, message: `duplicate (roleKey, departmentCode) in holders: ${label}` });
      }
      seen.add(key);
    });
    if (issues.length > 0) {
      throw new PlanError('holders reference positions that are not in the profile', issues);
    }
  }

  return parsed.data;
}

// ─── What NPI holds right now ───────────────────────────────────────────────

/**
 * A read of NPI's admin screens taken just before planning. `null` in a slot
 * means the slot could not be read — the caller lacks the guard permission
 * (see `SNAPSHOT_READ_PERMISSION`) or NPI answered 403 — and every step that
 * needs that slot is `blocked`, never guessed.
 */
export interface NpiSnapshot {
  permissions: NpiPermissionMeta[] | null;
  roles: NpiRole[] | null;
  departments: NpiDepartment[] | null;
  users: NpiDirectoryUser[] | null;
  approvalRules: NpiApprovalRule[] | null;
  items: NpiItem[] | null;
}

/** The administrator running the setup, as `/auth/me` reports them. */
export interface PlanCaller {
  roleKey: string;
  permissions: readonly string[];
}

// ─── Steps ──────────────────────────────────────────────────────────────────

export type StepAction = 'create' | 'update' | 'skip' | 'blocked';

interface StepBase {
  /** Stable across runs (`department:SALES`, `role:pm`,
   *  `approval_rule:PURCHASE_ORDER:100000`, `item:MOD-600`) so a step can be
   *  re-run on its own from `/settings`. */
  id: string;
  action: StepAction;
  blocked: BlockedReason | null;
  /** NPI's id when the object already exists (skip/update). */
  existingId: string | null;
  /** Arabic remarks for the diff card — things noticed but not changed. */
  notesAr: string[];
}

export interface DepartmentStep extends StepBase {
  kind: 'department';
  code: string;
  nameAr: string;
  nameEn: string | undefined;
}

export interface RoleStep extends StepBase {
  kind: 'role';
  roleKey: string;
  nameAr: string;
  nameEn: string | undefined;
  /** The permission set to send: the pack's set minus keys NPI does not serve. */
  permissions: string[];
  permissionsAdded: string[];
  permissionsRemoved: string[];
}

export interface ApprovalRuleStep extends StepBase {
  kind: 'approval_rule';
  docType: ApprovalDocumentType;
  minAmount: number;
  maxAmount: number | null;
  stepRoleKeys: string[];
  /** For `update`: the chain NPI holds today. */
  existingStepRoleKeys: string[] | null;
  /** For `update`: the floor NPI holds today (differs from `minAmount` when
   *  the administrator moved the threshold of the open-ended band). */
  existingMinAmount: number | null;
  /** For `update` of a rule NPI holds as inactive. */
  reactivate: boolean;
}

export interface ItemStep extends StepBase {
  kind: 'item';
  sku: string;
  nameAr: string;
  nameEn: string;
  itemCategory: ItemCategory;
  uom: string | undefined;
  isSerialised: boolean | undefined;
}

export type PlanStep = DepartmentStep | RoleStep | ApprovalRuleStep | ItemStep;

// ─── Copilot-side configuration ─────────────────────────────────────────────

export interface CopilotConfigPlan {
  profileKey: ProfileKey;
  titleAr: string;
  revenueLines: string[];
  visibleModules: ModuleKey[];
  visibleFlows: FlowType[];
  acceptedDocTypes: ProfilePack['acceptedDocTypes'];
  terminology: Partial<Record<TermKey, string>>;
  positions: ProfilePack['positions'];
  holders: PositionHolder[];
}

export interface OnboardingPlan {
  profileKey: ProfileKey;
  steps: PlanStep[];
  copilot: CopilotConfigPlan;
  gaps: NpiApiGap[];
  counts: Record<StepAction, number>;
  /** Arabic label of every NPI permission key the snapshot could read, for
   *  rendering blocked reasons; falls back to the key as a code. */
  permissionLabel: (key: string) => string;
  /** Arabic name of every role the plan knows (the pack's, or NPI's own for
   *  discovered answers), for rendering approval chains. */
  roleNamesAr: Record<string, string>;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Copied from packages/shared/src/approvals.ts:84-88 (`bandsOverlap`) — the
 *  exact predicate `ApprovalRulesService.validateBand` applies, so the plan
 *  predicts NPI's refusal instead of discovering it on apply. */
function bandsOverlap(a: { min: number; max: number | null }, b: { min: number; max: number | null }): boolean {
  return (a.max === null || b.min < a.max) && (b.max === null || a.min < b.max);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((v) => sb.has(v));
}

function sameSequence(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function blockedStep(reason: BlockedReason): Pick<StepBase, 'action' | 'blocked' | 'existingId' | 'notesAr'> {
  return { action: 'blocked', blocked: reason, existingId: null, notesAr: [] };
}

function gate(caller: PlanCaller, writePermission: string, readSlots: { permission: string; value: unknown }[]): BlockedReason | null {
  if (!caller.permissions.includes(writePermission)) {
    return { code: 'missing_permission', permission: writePermission };
  }
  for (const slot of readSlots) {
    if (slot.value === null) return { code: 'npi_state_unreadable', permission: slot.permission };
  }
  return null;
}

// ─── The plan ───────────────────────────────────────────────────────────────

export function buildPlan(
  pack: ProfilePack,
  answers: SetupAnswers,
  snapshot: NpiSnapshot,
  caller: PlanCaller,
): OnboardingPlan {
  const eff = effectivePack(pack, answers);
  // Every plan starts with the standing gap: workflow definitions are
  // seed-only in NPI (01 B-02, ADR-30), so no pack can set them and the
  // administrator is told so on every setup (AT-11, G-M2-3 "gaps list
  // non-empty and shown").
  const gaps: NpiApiGap[] = [WORKFLOW_DEFINITIONS_GAP];
  const steps: PlanStep[] = [];

  // ── departments ──────────────────────────────────────────────────────────
  const deptGate = gate(caller, STEP_WRITE_PERMISSION.department, [
    { permission: SNAPSHOT_READ_PERMISSION.departments, value: snapshot.departments },
  ]);
  for (const dept of eff.defaultDepartments) {
    const base = { kind: 'department' as const, id: `department:${dept.code}`, code: dept.code, nameAr: dept.nameAr, nameEn: dept.nameEn };
    if (deptGate) {
      steps.push({ ...base, ...blockedStep(deptGate) });
      continue;
    }
    const existing = snapshot.departments!.find((d) => d.code === dept.code);
    if (existing) {
      const notesAr: string[] = [];
      if (!existing.isActive) notesAr.push('القسم موجود في NPI لكنه موقوف؛ لم يُغيَّر.');
      if (existing.nameAr !== dept.nameAr) notesAr.push(`اسم القسم في NPI «${existing.nameAr}» يبقى كما هو.`);
      steps.push({ ...base, action: 'skip', blocked: null, existingId: existing.id, notesAr });
    } else {
      steps.push({ ...base, action: 'create', blocked: null, existingId: null, notesAr: [] });
    }
  }

  // ── roles ────────────────────────────────────────────────────────────────
  const roleGate = gate(caller, STEP_WRITE_PERMISSION.role, [
    { permission: SNAPSHOT_READ_PERMISSION.permissions, value: snapshot.permissions },
    { permission: SNAPSHOT_READ_PERMISSION.roles, value: snapshot.roles },
  ]);
  const knownPermissions = new Set((snapshot.permissions ?? []).map((p) => p.key));
  const roleStepByKey = new Map<string, RoleStep>();
  const rolesAreNpis = answers.npiRoleSets !== undefined;
  for (const [roleKey, roleSet] of Object.entries(eff.rolePermissionSets)) {
    const base = {
      kind: 'role' as const,
      id: `role:${roleKey}`,
      roleKey,
      nameAr: roleSet.nameAr,
      nameEn: roleSet.nameEn,
    };
    if (roleGate) {
      const step: RoleStep = { ...base, ...blockedStep(roleGate), permissions: roleSet.permissions, permissionsAdded: [], permissionsRemoved: [] };
      steps.push(step);
      roleStepByKey.set(roleKey, step);
      continue;
    }

    // Discovered answers: a role NPI already holds is NPI's, not the pack's —
    // never rewritten, whatever its permission set is today.
    const heldRole = snapshot.roles!.find((r) => r.key === roleKey);
    if (rolesAreNpis && heldRole) {
      const step: RoleStep = {
        ...base,
        action: 'skip',
        blocked: null,
        existingId: heldRole.id,
        notesAr: [],
        permissions: heldRole.permissions,
        permissionsAdded: [],
        permissionsRemoved: [],
      };
      steps.push(step);
      roleStepByKey.set(roleKey, step);
      continue;
    }

    // Keys NPI's live catalog does not serve are gaps — listed, not sent.
    let target = roleSet.permissions.filter((p) => knownPermissions.has(p));
    for (const p of roleSet.permissions) {
      if (!knownPermissions.has(p)) gaps.push({ kind: 'permission_unknown', roleKey, permission: p });
    }

    const existing = snapshot.roles!.find((r) => r.key === roleKey);
    const notesAr: string[] = [];
    let step: RoleStep;
    if (existing) {
      if (roleKey === caller.roleKey) {
        // Never strip a permission from the role the administrator is acting
        // under: the next step of this very apply would be refused.
        target = [...new Set([...existing.permissions, ...target])];
        notesAr.push('هذا دورك أنت؛ شاشة الإعداد تضيف إليه ولا تسحب منه.');
      }
      if (existing.nameAr !== roleSet.nameAr) notesAr.push(`اسم الدور في NPI «${existing.nameAr}» يبقى كما هو.`);
      const added = target.filter((p) => !existing.permissions.includes(p));
      const removed = existing.permissions.filter((p) => !target.includes(p));
      step = sameSet(existing.permissions, target)
        ? { ...base, action: 'skip', blocked: null, existingId: existing.id, notesAr, permissions: target, permissionsAdded: [], permissionsRemoved: [] }
        : { ...base, action: 'update', blocked: null, existingId: existing.id, notesAr, permissions: target, permissionsAdded: added, permissionsRemoved: removed };
    } else {
      step = { ...base, action: 'create', blocked: null, existingId: null, notesAr, permissions: target, permissionsAdded: target, permissionsRemoved: [] };
    }
    steps.push(step);
    roleStepByKey.set(roleKey, step);
  }

  // ── approval rules ───────────────────────────────────────────────────────
  const ruleGate = gate(caller, STEP_WRITE_PERMISSION.approval_rule, [
    { permission: SNAPSHOT_READ_PERMISSION.rules, value: snapshot.approvalRules },
    { permission: SNAPSHOT_READ_PERMISSION.roles, value: snapshot.roles },
  ]);
  const activeUsersByRole = new Set((snapshot.users ?? []).filter((u) => u.isActive).map((u) => u.roleKey));
  // The active bands NPI will hold once the updates planned here have run,
  // keyed by NPI rule id (or a synthetic key for a band this plan creates).
  // Creates are checked against *these* bands, and updates are emitted before
  // creates, so a moved threshold makes room for a new band in the same run.
  const bandsAfterUpdates = new Map<string, { docType: string; min: number; max: number | null }>();
  for (const r of snapshot.approvalRules ?? []) {
    if (r.isActive) bandsAfterUpdates.set(r.id, { docType: r.documentType, min: r.minAmount, max: r.maxAmount });
  }
  const clashWith = (docType: string, band: { min: number; max: number | null }, excludeId: string | null) => {
    for (const [id, other] of bandsAfterUpdates) {
      if (id !== excludeId && other.docType === docType && bandsOverlap(band, other)) return other;
    }
    return null;
  };
  // Which NPI rule each planned rule *is*: the same band exactly; otherwise,
  // for an open-ended band («فأكثر»), the document type's open-ended rule
  // whatever its current floor — moving that floor is what "change the
  // threshold" means, and NPI allows at most one active open-ended band per
  // type. Each NPI rule is claimed by at most one planned rule.
  const claimedRuleIds = new Set<string>();
  const matched = eff.approvalRuleDefaults.map((rule) => {
    if (snapshot.approvalRules === null) return null;
    const maxAmount = rule.maxAmount ?? null;
    const candidates = snapshot.approvalRules.filter((r) => r.documentType === rule.docType && !claimedRuleIds.has(r.id));
    const existing =
      candidates.find((r) => r.minAmount === rule.minAmount && r.maxAmount === maxAmount) ??
      (maxAmount === null ? (candidates.find((r) => r.maxAmount === null && r.isActive) ?? candidates.find((r) => r.maxAmount === null)) : undefined) ??
      candidates.find((r) => r.minAmount === rule.minAmount);
    if (existing) claimedRuleIds.add(existing.id);
    return existing ?? null;
  });
  // Rules that update an existing NPI rule are planned (and later run) before
  // rules that create one, so a moved threshold has already made room.
  const ruleIndices = eff.approvalRuleDefaults.map((_, i) => i);
  const ruleOrder = [...ruleIndices.filter((i) => matched[i] !== null), ...ruleIndices.filter((i) => matched[i] === null)];
  const ruleUpdates: ApprovalRuleStep[] = [];
  const ruleOthers: ApprovalRuleStep[] = [];
  for (const index of ruleOrder) {
    const rule = eff.approvalRuleDefaults[index];
    const existing = matched[index];
    const maxAmount = rule.maxAmount ?? null;
    const band = { min: rule.minAmount, max: maxAmount };
    const base = {
      kind: 'approval_rule' as const,
      id: `approval_rule:${rule.docType}:${rule.minAmount}`,
      docType: rule.docType,
      minAmount: rule.minAmount,
      maxAmount,
      stepRoleKeys: [...rule.steps],
      existingStepRoleKeys: null as string[] | null,
      existingMinAmount: null as number | null,
      reactivate: false,
    };
    if (ruleGate) {
      ruleOthers.push({ ...base, ...blockedStep(ruleGate) });
      continue;
    }

    if (
      existing &&
      existing.isActive &&
      existing.minAmount === rule.minAmount &&
      existing.maxAmount === maxAmount &&
      sameSequence(existing.stepRoleKeys, rule.steps)
    ) {
      ruleOthers.push({ ...base, action: 'skip', blocked: null, existingId: existing.id, notesAr: [], existingStepRoleKeys: existing.stepRoleKeys, existingMinAmount: existing.minAmount });
      continue;
    }

    // Discovered rules are NPI's: one that moved since it was read is left as
    // it is (the next sync reports it), never put back.
    if (existing && answers.sources?.['3'] === 'npi') {
      ruleOthers.push({
        ...base,
        action: 'skip',
        blocked: null,
        existingId: existing.id,
        notesAr: ['القاعدة في NPI تغيّرت بعد قراءتها؛ تبقى كما هي في NPI.'],
        existingStepRoleKeys: existing.stepRoleKeys,
        existingMinAmount: existing.minAmount,
      });
      continue;
    }

    // Preconditions NPI enforces on create and on a step change.
    const blockedRole = rule.steps.find((key) => roleStepByKey.get(key)?.action === 'blocked');
    if (blockedRole !== undefined) {
      ruleOthers.push({ ...base, ...blockedStep({ code: 'depends_on_blocked_role', roleKey: blockedRole }) });
      continue;
    }
    const notesAr: string[] = [];
    if (snapshot.users === null) {
      notesAr.push('لم يُتحقق من وجود مستخدمين نشطين لأدوار السلسلة؛ قد ترفض NPI القاعدة عند التطبيق.');
    } else {
      const emptyRole = rule.steps.find((key) => !activeUsersByRole.has(key));
      if (emptyRole !== undefined) {
        ruleOthers.push({
          ...base,
          ...blockedStep({ code: 'role_without_active_user', roleKey: emptyRole, roleNameAr: eff.rolePermissionSets[emptyRole].nameAr }),
        });
        continue;
      }
    }

    const clash = clashWith(rule.docType, band, existing?.id ?? null);
    if (clash) {
      ruleOthers.push({ ...base, ...blockedStep({ code: 'band_overlap', min: clash.min, max: clash.max }) });
      continue;
    }

    if (existing) {
      bandsAfterUpdates.set(existing.id, { docType: rule.docType, ...band });
      ruleUpdates.push({
        ...base,
        action: 'update',
        blocked: null,
        existingId: existing.id,
        notesAr,
        existingStepRoleKeys: existing.stepRoleKeys,
        existingMinAmount: existing.minAmount,
        reactivate: !existing.isActive,
      });
      continue;
    }
    bandsAfterUpdates.set(`new:${base.id}`, { docType: rule.docType, ...band });
    ruleOthers.push({ ...base, action: 'create', blocked: null, existingId: null, notesAr });
  }
  steps.push(...ruleUpdates, ...ruleOthers);

  // ── items ────────────────────────────────────────────────────────────────
  const itemGate = gate(caller, STEP_WRITE_PERMISSION.item, [
    { permission: SNAPSHOT_READ_PERMISSION.items, value: snapshot.items },
  ]);
  for (const item of eff.itemTemplates) {
    const base = {
      kind: 'item' as const,
      id: `item:${item.sku}`,
      sku: item.sku,
      nameAr: item.nameAr,
      nameEn: item.nameEn,
      itemCategory: item.itemCategory,
      uom: item.uom,
      isSerialised: item.isSerialised,
    };
    if (itemGate) {
      steps.push({ ...base, ...blockedStep(itemGate) });
      continue;
    }
    const existing = snapshot.items!.find((i) => i.sku === item.sku);
    if (existing) {
      const notesAr: string[] = [];
      if (existing.itemCategory !== item.itemCategory) {
        notesAr.push(`الصنف موجود في NPI بتصنيف مختلف (${existing.itemCategory})؛ لم يُغيَّر.`);
      }
      if (existing.nameAr !== item.nameAr) notesAr.push(`اسم الصنف في NPI «${existing.nameAr}» يبقى كما هو.`);
      steps.push({ ...base, action: 'skip', blocked: null, existingId: existing.id, notesAr });
    } else {
      steps.push({ ...base, action: 'create', blocked: null, existingId: null, notesAr: [] });
    }
  }

  const counts: Record<StepAction, number> = { create: 0, update: 0, skip: 0, blocked: 0 };
  for (const step of steps) counts[step.action] += 1;

  return {
    profileKey: eff.key,
    steps,
    copilot: {
      profileKey: eff.key,
      titleAr: eff.titleAr,
      revenueLines: eff.revenueLines,
      visibleModules: eff.visibleModules as ModuleKey[],
      visibleFlows: visibleFlowsOf(eff),
      acceptedDocTypes: eff.acceptedDocTypes,
      terminology: eff.terminology,
      positions: eff.positions,
      holders: answers.holders ?? [],
    },
    gaps,
    counts,
    permissionLabel: permissionLabelResolver(snapshot.permissions),
    roleNamesAr: Object.fromEntries(Object.entries(eff.rolePermissionSets).map(([key, set]) => [key, set.nameAr])),
  };
}

// ─── Q7: «هذا ما سأضبطه في NPI وما سأضبطه في المحادثة» ──────────────────────

/** Copied from `APPROVAL_DOCUMENTS[].labelAr` (packages/shared/src/approvals.ts:36-73). */
export const APPROVAL_DOCUMENT_LABEL_AR: Record<ApprovalDocumentType, string> = {
  PURCHASE_REQUISITION: 'طلب شراء',
  PURCHASE_ORDER: 'أمر شراء',
  PROGRESS_CLAIM: 'مستخلص مقاول من الباطن',
  CHANGE_ORDER: 'أمر تغيير',
};

export interface PlanSummaryAr {
  /** What will be written to NPI (create/update), one line per step. */
  npi: string[];
  /** What NPI already holds exactly as planned. */
  already: string[];
  /** What is configured in the copilot only. */
  copilot: string[];
  /** Steps NPI would refuse today, with the reason. */
  blocked: string[];
  /** «لا تتيحه واجهة NPI حالياً». */
  gaps: string[];
}

/** One Arabic line naming a plan step (what it is, not what happens to it).
 *  Exported for the setup screens, which show the apply result per step id
 *  (T-18) — the summary lines below are built from the same text. */
export function describeStepAr(step: PlanStep, roleNameAr: (key: string) => string): string {
  switch (step.kind) {
    case 'department':
      return `القسم «${step.nameAr}» (${step.code})`;
    case 'role': {
      const delta =
        step.action === 'update'
          ? ` — إضافة ${step.permissionsAdded.length} صلاحية وسحب ${step.permissionsRemoved.length}`
          : step.action === 'create'
            ? ` — ${step.permissions.length} صلاحية`
            : '';
      return `الدور «${step.nameAr}»${delta}`;
    }
    case 'approval_rule': {
      const chain = step.stepRoleKeys.map(roleNameAr).join(' ثم ');
      const moved =
        step.action === 'update' && step.existingMinAmount !== null && step.existingMinAmount !== step.minAmount
          ? ` (كان ${formatBand(step.existingMinAmount, step.maxAmount)})`
          : '';
      return `قاعدة اعتماد: ${APPROVAL_DOCUMENT_LABEL_AR[step.docType]} ${formatBand(step.minAmount, step.maxAmount)}${moved} ← ${chain}`;
    }
    case 'item':
      return `الصنف ${step.sku} «${step.nameAr}»`;
  }
}

const ACTION_VERB_AR: Record<Exclude<StepAction, 'skip' | 'blocked'>, string> = {
  create: 'إنشاء',
  update: 'تحديث',
};

export function summarizePlanAr(plan: OnboardingPlan, pack: ProfilePack): PlanSummaryAr {
  const roleNameAr = (key: string) => plan.roleNamesAr[key] ?? pack.rolePermissionSets[key]?.nameAr ?? key;
  const npi: string[] = [];
  const already: string[] = [];
  const blocked: string[] = [];
  for (const step of plan.steps) {
    const text = describeStepAr(step, roleNameAr);
    if (step.action === 'create' || step.action === 'update') npi.push(`${ACTION_VERB_AR[step.action]} ${text}`);
    else if (step.action === 'skip') already.push(text);
    else blocked.push(`${text}: ${describeBlockedAr(step.blocked!, plan.permissionLabel)}`);
  }

  const copilot = [
    `الوحدات الظاهرة: ${plan.copilot.visibleModules.map((m) => MODULE_NAMES_AR[m]).join('، ')}`,
    `المستندات التي تُدخل بالمحادثة: ${plan.copilot.acceptedDocTypes.map((d) => d.labelAr).join('، ')}`,
    `المناصب: ${plan.copilot.positions.map((p) => p.titleAr).join('، ')}`,
  ];
  const terms = Object.values(plan.copilot.terminology);
  if (terms.length > 0) copilot.push(`المصطلحات: ${terms.join('، ')}`);
  const holderUserCount = plan.copilot.holders.reduce((n, h) => n + h.npiUserIds.length, 0);
  if (holderUserCount > 0) copilot.push(`شاغلو المناصب المختارون: ${holderUserCount}`);

  const gaps = plan.gaps.map((gap) => describeGapAr(gap, gap.kind === 'permission_unknown' ? roleNameAr(gap.roleKey) : ''));
  return { npi, already, copilot, blocked, gaps };
}
