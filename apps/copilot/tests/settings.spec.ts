// T-19 acceptance: the /settings screen's backend orchestration
// (`getSettingsView` / `handleSettingsAction`), built on top of T-17/T-18's
// onboarding machinery. `apps/copilot/catalog` must be on disk for
// `loadProfilePack('epc')` / `('om_provider')` to resolve — set before any
// module that reads it is imported, same as the onboarding specs.
import path from 'node:path';

process.env.COPILOT_CATALOG_DIR = path.join(__dirname, '..', 'catalog');

import { ZodError } from 'zod';
import { loadProfilePack } from '../src/onboarding/catalog';
import { initialState, applyAnswer } from '../src/onboarding/machine';
import { SetupForbiddenError, type OnboardingSessionRow, type SetupCaller } from '../src/onboarding/service';
import { NpiError } from '../src/npi/errors';
import { t } from '../src/i18n/ar';
import { formatNumber } from '../src/i18n/format';
import {
  getSettingsView,
  handleSettingsAction,
  type SettingsDb,
  type SettingsDeps,
  type SettingsNpi,
} from '../src/settings/service';
import { BASELINE_MAX_MINUTES, BASELINE_MIN_MINUTES, type SettingsView } from '../src/settings/types';

// ─── Fake db ────────────────────────────────────────────────────────────────

interface FakePositionRow {
  id: string;
  npiOrgId: string;
  roleKey: string;
  departmentId: string | null;
  titleAr: string;
  assignments: { npiUserId: string; startedAt: Date; endedAt: Date | null }[];
}

function buildFakeSettingsDb() {
  const firmConfigs = new Map<string, Record<string, unknown>>();
  const positions: FakePositionRow[] = [];
  const baselines = new Map<string, { npiOrgId: string; flowType: string; minutes: number; measuredAt: Date; npiUserId: string }>();
  const sessions: OnboardingSessionRow[] = [];
  let seq = 0;

  const db: SettingsDb = {
    firmConfig: {
      async findUnique({ where }) {
        const row = firmConfigs.get(where.npiOrgId);
        if (!row) return null;
        return {
          profileKey: (row.profileKey as string | null | undefined) ?? null,
          visibleModulesJson: row.visibleModulesJson,
          acceptedDocTypesJson: row.acceptedDocTypesJson,
          terminologyJson: row.terminologyJson,
          npiApiGapsJson: row.npiApiGapsJson,
          setupCompletedAt: (row.setupCompletedAt as Date | null | undefined) ?? null,
        };
      },
      async update({ where, data }) {
        const row = firmConfigs.get(where.npiOrgId) ?? {};
        firmConfigs.set(where.npiOrgId, { ...row, ...data });
        return null;
      },
    },
    position: {
      async findMany({ where }) {
        return positions
          .filter((p) => p.npiOrgId === where.npiOrgId)
          .map((p) => ({
            id: p.id,
            roleKey: p.roleKey,
            departmentId: p.departmentId,
            titleAr: p.titleAr,
            assignments: p.assignments
              .filter((a) => a.endedAt === null)
              .map((a) => ({ npiUserId: a.npiUserId, startedAt: a.startedAt })),
          }));
      },
    },
    manualBaseline: {
      async findMany({ where }) {
        return [...baselines.values()]
          .filter((b) => b.npiOrgId === where.npiOrgId)
          .map((b) => ({ flowType: b.flowType, minutes: b.minutes, measuredAt: b.measuredAt }));
      },
      async upsert({ where, create, update }) {
        const key = `${where.npiOrgId_flowType.npiOrgId}\u0000${where.npiOrgId_flowType.flowType}`;
        const existing = baselines.get(key);
        baselines.set(
          key,
          existing ? { ...existing, ...update } : { ...create },
        );
        return null;
      },
    },
    onboardingSession: {
      async findFirst({ where }: { where: { npiOrgId: string; completedAt: null | { not: null } } }) {
        if (where.completedAt === null) {
          return sessions.find((s) => s.npiOrgId === where.npiOrgId && s.completedAt === null) ?? null;
        }
        const matches = sessions
          .filter((s) => s.npiOrgId === where.npiOrgId && s.completedAt !== null)
          .sort((a, b) => (b.completedAt as Date).getTime() - (a.completedAt as Date).getTime());
        return matches[0] ?? null;
      },
      async create({ data }) {
        const row: OnboardingSessionRow = {
          id: `sess_${++seq}`,
          npiOrgId: data.npiOrgId,
          npiUserId: data.npiUserId,
          stepsJson: data.stepsJson,
          completedAt: null,
          profileChosen: null,
        };
        sessions.push(row);
        return row;
      },
      async update({ where, data }) {
        const row = sessions.find((s) => s.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
    },
  };

  function addPosition(row: Omit<FakePositionRow, 'id' | 'npiOrgId'> & { npiOrgId?: string }) {
    const full: FakePositionRow = { id: `pos_${++seq}`, npiOrgId: 'org1', ...row };
    positions.push(full);
    return full;
  }

  function setFirmConfig(npiOrgId: string, data: Record<string, unknown>) {
    firmConfigs.set(npiOrgId, data);
  }

  function addCompletedSession(npiOrgId: string, stepsJson: unknown, completedAt: Date) {
    const row: OnboardingSessionRow = {
      id: `sess_${++seq}`,
      npiOrgId,
      npiUserId: 'u1',
      stepsJson,
      completedAt,
      profileChosen: 'epc',
    };
    sessions.push(row);
    return row;
  }

  return { db, firmConfigs, positions, baselines, sessions, addPosition, setFirmConfig, addCompletedSession };
}

// ─── Fake NPI ───────────────────────────────────────────────────────────────

class FakeSettingsNpi implements SettingsNpi {
  departments: { id: string; code: string; nameAr: string; isActive: boolean }[] = [];
  directory: { id: string; nameAr: string; isActive: boolean; roleKey: string }[] = [];
  roles: { key: string; nameAr: string }[] = [];
  departmentsCalls = 0;
  directoryCalls = 0;
  rolesCalls = 0;
  forbiddenDepartments = false;
  forbiddenDirectory = false;
  forbiddenRoles = false;

  async listRoles() {
    this.rolesCalls += 1;
    if (this.forbiddenRoles) throw new NpiError({ status: 403, kind: 'forbidden', npiMessage: 'Forbidden resource' });
    return this.roles.map((r) => ({ id: `r_${r.key}`, key: r.key, nameAr: r.nameAr, nameEn: r.key, permissions: [] }));
  }
  async listDepartments() {
    this.departmentsCalls += 1;
    if (this.forbiddenDepartments) throw new NpiError({ status: 403, kind: 'forbidden', npiMessage: 'Forbidden resource' });
    return this.departments;
  }
  async listDepartmentDirectory() {
    this.directoryCalls += 1;
    if (this.forbiddenDirectory) throw new NpiError({ status: 403, kind: 'forbidden', npiMessage: 'Forbidden resource' });
    return this.directory.map((u) => ({
      id: u.id,
      nameAr: u.nameAr,
      nameEn: 'u',
      email: `${u.id}@x`,
      isActive: u.isActive,
      departmentId: null,
      role: { id: `r_${u.roleKey}`, key: u.roleKey, nameAr: u.roleKey, nameEn: u.roleKey },
    }));
  }
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const pack = () => loadProfilePack('epc');
const adminCaller: SetupCaller = { npiOrgId: 'org1', npiUserId: 'u1', roleKey: 'admin', permissions: ['admin.user.manage', 'admin.department.manage'] };
const nonAdminCaller: SetupCaller = { npiOrgId: 'org1', npiUserId: 'u2', roleKey: 'sales', permissions: [] };

function buildDeps(overrides: Partial<SettingsDeps> = {}) {
  const fake = buildFakeSettingsDb();
  const npi = new FakeSettingsNpi();
  const deps: SettingsDeps = {
    db: fake.db,
    npi,
    now: () => new Date('2026-10-04T10:00:00.000Z'),
    ...overrides,
  };
  return { deps, fake, npi };
}

const validGapsJson = (overrides: Record<string, unknown> = {}) => ({
  gaps: [],
  blocked: [],
  failed: [],
  appliedAt: '2026-10-04T10:00:00.000Z',
  ...overrides,
});

// ─── Forbidden ──────────────────────────────────────────────────────────────

describe('getSettingsView / handleSettingsAction — non-admin refusal', () => {
  it('getSettingsView throws SetupForbiddenError (403) with the settings-specific Arabic message', async () => {
    const { deps } = buildDeps();
    await expect(getSettingsView(deps, nonAdminCaller)).rejects.toBeInstanceOf(SetupForbiddenError);
    await expect(getSettingsView(deps, nonAdminCaller)).rejects.toMatchObject({ status: 403, messageAr: t('settings.forbidden') });
  });

  it('handleSettingsAction throws SetupForbiddenError (403) for a non-admin caller', async () => {
    const { deps } = buildDeps();
    await expect(handleSettingsAction(deps, nonAdminCaller, { action: 'rerun', step: 1 })).rejects.toMatchObject({ status: 403 });
  });
});

// ─── View: no config ────────────────────────────────────────────────────────

describe('getSettingsView — no firm_config row', () => {
  it('config is null, baselines are all null, positions are still listed', async () => {
    const { deps, fake } = buildDeps();
    fake.addPosition({ roleKey: 'pm', departmentId: null, titleAr: 'مدير المشاريع', assignments: [] });

    const view = await getSettingsView(deps, adminCaller);
    expect(view.config).toBeNull();
    for (const flow of ['customer_contract', 'pr', 'po', 'grn', 'vendor_bill'] as const) {
      expect(view.baselines[flow]).toBeNull();
    }
    expect(view.positions).toHaveLength(1);
    expect(view.positions[0]).toMatchObject({ roleKey: 'pm', roleNameAr: 'pm' }); // no pack to resolve the name
    expect(view.openSetup).toBe(false);
  });

  it('config is also null when the stored profileKey is not a known profile', async () => {
    const { deps, fake } = buildDeps();
    fake.setFirmConfig('org1', {
      npiOrgId: 'org1',
      profileKey: 'not_a_real_profile',
      visibleModulesJson: ['finance'],
      acceptedDocTypesJson: [],
      terminologyJson: {},
      npiApiGapsJson: validGapsJson(),
      setupCompletedAt: null,
    });
    const view = await getSettingsView(deps, adminCaller);
    expect(view.config).toBeNull();
  });
});

// ─── View: a full config ────────────────────────────────────────────────────

describe('getSettingsView — a full config', () => {
  function fullFirmConfig(overrides: Record<string, unknown> = {}) {
    return {
      npiOrgId: 'org1',
      profileKey: 'epc',
      visibleModulesJson: ['crm', 'commercial', 'projects', 'finance', 'not_a_real_module'],
      acceptedDocTypesJson: [
        { key: 'epc_contract', labelAr: 'عقد EPC', flow: 'customer_contract' },
        { key: 'broken', flow: 'pr' }, // missing labelAr -> dropped
      ],
      terminologyJson: { vendor: 'المورّد المعتمد', not_a_real_term: 'شيء' },
      npiApiGapsJson: validGapsJson(),
      setupCompletedAt: new Date('2026-09-01T00:00:00.000Z'),
      ...overrides,
    };
  }

  it('parses modules/doc types/terminology, dropping garbage, and resolves the profile title', async () => {
    const { deps, fake } = buildDeps();
    fake.setFirmConfig('org1', fullFirmConfig());

    const view = await getSettingsView(deps, adminCaller);
    expect(view.config).not.toBeNull();
    const cfg = view.config!;
    expect(cfg.profileKey).toBe('epc');
    expect(cfg.profileTitleAr).toBe(t('profile.epc'));
    expect(cfg.setupCompletedAt).toBe('2026-09-01T00:00:00.000Z');
    expect(cfg.visibleModules).toEqual(['crm', 'commercial', 'projects', 'finance']);
    expect(cfg.acceptedDocTypes).toEqual([{ key: 'epc_contract', labelAr: 'عقد EPC', flow: 'customer_contract' }]);
    expect(cfg.terminology).toEqual({ vendor: 'المورّد المعتمد' });
    expect(cfg.lastApply).toEqual({ appliedAt: '2026-10-04T10:00:00.000Z', gaps: [], blocked: [], failed: [] });
  });

  it('lastApply is null when npiApiGapsJson is malformed', async () => {
    const { deps, fake } = buildDeps();
    fake.setFirmConfig('org1', fullFirmConfig({ npiApiGapsJson: { nonsense: true } }));
    const view = await getSettingsView(deps, adminCaller);
    expect(view.config!.lastApply).toBeNull();
  });
});

// ─── Leftovers ──────────────────────────────────────────────────────────────

describe('getSettingsView — lastApply leftovers, mapped by step-id kind', () => {
  it('maps department/role/approval_rule/item/unknown step ids to the right setupStep and Arabic label', async () => {
    const { deps, fake } = buildDeps();
    fake.setFirmConfig('org1', {
      npiOrgId: 'org1',
      profileKey: 'epc',
      visibleModulesJson: ['finance'],
      acceptedDocTypesJson: [],
      terminologyJson: {},
      npiApiGapsJson: {
        gaps: [],
        blocked: [
          { stepId: 'department:SALES', reasonAr: 'سبب 1' },
          { stepId: 'role:pm', reasonAr: 'سبب 2' },
          { stepId: 'approval_rule:PURCHASE_ORDER:100000', reasonAr: 'سبب 3' },
        ],
        failed: [
          { stepId: 'item:MOD-600', reasonAr: 'سبب 4', npiMessage: 'NPI said no' },
          { stepId: 'mystery:thing', reasonAr: 'سبب 5', npiMessage: null },
        ],
        appliedAt: '2026-10-04T10:00:00.000Z',
      },
      setupCompletedAt: null,
    });

    const view = await getSettingsView(deps, adminCaller);
    const { blocked, failed } = view.config!.lastApply!;

    expect(blocked).toEqual([
      { stepId: 'department:SALES', kind: 'department', labelAr: t('settings.leftover.department', { code: 'SALES' }), reasonAr: 'سبب 1', npiMessage: null, setupStep: 2 },
      { stepId: 'role:pm', kind: 'role', labelAr: t('settings.leftover.role', { name: pack().rolePermissionSets.pm.nameAr }), reasonAr: 'سبب 2', npiMessage: null, setupStep: 2 },
      {
        stepId: 'approval_rule:PURCHASE_ORDER:100000',
        kind: 'approval_rule',
        labelAr: t('settings.leftover.approval_rule', { doc: 'أمر شراء', min: formatNumber(100000) }),
        reasonAr: 'سبب 3',
        npiMessage: null,
        setupStep: 3,
      },
    ]);
    expect(failed).toEqual([
      { stepId: 'item:MOD-600', kind: 'item', labelAr: t('settings.leftover.item', { sku: 'MOD-600' }), reasonAr: 'سبب 4', npiMessage: 'NPI said no', setupStep: 5 },
      { stepId: 'mystery:thing', kind: 'unknown', labelAr: t('settings.leftover.unknown', { id: 'mystery:thing' }), reasonAr: 'سبب 5', npiMessage: null, setupStep: null },
    ]);
  });

  it('a moved threshold still maps to setupStep 3 and labels by document type, not by the threshold', async () => {
    const { deps, fake } = buildDeps();
    fake.setFirmConfig('org1', {
      npiOrgId: 'org1',
      profileKey: 'epc',
      visibleModulesJson: ['finance'],
      acceptedDocTypesJson: [],
      terminologyJson: {},
      npiApiGapsJson: {
        gaps: [],
        blocked: [{ stepId: 'approval_rule:PURCHASE_REQUISITION:5000', reasonAr: 'تحرك السقف' }],
        failed: [],
        appliedAt: '2026-10-04T10:00:00.000Z',
      },
      setupCompletedAt: null,
    });
    const view = await getSettingsView(deps, adminCaller);
    const leftover = view.config!.lastApply!.blocked[0];
    expect(leftover.setupStep).toBe(3);
    expect(leftover.labelAr).toBe(t('settings.leftover.approval_rule', { doc: 'طلب شراء', min: formatNumber(5000) }));
  });
});

// ─── Positions: department / holder name resolution ────────────────────────

describe('getSettingsView — position and holder name resolution', () => {
  it('resolves department and holder names, sorted by roleKey/titleAr and startedAt, with exactly one NPI call per endpoint', async () => {
    const { deps, fake, npi } = buildDeps();
    fake.setFirmConfig('org1', {
      npiOrgId: 'org1',
      profileKey: 'epc',
      visibleModulesJson: ['finance'],
      acceptedDocTypesJson: [],
      terminologyJson: {},
      npiApiGapsJson: validGapsJson(),
      setupCompletedAt: null,
    });
    npi.departments = [{ id: 'dept_proj', code: 'PROJ', nameAr: 'المشاريع', isActive: true }];
    npi.directory = [
      { id: 'u1', nameAr: 'أحمد', isActive: true, roleKey: 'pm' },
      { id: 'u2', nameAr: 'سالم', isActive: true, roleKey: 'accountant' },
    ];
    fake.addPosition({
      roleKey: 'sales',
      departmentId: null,
      titleAr: 'ب',
      assignments: [{ npiUserId: 'u2', startedAt: new Date('2026-01-02T00:00:00.000Z'), endedAt: null }],
    });
    fake.addPosition({
      roleKey: 'pm',
      departmentId: 'dept_proj',
      titleAr: 'أ',
      assignments: [
        { npiUserId: 'u1', startedAt: new Date('2026-01-02T00:00:00.000Z'), endedAt: null },
        { npiUserId: 'unknown_user', startedAt: new Date('2026-01-01T00:00:00.000Z'), endedAt: null },
      ],
    });

    const view = await getSettingsView(deps, adminCaller);
    expect(view.positions.map((p) => p.roleKey)).toEqual(['pm', 'sales']);
    const pm = view.positions[0];
    expect(pm.roleNameAr).toBe(pack().rolePermissionSets.pm.nameAr);
    expect(pm.departmentNameAr).toBe('المشاريع');
    expect(pm.holders.map((h) => h.npiUserId)).toEqual(['unknown_user', 'u1']);
    expect(pm.holders[1].nameAr).toBe('أحمد');
    expect(pm.holders[0].nameAr).toBeNull();

    expect(npi.departmentsCalls).toBe(1);
    expect(npi.directoryCalls).toBe(1);
  });

  it('names a role from NPI when no profile pack names it (no config yet), and never calls NPI roles when the pack does', async () => {
    // Live finding (reviewer, 2026-10-04): before the first apply there is
    // no pack, and the card showed «admin» / «site_engineer» as the role.
    const { deps, fake, npi } = buildDeps();
    npi.roles = [{ key: 'site_engineer', nameAr: 'مهندس موقع' }];
    fake.addPosition({ roleKey: 'site_engineer', departmentId: null, titleAr: 'مهندس الموقع', assignments: [] });

    const noConfig = await getSettingsView(deps, adminCaller);
    expect(noConfig.config).toBeNull();
    expect(noConfig.positions[0].roleNameAr).toBe('مهندس موقع');
    expect(npi.rolesCalls).toBe(1);

    // A role NPI does not list either falls back to the key — never throws.
    npi.roles = [];
    const unknown = await getSettingsView(deps, adminCaller);
    expect(unknown.positions[0].roleNameAr).toBe('site_engineer');

    // NPI 403 on roles: same fallback, view still renders.
    npi.forbiddenRoles = true;
    const forbidden = await getSettingsView(deps, adminCaller);
    expect(forbidden.positions[0].roleNameAr).toBe('site_engineer');

    // With a pack that names the role, NPI roles are not read at all.
    npi.forbiddenRoles = false;
    npi.rolesCalls = 0;
    fake.positions.length = 0;
    fake.addPosition({ roleKey: 'pm', departmentId: null, titleAr: 'مدير المشروع', assignments: [] });
    fake.setFirmConfig('org1', {
      npiOrgId: 'org1',
      profileKey: 'epc',
      visibleModulesJson: ['finance'],
      acceptedDocTypesJson: [],
      terminologyJson: {},
      npiApiGapsJson: validGapsJson(),
      setupCompletedAt: null,
    });
    const withPack = await getSettingsView(deps, adminCaller);
    expect(withPack.positions[0].roleNameAr).toBe(pack().rolePermissionSets.pm.nameAr);
    expect(npi.rolesCalls).toBe(0);
  });

  it('departmentNameAr/holder name are null when NPI 403s, without failing the view', async () => {
    const { deps, fake, npi } = buildDeps();
    fake.setFirmConfig('org1', {
      npiOrgId: 'org1',
      profileKey: 'epc',
      visibleModulesJson: ['finance'],
      acceptedDocTypesJson: [],
      terminologyJson: {},
      npiApiGapsJson: validGapsJson(),
      setupCompletedAt: null,
    });
    npi.forbiddenDirectory = true;
    npi.departments = [{ id: 'dept_proj', code: 'PROJ', nameAr: 'المشاريع', isActive: true }];
    fake.addPosition({
      roleKey: 'pm',
      departmentId: 'dept_proj',
      titleAr: 'أ',
      assignments: [{ npiUserId: 'u1', startedAt: new Date(), endedAt: null }],
    });

    const view = await getSettingsView(deps, adminCaller);
    const pm = view.positions[0];
    expect(pm.departmentNameAr).toBe('المشاريع'); // departments still resolve
    expect(pm.holders[0].nameAr).toBeNull(); // directory was forbidden
  });

  it('a caller without admin.department.manage never calls NPI and gets null names', async () => {
    const { deps, fake, npi } = buildDeps();
    fake.setFirmConfig('org1', {
      npiOrgId: 'org1',
      profileKey: 'epc',
      visibleModulesJson: ['finance'],
      acceptedDocTypesJson: [],
      terminologyJson: {},
      npiApiGapsJson: validGapsJson(),
      setupCompletedAt: null,
    });
    fake.addPosition({
      roleKey: 'pm',
      departmentId: 'dept_proj',
      titleAr: 'أ',
      assignments: [{ npiUserId: 'u1', startedAt: new Date(), endedAt: null }],
    });
    const noDeptCaller: SetupCaller = { ...adminCaller, permissions: ['admin.user.manage'] };
    const view = await getSettingsView(deps, noDeptCaller);
    expect(view.positions[0].departmentNameAr).toBeNull();
    expect(view.positions[0].holders[0].nameAr).toBeNull();
    expect(npi.departmentsCalls).toBe(0);
    expect(npi.directoryCalls).toBe(0);
  });
});

// ─── openSetup ──────────────────────────────────────────────────────────────

describe('getSettingsView — openSetup', () => {
  it('is true exactly when an open onboarding session exists', async () => {
    const { deps, fake } = buildDeps();
    expect((await getSettingsView(deps, adminCaller)).openSetup).toBe(false);
    fake.sessions.push({ id: 's1', npiOrgId: 'org1', npiUserId: 'u1', stepsJson: initialState(), completedAt: null, profileChosen: null });
    expect((await getSettingsView(deps, adminCaller)).openSetup).toBe(true);
  });
});

// ─── visible_modules action ─────────────────────────────────────────────────

describe('handleSettingsAction — visible_modules', () => {
  function configured(fake: ReturnType<typeof buildFakeSettingsDb>, modules: string[] = ['crm', 'finance']) {
    fake.setFirmConfig('org1', {
      npiOrgId: 'org1',
      profileKey: 'epc',
      visibleModulesJson: modules,
      acceptedDocTypesJson: [],
      terminologyJson: {},
      npiApiGapsJson: validGapsJson(),
      setupCompletedAt: null,
    });
  }

  it('writes the modules in MODULE_KEYS order and returns the refreshed view', async () => {
    const { deps, fake } = buildDeps();
    configured(fake);
    const result = await handleSettingsAction(deps, adminCaller, { action: 'visible_modules', modules: ['projects', 'finance', 'crm', 'crm'] });
    expect(fake.firmConfigs.get('org1')!.visibleModulesJson).toEqual(['crm', 'projects', 'finance']);
    const view = result as SettingsView;
    expect(view.config!.visibleModules).toEqual(['crm', 'projects', 'finance']);
  });

  it('rejects a list missing "finance" with SettingsError invalid_modules', async () => {
    const { deps, fake } = buildDeps();
    configured(fake);
    await expect(handleSettingsAction(deps, adminCaller, { action: 'visible_modules', modules: ['crm'] })).rejects.toMatchObject({
      code: 'invalid_modules',
      messageAr: t('settings.modules.invalid'),
    });
  });

  it('rejects an unknown module key as a ZodError', async () => {
    const { deps, fake } = buildDeps();
    configured(fake);
    await expect(handleSettingsAction(deps, adminCaller, { action: 'visible_modules', modules: ['not_a_module'] })).rejects.toBeInstanceOf(
      ZodError,
    );
  });

  it('rejects when there is no config yet', async () => {
    const { deps } = buildDeps();
    await expect(handleSettingsAction(deps, adminCaller, { action: 'visible_modules', modules: ['finance'] })).rejects.toMatchObject({
      code: 'no_config',
      messageAr: t('settings.no_config'),
    });
  });
});

// ─── baseline action ─────────────────────────────────────────────────────────

describe('handleSettingsAction — baseline', () => {
  it('creates, then updates on a second save, stamping measuredAt from the injected clock', async () => {
    const t1 = new Date('2026-10-04T10:00:00.000Z');
    const t2 = new Date('2026-10-05T12:00:00.000Z');
    let now = t1;
    const { deps, fake } = buildDeps({ now: () => now });

    await handleSettingsAction(deps, adminCaller, { action: 'baseline', flow: 'pr', minutes: 12 });
    let row = [...fake.baselines.values()].find((b) => b.flowType === 'pr')!;
    expect(row).toMatchObject({ minutes: 12, measuredAt: t1, npiUserId: 'u1' });

    now = t2;
    const result = await handleSettingsAction(deps, adminCaller, { action: 'baseline', flow: 'pr', minutes: 20 });
    row = [...fake.baselines.values()].find((b) => b.flowType === 'pr')!;
    expect(row).toMatchObject({ minutes: 20, measuredAt: t2 });
    const view = result as SettingsView;
    expect(view.baselines.pr).toEqual({ minutes: 20, measuredAt: t2.toISOString() });
  });

  it('rejects 0 minutes and 601 minutes as SettingsError invalid_baseline', async () => {
    const { deps } = buildDeps();
    const expected = { code: 'invalid_baseline', messageAr: t('settings.baselines.invalid', { min: formatNumber(BASELINE_MIN_MINUTES), max: formatNumber(BASELINE_MAX_MINUTES) }) };
    await expect(handleSettingsAction(deps, adminCaller, { action: 'baseline', flow: 'pr', minutes: 0 })).rejects.toMatchObject(expected);
    await expect(handleSettingsAction(deps, adminCaller, { action: 'baseline', flow: 'pr', minutes: 601 })).rejects.toMatchObject(expected);
  });

  it('rejects a non-integer minutes value as a ZodError', async () => {
    const { deps } = buildDeps();
    await expect(handleSettingsAction(deps, adminCaller, { action: 'baseline', flow: 'pr', minutes: 5.5 })).rejects.toBeInstanceOf(ZodError);
  });

  it('rejects an unknown flow as a ZodError', async () => {
    const { deps } = buildDeps();
    await expect(
      handleSettingsAction(deps, adminCaller, { action: 'baseline', flow: 'not_a_flow' as never, minutes: 5 }),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it('the administrative flow has no manual reference time (D-26): it is not a baseline flow and the view stays at five', async () => {
    const { deps, fake } = buildDeps();
    await expect(
      handleSettingsAction(deps, adminCaller, { action: 'baseline', flow: 'user_permissions' as never, minutes: 5 }),
    ).rejects.toBeInstanceOf(ZodError);

    fake.baselines.set('org1\u0000user_permissions', { npiOrgId: 'org1', flowType: 'user_permissions', minutes: 9, measuredAt: new Date(), npiUserId: 'u1' });
    const view = await getSettingsView(deps, adminCaller);
    expect(Object.keys(view.baselines).sort()).toEqual(['customer_contract', 'grn', 'po', 'pr', 'vendor_bill']);
  });
});

// ─── rerun action ────────────────────────────────────────────────────────────

describe('handleSettingsAction — rerun', () => {
  it("returns { redirect: '/setup' } and leaves no session when there is nothing to clone (fresh)", async () => {
    const { deps, fake } = buildDeps();
    const result = await handleSettingsAction(deps, adminCaller, { action: 'rerun', step: 2 });
    expect(result).toEqual({ redirect: '/setup' });
    expect(fake.sessions).toHaveLength(0);
  });

  it('moves an existing OPEN session to the requested step (open)', async () => {
    const { deps, fake } = buildDeps();
    let state = applyAnswer(initialState(), 1, { step: 1, profileKey: 'epc' });
    state = applyAnswer(state, 2, { step: 2, departments: pack().defaultDepartments, positions: pack().positions });
    fake.sessions.push({ id: 's1', npiOrgId: 'org1', npiUserId: 'u1', stepsJson: state, completedAt: null, profileChosen: null });

    const result = await handleSettingsAction(deps, adminCaller, { action: 'rerun', step: 1 });
    expect(result).toEqual({ redirect: '/setup' });
    expect(fake.sessions).toHaveLength(1);
    expect((fake.sessions[0].stepsJson as { step: number }).step).toBe(1);
  });

  it('clones the latest completed session at the requested step, keeping its holders and terminology (cloned)', async () => {
    const { deps, fake } = buildDeps();
    const holders = [{ roleKey: 'pm', departmentCode: 'PROJ', npiUserIds: ['u1'] }];
    const completedAnswers = {
      profileKey: 'epc' as const,
      departments: pack().defaultDepartments,
      positions: pack().positions,
      holders,
      approvalRules: pack().approvalRuleDefaults,
      acceptedDocTypeKeys: pack().acceptedDocTypes.map((d) => d.key),
      items: pack().itemTemplates,
      terminology: { vendor: 'المورّد المعتمد' },
    };
    fake.addCompletedSession(
      'org1',
      { step: 7, answers: completedAnswers, completedSteps: [1, 2, 3, 4, 5, 6] },
      new Date('2026-09-01T00:00:00.000Z'),
    );

    const result = await handleSettingsAction(deps, adminCaller, { action: 'rerun', step: 4 });
    expect(result).toEqual({ redirect: '/setup' });
    const open = fake.sessions.find((s) => s.completedAt === null)!;
    const stored = open.stepsJson as { step: number; answers: typeof completedAnswers; completedSteps: number[] };
    expect(stored.step).toBe(4);
    expect(stored.completedSteps).toEqual([1, 2, 3, 4, 5, 6]);
    expect(stored.answers.holders).toEqual(holders);
    expect(stored.answers.terminology).toEqual({ vendor: 'المورّد المعتمد' });
  });
});
