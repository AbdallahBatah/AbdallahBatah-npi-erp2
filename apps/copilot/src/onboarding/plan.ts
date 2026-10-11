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

type PackDepartment = ProfilePack['defaultDepartments'][number];
type PackRoleSet = ProfilePack['rolePermissionSets'][string];
type PackApprovalRule = ProfilePack['approvalRuleDefaults'][number];
type PackItem = ProfilePack['itemTemplates'][number];

// ── departments ──────────────────────────────────────────────────────────────

function planDepartments(eff: ProfilePack, snapshot: NpiSnapshot, caller: PlanCaller): DepartmentStep[] {
  const deptGate = gate(caller, STEP_WRITE_PERMISSION.department, [
    { permission: SNAPSHOT_READ_PERMISSION.departments, value: snapshot.departments },
  ]);
  return eff.defaultDepartments.map((dept) => planDepartment(dept, snapshot, deptGate));
}

function planDepartment(dept: PackDepartment, snapshot: NpiSnapshot, deptGate: BlockedReason | null): DepartmentStep {
  const base = { kind: 'department' as const, id: `department:${dept.code}`, code: dept.code, nameAr: dept.nameAr, nameEn: dept.nameEn };
  if (deptGate) return { ...base, ...blockedStep(deptGate) };
  const existing = snapshot.departments!.find((d) => d.code === dept.code);
  if (!existing) return { ...base, action: 'create', blocked: null, existingId: null, notesAr: [] };
  const notesAr: string[] = [];
  if (!existing.isActive) notesAr.push('القسم موجود في NPI لكنه موقوف؛ لم يُغيَّر.');
  if (existing.nameAr !== dept.nameAr) notesAr.push(`اسم القسم في NPI «${existing.nameAr}» يبقى كما هو.`);
  return { ...base, action: 'skip', blocked: null, existingId: existing.id, notesAr };
}

// ── roles ────────────────────────────────────────────────────────────────────

interface RolePlanContext {
  roleGate: BlockedReason | null;
  snapshot: NpiSnapshot;
  knownPermissions: Set<string>;
  rolesAreNpis: boolean;
  caller: PlanCaller;
  gaps: NpiApiGap[];
}

function planRoles(
  eff: ProfilePack,
  answers: SetupAnswers,
  snapshot: NpiSnapshot,
  caller: PlanCaller,
): { steps: RoleStep[]; gaps: NpiApiGap[]; byKey: Map<string, RoleStep> } {
  const gaps: NpiApiGap[] = [];
  const ctx: RolePlanContext = {
    roleGate: gate(caller, STEP_WRITE_PERMISSION.role, [
      { permission: SNAPSHOT_READ_PERMISSION.permissions, value: snapshot.permissions },
      { permission: SNAPSHOT_READ_PERMISSION.roles, value: snapshot.roles },
    ]),
    snapshot,
    knownPermissions: new Set((snapshot.permissions ?? []).map((p) => p.key)),
    rolesAreNpis: answers.npiRoleSets !== undefined,
    caller,
    gaps,
  };
  const steps: RoleStep[] = [];
  const byKey = new Map<string, RoleStep>();
  for (const [roleKey, roleSet] of Object.entries(eff.rolePermissionSets)) {
    const step = planRole(ctx, roleKey, roleSet);
    steps.push(step);
    byKey.set(roleKey, step);
  }
  return { steps, gaps, byKey };
}

function roleBase(roleKey: string, roleSet: PackRoleSet) {
  return {
    kind: 'role' as const,
    id: `role:${roleKey}`,
    roleKey,
    nameAr: roleSet.nameAr,
    nameEn: roleSet.nameEn,
  };
}

function planRole(ctx: RolePlanContext, roleKey: string, roleSet: PackRoleSet): RoleStep {
  const base = roleBase(roleKey, roleSet);
  if (ctx.roleGate) {
    return { ...base, ...blockedStep(ctx.roleGate), permissions: roleSet.permissions, permissionsAdded: [], permissionsRemoved: [] };
  }

  // Discovered answers: a role NPI already holds is NPI's, not the pack's —
  // never rewritten, whatever its permission set is today.
  const existing = ctx.snapshot.roles!.find((r) => r.key === roleKey);
  if (ctx.rolesAreNpis && existing) {
    return {
      ...base,
      action: 'skip',
      blocked: null,
      existingId: existing.id,
      notesAr: [],
      permissions: existing.permissions,
      permissionsAdded: [],
      permissionsRemoved: [],
    };
  }

  // Keys NPI's live catalog does not serve are gaps — listed, not sent.
  const target = roleSet.permissions.filter((p) => ctx.knownPermissions.has(p));
  for (const p of roleSet.permissions) {
    if (!ctx.knownPermissions.has(p)) ctx.gaps.push({ kind: 'permission_unknown', roleKey, permission: p });
  }

  if (!existing) {
    return { ...base, action: 'create', blocked: null, existingId: null, notesAr: [], permissions: target, permissionsAdded: target, permissionsRemoved: [] };
  }
  return planExistingRole(base, existing, roleSet, target, ctx.caller);
}

function planExistingRole(
  base: ReturnType<typeof roleBase>,
  existing: NpiRole,
  roleSet: PackRoleSet,
  packTarget: string[],
  caller: PlanCaller,
): RoleStep {
  let target = packTarget;
  const notesAr: string[] = [];
  if (base.roleKey === caller.roleKey) {
    // Never strip a permission from the role the administrator is acting
    // under: the next step of this very apply would be refused.
    target = [...new Set([...existing.permissions, ...target])];
    notesAr.push('هذا دورك أنت؛ شاشة الإعداد تضيف إليه ولا تسحب منه.');
  }
  if (existing.nameAr !== roleSet.nameAr) notesAr.push(`اسم الدور في NPI «${existing.nameAr}» يبقى كما هو.`);
  const added = target.filter((p) => !existing.permissions.includes(p));
  const removed = existing.permissions.filter((p) => !target.includes(p));
  return sameSet(existing.permissions, target)
    ? { ...base, action: 'skip', blocked: null, existingId: existing.id, notesAr, permissions: target, permissionsAdded: [], permissionsRemoved: [] }
    : { ...base, action: 'update', blocked: null, existingId: existing.id, notesAr, permissions: target, permissionsAdded: added, permissionsRemoved: removed };
}

// ── approval rules ───────────────────────────────────────────────────────────

type Band = { min: number; max: number | null };
type TypedBand = Band & { docType: string };

interface RulePlanContext {
  eff: ProfilePack;
  answers: SetupAnswers;
  snapshot: NpiSnapshot;
  ruleGate: BlockedReason | null;
  roleStepByKey: Map<string, RoleStep>;
  activeUsersByRole: Set<string>;
  /** The active bands NPI will hold once the updates planned here have run,
   *  keyed by NPI rule id (or a synthetic key for a band this plan creates).
   *  Creates are checked against *these* bands, and updates are emitted before
   *  creates, so a moved threshold makes room for a new band in the same run. */
  bandsAfterUpdates: Map<string, TypedBand>;
}

/** Which NPI rule each planned rule *is*: the same band exactly; otherwise,
 *  for an open-ended band («فأكثر»), the document type's open-ended rule
 *  whatever its current floor — moving that floor is what "change the
 *  threshold" means, and NPI allows at most one active open-ended band per
 *  type. Each NPI rule is claimed by at most one planned rule. */
function matchApprovalRules(eff: ProfilePack, snapshot: NpiSnapshot): (NpiApprovalRule | null)[] {
  const npiRules = snapshot.approvalRules;
  if (npiRules === null) return eff.approvalRuleDefaults.map(() => null);
  const claimedRuleIds = new Set<string>();
  return eff.approvalRuleDefaults.map((rule) => {
    const candidates = npiRules.filter((r) => r.documentType === rule.docType && !claimedRuleIds.has(r.id));
    const existing = findNpiRule(rule, candidates);
    if (existing) claimedRuleIds.add(existing.id);
    return existing ?? null;
  });
}

function findNpiRule(rule: PackApprovalRule, candidates: NpiApprovalRule[]): NpiApprovalRule | undefined {
  const maxAmount = rule.maxAmount ?? null;
  return (
    candidates.find((r) => r.minAmount === rule.minAmount && r.maxAmount === maxAmount) ??
    (maxAmount === null ? (candidates.find((r) => r.maxAmount === null && r.isActive) ?? candidates.find((r) => r.maxAmount === null)) : undefined) ??
    candidates.find((r) => r.minAmount === rule.minAmount)
  );
}

function activeBands(snapshot: NpiSnapshot): Map<string, TypedBand> {
  const bands = new Map<string, TypedBand>();
  for (const r of snapshot.approvalRules ?? []) {
    if (r.isActive) bands.set(r.id, { docType: r.documentType, min: r.minAmount, max: r.maxAmount });
  }
  return bands;
}

function clashWith(ctx: RulePlanContext, docType: string, band: Band, excludeId: string | null): TypedBand | null {
  for (const [id, other] of ctx.bandsAfterUpdates) {
    if (id !== excludeId && other.docType === docType && bandsOverlap(band, other)) return other;
  }
  return null;
}

function planApprovalRules(
  eff: ProfilePack,
  answers: SetupAnswers,
  snapshot: NpiSnapshot,
  caller: PlanCaller,
  roleStepByKey: Map<string, RoleStep>,
): ApprovalRuleStep[] {
  const ctx: RulePlanContext = {
    eff,
    answers,
    snapshot,
    ruleGate: gate(caller, STEP_WRITE_PERMISSION.approval_rule, [
      { permission: SNAPSHOT_READ_PERMISSION.rules, value: snapshot.approvalRules },
      { permission: SNAPSHOT_READ_PERMISSION.roles, value: snapshot.roles },
    ]),
    roleStepByKey,
    activeUsersByRole: new Set((snapshot.users ?? []).filter((u) => u.isActive).map((u) => u.roleKey)),
    bandsAfterUpdates: activeBands(snapshot),
  };
  const matched = matchApprovalRules(eff, snapshot);
  // Rules that update an existing NPI rule are planned (and later run) before
  // rules that create one, so a moved threshold has already made room.
  const ruleIndices = eff.approvalRuleDefaults.map((_, i) => i);
  const ruleOrder = [...ruleIndices.filter((i) => matched[i] !== null), ...ruleIndices.filter((i) => matched[i] === null)];
  const ruleUpdates: ApprovalRuleStep[] = [];
  const ruleOthers: ApprovalRuleStep[] = [];
  for (const index of ruleOrder) {
    const { step, isUpdate } = planApprovalRule(ctx, eff.approvalRuleDefaults[index], matched[index]);
    (isUpdate ? ruleUpdates : ruleOthers).push(step);
  }
  return [...ruleUpdates, ...ruleOthers];
}

function approvalRuleBase(rule: PackApprovalRule, maxAmount: number | null) {
  return {
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
}

function planApprovalRule(
  ctx: RulePlanContext,
  rule: PackApprovalRule,
  existing: NpiApprovalRule | null,
): { step: ApprovalRuleStep; isUpdate: boolean } {
  const maxAmount = rule.maxAmount ?? null;
  const base = approvalRuleBase(rule, maxAmount);
  if (ctx.ruleGate) return { step: { ...base, ...blockedStep(ctx.ruleGate) }, isUpdate: false };

  const settled = skipApprovalRule(ctx, rule, existing, base) ?? blockApprovalRule(ctx, rule, existing, base);
  if (settled) return { step: settled, isUpdate: false };

  const notesAr: string[] = [];
  if (ctx.snapshot.users === null) {
    notesAr.push('لم يُتحقق من وجود مستخدمين نشطين لأدوار السلسلة؛ قد ترفض NPI القاعدة عند التطبيق.');
  }
  const band = { min: rule.minAmount, max: maxAmount };
  if (existing) {
    ctx.bandsAfterUpdates.set(existing.id, { docType: rule.docType, ...band });
    return {
      step: {
        ...base,
        action: 'update',
        blocked: null,
        existingId: existing.id,
        notesAr,
        existingStepRoleKeys: existing.stepRoleKeys,
        existingMinAmount: existing.minAmount,
        reactivate: !existing.isActive,
      },
      isUpdate: true,
    };
  }
  ctx.bandsAfterUpdates.set(`new:${base.id}`, { docType: rule.docType, ...band });
  return { step: { ...base, action: 'create', blocked: null, existingId: null, notesAr }, isUpdate: false };
}

/** The two cases where NPI already holds the rule and nothing is written. */
function skipApprovalRule(
  ctx: RulePlanContext,
  rule: PackApprovalRule,
  existing: NpiApprovalRule | null,
  base: ReturnType<typeof approvalRuleBase>,
): ApprovalRuleStep | null {
  if (!existing) return null;
  if (
    existing.isActive &&
    existing.minAmount === rule.minAmount &&
    existing.maxAmount === base.maxAmount &&
    sameSequence(existing.stepRoleKeys, rule.steps)
  ) {
    return { ...base, action: 'skip', blocked: null, existingId: existing.id, notesAr: [], existingStepRoleKeys: existing.stepRoleKeys, existingMinAmount: existing.minAmount };
  }

  // Discovered rules are NPI's: one that moved since it was read is left as
  // it is (the next sync reports it), never put back.
  if (ctx.answers.sources?.['3'] === 'npi') {
    return {
      ...base,
      action: 'skip',
      blocked: null,
      existingId: existing.id,
      notesAr: ['القاعدة في NPI تغيّرت بعد قراءتها؛ تبقى كما هي في NPI.'],
      existingStepRoleKeys: existing.stepRoleKeys,
      existingMinAmount: existing.minAmount,
    };
  }
  return null;
}

/** Preconditions NPI enforces on create and on a step change. */
function blockApprovalRule(
  ctx: RulePlanContext,
  rule: PackApprovalRule,
  existing: NpiApprovalRule | null,
  base: ReturnType<typeof approvalRuleBase>,
): ApprovalRuleStep | null {
  const blockedRole = rule.steps.find((key) => ctx.roleStepByKey.get(key)?.action === 'blocked');
  if (blockedRole !== undefined) {
    return { ...base, ...blockedStep({ code: 'depends_on_blocked_role', roleKey: blockedRole }) };
  }
  const emptyRole = ctx.snapshot.users === null ? undefined : rule.steps.find((key) => !ctx.activeUsersByRole.has(key));
  if (emptyRole !== undefined) {
    return {
      ...base,
      ...blockedStep({ code: 'role_without_active_user', roleKey: emptyRole, roleNameAr: ctx.eff.rolePermissionSets[emptyRole].nameAr }),
    };
  }
  const clash = clashWith(ctx, rule.docType, { min: rule.minAmount, max: base.maxAmount }, existing?.id ?? null);
  if (clash) return { ...base, ...blockedStep({ code: 'band_overlap', min: clash.min, max: clash.max }) };
  return null;
}

// ── items ────────────────────────────────────────────────────────────────────

function planItems(eff: ProfilePack, snapshot: NpiSnapshot, caller: PlanCaller): ItemStep[] {
  const itemGate = gate(caller, STEP_WRITE_PERMISSION.item, [
    { permission: SNAPSHOT_READ_PERMISSION.items, value: snapshot.items },
  ]);
  return eff.itemTemplates.map((item) => planItem(item, snapshot, itemGate));
}

function planItem(item: PackItem, snapshot: NpiSnapshot, itemGate: BlockedReason | null): ItemStep {
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
  if (itemGate) return { ...base, ...blockedStep(itemGate) };
  const existing = snapshot.items!.find((i) => i.sku === item.sku);
  if (!existing) return { ...base, action: 'create', blocked: null, existingId: null, notesAr: [] };
  const notesAr: string[] = [];
  if (existing.itemCategory !== item.itemCategory) {
    notesAr.push(`الصنف موجود في NPI بتصنيف مختلف (${existing.itemCategory})؛ لم يُغيَّر.`);
  }
  if (existing.nameAr !== item.nameAr) notesAr.push(`اسم الصنف في NPI «${existing.nameAr}» يبقى كما هو.`);
  return { ...base, action: 'skip', blocked: null, existingId: existing.id, notesAr };
}

export function buildPlan(
  pack: ProfilePack,
  answers: SetupAnswers,
  snapshot: NpiSnapshot,
  caller: PlanCaller,
): OnboardingPlan {
  const eff = effectivePack(pack, answers);
  const roles = planRoles(eff, answers, snapshot, caller);
  const steps: PlanStep[] = [
    ...planDepartments(eff, snapshot, caller),
    ...roles.steps,
    ...planApprovalRules(eff, answers, snapshot, caller, roles.byKey),
    ...planItems(eff, snapshot, caller),
  ];

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
    // Every plan starts with the standing gap: workflow definitions are
    // seed-only in NPI (01 B-02, ADR-30), so no pack can set them and the
    // administrator is told so on every setup (AT-11, G-M2-3 "gaps list
    // non-empty and shown").
    gaps: [WORKFLOW_DEFINITIONS_GAP, ...roles.gaps],
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
