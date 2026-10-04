import path from 'node:path';

process.env.COPILOT_CATALOG_DIR = path.join(__dirname, '..', 'catalog');

import { loadProfilePack } from '../src/onboarding/catalog';
import {
  applyPlan,
  dryRun,
  loadNpiSnapshot,
  persistCopilotConfig,
  validateHolders,
  type OnboardingDb,
  type OnboardingNpi,
} from '../src/onboarding/apply';
import { describeBlockedAr } from '../src/onboarding/gaps';
import { buildPlan, effectivePack, PlanError, summarizePlanAr, type SetupAnswers } from '../src/onboarding/plan';
import type { ProfilePack } from '../src/onboarding/profile.schema';
import { readApprovalRules, readRoles, type NpiDirectoryUser } from '../src/npi/admin';
import { mapNpiError, NpiError } from '../src/npi/errors';
// Same relative import `tests/catalog.spec.ts` uses: the file has no imports
// of its own, so ts-jest compiles it without extra project wiring.
import { PERMISSION_CATALOG } from '../../../packages/shared/src/permissions';

const ALL_PERMISSION_KEYS: string[] = PERMISSION_CATALOG.map((p) => p.key as string);

// ─── A fake NPI that enforces what NPI's admin services enforce ─────────────
//
// Every refusal below mirrors a guard in apps/api (file:line cited), and is
// thrown through `mapNpiError` so the copilot sees exactly the status/body
// shape NPI's GlobalExceptionFilter would send.

interface FakeRole { id: string; key: string; nameAr: string; nameEn: string; permissions: string[] }
interface FakeDept { id: string; code: string; nameAr: string; nameEn: string; isActive: boolean }
interface FakeUser { id: string; isActive: boolean; departmentId: string | null; roleKey: string }
interface FakeRule {
  id: string;
  documentType: string;
  minAmount: number;
  maxAmount: number | null;
  isActive: boolean;
  steps: { roleId: string }[];
}
interface FakeItem { id: string; sku: string; nameAr: string; nameEn: string; itemCategory: string; uom: string; isSerialised: boolean }

// packages/shared/src/approvals.ts — the permission each document's steps need.
const DOC_PERMISSION: Record<string, string> = {
  PURCHASE_REQUISITION: 'scm.procurement.write',
  PURCHASE_ORDER: 'scm.procurement.write',
  PROGRESS_CLAIM: 'scm.procurement.write',
  CHANGE_ORDER: 'projects.project.write',
};

const bad = (message: string) => mapNpiError(400, { statusCode: 400, message });
const forbidden = () => mapNpiError(403, { statusCode: 403, message: 'Forbidden resource' });

class FakeNpi implements OnboardingNpi {
  roles: FakeRole[] = [];
  departments: FakeDept[] = [];
  users: FakeUser[] = [];
  rules: FakeRule[] = [];
  items: FakeItem[] = [];
  calls: string[] = [];
  /** Permissions NPI's guards see for the caller. */
  callerPermissions: string[] = ALL_PERMISSION_KEYS;
  /** Test hook: throw this instead of performing the named call. */
  failOn: { call: string; error: unknown } | null = null;
  private seq = 0;

  private id(prefix: string) { return `${prefix}_${++this.seq}`; }

  private guard(call: string, permission: string) {
    this.calls.push(call);
    if (this.failOn && this.failOn.call === call) {
      const { error } = this.failOn;
      this.failOn = null;
      throw error;
    }
    if (!this.callerPermissions.includes(permission)) throw forbidden();
  }

  private roleRow(r: FakeRole) { return { ...r, _count: { users: this.users.filter((u) => u.roleKey === r.key).length } }; }

  // ── reads ──
  async listPermissions() { this.guard('listPermissions', 'admin.user.manage'); return PERMISSION_CATALOG; }
  async listRoles() { this.guard('listRoles', 'admin.user.manage'); return this.roles.map((r) => this.roleRow(r)); }
  async listDepartments() { this.guard('listDepartments', 'admin.department.manage'); return this.departments.map((d) => ({ ...d, manager: null, parent: null })); }
  async listDepartmentDirectory() {
    this.guard('listDepartmentDirectory', 'admin.department.manage');
    return this.users.map((u) => {
      const role = this.roles.find((r) => r.key === u.roleKey) ?? { id: `missing_${u.roleKey}`, key: u.roleKey, nameAr: u.roleKey, nameEn: u.roleKey };
      return { id: u.id, nameAr: 'م', nameEn: 'u', email: `${u.id}@x`, isActive: u.isActive, departmentId: u.departmentId, role: { id: role.id, key: role.key, nameAr: role.nameAr, nameEn: role.nameEn } };
    });
  }
  async listApprovalRules() {
    this.guard('listApprovalRules', 'admin.approval.manage');
    return this.rules.map((r) => ({
      ...r,
      // Prisma Decimal → string on the wire.
      minAmount: String(r.minAmount),
      maxAmount: r.maxAmount === null ? null : String(r.maxAmount),
      steps: r.steps.map((s, i) => {
        const role = this.roles.find((x) => x.id === s.roleId)!;
        return { sequence: i + 1, roleId: s.roleId, role: { id: role.id, key: role.key, nameAr: role.nameAr, nameEn: role.nameEn } };
      }),
    }));
  }
  async listItems() { this.guard('listItems', 'commercial.item.read'); return this.items.map((i) => ({ ...i, unitCost: '0' })); }

  // ── writes ──
  async createDepartment(dto: { code: string; nameAr: string; nameEn?: string }) {
    this.guard('createDepartment', 'admin.department.manage');
    // departments.service.ts create(): 'Department code already in use'
    if (this.departments.some((d) => d.code === dto.code.toUpperCase())) throw bad('Department code already in use');
    const row: FakeDept = { id: this.id('dept'), code: dto.code.toUpperCase(), nameAr: dto.nameAr, nameEn: dto.nameEn ?? dto.nameAr, isActive: true };
    this.departments.push(row);
    return row;
  }
  async createRole(dto: { key: string; nameAr: string; nameEn?: string; permissions: string[] }) {
    this.guard('createRole', 'admin.user.manage');
    // admin.service.ts createRole(): 'Role key already in use' / validatePermissions()
    if (this.roles.some((r) => r.key === dto.key)) throw bad('Role key already in use');
    const unknown = dto.permissions.filter((p) => !ALL_PERMISSION_KEYS.includes(p));
    if (unknown.length) throw bad(`Unknown permission key: ${unknown.join(', ')}`);
    if (dto.permissions.length === 0) throw bad('permissions should not be empty');
    const row: FakeRole = { id: this.id('role'), key: dto.key, nameAr: dto.nameAr, nameEn: dto.nameEn ?? dto.nameAr, permissions: [...new Set(dto.permissions)] };
    this.roles.push(row);
    return this.roleRow(row);
  }
  async updateRole(id: string, dto: { permissions?: string[] }) {
    this.guard('updateRole', 'admin.user.manage');
    const role = this.roles.find((r) => r.id === id);
    if (!role) throw mapNpiError(404, { statusCode: 404, message: 'Role not found' });
    if (dto.permissions) {
      const unknown = dto.permissions.filter((p) => !ALL_PERMISSION_KEYS.includes(p));
      if (unknown.length) throw bad(`Unknown permission key: ${unknown.join(', ')}`);
      role.permissions = [...new Set(dto.permissions)];
    }
    return this.roleRow(role);
  }
  private validateRule(documentType: string, min: number, max: number | null, steps: { roleId: string }[], excludeId: string | null) {
    // approvals.service.ts validateBand()
    if (max !== null && max <= min) throw bad('maxAmount must be greater than minAmount');
    const clash = this.rules.find(
      (r) => r.documentType === documentType && r.isActive && r.id !== excludeId && (max === null || r.minAmount < max) && (r.maxAmount === null || min < r.maxAmount),
    );
    if (clash) throw bad(`This amount band overlaps an existing rule (${clash.minAmount} – ${clash.maxAmount === null ? '∞' : clash.maxAmount})`);
    // approvals.service.ts validateSteps()
    const ids = steps.map((s) => s.roleId);
    if (new Set(ids).size !== ids.length) throw bad('A role cannot appear twice in the same chain');
    for (const roleId of ids) {
      const role = this.roles.find((r) => r.id === roleId);
      if (!role) throw mapNpiError(404, { statusCode: 404, message: 'Role not found' });
      if (!role.permissions.includes(DOC_PERMISSION[documentType])) throw bad(`Role "${role.nameEn}" cannot approve this document type — it lacks ${DOC_PERMISSION[documentType]}`);
      if (!this.users.some((u) => u.isActive && u.roleKey === role.key)) throw bad(`Role "${role.nameEn}" has no active users — a chain that reaches it would never move`);
    }
  }
  async createApprovalRule(dto: { documentType: string; minAmount: number; maxAmount?: number | null; steps: { roleId: string }[] }) {
    this.guard('createApprovalRule', 'admin.approval.manage');
    const max = dto.maxAmount ?? null;
    this.validateRule(dto.documentType, dto.minAmount, max, dto.steps, null);
    const row: FakeRule = { id: this.id('rule'), documentType: dto.documentType, minAmount: dto.minAmount, maxAmount: max, isActive: true, steps: dto.steps.map((s) => ({ roleId: s.roleId })) };
    this.rules.push(row);
    return row;
  }
  async updateApprovalRule(id: string, dto: { minAmount?: number; maxAmount?: number | null; isActive?: boolean; steps?: { roleId: string }[] }) {
    this.guard('updateApprovalRule', 'admin.approval.manage');
    const rule = this.rules.find((r) => r.id === id);
    if (!rule) throw mapNpiError(404, { statusCode: 404, message: 'Approval rule not found' });
    const min = dto.minAmount ?? rule.minAmount;
    const max = dto.maxAmount === undefined ? rule.maxAmount : dto.maxAmount;
    const active = dto.isActive ?? rule.isActive;
    if (active) this.validateRule(rule.documentType, min, max, dto.steps ?? rule.steps, rule.id);
    Object.assign(rule, { minAmount: min, maxAmount: max, isActive: active, steps: dto.steps ? dto.steps.map((s) => ({ roleId: s.roleId })) : rule.steps });
    return rule;
  }
  async createItem(dto: { sku: string; nameAr: string; nameEn: string; itemCategory: string; uom?: string; isSerialised?: boolean }) {
    this.guard('createItem', 'commercial.item.write');
    // @@unique([organizationId, sku]) → P2002 → GlobalExceptionFilter 409 DUPLICATE
    if (this.items.some((i) => i.sku === dto.sku)) throw mapNpiError(409, { statusCode: 409, message: 'A record with the same unique value already exists', code: 'DUPLICATE' });
    const row: FakeItem = { id: this.id('item'), sku: dto.sku, nameAr: dto.nameAr, nameEn: dto.nameEn, itemCategory: dto.itemCategory, uom: dto.uom ?? 'unit', isSerialised: dto.isSerialised ?? false };
    this.items.push(row);
    return row;
  }

  // ── fixtures ──
  addRole(key: string, nameAr: string, permissions: string[]) {
    const row: FakeRole = { id: this.id('role'), key, nameAr, nameEn: key, permissions: [...permissions] };
    this.roles.push(row);
    return row;
  }
  addUser(roleKey: string, isActive = true) {
    const row: FakeUser = { id: this.id('user'), isActive, departmentId: null, roleKey };
    this.users.push(row);
    return row;
  }
  writeCalls() { return this.calls.filter((c) => /^(create|update)/.test(c)); }
}

const pack = (): ProfilePack => loadProfilePack('epc');
const adminCaller = { roleKey: 'admin', permissions: ALL_PERMISSION_KEYS };
const answersOnly = (profileKey: SetupAnswers['profileKey'] = 'epc'): SetupAnswers => ({ profileKey });

/** NPI as the seed leaves it for a fresh demo org: an admin role with every
 *  permission, one active admin user, nothing else. */
function freshOrg(): FakeNpi {
  const npi = new FakeNpi();
  npi.addRole('admin', 'مدير النظام', ALL_PERMISSION_KEYS);
  npi.addUser('admin');
  return npi;
}

/** An org already configured exactly as the epc pack says. */
function seededLikePack(): FakeNpi {
  const npi = new FakeNpi();
  const p = pack();
  for (const [key, set] of Object.entries(p.rolePermissionSets)) {
    npi.addRole(key, set.nameAr, set.permissions);
    npi.addUser(key);
  }
  for (const d of p.defaultDepartments) {
    npi.departments.push({ id: `dept_${d.code}`, code: d.code, nameAr: d.nameAr, nameEn: d.nameEn ?? d.nameAr, isActive: true });
  }
  for (const r of p.approvalRuleDefaults) {
    npi.rules.push({
      id: `rule_${r.docType}`,
      documentType: r.docType,
      minAmount: r.minAmount,
      maxAmount: r.maxAmount ?? null,
      isActive: true,
      steps: r.steps.map((key) => ({ roleId: npi.roles.find((x) => x.key === key)!.id })),
    });
  }
  for (const i of p.itemTemplates) {
    npi.items.push({ id: `item_${i.sku}`, sku: i.sku, nameAr: i.nameAr, nameEn: i.nameEn, itemCategory: i.itemCategory, uom: i.uom ?? 'unit', isSerialised: i.isSerialised ?? false });
  }
  return npi;
}

const byId = (plan: { steps: { id: string }[] }, id: string) => {
  const step = plan.steps.find((s) => s.id === id);
  if (!step) throw new Error(`no step ${id}`);
  return step as never as import('../src/onboarding/plan').PlanStep;
};

// ─── Readers ────────────────────────────────────────────────────────────────

describe('npi/admin readers', () => {
  it('readApprovalRules parses Decimal strings and ordered steps', () => {
    const rules = readApprovalRules([
      { id: 'r1', documentType: 'PURCHASE_ORDER', minAmount: '100000', maxAmount: null, isActive: true, steps: [{ sequence: 1, roleId: 'a', role: { key: 'pm' } }, { sequence: 2, roleId: 'b', role: { key: 'accountant' } }] },
      { id: 'r2', documentType: 'PURCHASE_ORDER', minAmount: 5000.5, maxAmount: '9999.99', isActive: false, steps: [] },
    ]);
    expect(rules).toEqual([
      { id: 'r1', documentType: 'PURCHASE_ORDER', minAmount: 100000, maxAmount: null, isActive: true, stepRoleKeys: ['pm', 'accountant'], stepRoleIds: ['a', 'b'] },
      { id: 'r2', documentType: 'PURCHASE_ORDER', minAmount: 5000.5, maxAmount: 9999.99, isActive: false, stepRoleKeys: [], stepRoleIds: [] },
    ]);
  });

  it('readApprovalRules refuses a non-numeric amount instead of producing NaN', () => {
    expect(() => readApprovalRules([{ id: 'r', documentType: 'PURCHASE_ORDER', minAmount: 'abc', maxAmount: null, isActive: true, steps: [] }])).toThrow(NpiError);
  });

  it('readRoles requires a string[] permissions column', () => {
    expect(() => readRoles([{ id: 'r', key: 'pm', nameAr: 'م', permissions: 'scm.procurement.write' }])).toThrow(NpiError);
    expect(readRoles([{ id: 'r', key: 'pm', nameAr: 'م', nameEn: 'PM', permissions: ['a'], _count: { users: 2 } }])).toEqual([{ id: 'r', key: 'pm', nameAr: 'م', permissions: ['a'] }]);
  });
});

// ─── effectivePack / answers ────────────────────────────────────────────────

describe('effectivePack — answers laid over the pack', () => {
  it('with no answers returns the pack unchanged', () => {
    expect(effectivePack(pack(), answersOnly())).toEqual(pack());
  });

  it('replaces thresholds, filters doc types, merges terminology', () => {
    const eff = effectivePack(pack(), {
      profileKey: 'epc',
      approvalRules: [{ docType: 'PURCHASE_ORDER', minAmount: 50000, steps: ['pm'] }],
      acceptedDocTypeKeys: ['epc_contract', 'vendor_bill'],
      terminology: { vendor: 'المورّد المعتمد' },
    });
    expect(eff.approvalRuleDefaults).toEqual([{ docType: 'PURCHASE_ORDER', minAmount: 50000, steps: ['pm'] }]);
    expect(eff.acceptedDocTypes.map((d) => d.key)).toEqual(['epc_contract', 'vendor_bill']);
    expect(eff.terminology).toEqual({ contract: 'عقد EPC', purchase_order: 'أمر الشراء', vendor: 'المورّد المعتمد' });
  });

  it('rejects answers that break the pack invariants, naming the field', () => {
    // Removing SITE while a position still points at it.
    const departments = pack().defaultDepartments.filter((d) => d.code !== 'SITE');
    try {
      effectivePack(pack(), { profileKey: 'epc', departments });
      throw new Error('expected PlanError');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanError);
      const issues = (err as PlanError).issues;
      expect(issues.some((i) => i.path.startsWith('positions.') && i.message.includes('"SITE"'))).toBe(true);
    }
  });

  it('rejects a threshold chain through a role that cannot approve that document', () => {
    expect(() => effectivePack(pack(), { profileKey: 'epc', approvalRules: [{ docType: 'CHANGE_ORDER', minAmount: 1000, steps: ['accountant'] }] })).toThrow(PlanError);
  });

  it('rejects unknown doc type keys and a mismatched profileKey', () => {
    expect(() => effectivePack(pack(), { profileKey: 'epc', acceptedDocTypeKeys: ['nope'] })).toThrow(/unknown keys: nope/);
    expect(() => effectivePack(pack(), answersOnly('om_provider'))).toThrow(PlanError);
  });
});

// ─── Plan on a fresh organization ───────────────────────────────────────────

describe('buildPlan / dryRun — fresh organization', () => {
  it('creates departments, roles and items; keeps the admin role; blocks rules until roles have users', async () => {
    const npi = freshOrg();
    const plan = await dryRun({ npi }, pack(), answersOnly(), adminCaller);

    expect(plan.steps.map((s) => s.kind)).toEqual([
      ...Array(5).fill('department'),
      ...Array(5).fill('role'),
      ...Array(3).fill('approval_rule'),
      ...Array(4).fill('item'),
    ]);
    expect(plan.steps.filter((s) => s.kind === 'department').every((s) => s.action === 'create')).toBe(true);
    expect(byId(plan, 'role:admin').action).toBe('skip');
    for (const key of ['sales', 'pm', 'accountant', 'site_engineer']) expect(byId(plan, `role:${key}`).action).toBe('create');
    expect(plan.steps.filter((s) => s.kind === 'item').every((s) => s.action === 'create')).toBe(true);

    const pr = byId(plan, 'approval_rule:PURCHASE_REQUISITION:10000');
    expect(pr.action).toBe('blocked');
    expect(pr.blocked).toEqual({ code: 'role_without_active_user', roleKey: 'pm', roleNameAr: 'مدير المشاريع' });
    expect(describeBlockedAr(pr.blocked!)).toContain('«مدير المشاريع» ليس له مستخدم نشط في NPI');

    expect(plan.counts).toEqual({ create: 13, update: 0, skip: 1, blocked: 3 });
    expect(plan.gaps).toEqual([]);
    expect(npi.writeCalls()).toEqual([]);
  });

  it('applies in order, then a second dry-run is all skip (idempotent)', async () => {
    const npi = freshOrg();
    const plan = await dryRun({ npi }, pack(), answersOnly(), adminCaller);
    const result = await applyPlan({ npi }, plan);

    expect(result.counts).toEqual({ created: 13, updated: 0, skipped: 1, blocked: 3, failed: 0 });
    expect(result.completed).toBe(true);
    expect(npi.writeCalls()).toEqual([
      ...Array(5).fill('createDepartment'),
      ...Array(4).fill('createRole'),
      ...Array(4).fill('createItem'),
    ]);
    expect(npi.departments.map((d) => d.code)).toEqual(['SALES', 'PROJ', 'PROC', 'FIN', 'SITE']);
    expect(npi.roles.find((r) => r.key === 'pm')!.permissions).toEqual(pack().rolePermissionSets.pm.permissions);
    expect(npi.items.find((i) => i.sku === 'MOD-600')).toMatchObject({ itemCategory: 'MODULE', isSerialised: true, uom: 'unit' });
    expect(Object.keys(result.departmentIdByCode).sort()).toEqual(['FIN', 'PROC', 'PROJ', 'SALES', 'SITE']);
    expect(Object.keys(result.roleIdByKey).sort()).toEqual(['accountant', 'admin', 'pm', 'sales', 'site_engineer']);

    npi.calls = [];
    const again = await dryRun({ npi }, pack(), answersOnly(), adminCaller);
    expect(again.counts).toEqual({ create: 0, update: 0, skip: 14, blocked: 3 });
    const applied = await applyPlan({ npi }, again);
    expect(npi.writeCalls()).toEqual([]);
    expect(applied.counts.skipped).toBe(14);

    // Once the administrator assigns users to the roles in NPI, the rules go through.
    npi.addUser('pm');
    npi.addUser('accountant');
    const third = await dryRun({ npi }, pack(), answersOnly(), adminCaller);
    expect(third.counts).toEqual({ create: 3, update: 0, skip: 14, blocked: 0 });
    const r3 = await applyPlan({ npi }, third);
    expect(r3.counts.created).toBe(3);
    expect(npi.rules.map((r) => [r.documentType, r.minAmount, r.steps.length])).toEqual([
      ['PURCHASE_REQUISITION', 10000, 1],
      ['PURCHASE_ORDER', 100000, 2],
      ['PROGRESS_CLAIM', 250000, 2],
    ]);
    const fourth = await dryRun({ npi }, pack(), answersOnly(), adminCaller);
    expect(fourth.counts).toEqual({ create: 0, update: 0, skip: 17, blocked: 0 });
  });
});

// ─── Plan on an already-configured organization ─────────────────────────────

describe('buildPlan — organization already matching the pack', () => {
  it('is all skip and apply makes no write call', async () => {
    const npi = seededLikePack();
    const plan = await dryRun({ npi }, pack(), answersOnly(), adminCaller);
    expect(plan.counts).toEqual({ create: 0, update: 0, skip: 17, blocked: 0 });
    const result = await applyPlan({ npi }, plan);
    expect(result.counts.skipped).toBe(17);
    expect(npi.writeCalls()).toEqual([]);
    expect(result.steps.every((s) => s.npiId !== null)).toBe(true);
  });

  it('updates a role whose permission set drifted, and reports exactly what changes', async () => {
    const npi = seededLikePack();
    const pm = npi.roles.find((r) => r.key === 'pm')!;
    pm.permissions = pm.permissions.filter((p) => p !== 'projects.project.write').concat('finance.payment.read');

    const plan = await dryRun({ npi }, pack(), answersOnly(), adminCaller);
    const step = byId(plan, 'role:pm');
    expect(step.action).toBe('update');
    expect(step.kind === 'role' && step.permissionsAdded).toEqual(['projects.project.write']);
    expect(step.kind === 'role' && step.permissionsRemoved).toEqual(['finance.payment.read']);
    expect(plan.counts).toEqual({ create: 0, update: 1, skip: 16, blocked: 0 });

    const result = await applyPlan({ npi }, plan);
    expect(npi.writeCalls()).toEqual(['updateRole']);
    expect(result.steps.find((s) => s.stepId === 'role:pm')).toMatchObject({ outcome: 'updated', npiId: pm.id });
    expect(new Set(pm.permissions)).toEqual(new Set(pack().rolePermissionSets.pm.permissions));

    const again = await dryRun({ npi }, pack(), answersOnly(), adminCaller);
    expect(again.counts.update).toBe(0);
  });

  it("never removes a permission from the caller's own role", async () => {
    const npi = seededLikePack();
    // The setup is run by a project manager who happens to hold every permission.
    const pm = npi.roles.find((r) => r.key === 'pm')!;
    pm.permissions = [...ALL_PERMISSION_KEYS];
    const plan = await dryRun({ npi }, pack(), answersOnly(), { roleKey: 'pm', permissions: ALL_PERMISSION_KEYS });
    const step = byId(plan, 'role:pm');
    expect(step.action).toBe('skip');
    expect(step.notesAr).toContain('هذا دورك أنت؛ شاشة الإعداد تضيف إليه ولا تسحب منه.');
  });

  it('updates an approval rule whose chain differs, and reactivates an inactive identical one', async () => {
    const npi = seededLikePack();
    const po = npi.rules.find((r) => r.documentType === 'PURCHASE_ORDER')!;
    po.steps = [{ roleId: npi.roles.find((r) => r.key === 'accountant')!.id }];
    const claim = npi.rules.find((r) => r.documentType === 'PROGRESS_CLAIM')!;
    claim.isActive = false;

    const plan = await dryRun({ npi }, pack(), answersOnly(), adminCaller);
    const poStep = byId(plan, 'approval_rule:PURCHASE_ORDER:100000');
    expect(poStep).toMatchObject({ action: 'update', existingId: po.id, existingStepRoleKeys: ['accountant'], reactivate: false });
    const claimStep = byId(plan, 'approval_rule:PROGRESS_CLAIM:250000');
    expect(claimStep).toMatchObject({ action: 'update', reactivate: true });

    await applyPlan({ npi }, plan);
    expect(npi.writeCalls()).toEqual(['updateApprovalRule', 'updateApprovalRule']);
    expect(po.steps.map((s) => npi.roles.find((r) => r.id === s.roleId)!.key)).toEqual(['pm', 'accountant']);
    expect(claim.isActive).toBe(true);
    expect((await dryRun({ npi }, pack(), answersOnly(), adminCaller)).counts.update).toBe(0);
  });

  it('moves the threshold of the open-ended band instead of creating an overlapping one', async () => {
    const npi = seededLikePack();
    const pr = npi.rules.find((r) => r.documentType === 'PURCHASE_REQUISITION')!;
    const answers: SetupAnswers = { profileKey: 'epc', approvalRules: [{ docType: 'PURCHASE_REQUISITION', minAmount: 5000, steps: ['pm'] }] };
    const plan = await dryRun({ npi }, pack(), answers, adminCaller);
    const step = byId(plan, 'approval_rule:PURCHASE_REQUISITION:5000');
    expect(step).toMatchObject({ action: 'update', existingId: pr.id, existingMinAmount: 10000, minAmount: 5000, maxAmount: null });
    expect(summarizePlanAr(plan, pack()).npi).toEqual(['تحديث قاعدة اعتماد: طلب شراء من 5000 فأكثر (كان من 10000 فأكثر) ← مدير المشاريع']);

    const result = await applyPlan({ npi }, plan);
    expect(npi.writeCalls()).toEqual(['updateApprovalRule']);
    expect(result.steps.find((s) => s.stepId === step.id)).toMatchObject({ outcome: 'updated', npiId: pr.id });
    expect(pr.minAmount).toBe(5000);
    expect(npi.rules.filter((r) => r.documentType === 'PURCHASE_REQUISITION')).toHaveLength(1);
    expect((await dryRun({ npi }, pack(), answers, adminCaller)).counts).toMatchObject({ create: 0, update: 0, blocked: 0 });
  });

  it('runs a threshold move before a new band that only fits after it', async () => {
    const npi = seededLikePack();
    const po = npi.rules.find((r) => r.documentType === 'PURCHASE_ORDER')!;
    const answers: SetupAnswers = {
      profileKey: 'epc',
      approvalRules: [
        { docType: 'PURCHASE_ORDER', minAmount: 50000, maxAmount: 150000, steps: ['pm'] },
        { docType: 'PURCHASE_ORDER', minAmount: 150000, steps: ['pm', 'accountant'] },
      ],
    };
    const plan = await dryRun({ npi }, pack(), answers, adminCaller);
    const ruleSteps = plan.steps.filter((s) => s.kind === 'approval_rule');
    expect(ruleSteps.map((s) => [s.id, s.action])).toEqual([
      ['approval_rule:PURCHASE_ORDER:150000', 'update'],
      ['approval_rule:PURCHASE_ORDER:50000', 'create'],
    ]);
    const result = await applyPlan({ npi }, plan); // the fake validates bands exactly as NPI does
    expect(result.counts).toMatchObject({ updated: 1, created: 1, failed: 0, blocked: 0 });
    expect(npi.writeCalls()).toEqual(['updateApprovalRule', 'createApprovalRule']);
    expect(po.minAmount).toBe(150000);
    expect(npi.rules.find((r) => r.minAmount === 50000)).toMatchObject({ maxAmount: 150000 });
  });

  it('blocks a bounded band that overlaps an existing active rule, quoting the band', async () => {
    const npi = seededLikePack();
    const answers: SetupAnswers = { profileKey: 'epc', approvalRules: [{ docType: 'PURCHASE_ORDER', minAmount: 50000, maxAmount: 120000, steps: ['pm'] }] };
    const plan = await dryRun({ npi }, pack(), answers, adminCaller);
    const step = byId(plan, 'approval_rule:PURCHASE_ORDER:50000');
    expect(step.action).toBe('blocked');
    expect(step.blocked).toEqual({ code: 'band_overlap', min: 100000, max: null });
    expect(describeBlockedAr(step.blocked!)).toBe('نطاق المبلغ يتداخل مع قاعدة قائمة في NPI (من 100000 فأكثر).');
    const result = await applyPlan({ npi }, plan);
    expect(npi.writeCalls()).toEqual([]);
    expect(result.steps.find((s) => s.stepId === step.id)!.outcome).toBe('blocked');
  });

  it('creates a non-overlapping band below the existing one', async () => {
    const npi = seededLikePack();
    const answers: SetupAnswers = {
      profileKey: 'epc',
      approvalRules: [
        { docType: 'PURCHASE_ORDER', minAmount: 20000, maxAmount: 100000, steps: ['pm'] },
        { docType: 'PURCHASE_ORDER', minAmount: 100000, steps: ['pm', 'accountant'] },
      ],
    };
    const plan = await dryRun({ npi }, pack(), answers, adminCaller);
    expect(byId(plan, 'approval_rule:PURCHASE_ORDER:20000').action).toBe('create');
    expect(byId(plan, 'approval_rule:PURCHASE_ORDER:100000').action).toBe('skip');
    const result = await applyPlan({ npi }, plan);
    expect(result.counts.created).toBe(1);
    expect(npi.rules.find((r) => r.minAmount === 20000)).toMatchObject({ maxAmount: 100000 });
  });

  it('notes, but does not change, an item that exists under another category', async () => {
    const npi = seededLikePack();
    npi.items.find((i) => i.sku === 'MOD-600')!.itemCategory = 'BOS';
    const plan = await dryRun({ npi }, pack(), answersOnly(), adminCaller);
    const step = byId(plan, 'item:MOD-600');
    expect(step.action).toBe('skip');
    expect(step.notesAr).toEqual(['الصنف موجود في NPI بتصنيف مختلف (BOS)؛ لم يُغيَّر.']);
  });
});

// ─── Gaps ───────────────────────────────────────────────────────────────────

describe('gaps — a permission NPI does not serve', () => {
  it('is listed and left out of the role sent to NPI, which then accepts it', async () => {
    const npi = freshOrg();
    const p = pack();
    const custom: ProfilePack = {
      ...p,
      rolePermissionSets: {
        ...p.rolePermissionSets,
        pm: { ...p.rolePermissionSets.pm, permissions: [...p.rolePermissionSets.pm.permissions, 'projects.cost.approve'] },
      },
    };
    const plan = await dryRun({ npi }, custom, answersOnly(), adminCaller);
    expect(plan.gaps).toEqual([{ kind: 'permission_unknown', roleKey: 'pm', permission: 'projects.cost.approve' }]);
    const step = byId(plan, 'role:pm');
    expect(step.kind === 'role' && step.permissions).not.toContain('projects.cost.approve');

    const result = await applyPlan({ npi }, plan);
    expect(result.steps.find((s) => s.stepId === 'role:pm')!.outcome).toBe('created');
    expect(result.gaps).toEqual(plan.gaps);
    const summary = summarizePlanAr(plan, custom);
    expect(summary.gaps).toEqual(['الصلاحية «projects.cost.approve» المطلوبة للدور «مدير المشاريع» لا تتيحها واجهة NPI حالياً، فلن تُمنح.']);
  });
});

// ─── Caller permissions and unreadable slots ────────────────────────────────

describe('caller permissions', () => {
  it('blocks the steps whose write permission the caller lacks, naming NPI’s Arabic label', async () => {
    const npi = freshOrg();
    const permissions = ALL_PERMISSION_KEYS.filter((p) => p !== 'admin.approval.manage');
    npi.callerPermissions = permissions;
    const plan = await dryRun({ npi }, pack(), answersOnly(), { roleKey: 'admin', permissions });
    const labelAr = PERMISSION_CATALOG.find((p) => p.key === 'admin.approval.manage')!.labelAr;
    for (const step of plan.steps.filter((s) => s.kind === 'approval_rule')) {
      expect(step.blocked).toEqual({ code: 'missing_permission', permission: 'admin.approval.manage' });
      expect(describeBlockedAr(step.blocked!, plan.permissionLabel)).toBe(`تحتاج صلاحية «${labelAr}» في NPI لتنفيذ هذه الخطوة.`);
    }
    expect(npi.calls).not.toContain('listApprovalRules');
    expect(plan.steps.filter((s) => s.kind !== 'approval_rule').every((s) => s.action !== 'blocked')).toBe(true);
  });

  it('blocks items when the caller can write but not read them (state unreadable)', async () => {
    const npi = freshOrg();
    const permissions = ALL_PERMISSION_KEYS.filter((p) => p !== 'commercial.item.read');
    npi.callerPermissions = permissions;
    const plan = await dryRun({ npi }, pack(), answersOnly(), { roleKey: 'admin', permissions });
    for (const step of plan.steps.filter((s) => s.kind === 'item')) {
      expect(step.blocked).toEqual({ code: 'npi_state_unreadable', permission: 'commercial.item.read' });
    }
  });

  it('treats a 403 from NPI on a read as unreadable even when the token claims the permission', async () => {
    const npi = freshOrg();
    npi.callerPermissions = ALL_PERMISSION_KEYS.filter((p) => p !== 'admin.department.manage');
    const snapshot = await loadNpiSnapshot(npi, adminCaller);
    expect(snapshot.departments).toBeNull();
    expect(snapshot.users).toBeNull();
    expect(snapshot.roles).not.toBeNull();
    const plan = buildPlan(pack(), answersOnly(), snapshot, adminCaller);
    expect(plan.steps.filter((s) => s.kind === 'department').every((s) => s.blocked?.code === 'npi_state_unreadable')).toBe(true);
    // Without the directory the active-user check cannot run; the rule is
    // planned with a warning rather than blocked on a guess.
    const pr = byId(plan, 'approval_rule:PURCHASE_REQUISITION:10000');
    expect(pr.action).toBe('create');
    expect(pr.notesAr[0]).toContain('لم يُتحقق من وجود مستخدمين نشطين');
  });

  it('rethrows a read failure that is not a 403', async () => {
    const npi = freshOrg();
    npi.failOn = { call: 'listRoles', error: mapNpiError(500, { statusCode: 500, message: 'Internal server error' }) };
    await expect(loadNpiSnapshot(npi, adminCaller)).rejects.toMatchObject({ kind: 'server' });
  });
});

// ─── Failures during apply ──────────────────────────────────────────────────

describe('applyPlan — failures', () => {
  it('records NPI’s refusal verbatim, blocks dependents, continues, and converges on re-run', async () => {
    const npi = freshOrg();
    // Users already sit on the pm/accountant roles (as a directory would show
    // for an org whose roles were deleted and are being recreated), so the
    // rules are not blocked for lack of users and the dependency path shows.
    npi.addUser('pm');
    npi.addUser('accountant');
    npi.failOn = { call: 'createRole', error: mapNpiError(500, { statusCode: 500, message: 'Internal server error' }) };

    const snapshot = await loadNpiSnapshot(npi, adminCaller);
    // The directory lists users of roles that do not exist yet in NPI — the
    // fake tolerates that; the plan only cares that the role will have users.
    const plan = buildPlan(pack(), answersOnly(), snapshot, adminCaller);
    const result = await applyPlan({ npi }, plan);

    const sales = result.steps.find((s) => s.stepId === 'role:sales')!; // first createRole call → fails
    expect(sales).toMatchObject({ outcome: 'failed', npiMessage: 'Internal server error', reasonAr: 'تعذر إتمام الطلب في NPI حالياً.' });
    expect(result.steps.find((s) => s.stepId === 'role:pm')!.outcome).toBe('created');
    expect(result.steps.find((s) => s.stepId === 'approval_rule:PURCHASE_REQUISITION:10000')!.outcome).toBe('created');
    expect(result.steps.filter((s) => s.kind === 'item').every((s) => s.outcome === 'created')).toBe(true);
    expect(result.completed).toBe(false);

    const again = await dryRun({ npi }, pack(), answersOnly(), adminCaller);
    expect(again.counts.create).toBe(1);
    expect(byId(again, 'role:sales').action).toBe('create');
    const r2 = await applyPlan({ npi }, again);
    expect(r2.completed).toBe(true);
  });

  it('blocks a rule at apply time when its role failed to be created', async () => {
    const npi = freshOrg();
    npi.failOn = { call: 'createRole', error: mapNpiError(500, { statusCode: 500, message: 'Internal server error' }) };
    const p = pack();
    // A plan where the first created role is the one the rule needs, and the
    // directory check is skipped (no admin.department.manage → users null).
    const perms = ALL_PERMISSION_KEYS.filter((x) => x !== 'admin.department.manage');
    npi.callerPermissions = perms;
    const custom: ProfilePack = { ...p, rolePermissionSets: { admin: p.rolePermissionSets.admin, pm: p.rolePermissionSets.pm }, approvalRuleDefaults: [{ docType: 'PURCHASE_REQUISITION', minAmount: 10000, steps: ['pm'] }], positions: p.positions.filter((x) => x.roleKey === 'admin' || x.roleKey === 'pm') };
    const plan = await dryRun({ npi }, custom, answersOnly(), { roleKey: 'admin', permissions: perms });
    expect(byId(plan, 'approval_rule:PURCHASE_REQUISITION:10000').action).toBe('create');
    const result = await applyPlan({ npi }, plan);
    expect(result.steps.find((s) => s.stepId === 'role:pm')!.outcome).toBe('failed');
    expect(result.steps.find((s) => s.stepId === 'approval_rule:PURCHASE_REQUISITION:10000')).toMatchObject({
      outcome: 'blocked',
      reasonAr: 'تعتمد هذه الخطوة على الدور «pm» الذي لم يُنشأ في NPI.',
    });
    expect(npi.calls).not.toContain('createApprovalRule');
  });

  it('stops calling NPI after a 401 and marks the remaining writes failed', async () => {
    const npi = freshOrg();
    npi.failOn = { call: 'createDepartment', error: mapNpiError(401, { statusCode: 401, message: 'Unauthorized' }) };
    const plan = await dryRun({ npi }, pack(), answersOnly(), adminCaller);
    const result = await applyPlan({ npi }, plan);
    expect(npi.writeCalls()).toEqual(['createDepartment']);
    const failed = result.steps.filter((s) => s.outcome === 'failed');
    expect(failed).toHaveLength(13);
    expect(failed.every((s) => s.reasonAr === 'انتهت جلستك في NPI. سجّل الدخول من جديد.')).toBe(true);
    expect(result.steps.find((s) => s.stepId === 'role:admin')!.outcome).toBe('skipped');
  });

  it('rethrows a non-NpiError (a bug, not an NPI answer)', async () => {
    const npi = freshOrg();
    npi.failOn = { call: 'createDepartment', error: new TypeError('boom') };
    const plan = await dryRun({ npi }, pack(), answersOnly(), adminCaller);
    await expect(applyPlan({ npi }, plan)).rejects.toThrow(TypeError);
  });
});

// ─── Copilot-side persistence ───────────────────────────────────────────────

interface FakePositionRow { id: string; npiOrgId: string; roleKey: string; departmentId: string | null; titleAr: string; personaAr: string }
interface FakeAssignmentRow { id: string; positionId: string; npiUserId: string; endedAt: Date | null }

function fakeDb() {
  const firmConfigs = new Map<string, Record<string, unknown>>();
  const positions: FakePositionRow[] = [];
  const assignments: FakeAssignmentRow[] = [];
  let seq = 0;
  const db: OnboardingDb = {
    firmConfig: {
      async upsert({ where, create, update }) {
        const existing = firmConfigs.get(where.npiOrgId);
        firmConfigs.set(where.npiOrgId, existing ? { ...existing, ...update } : { ...create });
        return null;
      },
    },
    position: {
      async findFirst({ where }) {
        return positions.find((p) => p.npiOrgId === where.npiOrgId && p.roleKey === where.roleKey && p.departmentId === where.departmentId) ?? null;
      },
      async create({ data }) {
        const row: FakePositionRow = { id: `pos_${++seq}`, ...data };
        positions.push(row);
        return { id: row.id };
      },
      async update({ where, data }) {
        Object.assign(positions.find((p) => p.id === where.id)!, data);
        return null;
      },
    },
    positionAssignment: {
      async findFirst({ where }) {
        return assignments.find((a) => a.positionId === where.positionId && a.npiUserId === where.npiUserId && a.endedAt === null) ?? null;
      },
      async create({ data }) {
        const row: FakeAssignmentRow = { id: `pa_${++seq}`, positionId: data.positionId, npiUserId: data.npiUserId, endedAt: null };
        assignments.push(row);
        return row;
      },
      async updateMany({ where, data }) {
        for (const a of assignments) {
          if (a.npiUserId !== where.npiUserId || a.endedAt !== null || a.positionId === where.positionId.not) continue;
          const position = positions.find((p) => p.id === a.positionId);
          if (!position || position.npiOrgId !== where.position.npiOrgId || position.roleKey !== where.position.roleKey) continue;
          a.endedAt = data.endedAt;
        }
        return null;
      },
    },
  };
  return { db, firmConfigs, positions, assignments };
}

describe('persistCopilotConfig', () => {
  const now = () => new Date('2026-10-04T10:00:00.000Z');

  it('writes firm_config and one position per (role, department), idempotently', async () => {
    const npi = freshOrg();
    const plan = await dryRun({ npi }, pack(), answersOnly(), adminCaller);
    const result = await applyPlan({ npi }, plan);
    const { db, firmConfigs, positions } = fakeDb();

    const out = await persistCopilotConfig(db, { npiOrgId: 'org1', plan, result, holders: [], now });
    expect(out).toEqual({ positionsWritten: 5, positionsSkipped: [], assignmentsWritten: 0, holdersSkipped: [] });

    const cfg = firmConfigs.get('org1')!;
    expect(cfg).toMatchObject({
      npiOrgId: 'org1',
      profileKey: 'epc',
      visibleModulesJson: ['crm', 'commercial', 'projects', 'procurement', 'finance'],
      terminologyJson: { contract: 'عقد EPC', purchase_order: 'أمر الشراء' },
      setupCompletedAt: now(),
    });
    expect((cfg.acceptedDocTypesJson as unknown[]).length).toBe(5);
    const gaps = cfg.npiApiGapsJson as { gaps: unknown[]; blocked: { stepId: string }[]; failed: unknown[]; appliedAt: string };
    expect(gaps.gaps).toEqual([]);
    expect(gaps.blocked.map((b) => b.stepId)).toEqual([
      'approval_rule:PURCHASE_REQUISITION:10000',
      'approval_rule:PURCHASE_ORDER:100000',
      'approval_rule:PROGRESS_CLAIM:250000',
    ]);
    expect(gaps.failed).toEqual([]);
    expect(gaps.appliedAt).toBe('2026-10-04T10:00:00.000Z');

    const admin = positions.find((p) => p.roleKey === 'admin')!;
    expect(admin.departmentId).toBeNull();
    const pm = positions.find((p) => p.roleKey === 'pm')!;
    expect(pm.departmentId).toBe(result.departmentIdByCode.PROJ);
    expect(pm.titleAr).toBe('مدير المشاريع');

    // Second run: same rows, updated in place — no duplicates.
    const again = await persistCopilotConfig(db, { npiOrgId: 'org1', plan, result, holders: [], now });
    expect(again.positionsWritten).toBe(5);
    expect(positions).toHaveLength(5);
  });

  it('does not stamp setupCompletedAt on an incomplete re-run, and skips positions whose department is missing', async () => {
    const npi = freshOrg();
    const okPlan = await dryRun({ npi }, pack(), answersOnly(), adminCaller);
    const okResult = await applyPlan({ npi }, okPlan);
    const { db, firmConfigs, positions } = fakeDb();
    await persistCopilotConfig(db, { npiOrgId: 'org1', plan: okPlan, result: okResult, holders: [], now });

    const npi2 = freshOrg();
    npi2.failOn = { call: 'createDepartment', error: mapNpiError(500, { statusCode: 500, message: 'Internal server error' }) };
    const plan2 = await dryRun({ npi: npi2 }, pack(), answersOnly(), adminCaller);
    const result2 = await applyPlan({ npi: npi2 }, plan2); // SALES fails, the rest is created
    expect(result2.completed).toBe(false);
    const later = () => new Date('2026-10-05T10:00:00.000Z');
    const out = await persistCopilotConfig(db, { npiOrgId: 'org1', plan: plan2, result: result2, holders: [], now: later });
    expect(out.positionsSkipped).toEqual([{ roleKey: 'sales', departmentCode: 'SALES' }]);
    expect(firmConfigs.get('org1')!.setupCompletedAt).toEqual(now()); // unchanged
    const failed = (firmConfigs.get('org1')!.npiApiGapsJson as { failed: { stepId: string; npiMessage: string }[] }).failed;
    expect(failed).toEqual([{ stepId: 'department:SALES', reasonAr: 'تعذر إتمام الطلب في NPI حالياً.', npiMessage: 'Internal server error' }]);
    // The second NPI handed out new department ids, so (role, department)
    // pairs are new positions — but no sales position was added for the
    // department that does not exist, and no pair was written twice.
    expect(positions.filter((p) => p.roleKey === 'sales')).toHaveLength(1);
    const keys = positions.map((p) => `${p.roleKey}/${p.departmentId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  // ─── T-18: position holders ────────────────────────────────────────────

  it('writes one open assignment per (position, user) from holders, idempotently', async () => {
    const npi = freshOrg();
    const plan = await dryRun({ npi }, pack(), answersOnly(), adminCaller);
    const result = await applyPlan({ npi }, plan);
    const { db, assignments } = fakeDb();

    const holders = [{ roleKey: 'pm', departmentCode: 'PROJ', npiUserIds: ['u1', 'u2'] }];
    const out = await persistCopilotConfig(db, { npiOrgId: 'org1', plan, result, holders, now });
    expect(out.assignmentsWritten).toBe(2);
    expect(out.holdersSkipped).toEqual([]);
    expect(assignments).toHaveLength(2);
    expect(assignments.every((a) => a.endedAt === null)).toBe(true);

    // Re-run with the same holders: no new rows, nothing to end.
    const again = await persistCopilotConfig(db, { npiOrgId: 'org1', plan, result, holders, now });
    expect(again.assignmentsWritten).toBe(0);
    expect(assignments).toHaveLength(2);
  });

  it('ends a stale role-only assignment of the same role once the setup assigns a department position, leaving a different role untouched', async () => {
    const npi = freshOrg();
    const plan = await dryRun({ npi }, pack(), answersOnly(), adminCaller);
    const result = await applyPlan({ npi }, plan);
    const { db, positions, assignments } = fakeDb();

    // A role-only 'pm' position already exists, as `resolvePosition` would
    // have created at login, with an open assignment for 'u1'.
    const roleOnlyPm = await db.position.create({
      data: { npiOrgId: 'org1', roleKey: 'pm', departmentId: null, titleAr: 'مدير المشاريع', personaAr: 'x'.repeat(80) },
    });
    await db.positionAssignment.create({ data: { positionId: roleOnlyPm.id, npiUserId: 'u1' } });
    // An unrelated assignment of a different role for the same user.
    const accountantPosition = await db.position.create({
      data: { npiOrgId: 'org1', roleKey: 'accountant', departmentId: null, titleAr: 'محاسب', personaAr: 'y'.repeat(80) },
    });
    await db.positionAssignment.create({ data: { positionId: accountantPosition.id, npiUserId: 'u1' } });

    const holders = [{ roleKey: 'pm', departmentCode: 'PROJ', npiUserIds: ['u1'] }];
    await persistCopilotConfig(db, { npiOrgId: 'org1', plan, result, holders, now });

    const deptPm = positions.find((p) => p.roleKey === 'pm' && p.departmentId === result.departmentIdByCode.PROJ)!;
    expect(assignments.find((a) => a.positionId === deptPm.id && a.npiUserId === 'u1')?.endedAt).toBeNull();
    expect(assignments.find((a) => a.positionId === roleOnlyPm.id)?.endedAt).toEqual(now());
    expect(assignments.find((a) => a.positionId === accountantPosition.id)?.endedAt).toBeNull();
  });

  it('reports a holder whose position was not created this run as position_missing', async () => {
    const npi = freshOrg();
    npi.failOn = { call: 'createDepartment', error: mapNpiError(500, { statusCode: 500, message: 'Internal server error' }) };
    const plan = await dryRun({ npi }, pack(), answersOnly(), adminCaller);
    const result = await applyPlan({ npi }, plan); // SALES department fails to be created
    const { db } = fakeDb();

    const holders = [{ roleKey: 'sales', departmentCode: 'SALES', npiUserIds: ['u1'] }];
    const out = await persistCopilotConfig(db, { npiOrgId: 'org1', plan, result, holders, now });
    expect(out.holdersSkipped).toEqual([{ roleKey: 'sales', departmentCode: 'SALES', npiUserId: 'u1', reason: 'position_missing' }]);
    expect(out.assignmentsWritten).toBe(0);
  });
});

describe('validateHolders', () => {
  const positions = pack().positions;

  it('reports unknown, inactive and role-mismatched users, and passes the valid one through', () => {
    const users: NpiDirectoryUser[] = [
      { id: 'u1', isActive: true, roleKey: 'pm', nameAr: 'أحمد' },
      { id: 'u2', isActive: false, roleKey: 'pm', nameAr: 'سالم' },
      { id: 'u3', isActive: true, roleKey: 'accountant', nameAr: 'خالد' },
    ];
    const holders = [{ roleKey: 'pm', departmentCode: 'PROJ', npiUserIds: ['u1', 'u2', 'u3', 'unknown'] }];
    const { valid, skipped } = validateHolders(holders, positions, users);
    expect(valid).toEqual([{ roleKey: 'pm', departmentCode: 'PROJ', npiUserIds: ['u1'] }]);
    expect(skipped).toEqual([
      { roleKey: 'pm', departmentCode: 'PROJ', npiUserId: 'u2', reason: 'inactive' },
      { roleKey: 'pm', departmentCode: 'PROJ', npiUserId: 'u3', reason: 'role_mismatch' },
      { roleKey: 'pm', departmentCode: 'PROJ', npiUserId: 'unknown', reason: 'unknown_user' },
    ]);
  });

  it('reports every user as directory_unreadable when the snapshot could not read the directory', () => {
    const holders = [{ roleKey: 'pm', departmentCode: 'PROJ', npiUserIds: ['u1'] }];
    const { valid, skipped } = validateHolders(holders, positions, null);
    expect(valid).toEqual([]);
    expect(skipped).toEqual([{ roleKey: 'pm', departmentCode: 'PROJ', npiUserId: 'u1', reason: 'directory_unreadable' }]);
  });
});

// ─── Q7 summary ─────────────────────────────────────────────────────────────

describe('summarizePlanAr', () => {
  it('splits the plan into NPI / already / copilot / blocked / gaps lines in Arabic', async () => {
    const npi = freshOrg();
    const plan = await dryRun({ npi }, pack(), answersOnly(), adminCaller);
    const s = summarizePlanAr(plan, pack());
    expect(s.npi).toHaveLength(13);
    expect(s.npi[0]).toBe('إنشاء القسم «المبيعات» (SALES)');
    expect(s.npi).toContain('إنشاء الدور «مدير المشاريع» — 13 صلاحية');
    expect(s.npi).toContain('إنشاء الصنف MOD-600 «لوح شمسي 600 واط»');
    expect(s.already).toEqual(['الدور «مدير النظام»']);
    expect(s.blocked[1]).toBe(
      'قاعدة اعتماد: أمر شراء من 100000 فأكثر ← مدير المشاريع ثم محاسب: الدور «مدير المشاريع» ليس له مستخدم نشط في NPI، ولن تقبل NPI سلسلة اعتماد تمر به. عيّن مستخدماً لهذا الدور من شاشة NPI ثم أعد هذه الخطوة.',
    );
    expect(s.copilot[0]).toBe('الوحدات الظاهرة: العملاء والفرص، العروض والعقود، المشاريع، المشتريات والمخزون، المالية');
    expect(s.copilot[1]).toContain('عقد EPC');
    expect(s.gaps).toEqual([]);

    // No Latin text beyond codes (department codes, SKUs) and the NPI/EPC tokens.
    const lines = [...s.npi, ...s.already, ...s.copilot, ...s.blocked];
    for (const line of lines) expect(line.match(/[a-z]+/g) ?? []).toEqual([]);
  });

  it('describes an update with the permission delta', async () => {
    const npi = seededLikePack();
    const pm = npi.roles.find((r) => r.key === 'pm')!;
    pm.permissions = pm.permissions.filter((p) => p !== 'projects.project.write');
    const plan = await dryRun({ npi }, pack(), answersOnly(), adminCaller);
    expect(summarizePlanAr(plan, pack()).npi).toEqual(['تحديث الدور «مدير المشاريع» — إضافة 1 صلاحية وسحب 0']);
  });
});
