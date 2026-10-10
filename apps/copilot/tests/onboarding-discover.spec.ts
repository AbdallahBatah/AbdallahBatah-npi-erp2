// T-47a — automatic setup: what `discoverFromNpi` reads out of NPI, how the
// plan treats the discovered answers (an organization NPI already holds gets
// an empty diff), and how the setup service seeds a session from it.
import path from 'node:path';

process.env.COPILOT_CATALOG_DIR = path.join(__dirname, '..', 'catalog');

import { loadProfilePack } from '../src/onboarding/catalog';
import {
  discoveryBlockers,
  discoverFromNpi,
  guessProfile,
  seedStateFromDiscovery,
  PROFILE_WEIGHTS,
  type DiscoveredAnswers,
} from '../src/onboarding/discover';
import {
  applyAnswer,
  StepAnswerSchema,
  toAnswers,
  type SetupState,
  type StepAnswer,
} from '../src/onboarding/machine';
import { buildPlan, type NpiSnapshot, type SetupAnswers } from '../src/onboarding/plan';
import { PROFILE_KEYS, type ProfilePack } from '../src/onboarding/profile.schema';
import { buildSummary } from '../src/onboarding/summary';
import {
  getSetupState,
  handleSetupAction,
  reopenSetupAtStep,
  type OnboardingSessionRow,
  type SetupCaller,
  type SetupDeps,
} from '../src/onboarding/service';
import { applyPlan, loadNpiSnapshot, type OnboardingNpi } from '../src/onboarding/apply';
import { t } from '../src/i18n/ar';
import { PERMISSION_CATALOG } from '../../../packages/shared/src/permissions';

const ALL_PERMISSION_KEYS: string[] = PERMISSION_CATALOG.map((p) => p.key as string);

// ─── Fixtures: three organizations as NPI reports them ─────────────────────

const ADMIN_CALLER = { roleKey: 'admin', permissions: ALL_PERMISSION_KEYS };

function rolesOf(pack: ProfilePack): NpiSnapshot['roles'] {
  return Object.entries(pack.rolePermissionSets).map(([key, set], i) => ({
    id: `role_${i}_${key}`,
    key,
    nameAr: set.nameAr,
    permissions: [...set.permissions],
  }));
}

function dept(code: string, nameAr: string, isActive = true) {
  return { id: `dept_${code}`, code, nameAr, isActive };
}

function user(id: string, roleKey: string, departmentCode: string | null, isActive = true) {
  return { id, nameAr: `مستخدم ${id}`, roleKey, isActive, departmentId: departmentCode ? `dept_${departmentCode}` : null };
}

function item(sku: string, itemCategory: string) {
  return { id: `item_${sku}`, sku, nameAr: `صنف ${sku}`, itemCategory };
}

function rule(id: string, documentType: string, minAmount: number, maxAmount: number | null, stepRoleKeys: string[], isActive = true) {
  return { id, documentType, minAmount, maxAmount, isActive, stepRoleKeys, stepRoleIds: stepRoleKeys.map((k) => `role_${k}`) };
}

const PERMISSION_META = PERMISSION_CATALOG.map((p) => ({ key: p.key as string, groupAr: 'مجموعة', labelAr: `تسمية ${p.key as string}` }));

/** An EPC: the epc pack's five roles held by real users, its departments, solar
 *  equipment in the item list, projects under way, two approval rules. */
function epcOrg(): { snapshot: NpiSnapshot; counts: { projects: number; customers: number; vendors: number } } {
  const epc = loadProfilePack('epc');
  return {
    snapshot: {
      permissions: PERMISSION_META,
      roles: rolesOf(epc),
      departments: [
        dept('SALES', 'المبيعات'),
        dept('PROJ', 'المشاريع'),
        dept('PROC', 'المشتريات'),
        dept('FIN', 'المالية'),
        dept('SITE', 'الموقع'),
        dept('OLD', 'قسم قديم', false),
      ],
      users: [
        user('u_admin', 'admin', null),
        user('u_sales', 'sales', 'SALES'),
        user('u_pm1', 'pm', 'PROJ'),
        user('u_pm2', 'pm', 'PROJ'),
        user('u_pm3_gone', 'pm', 'PROJ', false),
        user('u_acc', 'accountant', 'FIN'),
        user('u_site', 'site_engineer', 'SITE'),
      ],
      approvalRules: [
        rule('r1', 'PURCHASE_REQUISITION', 10000, null, ['pm']),
        rule('r2', 'PURCHASE_ORDER', 100000, null, ['pm', 'accountant']),
        rule('r3', 'PURCHASE_ORDER', 0, 100000, ['accountant'], false), // inactive: not carried over
      ],
      items: [item('MOD-550', 'MODULE'), item('INV-50', 'INVERTER'), item('MNT-1', 'MOUNTING'), item('CBL-4', 'CABLE')],
    },
    counts: { projects: 7, customers: 12, vendors: 5 },
  };
}

/** A trader: sales, a warehouse keeper and an accountant; no projects at all;
 *  many vendors; BOS next to modules and inverters. */
function tradingOrg(): { snapshot: NpiSnapshot; counts: { projects: number; customers: number; vendors: number } } {
  const trading = loadProfilePack('equipment_trading');
  return {
    snapshot: {
      permissions: PERMISSION_META,
      roles: rolesOf(trading),
      departments: [dept('SALES', 'المبيعات'), dept('WH', 'المستودع'), dept('FIN', 'المالية')],
      users: [
        user('u_admin', 'admin', null),
        user('u_sales', 'sales', 'SALES'),
        user('u_wh', 'warehouse_keeper', 'WH'),
        user('u_acc', 'accountant', 'FIN'),
      ],
      approvalRules: [rule('r1', 'PURCHASE_ORDER', 30000, null, ['accountant'])],
      items: [item('MOD-1', 'MODULE'), item('INV-1', 'INVERTER'), item('CBL-1', 'CABLE'), item('BOS-1', 'BOS')],
    },
    counts: { projects: 0, customers: 30, vendors: 14 },
  };
}

/** A brand-new organization: the admin role, the admin user, nothing else. */
function emptyOrg(): { snapshot: NpiSnapshot; counts: { projects: number; customers: number; vendors: number } } {
  const epc = loadProfilePack('epc');
  return {
    snapshot: {
      permissions: PERMISSION_META,
      roles: rolesOf(epc)!.filter((r) => r.key === 'admin'),
      departments: [],
      users: [user('u_admin', 'admin', null)],
      approvalRules: [],
      items: [],
    },
    counts: { projects: 0, customers: 0, vendors: 0 },
  };
}

function discover(org: { snapshot: NpiSnapshot; counts: { projects: number; customers: number; vendors: number } }): DiscoveredAnswers {
  return discoverFromNpi(org.snapshot, { counts: org.counts });
}

const STEPS = ['1', '2', '3', '4', '5', '6'] as const;

// ─── Step 1: the profile guess ──────────────────────────────────────────────

describe('discoverFromNpi — step 1 (profile guess)', () => {
  it('reads an EPC from its roles, solar items and projects, with a clear lead', () => {
    const d = discover(epcOrg());
    expect(d.answers[1].profileKey).toBe('epc');
    expect(d.evidence.profileKey).toBe('epc');
    expect(d.sources['1']).toBe('heuristic');
    // epc and general_contracting share roles and modules; the solar item
    // categories and the projects are what set EPC ahead of everything else.
    expect(['high', 'medium']).toContain(d.evidence.confidence);
    expect(d.evidence.scores.epc).toBeGreaterThan(d.evidence.scores.general_contracting);
    expect(d.evidence.scores.epc).toBeGreaterThan(d.evidence.scores.equipment_trading);
    expect(Object.keys(d.evidence.scores).sort()).toEqual([...PROFILE_KEYS].sort());
    expect(d.evidence.reasonsAr.length).toBeGreaterThanOrEqual(2);
    expect(d.evidence.reasonsAr.join(' ')).toContain('7'); // the project count
  });

  it('reads an equipment trader from a warehouse keeper, no projects and BOS items', () => {
    const d = discover(tradingOrg());
    expect(d.answers[1].profileKey).toBe('equipment_trading');
    expect(['high', 'medium']).toContain(d.evidence.confidence);
    expect(d.evidence.scores.equipment_trading).toBeGreaterThan(d.evidence.scores.epc);
  });

  it('answers an empty organization with EPC and low confidence, saying the evidence is thin', () => {
    const d = discover(emptyOrg());
    expect(d.answers[1].profileKey).toBe('epc');
    expect(d.evidence.confidence).toBe('low');
    expect(d.evidence.reasonsAr).toContain(t('setup.discover.reason.little_evidence'));
    expect(Object.values(d.evidence.scores).every((s) => s === 0)).toBe(true);
  });

  it('breaks a tie towards EPC and says so', () => {
    const { snapshot } = emptyOrg();
    const guess = guessProfile(snapshot, { projects: null, customers: null, vendors: null });
    expect(guess.profileKey).toBe('epc');
    expect(guess.reasonsAr).toContain(t('setup.discover.reason.tie'));
  });

  it('uses the weight table: projects count for packs that show the module and against those that do not', () => {
    const base = epcOrg();
    const withProjects = guessProfile(base.snapshot, { projects: 3, customers: null, vendors: null });
    const without = guessProfile(base.snapshot, { projects: 0, customers: null, vendors: null });
    expect(withProjects.scores.epc - without.scores.epc).toBe(PROFILE_WEIGHTS.projectsPresent);
    expect(withProjects.scores.om_provider - without.scores.om_provider).toBe(PROFILE_WEIGHTS.projectsAbsent);
  });
});

// ─── Steps 2–6 ──────────────────────────────────────────────────────────────

describe('discoverFromNpi — steps 2 to 6', () => {
  it('step 2: NPI’s active departments, one position per (role, department) with an active user, those users as holders', () => {
    const d = discover(epcOrg());
    const step2 = d.answers[2];
    expect(step2.departments.map((x) => x.code).sort()).toEqual(['FIN', 'PROC', 'PROJ', 'SALES', 'SITE']); // OLD is inactive
    expect(step2.departments.find((x) => x.code === 'PROJ')!.nameAr).toBe('المشاريع');

    const keys = step2.positions.map((p) => `${p.roleKey}/${p.departmentCode}`).sort();
    expect(keys).toEqual(['accountant/FIN', 'admin/null', 'pm/PROJ', 'sales/SALES', 'site_engineer/SITE']);
    const pm = step2.positions.find((p) => p.roleKey === 'pm')!;
    expect(pm.titleAr).toBe(`${loadProfilePack('epc').rolePermissionSets.pm.nameAr} — المشاريع`);
    expect(pm.personaAr.length).toBeGreaterThanOrEqual(80);
    expect(step2.positions.find((p) => p.roleKey === 'admin')!.titleAr).toBe(loadProfilePack('epc').rolePermissionSets.admin.nameAr);

    const holders = Object.fromEntries((step2.holders ?? []).map((h) => [`${h.roleKey}/${h.departmentCode}`, h.npiUserIds]));
    expect(holders['pm/PROJ']).toEqual(['u_pm1', 'u_pm2']); // the inactive pm is not a holder
    expect(holders['admin/null']).toEqual(['u_admin']);
    expect(d.sources['2']).toBe('npi');
  });

  it('step 2: a role nobody active holds gets no position; a user whose role NPI gave no permissions is reported, not guessed', () => {
    const org = epcOrg();
    org.snapshot.users!.push(user('u_ghost', 'ghost_role', 'SALES'));
    org.snapshot.roles!.push({ id: 'role_ghost', key: 'ghost_role', nameAr: 'دور فارغ', permissions: [] });
    const d = discover(org);
    expect(d.answers[2].positions.some((p) => p.roleKey === 'ghost_role')).toBe(false);
    expect(d.evidence.skippedAr.join(' ')).toContain('ghost_role');
  });

  it('step 2: a department code the schema refuses is left out and named', () => {
    const org = epcOrg();
    org.snapshot.departments!.push(dept('bad code', 'قسم برمز مرفوض'));
    const d = discover(org);
    expect(d.answers[2].departments.some((x) => x.code === 'bad code')).toBe(false);
    expect(d.evidence.skippedAr.some((line) => line.includes('قسم برمز مرفوض'))).toBe(true);
  });

  it('step 2: a user without a department sits in a department-less position', () => {
    const org = epcOrg();
    org.snapshot.users!.push(user('u_pm_nodept', 'pm', null));
    const d = discover(org);
    const dl = d.answers[2].positions.find((p) => p.roleKey === 'pm' && p.departmentCode === null);
    expect(dl).toBeDefined();
    expect(d.answers[2].holders!.find((h) => h.roleKey === 'pm' && h.departmentCode === null)!.npiUserIds).toEqual(['u_pm_nodept']);
  });

  it('step 3: the active rules NPI already holds, as they are; inactive ones are not carried over', () => {
    const d = discover(epcOrg());
    expect(d.sources['3']).toBe('npi');
    expect(d.answers[3].approvalRules).toEqual([
      { docType: 'PURCHASE_REQUISITION', minAmount: 10000, steps: ['pm'] },
      { docType: 'PURCHASE_ORDER', minAmount: 100000, steps: ['pm', 'accountant'] },
    ]);
    expect(d.evidence.skippedAr.some((line) => line.includes('1'))).toBe(true); // one inactive rule noted
  });

  it('step 3: bounded bands keep their ceiling', () => {
    const org = epcOrg();
    org.snapshot.approvalRules = [rule('r1', 'PURCHASE_ORDER', 0, 50000, ['accountant']), rule('r2', 'PURCHASE_ORDER', 50000, null, ['pm', 'accountant'])];
    const d = discover(org);
    expect(d.answers[3].approvalRules).toEqual([
      { docType: 'PURCHASE_ORDER', minAmount: 0, maxAmount: 50000, steps: ['accountant'] },
      { docType: 'PURCHASE_ORDER', minAmount: 50000, steps: ['pm', 'accountant'] },
    ]);
  });

  it('step 3: a rule through a role that cannot approve that document is left out and reported', () => {
    const org = epcOrg();
    org.snapshot.approvalRules = [rule('r1', 'PURCHASE_ORDER', 100000, null, ['sales'])]; // sales lacks scm.procurement.write
    const d = discover(org);
    expect(d.answers[3].approvalRules).toEqual(loadProfilePack('epc').approvalRuleDefaults);
    expect(d.sources['3']).toBe('pack-default');
    expect(d.evidence.skippedAr.length).toBeGreaterThan(0);
  });

  it('step 3: an organization with no rules gets the pack defaults, labelled pack-default', () => {
    const org = tradingOrg();
    org.snapshot.approvalRules = [];
    const d = discover(org);
    expect(d.sources['3']).toBe('pack-default');
    expect(d.answers[3].approvalRules).toEqual(loadProfilePack('equipment_trading').approvalRuleDefaults);
  });

  it('step 4: document types are derived from what the roles can run', () => {
    const d = discover(epcOrg());
    const epc = loadProfilePack('epc');
    expect(d.sources['4']).toBe('npi');
    // The epc roles together hold the contract and the procurement permissions.
    expect(d.answers[4].acceptedDocTypeKeys.sort()).toEqual(epc.acceptedDocTypes.map((x) => x.key).sort());

    // Remove the contract permission from every role: the contract doc type goes.
    const org = epcOrg();
    for (const role of org.snapshot.roles!) role.permissions = role.permissions.filter((p) => p !== 'commercial.contract.write');
    const without = discover(org);
    expect(without.answers[4].acceptedDocTypeKeys).not.toContain('epc_contract');
    expect(without.answers[4].acceptedDocTypeKeys).toContain('vendor_bill');
  });

  it('steps 5 and 6: no items are proposed, the terminology is the pack’s', () => {
    for (const org of [epcOrg(), tradingOrg(), emptyOrg()]) {
      const d = discover(org);
      const pack = loadProfilePack(d.answers[1].profileKey);
      expect(d.answers[5].items).toEqual([]);
      expect(d.sources['5']).toBe('npi');
      expect(d.answers[6].terminology).toEqual(pack.terminology);
      expect(d.sources['6']).toBe('pack-default');
      expect(d.answers[1].revenueLines).toEqual(pack.revenueLines);
    }
  });

  it('an empty organization falls back to the pack for steps 2 to 4, and says so', () => {
    const d = discover(emptyOrg());
    const epc = loadProfilePack('epc');
    expect(d.roleSets).toBeUndefined();
    expect(d.sources).toEqual({ '1': 'heuristic', '2': 'pack-default', '3': 'pack-default', '4': 'pack-default', '5': 'npi', '6': 'pack-default' });
    expect(d.answers[2].departments).toEqual(epc.defaultDepartments);
    expect(d.answers[2].positions).toEqual(epc.positions);
    expect(d.evidence.skippedAr).toContain(t('setup.discover.skipped.fallback'));
  });

  it('every answer parses against StepAnswerSchema and is accepted by applyAnswer, unchanged', () => {
    for (const org of [epcOrg(), tradingOrg(), emptyOrg()]) {
      const d = discover(org);
      const state = seedStateFromDiscovery(d, new Date('2026-10-10T08:00:00.000Z'));
      for (const key of STEPS) {
        const answer = d.answers[Number(key) as 1 | 2 | 3 | 4 | 5 | 6] as StepAnswer;
        expect(StepAnswerSchema.safeParse(answer).success).toBe(true);
        expect(() => applyAnswer(state, answer.step, answer)).not.toThrow();
      }
    }
  });

  it('discoveryBlockers names the NPI read permission that is missing', () => {
    const { snapshot } = epcOrg();
    expect(discoveryBlockers(snapshot)).toEqual([]);
    expect(discoveryBlockers({ ...snapshot, departments: null, users: null })).toEqual(['admin.department.manage']);
    expect(discoveryBlockers({ ...snapshot, roles: null })).toEqual(['admin.user.manage']);
  });
});

// ─── The plan for discovered answers ────────────────────────────────────────

function planFor(org: ReturnType<typeof epcOrg>, d: DiscoveredAnswers) {
  const state = seedStateFromDiscovery(d, new Date('2026-10-10T08:00:00.000Z'));
  const answers = toAnswers(state);
  return buildPlan(loadProfilePack(answers.profileKey), answers, org.snapshot, ADMIN_CALLER);
}

describe('buildPlan — discovered answers', () => {
  it('an organization NPI already holds gets an empty diff: no create, no update, no blocked', () => {
    for (const org of [epcOrg(), tradingOrg()]) {
      const plan = planFor(org, discover(org));
      expect(plan.counts.create).toBe(0);
      expect(plan.counts.update).toBe(0);
      expect(plan.counts.blocked).toBe(0);
      expect(plan.steps.filter((s) => s.action !== 'skip')).toEqual([]);
      // Items are never proposed.
      expect(plan.steps.some((s) => s.kind === 'item')).toBe(false);
    }
  });

  it('does not touch a role whose permissions differ from the pack’s (the same org, answered with pack defaults, would)', () => {
    const org = epcOrg();
    const sales = org.snapshot.roles!.find((r) => r.key === 'sales')!;
    sales.permissions = sales.permissions.filter((p) => p !== 'crm.lead.write'); // drift from the pack
    const discoveredPlan = planFor(org, discover(org));
    expect(discoveredPlan.counts.update).toBe(0);
    expect(discoveredPlan.steps.find((s) => s.id === 'role:sales')!.action).toBe('skip');

    const epc = loadProfilePack('epc');
    const manualPlan = buildPlan(epc, { profileKey: 'epc' }, org.snapshot, ADMIN_CALLER);
    expect(manualPlan.steps.find((s) => s.id === 'role:sales')!.action).toBe('update');
  });

  it('leaves a rule that moved in NPI since it was read as it is, instead of putting it back', () => {
    const org = epcOrg();
    const d = discover(org);
    org.snapshot.approvalRules = org.snapshot.approvalRules!.map((r) => (r.id === 'r2' ? { ...r, stepRoleKeys: ['accountant'], stepRoleIds: ['role_accountant'] } : r));
    const plan = planFor(org, d);
    expect(plan.counts.update).toBe(0);
    expect(plan.steps.find((s) => s.id === 'approval_rule:PURCHASE_ORDER:100000')!.action).toBe('skip');
  });

  it('a pack-default rule for an organization with none is created, and only that', () => {
    const org = tradingOrg();
    org.snapshot.approvalRules = [];
    const plan = planFor(org, discover(org));
    expect(plan.steps.filter((s) => s.action !== 'skip').map((s) => `${s.action}:${s.id}`)).toEqual(['create:approval_rule:PURCHASE_ORDER:30000']);
  });

  it('pack defaults keep today’s behaviour: an empty organization gets departments, roles, rules and items created', () => {
    const org = emptyOrg();
    const plan = planFor(org, discover(org));
    expect(plan.counts.create).toBeGreaterThan(0);
    expect(plan.steps.some((s) => s.kind === 'department' && s.action === 'create')).toBe(true);
    expect(plan.steps.some((s) => s.kind === 'role' && s.action === 'create')).toBe(true);
  });

  it('a manual edit of one step is written like any manual answer', () => {
    const org = epcOrg();
    const d = discover(org);
    let state = seedStateFromDiscovery(d, new Date('2026-10-10T08:00:00.000Z'));
    state = applyAnswer(state, 2, {
      step: 2,
      departments: [...d.answers[2].departments, { code: 'LEGAL', nameAr: 'الشؤون القانونية' }],
      positions: d.answers[2].positions,
      holders: d.answers[2].holders,
    });
    expect(state.discovery!.sources['2']).toBe('manual');
    expect(state.discovery!.sources['3']).toBe('npi');
    const answers = toAnswers(state);
    const plan = buildPlan(loadProfilePack('epc'), answers, org.snapshot, ADMIN_CALLER);
    expect(plan.steps.filter((s) => s.action !== 'skip').map((s) => s.id)).toEqual(['department:LEGAL']);
  });

  it('changing the profile drops the discovery and turns the session into the manual wizard', () => {
    const d = discover(epcOrg());
    const state = seedStateFromDiscovery(d, new Date('2026-10-10T08:00:00.000Z'));
    const next = applyAnswer(state, 1, { step: 1, profileKey: 'om_provider' });
    expect(next.discovery).toBeUndefined();
    expect(next.manual).toBe(true);
    expect(next.completedSteps).toEqual([1]);
    expect(next.answers.departments).toBeUndefined();
  });
});

// ─── The service: seeding, the summary, the fallback, the apply record ─────

type Org = ReturnType<typeof epcOrg>;

/** An NPI that answers with the organization's data in NPI's wire shapes and
 *  refuses a read the caller's permissions do not cover. */
class OrgNpi {
  calls: string[] = [];
  created: string[] = [];
  constructor(
    private readonly org: Org,
    public permissions: string[] = ALL_PERMISSION_KEYS,
  ) {}
  private read<T>(call: string, permission: string, value: T): T {
    this.calls.push(call);
    if (!this.permissions.includes(permission)) {
      const { mapNpiError } = jest.requireActual('../src/npi/errors') as typeof import('../src/npi/errors');
      throw mapNpiError(403, { statusCode: 403, message: 'Forbidden resource' });
    }
    return value;
  }
  async listPermissions() { return this.read('listPermissions', 'admin.user.manage', PERMISSION_META); }
  async listRoles() {
    return this.read('listRoles', 'admin.user.manage', this.org.snapshot.roles!.map((r) => ({ ...r, nameEn: r.nameAr })));
  }
  async listDepartments() { return this.read('listDepartments', 'admin.department.manage', this.org.snapshot.departments); }
  async listDepartmentDirectory() {
    return this.read(
      'listDepartmentDirectory',
      'admin.department.manage',
      this.org.snapshot.users!.map((u) => ({ id: u.id, nameAr: u.nameAr, isActive: u.isActive, departmentId: u.departmentId, role: { key: u.roleKey } })),
    );
  }
  async listApprovalRules() {
    return this.read(
      'listApprovalRules',
      'admin.approval.manage',
      this.org.snapshot.approvalRules!.map((r) => ({
        id: r.id,
        documentType: r.documentType,
        minAmount: String(r.minAmount),
        maxAmount: r.maxAmount === null ? null : String(r.maxAmount),
        isActive: r.isActive,
        steps: r.stepRoleKeys.map((k, i) => ({ sequence: i + 1, roleId: `role_${k}`, role: { key: k } })),
      })),
    );
  }
  async listItems() { return this.read('listItems', 'commercial.item.read', this.org.snapshot.items); }
  async listProjects() { return this.read('listProjects', 'projects.project.read', new Array(this.org.counts.projects).fill({})); }
  async listCustomers() { return this.read('listCustomers', 'crm.customer.read', new Array(this.org.counts.customers).fill({})); }
  async listVendors() { return this.read('listVendors', 'scm.procurement.read', new Array(this.org.counts.vendors).fill({})); }
  async createDepartment(): Promise<never> { this.created.push('department'); throw new Error('discovery must not write'); }
  async createRole(): Promise<never> { this.created.push('role'); throw new Error('discovery must not write'); }
  async updateRole(): Promise<never> { this.created.push('updateRole'); throw new Error('discovery must not write'); }
  async createApprovalRule(): Promise<never> { this.created.push('rule'); throw new Error('discovery must not write'); }
  async updateApprovalRule(): Promise<never> { this.created.push('updateRule'); throw new Error('discovery must not write'); }
  async createItem(): Promise<never> { this.created.push('item'); throw new Error('discovery must not write'); }
}

function fakeDb() {
  const sessions: OnboardingSessionRow[] = [];
  const firmConfigs = new Map<string, Record<string, unknown>>();
  const positions: { id: string; npiOrgId: string; roleKey: string; departmentId: string | null; titleAr: string; personaAr: string }[] = [];
  const assignments: { id: string; positionId: string; npiUserId: string; endedAt: Date | null }[] = [];
  let seq = 0;
  const db = {
    onboardingSession: {
      async findFirst({ where }: { where: { npiOrgId: string; completedAt: null | { not: null } } }) {
        const mine = sessions.filter((s) => s.npiOrgId === where.npiOrgId);
        if (where.completedAt === null) return mine.find((s) => s.completedAt === null) ?? null;
        return mine.filter((s) => s.completedAt !== null).sort((a, b) => b.completedAt!.getTime() - a.completedAt!.getTime())[0] ?? null;
      },
      async create({ data }: { data: { npiOrgId: string; npiUserId: string; stepsJson: unknown } }) {
        const row: OnboardingSessionRow = { id: `sess_${++seq}`, ...data, completedAt: null, profileChosen: null };
        sessions.push(row);
        return row;
      },
      async update({ where, data }: { where: { id: string }; data: Partial<OnboardingSessionRow> }) {
        const row = sessions.find((s) => s.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
    },
    firmConfig: {
      async findUnique({ where }: { where: { npiOrgId: string } }) {
        const c = firmConfigs.get(where.npiOrgId);
        return c ? { profileKey: (c.profileKey as string | null) ?? null, visibleModulesJson: c.visibleModulesJson } : null;
      },
      async upsert({ where, create, update }: { where: { npiOrgId: string }; create: Record<string, unknown>; update: Record<string, unknown> }) {
        const c = firmConfigs.get(where.npiOrgId);
        firmConfigs.set(where.npiOrgId, c ? { ...c, ...update } : { ...create });
        return null;
      },
    },
    position: {
      async findFirst({ where }: { where: { npiOrgId: string; roleKey: string; departmentId: string | null } }) {
        return positions.find((p) => p.npiOrgId === where.npiOrgId && p.roleKey === where.roleKey && p.departmentId === where.departmentId) ?? null;
      },
      async create({ data }: { data: Omit<(typeof positions)[number], 'id'> }) {
        const row = { id: `pos_${++seq}`, ...data };
        positions.push(row);
        return { id: row.id };
      },
      async update({ where, data }: { where: { id: string }; data: { titleAr: string; personaAr: string } }) {
        Object.assign(positions.find((p) => p.id === where.id)!, data);
        return null;
      },
    },
    positionAssignment: {
      async findFirst({ where }: { where: { positionId: string; npiUserId: string; endedAt: null } }) {
        return assignments.find((a) => a.positionId === where.positionId && a.npiUserId === where.npiUserId && a.endedAt === null) ?? null;
      },
      async create({ data }: { data: { positionId: string; npiUserId: string } }) {
        assignments.push({ id: `pa_${++seq}`, ...data, endedAt: null });
        return null;
      },
      async updateMany() { return null; },
    },
  };
  return { db, sessions, firmConfigs, positions, assignments };
}

const ADMIN_SETUP_CALLER: SetupCaller = { npiOrgId: 'org1', npiUserId: 'u_admin', roleKey: 'admin', permissions: ALL_PERMISSION_KEYS };
const NOW = new Date('2026-10-10T08:00:00.000Z');

function serviceDeps(org: Org, permissions: string[] = ALL_PERMISSION_KEYS) {
  const fake = fakeDb();
  const npi = new OrgNpi(org, permissions);
  const deps = { db: fake.db as unknown as SetupDeps['db'], npi: npi as unknown as SetupDeps['npi'], now: () => NOW } as SetupDeps;
  return { deps, fake, npi };
}

describe('getSetupState — seeds a discovered session', () => {
  it('reads NPI with the caller’s permissions, seeds all six answers and returns the summary view', async () => {
    const { deps, fake, npi } = serviceDeps(epcOrg());
    const view = await getSetupState(deps, ADMIN_SETUP_CALLER);

    expect(fake.sessions).toHaveLength(1);
    expect(view.state.step).toBe(7);
    expect(view.state.completedSteps).toEqual([1, 2, 3, 4, 5, 6]);
    expect(view.state.discovery!.discovered).toBe(true);
    expect(view.state.discovery!.needsReview).toBe(true);
    expect(view.state.answers.profileKey).toBe('epc');
    expect(view.state.answers.holders!.length).toBeGreaterThan(0);
    expect(view.discoveryNoteAr).toBeNull();

    expect(view.summary).not.toBeNull();
    expect(view.summary!.profile.key).toBe('epc');
    expect(view.summary!.profile.source).toBe('heuristic');
    expect(view.summary!.profile.reasonsAr.length).toBeGreaterThan(0);
    expect(view.summary!.cards.map((c) => c.step)).toEqual([2, 3, 4, 5, 6]);
    expect(view.summary!.cards.find((c) => c.step === 3)!.lines.join(' ')).toContain('أمر شراء');

    // The seeded state is what the session row stores.
    expect(fake.sessions[0].stepsJson).toEqual(view.state);
    // Only reads: nothing was written to NPI.
    expect(npi.created).toEqual([]);

    // A second GET does not read NPI again.
    const callsBefore = npi.calls.length;
    const again = await getSetupState(deps, ADMIN_SETUP_CALLER);
    expect(again.state).toEqual(view.state);
    expect(npi.calls.length).toBe(callsBefore);
  });

  it('falls back to the manual wizard and names the missing permission when the department screens are closed to the caller', async () => {
    const limited = ALL_PERMISSION_KEYS.filter((p) => p !== 'admin.department.manage');
    const { deps, fake, npi } = serviceDeps(epcOrg(), limited);
    const caller: SetupCaller = { ...ADMIN_SETUP_CALLER, permissions: limited };
    const view = await getSetupState(deps, caller);

    expect(view.state.step).toBe(1);
    expect(view.state.manual).toBe(true);
    expect(view.state.discoveryMissing).toEqual(['admin.department.manage']);
    expect(view.summary).toBeNull();
    expect(view.discoveryNoteAr).toContain(t('setup.discover.unavailable'));
    expect(view.discoveryNoteAr).toContain('admin.department.manage');
    expect(fake.sessions[0].stepsJson).toMatchObject({ manual: true, discoveryMissing: ['admin.department.manage'] });

    // Not retried on the next read.
    const callsBefore = npi.calls.length;
    await getSetupState(deps, caller);
    expect(npi.calls.length).toBe(callsBefore);
  });

  it('the «manual» action drops the discovered answers for today’s step-by-step wizard', async () => {
    const { deps } = serviceDeps(epcOrg());
    const seeded = await getSetupState(deps, ADMIN_SETUP_CALLER);
    expect(seeded.summary).not.toBeNull();
    const manual = await handleSetupAction(deps, ADMIN_SETUP_CALLER, { action: 'manual' });
    expect('state' in manual && manual.state).toEqual({ step: 1, answers: {}, completedSteps: [], manual: true });
    const next = await getSetupState(deps, ADMIN_SETUP_CALLER);
    expect(next.state.step).toBe(1);
    expect(next.summary).toBeNull();
  });

  it('«غيّر» on a card jumps to that step, and saving it returns to the summary with that step marked as the administrator’s', async () => {
    const { deps } = serviceDeps(epcOrg());
    const seeded = await getSetupState(deps, ADMIN_SETUP_CALLER);
    const at3 = await handleSetupAction(deps, ADMIN_SETUP_CALLER, { action: 'goto', step: 3 });
    expect('state' in at3 && at3.state.step).toBe(3);
    expect('summary' in at3 && at3.summary).toBeNull();

    const rules = seeded.state.answers.approvalRules!.slice(0, 1);
    const saved = await handleSetupAction(deps, ADMIN_SETUP_CALLER, { action: 'answer', step: 3, answer: { step: 3, approvalRules: rules } });
    expect('state' in saved && saved.state.step).toBe(7);
    expect('summary' in saved && saved.summary).not.toBeNull();
    expect('state' in saved && saved.state.discovery!.sources['3']).toBe('manual');
  });

  it('preview of a discovered session is an empty diff against the same NPI', async () => {
    const { deps } = serviceDeps(epcOrg());
    await getSetupState(deps, ADMIN_SETUP_CALLER);
    const preview = await handleSetupAction(deps, ADMIN_SETUP_CALLER, { action: 'preview' });
    expect('plan' in preview).toBe(true);
    if (!('plan' in preview)) return;
    expect(preview.plan.counts).toEqual({ create: 0, update: 0, skip: preview.plan.steps.length, blocked: 0 });
    expect(preview.summary.npi).toEqual([]);
    expect(preview.summary.blocked).toEqual([]);
    expect(preview.summary.copilot.join(' ')).toContain('المناصب');
  });

  it('apply writes nothing to NPI, stores the positions and holders, and records setupSource = discovered', async () => {
    const { deps, fake, npi } = serviceDeps(epcOrg());
    await getSetupState(deps, ADMIN_SETUP_CALLER);
    const applied = await handleSetupAction(deps, ADMIN_SETUP_CALLER, { action: 'apply' });
    expect('result' in applied && applied.result.completed).toBe(true);
    expect(npi.created).toEqual([]);

    expect(fake.positions.map((p) => `${p.roleKey}`).sort()).toEqual(['accountant', 'admin', 'pm', 'sales', 'site_engineer']);
    expect(fake.assignments.map((a) => a.npiUserId).sort()).toEqual(['u_acc', 'u_admin', 'u_pm1', 'u_pm2', 'u_sales', 'u_site']);

    const config = fake.firmConfigs.get('org1')!;
    expect(config.setupSource).toBe('discovered');
    expect(config.profileKey).toBe('epc');
    expect(config.discoveryJson).toMatchObject({
      sources: { '1': 'heuristic', '2': 'npi', '3': 'npi', '4': 'npi', '5': 'npi', '6': 'pack-default' },
      evidence: { profileKey: 'epc' },
    });
    expect(fake.sessions[0].completedAt).not.toBeNull();
  });

  it('a manual setup is recorded as manual', async () => {
    const { deps, fake } = serviceDeps(epcOrg());
    await handleSetupAction(deps, ADMIN_SETUP_CALLER, { action: 'manual' });
    await handleSetupAction(deps, ADMIN_SETUP_CALLER, { action: 'answer', step: 1, answer: { step: 1, profileKey: 'epc' } });
    // The organization already holds the pack's departments only partly; apply
    // would create the rest, which this fake NPI refuses — the record is what counts.
    await handleSetupAction(deps, ADMIN_SETUP_CALLER, { action: 'apply' }).catch(() => undefined);
    const config = fake.firmConfigs.get('org1');
    if (config) expect(config.setupSource).toBe('manual');
  });

  it('a re-run of one step from /settings keeps the discovered roles and goes straight to the diff', async () => {
    const { deps, fake } = serviceDeps(epcOrg());
    await getSetupState(deps, ADMIN_SETUP_CALLER);
    await handleSetupAction(deps, ADMIN_SETUP_CALLER, { action: 'apply' });
    expect(fake.sessions[0].completedAt).not.toBeNull();

    const outcome = await reopenSetupAtStep(deps, ADMIN_SETUP_CALLER, 4);
    expect(outcome).toBe('cloned');
    const reopened = await getSetupState(deps, ADMIN_SETUP_CALLER);
    expect(reopened.state.step).toBe(4);
    expect(reopened.state.discovery!.needsReview).toBe(false);
    expect(reopened.summary).toBeNull();
    expect(reopened.state.discovery!.roleSets).toBeDefined();

    const saved = await handleSetupAction(deps, ADMIN_SETUP_CALLER, {
      action: 'answer',
      step: 4,
      answer: { step: 4, acceptedDocTypeKeys: reopened.state.answers.acceptedDocTypeKeys! },
    });
    expect('state' in saved && saved.state.step).toBe(7);
    expect('summary' in saved && saved.summary).toBeNull(); // no summary on a step re-run
  });
});

describe('summary', () => {
  it('is null unless the session is discovered, unreviewed and on step 7', () => {
    const state = seedStateFromDiscovery(discover(epcOrg()), NOW);
    const pack = loadProfilePack('epc');
    expect(buildSummary(state, pack)).not.toBeNull();
    expect(buildSummary({ ...state, step: 3 }, pack)).toBeNull();
    expect(buildSummary({ ...state, discovery: { ...state.discovery!, needsReview: false } }, pack)).toBeNull();
    const { discovery: _discovery, ...manual } = state;
    expect(buildSummary(manual as SetupState, pack)).toBeNull();
  });
});

// An applyPlan with the discovered plan sends NPI nothing at all.
describe('applyPlan — discovered answers', () => {
  it('makes no NPI write call', async () => {
    const org = epcOrg();
    const npi = new OrgNpi(org);
    const snapshot = await loadNpiSnapshot(npi as unknown as OnboardingNpi, ADMIN_CALLER);
    const state = seedStateFromDiscovery(discover(org), NOW);
    const answers: SetupAnswers = toAnswers(state);
    const plan = buildPlan(loadProfilePack(answers.profileKey), answers, snapshot, ADMIN_CALLER);
    const result = await applyPlan({ npi: npi as unknown as OnboardingNpi }, plan);
    expect(result.completed).toBe(true);
    expect(npi.created).toEqual([]);
    expect(result.counts.created + result.counts.updated + result.counts.failed + result.counts.blocked).toBe(0);
  });
});
