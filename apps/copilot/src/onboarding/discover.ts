// Automatic setup (T-47a, owner decision 2026-10-10): the wizard reads the
// answers from NPI instead of asking the administrator to type what NPI
// already knows. Pure and deterministic — no model call, no I/O of its own
// (the snapshot and the three counts are read by the caller with the signed-in
// administrator's token, the persona text by an injectable loader).
//
// What comes out is one answer per setup step 1–6, each shaped exactly like
// `StepAnswerSchema` so `applyAnswer` accepts it unchanged, plus where each
// answer came from:
//
//   1  the profile pack — GUESSED from NPI evidence by the fixed weights in
//      `PROFILE_WEIGHTS` below (source 'heuristic'); the administrator confirms
//   2  NPI's departments, and one position per (role, department) that has an
//      active user in the directory, those users being its holders ('npi')
//   3  NPI's active approval rules ('npi'); the pack's defaults when NPI has
//      none ('pack-default')
//   4  the document types the organization's roles can actually run ('npi');
//      the pack's when nothing can be derived ('pack-default')
//   5  no items — an item NPI holds is never re-created ('npi')
//   6  the pack's terminology ('pack-default')
//
// Steps 2–4 are validated against NPI's own roles (`roleSets`), which stand in
// for the pack's `rolePermissionSets` (see `effectivePack`). When the
// organization's data cannot form a valid profile that way — an empty
// organization, a department code NPI accepts and the schema does not — the
// whole reading falls back to the pack's defaults for steps 2–4 and says so in
// `evidence.skippedAr`, rather than half-applying.
import type { NpiApprovalRule, NpiRole } from '../npi/admin';
import { t, type ArKey } from '../i18n/ar';
import { formatNumber } from '../i18n/format';
import { buildTitleAr, loadPersona } from '../positions/persona';
import { SNAPSHOT_READ_PERMISSION } from './gaps';
import { loadProfilePack } from './catalog';
import type { DiscoveryMeta, SetupState } from './machine';
import { APPROVAL_DOCUMENT_LABEL_AR, effectivePack, PlanError, type NpiSnapshot, type SetupAnswers } from './plan';
import {
  FLOW_REQUIRED_PERMISSION,
  MODULE_KEYS,
  MODULE_NAMES_AR,
  PROFILE_KEYS,
  APPROVAL_DOCUMENT_PERMISSION,
  type ModuleKey,
  type ProfileKey,
  type ProfilePack,
} from './profile.schema';

// ─── Shapes ─────────────────────────────────────────────────────────────────

export type DiscoverySourceKind = 'npi' | 'pack-default' | 'heuristic';
export type Confidence = 'high' | 'medium' | 'low';
type StepKey = '1' | '2' | '3' | '4' | '5' | '6';

type Step1 = { step: 1; profileKey: ProfileKey; revenueLines?: string[] };
type Step2 = {
  step: 2;
  departments: ProfilePack['defaultDepartments'];
  positions: ProfilePack['positions'];
  holders?: { roleKey: string; departmentCode: string | null; npiUserIds: string[] }[];
};
type Step3 = { step: 3; approvalRules: ProfilePack['approvalRuleDefaults'] };
type Step4 = { step: 4; acceptedDocTypeKeys: string[] };
type Step5 = { step: 5; items: ProfilePack['itemTemplates'] };
type Step6 = { step: 6; terminology: ProfilePack['terminology'] };

export interface DiscoveredAnswers {
  /** One answer per step, each valid against `StepAnswerSchema`. */
  answers: { 1: Step1; 2: Step2; 3: Step3; 4: Step4; 5: Step5; 6: Step6 };
  sources: Record<StepKey, DiscoverySourceKind>;
  /** The reading behind step 1 and what the reading left out. */
  evidence: {
    profileKey: ProfileKey;
    confidence: Confidence;
    reasonsAr: string[];
    scores: Record<string, number>;
    skippedAr: string[];
  };
  /** NPI's own roles the answers were validated against; absent when the
   *  reading fell back to the pack's roles. */
  roleSets?: Record<string, { nameAr: string; permissions: string[] }>;
}

export interface DiscoveryExtras {
  /** How many projects / customers / vendors NPI holds (one page is enough);
   *  `null` when the list could not be read. */
  counts: { projects: number | null; customers: number | null; vendors: number | null };
  /** Overridable for tests; defaults to the real loaders. */
  loadPack?: (key: string) => ProfilePack;
  personaFor?: (roleKey: string) => string;
}

// ─── Step 1: the weights (one small table) ──────────────────────────────────

/**
 * How the six packs are scored from NPI evidence. Score = the sum of the
 * rows below; the highest wins, a tie goes to `epc` (NPI is a solar EPC).
 *
 *  moduleHeld        per pack module whose permission family a role that has an
 *                    active user holds (the admin role holds everything, so it
 *                    says nothing and is left out)
 *  moduleUnused      per family such a role holds that the pack does not show
 *  itemCategories    × Jaccard(categories of the items in NPI, categories of
 *                    the pack's item templates)
 *  roleKeys          × share of the pack's non-admin position roles that NPI has
 *                    a role of, with an active user
 *  projectsPresent   NPI has projects and the pack shows the projects module
 *  projectsAbsent    NPI has projects and the pack does not show the module
 *  tradingShape      no projects, but vendors or items — equipment trading only
 *  customersCrm      NPI has customers and the pack shows the CRM module
 *  vendorsProcurement NPI has vendors and the pack shows the procurement module
 */
export const PROFILE_WEIGHTS = {
  moduleHeld: 3,
  moduleUnused: -1,
  itemCategories: 6,
  roleKeys: 4,
  projectsPresent: 4,
  projectsAbsent: -3,
  tradingShape: 4,
  customersCrm: 1,
  vendorsProcurement: 1,
} as const;

/** The permission prefixes that mean a module is in use. `commercial.item.*`
 *  is left out: nearly every role reads items. */
const MODULE_PERMISSION_PREFIXES: Record<ModuleKey, string[]> = {
  crm: ['crm.'],
  commercial: ['commercial.contract.', 'commercial.proposal.'],
  projects: ['projects.'],
  procurement: ['scm.'],
  fsm: ['fsm.'],
  finance: ['finance.'],
  ppa: ['ppa.'],
  telemetry: ['telemetry.'],
};

/** A lead of this share of the top score is «high», of this share «medium». */
const CONFIDENCE_HIGH_LEAD = 0.3;
const CONFIDENCE_MEDIUM_LEAD = 0.1;

interface Evidence {
  heldModules: Set<ModuleKey>;
  itemCategories: Set<string>;
  itemCount: number | null;
  /** Non-admin role keys that have an active user. */
  activeRoleKeys: Set<string>;
  counts: DiscoveryExtras['counts'];
}

function gatherEvidence(snapshot: NpiSnapshot, counts: DiscoveryExtras['counts']): Evidence {
  const roles = snapshot.roles ?? [];
  const activeRoleKeys = new Set(
    snapshot.users === null ? roles.map((r) => r.key) : snapshot.users.filter((u) => u.isActive).map((u) => u.roleKey),
  );
  activeRoleKeys.delete('admin');
  const heldModules = new Set<ModuleKey>();
  for (const role of roles) {
    if (role.key === 'admin' || !activeRoleKeys.has(role.key)) continue;
    for (const module of MODULE_KEYS) {
      if (role.permissions.some((p) => MODULE_PERMISSION_PREFIXES[module].some((prefix) => p.startsWith(prefix)))) heldModules.add(module);
    }
  }
  const items = snapshot.items ?? [];
  return {
    heldModules,
    itemCategories: new Set(items.map((i) => i.itemCategory)),
    itemCount: snapshot.items === null ? null : items.length,
    activeRoleKeys,
    counts,
  };
}

function packItemCategories(pack: ProfilePack): Set<string> {
  return new Set(pack.itemTemplates.map((i) => i.itemCategory));
}

function packPositionRoles(pack: ProfilePack): string[] {
  return [...new Set(pack.positions.map((p) => p.roleKey))].filter((k) => k !== 'admin');
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let both = 0;
  for (const v of a) if (b.has(v)) both += 1;
  return both / (a.size + b.size - both);
}

function scorePack(pack: ProfilePack, e: Evidence): number {
  const w = PROFILE_WEIGHTS;
  const modules = new Set<string>(pack.visibleModules);
  let score = 0;
  for (const module of e.heldModules) score += modules.has(module) ? w.moduleHeld : w.moduleUnused;
  score += w.itemCategories * jaccard(e.itemCategories, packItemCategories(pack));
  const roles = packPositionRoles(pack);
  if (roles.length > 0) score += w.roleKeys * (roles.filter((k) => e.activeRoleKeys.has(k)).length / roles.length);
  const { projects, customers, vendors } = e.counts;
  if (projects !== null && projects > 0) score += modules.has('projects') ? w.projectsPresent : w.projectsAbsent;
  if (projects === 0 && ((vendors ?? 0) > 0 || (e.itemCount ?? 0) > 0) && pack.key === 'equipment_trading') score += w.tradingShape;
  if (customers !== null && customers > 0 && modules.has('crm')) score += w.customersCrm;
  if (vendors !== null && vendors > 0 && modules.has('procurement')) score += w.vendorsProcurement;
  return Math.round(score * 100) / 100;
}

function categoryNamesAr(categories: Iterable<string>): string {
  return [...categories].map((c) => t(`setup.item.category.${c}` as ArKey)).join('، ');
}

function reasonsFor(pack: ProfilePack, e: Evidence, confidence: Confidence, tie: boolean): string[] {
  const reasons: string[] = [];
  const modules = new Set<string>(pack.visibleModules);
  const { projects } = e.counts;
  if (projects !== null && projects > 0 && modules.has('projects')) {
    reasons.push(t('setup.discover.reason.projects', { n: formatNumber(projects) }));
  } else if (projects === 0 && !modules.has('projects')) {
    reasons.push(t('setup.discover.reason.no_projects'));
  }
  const shared = [...e.itemCategories].filter((c) => packItemCategories(pack).has(c));
  if (shared.length > 0) reasons.push(t('setup.discover.reason.items', { categories: categoryNamesAr(shared) }));
  const sharedRoles = packPositionRoles(pack).filter((k) => e.activeRoleKeys.has(k));
  if (sharedRoles.length > 0) reasons.push(t('setup.discover.reason.roles', { n: formatNumber(sharedRoles.length) }));
  const sharedModules = [...e.heldModules].filter((m) => modules.has(m) && m !== 'finance');
  if (sharedModules.length > 0) {
    reasons.push(t('setup.discover.reason.modules', { modules: sharedModules.map((m) => MODULE_NAMES_AR[m]).join('، ') }));
  }
  if (tie) reasons.push(t('setup.discover.reason.tie'));
  if (reasons.length === 0 || confidence === 'low') reasons.push(t('setup.discover.reason.little_evidence'));
  return reasons;
}

/**
 * Step 1: scores the six packs and returns the winner with its confidence.
 * Exported for the tests, which pin the weights' behaviour on fixtures.
 */
export function guessProfile(
  snapshot: NpiSnapshot,
  counts: DiscoveryExtras['counts'],
  loadPack: (key: string) => ProfilePack = loadProfilePack,
): { profileKey: ProfileKey; confidence: Confidence; reasonsAr: string[]; scores: Record<string, number> } {
  const evidence = gatherEvidence(snapshot, counts);
  const scores: Record<string, number> = {};
  for (const key of PROFILE_KEYS) scores[key] = scorePack(loadPack(key), evidence);

  // Highest score; PROFILE_KEYS lists `epc` first, so a tie keeps it.
  let best: ProfileKey = 'epc';
  for (const key of PROFILE_KEYS) if (scores[key] > scores[best]) best = key;
  const others = PROFILE_KEYS.filter((k) => k !== best).map((k) => scores[k]);
  const second = Math.max(...others);
  const top = scores[best];
  const lead = top > 0 ? (top - second) / top : 0;
  const confidence: Confidence = lead >= CONFIDENCE_HIGH_LEAD ? 'high' : lead >= CONFIDENCE_MEDIUM_LEAD ? 'medium' : 'low';
  const tie = top === second;
  return { profileKey: best, confidence, reasonsAr: reasonsFor(loadPack(best), evidence, confidence, tie), scores };
}

// ─── Steps 2–6 ──────────────────────────────────────────────────────────────

const ROLE_KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;
const DEPARTMENT_CODE_RE = /^[A-Z][A-Z0-9_-]{1,19}$/;

type RoleSets = Record<string, { nameAr: string; permissions: string[] }>;

function usableRoles(roles: NpiRole[] | null): RoleSets | undefined {
  if (roles === null) return undefined;
  const sets: RoleSets = {};
  for (const role of roles) {
    if (ROLE_KEY_RE.test(role.key) && role.permissions.length > 0 && role.nameAr.trim().length > 0) {
      sets[role.key] = { nameAr: role.nameAr, permissions: [...new Set(role.permissions)] };
    }
  }
  return sets.admin ? sets : undefined;
}

function positionKey(roleKey: string, departmentCode: string | null): string {
  return `${roleKey}\u0000${departmentCode ?? ''}`;
}

type DeptById = Map<string, { code: string; nameAr: string }>;

/** NPI's active departments the profile schema accepts; the others are named in `skippedAr`. */
function carriedDepartments(all: NonNullable<NpiSnapshot['departments']>, skippedAr: string[]): { departments: Step2['departments']; deptById: DeptById } {
  const departments: Step2['departments'] = [];
  const deptById: DeptById = new Map();
  for (const d of all) {
    if (!d.isActive) continue;
    if (!DEPARTMENT_CODE_RE.test(d.code) || d.nameAr.trim().length < 2 || d.nameAr.length > 120) {
      skippedAr.push(t('setup.discover.skipped.department', { name: d.nameAr }));
      continue;
    }
    departments.push({ code: d.code, nameAr: d.nameAr });
    deptById.set(d.id, { code: d.code, nameAr: d.nameAr });
  }
  return { departments, deptById };
}

interface HolderGroup {
  roleKey: string;
  departmentCode: string | null;
  departmentNameAr: string | null;
  userIds: string[];
}

/** One group per (role, department) with an active user; users it cannot place are named in `skippedAr`. */
function groupHolders(users: NonNullable<NpiSnapshot['users']>, roleSets: RoleSets, deptById: DeptById, skippedAr: string[]): Map<string, HolderGroup> {
  const groups = new Map<string, HolderGroup>();
  const skippedRoles = new Set<string>();
  let strandedUsers = 0; // active users of a department that is not carried over
  for (const user of users) {
    if (!user.isActive) continue;
    if (!roleSets[user.roleKey]) {
      skippedRoles.add(user.roleKey);
      continue;
    }
    const dept = user.departmentId ? deptById.get(user.departmentId) : undefined;
    // A user whose department NPI deactivated (or the schema refuses) is not
    // moved into a department-less position: they are left out and counted.
    if (user.departmentId && !dept) {
      strandedUsers += 1;
      continue;
    }
    const key = positionKey(user.roleKey, dept?.code ?? null);
    const group = groups.get(key) ?? { roleKey: user.roleKey, departmentCode: dept?.code ?? null, departmentNameAr: dept?.nameAr ?? null, userIds: [] };
    group.userIds.push(user.id);
    groups.set(key, group);
  }
  for (const roleKey of skippedRoles) skippedAr.push(t('setup.discover.skipped.role', { role: roleKey }));
  if (strandedUsers > 0) skippedAr.push(t('setup.discover.skipped.department_users', { n: formatNumber(strandedUsers) }));
  return groups;
}

function discoverStep2(
  snapshot: NpiSnapshot,
  roleSets: RoleSets,
  personaFor: (roleKey: string) => string,
  skippedAr: string[],
): Step2 | null {
  if (snapshot.departments === null || snapshot.users === null) return null;

  const { departments, deptById } = carriedDepartments(snapshot.departments, skippedAr);
  if (departments.length === 0) return null;

  const groups = groupHolders(snapshot.users, roleSets, deptById, skippedAr);
  if (groups.size === 0) return null;

  const ordered = [...groups.values()].sort((a, b) => positionKey(a.roleKey, a.departmentCode).localeCompare(positionKey(b.roleKey, b.departmentCode)));
  return {
    step: 2,
    departments,
    positions: ordered.map((g) => ({
      roleKey: g.roleKey,
      departmentCode: g.departmentCode,
      titleAr: buildTitleAr(roleSets[g.roleKey].nameAr, g.departmentNameAr),
      personaAr: personaFor(g.roleKey),
    })),
    holders: ordered.map((g) => ({ roleKey: g.roleKey, departmentCode: g.departmentCode, npiUserIds: g.userIds })),
  };
}

function discoverStep3(rules: NpiApprovalRule[] | null, roleSets: RoleSets, skippedAr: string[]): Step3 | null {
  if (rules === null) return null;
  const active = rules.filter((r) => r.isActive);
  const inactive = rules.length - active.length;
  if (inactive > 0) skippedAr.push(t('setup.discover.skipped.inactive_rules', { n: formatNumber(inactive) }));
  const out: Step3['approvalRules'] = [];
  const seen = new Set<string>();
  for (const rule of active) {
    const docType = rule.documentType as keyof typeof APPROVAL_DOCUMENT_PERMISSION;
    const needed = APPROVAL_DOCUMENT_PERMISSION[docType];
    const dedupe = `${rule.documentType}:${rule.minAmount}`;
    const valid =
      needed !== undefined &&
      Number.isInteger(rule.minAmount) &&
      rule.minAmount >= 0 &&
      (rule.maxAmount === null || (Number.isInteger(rule.maxAmount) && rule.maxAmount > rule.minAmount)) &&
      rule.stepRoleKeys.length > 0 &&
      rule.stepRoleKeys.every((k) => roleSets[k]?.permissions.includes(needed)) &&
      !seen.has(dedupe);
    if (!valid) {
      skippedAr.push(t('setup.discover.skipped.rule', { doc: APPROVAL_DOCUMENT_LABEL_AR[docType] ?? rule.documentType, min: formatNumber(rule.minAmount) }));
      continue;
    }
    seen.add(dedupe);
    out.push({ docType, minAmount: rule.minAmount, ...(rule.maxAmount === null ? {} : { maxAmount: rule.maxAmount }), steps: [...rule.stepRoleKeys] });
  }
  return out.length > 0 ? { step: 3, approvalRules: out } : null;
}

/** Pack rules that still hold under `roleSets` (every step's role exists and
 *  may approve that document). */
function packRulesUnder(pack: ProfilePack, roleSets: RoleSets | undefined, skippedAr: string[]): Step3['approvalRules'] {
  if (roleSets === undefined) return pack.approvalRuleDefaults;
  return pack.approvalRuleDefaults.filter((rule) => {
    const needed = APPROVAL_DOCUMENT_PERMISSION[rule.docType];
    const ok = rule.steps.every((k) => roleSets[k]?.permissions.includes(needed));
    if (!ok) skippedAr.push(t('setup.discover.skipped.pack_rule', { doc: APPROVAL_DOCUMENT_LABEL_AR[rule.docType], min: formatNumber(rule.minAmount) }));
    return ok;
  });
}

function discoverStep4(pack: ProfilePack, roleSets: RoleSets): Step4 | null {
  const held = new Set<string>();
  for (const role of Object.values(roleSets)) for (const p of role.permissions) held.add(p);
  const keys = pack.acceptedDocTypes
    .filter((d) => d.flow === null || held.has(FLOW_REQUIRED_PERMISSION[d.flow]))
    .map((d) => d.key);
  const withFlow = pack.acceptedDocTypes.filter((d) => d.flow !== null && keys.includes(d.key));
  // Nothing a chat flow can run is derivable: the pack's own list stands.
  return withFlow.length > 0 ? { step: 4, acceptedDocTypeKeys: keys } : null;
}

// ─── The reading ────────────────────────────────────────────────────────────

/** NPI read permissions without which no reading is possible (the roles, the
 *  departments and the user directory); the rest only sharpen it. */
export function discoveryBlockers(snapshot: NpiSnapshot): string[] {
  const missing: string[] = [];
  if (snapshot.roles === null) missing.push(SNAPSHOT_READ_PERMISSION.roles);
  if (snapshot.departments === null) missing.push(SNAPSHOT_READ_PERMISSION.departments);
  if (snapshot.users === null) missing.push(SNAPSHOT_READ_PERMISSION.directory);
  return [...new Set(missing)];
}

function toAnswers(a: DiscoveredAnswers['answers'], roleSets: RoleSets | undefined): SetupAnswers {
  return {
    profileKey: a[1].profileKey,
    revenueLines: a[1].revenueLines,
    departments: a[2].departments,
    positions: a[2].positions,
    holders: a[2].holders,
    approvalRules: a[3].approvalRules,
    acceptedDocTypeKeys: a[4].acceptedDocTypeKeys,
    items: a[5].items,
    terminology: a[6].terminology,
    npiRoleSets: roleSets,
  };
}

type Fixed = { step1: Step1; step5: Step5; step6: Step6 };

/**
 * Attempt 1 of the reading: NPI's own roles, departments, users and rules.
 * `null` when NPI holds too little for it, or when what it holds does not form
 * a valid profile (the caller then falls back to the pack's own steps 2–4).
 */
function discoverFromRoles(
  snapshot: NpiSnapshot,
  roleSets: RoleSets | undefined,
  pack: ProfilePack,
  fixed: Fixed,
  personaFor: (roleKey: string) => string,
  guess: ReturnType<typeof guessProfile>,
): DiscoveredAnswers | null {
  if (roleSets === undefined) return null;
  const attemptSkipped: string[] = [];
  const step2 = discoverStep2(snapshot, roleSets, personaFor, attemptSkipped);
  const step4 = discoverStep4(pack, roleSets);
  if (step2 === null || step4 === null) return null;

  const npiRules = discoverStep3(snapshot.approvalRules, roleSets, attemptSkipped);
  const step3: Step3 = npiRules ?? { step: 3, approvalRules: packRulesUnder(pack, roleSets, attemptSkipped) };
  const answers = { 1: fixed.step1, 2: step2, 3: step3, 4: step4, 5: fixed.step5, 6: fixed.step6 };
  try {
    effectivePack(pack, toAnswers(answers, roleSets));
  } catch (err) {
    // The data NPI holds does not form a valid profile: fall through to
    // the pack's own steps 2–4.
    if (err instanceof PlanError) return null;
    throw err;
  }
  return {
    answers,
    sources: { '1': 'heuristic', '2': 'npi', '3': npiRules ? 'npi' : 'pack-default', '4': 'npi', '5': 'npi', '6': 'pack-default' },
    evidence: { ...guess, skippedAr: attemptSkipped },
    roleSets,
  };
}

export function discoverFromNpi(snapshot: NpiSnapshot, extras: DiscoveryExtras): DiscoveredAnswers {
  const loadPack = extras.loadPack ?? loadProfilePack;
  const personaFor = extras.personaFor ?? loadPersona;
  const guess = guessProfile(snapshot, extras.counts, loadPack);
  const pack = loadPack(guess.profileKey);
  const skippedAr: string[] = [];

  const step1: Step1 = { step: 1, profileKey: guess.profileKey, revenueLines: [...pack.revenueLines] };
  const step5: Step5 = { step: 5, items: [] };
  const step6: Step6 = { step: 6, terminology: { ...pack.terminology } };

  // ── Attempt 1: NPI's own roles, departments, users and rules ──────────────
  const attempt1 = discoverFromRoles(snapshot, usableRoles(snapshot.roles), pack, { step1, step5, step6 }, personaFor, guess);
  if (attempt1 !== null) return attempt1;

  // ── Attempt 2: the pack's own steps 2–4 (an organization with too little
  //    of its own to read, or one whose data the profile schema refuses) ────
  skippedAr.push(t('setup.discover.skipped.fallback'));
  const answers = {
    1: step1,
    2: { step: 2, departments: pack.defaultDepartments, positions: pack.positions } satisfies Step2,
    3: { step: 3, approvalRules: pack.approvalRuleDefaults } satisfies Step3,
    4: { step: 4, acceptedDocTypeKeys: pack.acceptedDocTypes.map((d) => d.key) } satisfies Step4,
    5: step5,
    6: step6,
  } as DiscoveredAnswers['answers'];
  return {
    answers,
    sources: { '1': 'heuristic', '2': 'pack-default', '3': 'pack-default', '4': 'pack-default', '5': 'npi', '6': 'pack-default' },
    evidence: { ...guess, skippedAr },
  };
}

/**
 * The session state a reading seeds: steps 1–6 answered, standing on step 7,
 * with the reading's own metadata (`needsReview` until the administrator
 * confirms the summary).
 */
export function seedStateFromDiscovery(discovered: DiscoveredAnswers, now: Date): SetupState {
  const a = discovered.answers;
  const discovery: DiscoveryMeta = {
    discovered: true,
    at: now.toISOString(),
    sources: discovered.sources,
    ...(discovered.roleSets ? { roleSets: discovered.roleSets } : {}),
    evidence: discovered.evidence,
    needsReview: true,
  };
  return {
    step: 7,
    completedSteps: [1, 2, 3, 4, 5, 6],
    answers: {
      profileKey: a[1].profileKey,
      revenueLines: a[1].revenueLines,
      departments: a[2].departments,
      positions: a[2].positions,
      ...(a[2].holders ? { holders: a[2].holders } : {}),
      approvalRules: a[3].approvalRules,
      acceptedDocTypeKeys: a[4].acceptedDocTypeKeys,
      items: a[5].items,
      terminology: a[6].terminology,
    },
    discovery,
  };
}
