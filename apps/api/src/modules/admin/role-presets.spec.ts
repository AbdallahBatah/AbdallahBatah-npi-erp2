import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  ALL_PERMISSIONS,
  APPROVAL_DOCUMENT_META,
  PERMISSIONS,
  PROPOSED_APPROVAL_RULES,
  ROLE_PRESETS,
  rolePreset,
  sodConflicts,
  visibleScreens,
} from '@npi/shared';
import { AdminService } from './admin.service';
import { RolePresetsService } from './role-presets.service';
import { holdsEffectively } from '../../common/permission-predicates';
import type { AuthUser } from '../../common/auth-user';

const admin = (): AuthUser => ({
  userId: 'admin1',
  organizationId: 'org1',
  email: 'admin@npi.sa',
  roleId: 'role-admin',
  roleKey: 'admin',
  roleIds: ['role-admin'],
  permissions: [PERMISSIONS.USER_MANAGE, PERMISSIONS.APPROVAL_MANAGE],
  locale: 'AR',
});

interface FakeRole {
  id: string;
  key: string;
  nameAr: string;
  nameEn: string;
  permissions: string[];
}
interface FakeRule {
  id: string;
  documentType: string;
  minAmount: number;
  maxAmount: number | null;
  isActive: boolean;
  /** Role keys, in signing order. */
  steps: string[];
}
interface FakeUser {
  id: string;
  roleId: string;
  extraRoleIds?: string[];
}

const role = (key: string, permissions: readonly string[], names?: { nameAr: string; nameEn: string }): FakeRole => ({
  id: `role-${key}`,
  key,
  nameAr: names?.nameAr ?? key,
  nameEn: names?.nameEn ?? key,
  permissions: [...permissions],
});

/** The organization's role holding exactly the preset, under the preset's names: `same`. */
const asPreset = (key: string): FakeRole => {
  const p = rolePreset(key)!;
  return role(key, p.permissions, { nameAr: p.nameAr, nameEn: p.nameEn });
};

/** The seeded accountant after the P1-6 backfill (packages/db/prisma/seed.ts): 21 keys. */
const SEEDED_ACCOUNTANT = [
  'finance.invoice.read', 'finance.invoice.write', 'finance.ledger.read',
  'finance.report.read', 'finance.statement.read',
  'finance.payment.read', 'finance.payment.write', 'finance.period.manage',
  'finance.costs.view',
  'crm.customer.read', 'crm.task.read',
  'commercial.contract.read', 'commercial.proposal.read', 'commercial.item.read',
  'scm.procurement.read', 'scm.procurement.write', 'scm.procurement.approve',
  'scm.requisition.read', 'scm.requisition.write',
  'platform.attachment.read', 'platform.attachment.write',
];

const audit = { record: jest.fn().mockResolvedValue(undefined) };

/**
 * An in-memory organization behind a Prisma double: just the reads the
 * preview makes (roles, active rules, role holders) and the two read-only
 * guard queries of AdminService (the seat's rules and open steps, the
 * lockout's count). `admins` is what `user.count` answers. The double has
 * no write method, so a preview that wrote anything would throw.
 */
function world(opts: {
  roles: FakeRole[];
  rules?: FakeRule[];
  users?: FakeUser[];
  openSteps?: Record<string, number>;
  admins?: number;
}) {
  const roles = opts.roles;
  const rules = opts.rules ?? [];
  const users = opts.users ?? [];
  const roleById = (id: string) => roles.find((r) => r.id === id)!;
  const roleByKey = (key: string) => roles.find((r) => r.key === key)!;

  const prisma = {
    role: {
      findMany: jest.fn(async ({ where }: any) =>
        roles.filter((r) => !where?.key?.in || where.key.in.includes(r.key)),
      ),
      findUnique: jest.fn(async ({ where }: any) =>
        roles.find((r) => r.key === where.organizationId_key.key) ?? null,
      ),
      findUniqueOrThrow: jest.fn(async ({ where }: any) => ({ ...roleById(where.id), _count: { users: 0 } })),
    },
    approvalRule: {
      findMany: jest.fn(async ({ where }: any) =>
        rules
          .filter((r) => (where.isActive === undefined ? true : r.isActive === where.isActive))
          .filter((r) => !where.documentType?.in || where.documentType.in.includes(r.documentType))
          .filter(
            (r) => !where.steps?.some || r.steps.some((k) => roleByKey(k).id === where.steps.some.roleId),
          )
          .sort((a, b) => a.documentType.localeCompare(b.documentType) || a.minAmount - b.minAmount)
          .map((r) => ({
            ...r,
            steps: r.steps.map((k) => ({ role: roleByKey(k) })),
          })),
      ),
    },
    approvalStep: {
      count: jest.fn(async ({ where }: any) => opts.openSteps?.[where.roleId] ?? 0),
    },
    user: {
      findMany: jest.fn(async ({ where }: any) => {
        const ids: string[] = where.OR[0].roleId.in;
        return users
          .filter((u) => ids.includes(u.roleId) || (u.extraRoleIds ?? []).some((e) => ids.includes(e)))
          .map((u) => ({
            id: u.id,
            nameAr: u.id,
            nameEn: u.id,
            email: `${u.id}@npi.sa`,
            roleId: u.roleId,
            extraRoles: (u.extraRoleIds ?? []).map((roleId) => ({ roleId })),
          }));
      }),
      count: jest.fn(async (_args: { where: any }) => opts.admins ?? 1),
    },
  };
  const adminService = new AdminService(prisma as never, audit as never, {} as never);
  const approvals = {
    create: jest.fn(async (_u: AuthUser, dto: any) => ({ id: `new-${dto.documentType}` })),
    update: jest.fn(async (_u: AuthUser, id: string, _dto: unknown): Promise<unknown> => ({ id })),
  };
  const service = new RolePresetsService(prisma as never, audit as never, adminService, approvals as never);
  return { prisma, adminService, approvals, service };
}

beforeEach(() => jest.clearAllMocks());

// ── the constants ─────────────────────────────────────────────────────────

describe('ROLE_PRESETS and PROPOSED_APPROVAL_RULES (@npi/shared)', () => {
  it('lists the seven presets in the ADR order, with no preset for admin or sales', () => {
    expect(ROLE_PRESETS.map((p) => p.key)).toEqual([
      'executive',
      'pm',
      'technical_office',
      'site_engineer',
      'finance_manager',
      'accountant',
      'warehouse_keeper',
    ]);
    expect(rolePreset('admin')).toBeUndefined();
    expect(rolePreset('sales')).toBeUndefined();
  });

  it('gives the sidebar counts of the ADR table (17, 12, 9, 6, 12, 6, 7 of 24; P4 gave the keeper requisitions)', () => {
    expect(ROLE_PRESETS.map((p) => visibleScreens(p.permissions).length)).toEqual([
      17, 12, 9, 6, 12, 6, 7,
    ]);
  });

  it('names only catalogue keys, each once, and never admin.user.manage', () => {
    const known = new Set<string>(ALL_PERMISSIONS);
    for (const p of ROLE_PRESETS) {
      expect(p.permissions.filter((k) => !known.has(k))).toEqual([]);
      expect(new Set(p.permissions).size).toBe(p.permissions.length);
      expect(p.permissions).not.toContain(PERMISSIONS.USER_MANAGE);
    }
  });

  it('holds no separation-of-duties pair but finance management issuing invoices and closing the period', () => {
    const pairs = Object.fromEntries(
      ROLE_PRESETS.map((p) => [p.key, sodConflicts(p.permissions).map((c) => `${c.a}+${c.b}`)]),
    );
    expect(pairs).toEqual({
      executive: [],
      pm: [],
      technical_office: [],
      site_engineer: [],
      finance_manager: ['finance.invoice.write+finance.period.manage'],
      accountant: [],
      warehouse_keeper: [],
    });
  });

  it('proposes the ten rules from zero in order (P2 CONTRACT, P5 EXECUTION_OVERRUN, P7 PROJECT_CLOSURE, P6 payment request and petty cash), each step a preset that holds the document approve key', () => {
    expect(PROPOSED_APPROVAL_RULES.map((r) => [r.documentType, r.minAmount, [...r.steps]])).toEqual([
      ['PURCHASE_REQUISITION', 0, ['pm', 'finance_manager', 'executive']],
      ['PURCHASE_ORDER', 0, ['executive']],
      ['PROGRESS_CLAIM', 0, ['pm', 'executive']],
      ['CHANGE_ORDER', 0, ['executive']],
      ['PROPOSAL', 0, ['executive']],
      ['CONTRACT', 0, ['executive']],
      ['EXECUTION_OVERRUN', 0, ['pm', 'executive']],
      ['PROJECT_CLOSURE', 0, ['pm', 'executive']],
      ['VENDOR_PAYMENT_REQUEST', 0, ['pm', 'executive']],
      ['PETTY_CASH_SETTLEMENT', 0, ['pm']],
    ]);
    for (const r of PROPOSED_APPROVAL_RULES) {
      for (const key of r.steps) {
        expect(rolePreset(key)!.permissions).toContain(APPROVAL_DOCUMENT_META[r.documentType].permission);
      }
    }
  });
});

// ── the preview ───────────────────────────────────────────────────────────

describe('RolePresetsService.overview - presets', () => {
  it('create when the organization has no role of the key; same when keys and names match', async () => {
    const { service } = world({ roles: [asPreset('warehouse_keeper')] });
    const { presets } = await service.overview(admin());
    const byKey = Object.fromEntries(presets.map((p) => [p.key, p]));

    expect(byKey.technical_office).toMatchObject({
      status: 'create',
      roleId: null,
      currentName: null,
      proposedName: { nameAr: 'المكتب الفني', nameEn: 'Technical office' },
      currentCount: null,
      removed: [],
      screens: 9,
      totalScreens: 24,
      affectedUsers: [],
      blockedBy: [],
    });
    expect(byKey.technical_office.added).toHaveLength(11);
    expect(byKey.warehouse_keeper).toMatchObject({
      status: 'same',
      renamed: false,
      added: [],
      removed: [],
      blockedBy: [],
    });
  });

  it('differs on a rename alone, and lists added and removed keys in catalogue order', async () => {
    const executive = asPreset('executive');
    executive.nameAr = 'الإدارة العليا';
    const pm = asPreset('pm');
    pm.permissions = pm.permissions
      .filter((k) => k !== PERMISSIONS.LEAD_WRITE && k !== PERMISSIONS.COSTS_VIEW)
      .concat([PERMISSIONS.WORKORDER_READ, PERMISSIONS.ASSET_READ]);
    const { service } = world({ roles: [executive, pm] });
    const { presets } = await service.overview(admin());
    const byKey = Object.fromEntries(presets.map((p) => [p.key, p]));

    expect(byKey.executive).toMatchObject({
      status: 'differs',
      renamed: true,
      currentName: { nameAr: 'الإدارة العليا', nameEn: 'General manager' },
      proposedName: { nameAr: 'المدير العام', nameEn: 'General manager' },
      added: [],
      removed: [],
    });
    expect(byKey.pm).toMatchObject({
      status: 'differs',
      renamed: false,
      // Catalogue order: leads (sales) before costs (finance); assets (delivery) before work orders (operations).
      added: [PERMISSIONS.LEAD_WRITE, PERMISSIONS.COSTS_VIEW],
      removed: [PERMISSIONS.ASSET_READ, PERMISSIONS.WORKORDER_READ],
      currentCount: 18,
      screens: 12,
    });
  });

  it('narrows the seeded accountant from 21 keys to 3', async () => {
    const { service } = world({ roles: [role('accountant', SEEDED_ACCOUNTANT, { nameAr: 'المحاسب', nameEn: 'Accountant' })] });
    const accountant = (await service.overview(admin())).presets.find((p) => p.key === 'accountant')!;
    expect(accountant).toMatchObject({ status: 'differs', renamed: false, currentCount: 21, added: [] });
    expect(accountant.removed).toHaveLength(18);
    expect(accountant.permissions).toEqual([
      PERMISSIONS.PROCUREMENT_READ,
      PERMISSIONS.PAYMENT_READ,
      PERMISSIONS.PAYMENT_WRITE,
    ]);
  });

  it('counts the active users holding the role, primary or extra', async () => {
    const pm = role('pm', []);
    const { service } = world({
      roles: [pm, role('sales', [])],
      users: [
        { id: 'u1', roleId: pm.id },
        { id: 'u2', roleId: 'role-sales', extraRoleIds: [pm.id] },
        { id: 'u3', roleId: 'role-sales' },
      ],
    });
    const p = (await service.overview(admin())).presets.find((x) => x.key === 'pm')!;
    expect(p.affectedUsers.map((u) => [u.id, u.primary])).toEqual([
      ['u1', true],
      ['u2', false],
    ]);
  });

  it('carries the separation-of-duties pairs of the preset', async () => {
    const { service } = world({ roles: [] });
    const fm = (await service.overview(admin())).presets.find((p) => p.key === 'finance_manager')!;
    expect(fm.sodConflicts).toEqual([
      expect.objectContaining({ a: PERMISSIONS.INVOICE_WRITE, b: PERMISSIONS.PERIOD_MANAGE }),
    ]);
  });
});

describe('RolePresetsService.overview - blockedBy, without writing', () => {
  it('APPROVAL_SEAT when the preset drops an approve key the role signs with in an active rule, with the rules and open requests', async () => {
    const accountant = role('accountant', SEEDED_ACCOUNTANT);
    const { service } = world({
      roles: [accountant, role('pm', [PERMISSIONS.PROCUREMENT_APPROVE])],
      rules: [
        { id: 'po', documentType: 'PURCHASE_ORDER', minAmount: 100000, maxAmount: null, isActive: true, steps: ['pm', 'accountant'] },
        { id: 'pc', documentType: 'PROGRESS_CLAIM', minAmount: 250000, maxAmount: null, isActive: true, steps: ['pm', 'accountant'] },
        { id: 'old', documentType: 'PURCHASE_ORDER', minAmount: 0, maxAmount: 100000, isActive: false, steps: ['accountant'] },
      ],
      openSteps: { [accountant.id]: 2 },
    });
    const p = (await service.overview(admin())).presets.find((x) => x.key === 'accountant')!;
    expect(p.blockedBy).toEqual([
      {
        code: 'APPROVAL_SEAT',
        rules: [
          { id: 'pc', documentType: 'PROGRESS_CLAIM', minAmount: 250000, maxAmount: null },
          { id: 'po', documentType: 'PURCHASE_ORDER', minAmount: 100000, maxAmount: null },
        ],
        openRequests: 2,
      },
    ]);
  });

  it('no block when the dropped approve key signs nowhere, or the role keeps its approve keys', async () => {
    const { service } = world({
      roles: [role('accountant', SEEDED_ACCOUNTANT), role('executive', [PERMISSIONS.PROCUREMENT_APPROVE])],
      rules: [{ id: 'po', documentType: 'PURCHASE_ORDER', minAmount: 0, maxAmount: null, isActive: true, steps: ['executive'] }],
    });
    const { presets } = await service.overview(admin());
    expect(presets.find((x) => x.key === 'accountant')!.blockedBy).toEqual([]);
    expect(presets.find((x) => x.key === 'executive')!.blockedBy).toEqual([]);
  });

  it('LAST_ADMIN when the role holds admin.user.manage and nobody else would, asked as if the role had lost it', async () => {
    const pm = role('pm', [PERMISSIONS.USER_MANAGE, PERMISSIONS.PROJECT_READ]);
    const { service, prisma } = world({ roles: [pm], admins: 0 });
    const p = (await service.overview(admin())).presets.find((x) => x.key === 'pm')!;
    expect(p.blockedBy).toEqual([{ code: 'LAST_ADMIN' }]);

    const where = prisma.user.count.mock.calls[0][0].where;
    expect(where.organizationId).toBe('org1');
    expect(where.isActive).toBe(true);
    expect(where.AND[0]).toEqual(holdsEffectively(PERMISSIONS.USER_MANAGE));
    // ...and through something other than the role being narrowed.
    expect(where.AND[1].OR).toEqual([
      { role: { id: { not: pm.id }, permissions: { has: PERMISSIONS.USER_MANAGE } } },
      {
        extraRoles: {
          some: { roleId: { not: pm.id }, role: { permissions: { has: PERMISSIONS.USER_MANAGE } } },
        },
      },
      { permissionOverrides: { some: { permission: PERMISSIONS.USER_MANAGE, effect: 'GRANT' } } },
    ]);
  });

  it('no LAST_ADMIN while another administrator remains, and no lockout question for a role without the key', async () => {
    const { service, prisma } = world({
      roles: [role('pm', [PERMISSIONS.USER_MANAGE]), role('executive', [])],
      admins: 1,
    });
    const { presets } = await service.overview(admin());
    expect(presets.find((x) => x.key === 'pm')!.blockedBy).toEqual([]);
    expect(prisma.user.count).toHaveBeenCalledTimes(1);
  });
});

describe('RolePresetsService.overview - rules', () => {
  it('same, differs, create and blocked against the active rules of each type', async () => {
    const { service } = world({
      roles: [
        role('pm', [PERMISSIONS.PROCUREMENT_APPROVE]),
        role('executive', [PERMISSIONS.PROPOSAL_APPROVE, PERMISSIONS.PROCUREMENT_APPROVE]),
      ],
      users: [
        { id: 'u-pm', roleId: 'role-pm' },
        { id: 'u-ex', roleId: 'role-executive' },
      ],
      rules: [
        { id: 'pr', documentType: 'PURCHASE_REQUISITION', minAmount: 10000, maxAmount: null, isActive: true, steps: ['pm'] },
        { id: 'prop', documentType: 'PROPOSAL', minAmount: 0, maxAmount: null, isActive: true, steps: ['executive'] },
        { id: 'co', documentType: 'CHANGE_ORDER', minAmount: 100000, maxAmount: null, isActive: true, steps: ['pm'] },
      ],
    });
    const { rules } = await service.overview(admin());
    const byType = Object.fromEntries(rules.map((r) => [r.documentType, r]));

    expect(byType.PURCHASE_REQUISITION).toMatchObject({
      status: 'differs',
      current: [{ id: 'pr', minAmount: 10000, maxAmount: null, steps: [{ key: 'pm' }] }],
      change: { update: 'pr', deactivate: [] },
      blockedBy: [],
    });
    expect(byType.PURCHASE_ORDER).toMatchObject({
      status: 'create',
      current: [],
      change: { update: null, deactivate: [] },
      steps: [{ key: 'executive', roleId: 'role-executive' }],
    });
    expect(byType.PROGRESS_CLAIM.status).toBe('create');
    // executive lacks projects.project.approve, which signs change orders.
    expect(byType.CHANGE_ORDER).toMatchObject({
      status: 'blocked',
      blockedBy: [{ code: 'ROLE_LACKS_KEY', role: 'executive', permission: PERMISSIONS.PROJECT_APPROVE }],
      change: { update: 'co', deactivate: [] },
    });
    expect(byType.PROPOSAL).toMatchObject({ status: 'same', change: null, blockedBy: [] });
  });

  it('blocked when a step role is not created yet or has no active holder', async () => {
    const { service } = world({
      roles: [role('pm', [PERMISSIONS.PROCUREMENT_APPROVE])],
    });
    const byType = Object.fromEntries((await service.overview(admin())).rules.map((r) => [r.documentType, r]));
    expect(byType.PURCHASE_REQUISITION.blockedBy).toEqual([{ code: 'ROLE_NO_USERS', role: 'pm' }]);
    expect(byType.PROGRESS_CLAIM.blockedBy).toEqual([
      { code: 'ROLE_NO_USERS', role: 'pm' },
      { code: 'ROLE_MISSING', role: 'executive' },
    ]);
  });
});

// ── apply ─────────────────────────────────────────────────────────────────

describe('RolePresetsService.applyPreset', () => {
  it('updates through updateRole with the preset names and keys and acknowledgeSod, then records PRESET_APPLY', async () => {
    const accountant = role('accountant', SEEDED_ACCOUNTANT, { nameAr: 'المحاسب', nameEn: 'Accountant' });
    const { service, adminService } = world({ roles: [accountant] });
    const update = jest
      .spyOn(adminService, 'updateRole')
      .mockImplementation(async (_u, id) => ({ id }) as never);
    const create = jest.spyOn(adminService, 'createRole');

    const out = await service.applyPreset(admin(), 'accountant');

    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(admin(), accountant.id, {
      nameAr: 'المحاسب',
      nameEn: 'Accountant',
      permissions: [PERMISSIONS.PROCUREMENT_READ, PERMISSIONS.PAYMENT_READ, PERMISSIONS.PAYMENT_WRITE],
      acknowledgeSod: true,
    });
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0][0]).toMatchObject({
      entityType: 'Role',
      entityId: accountant.id,
      action: 'PRESET_APPLY',
      after: { preset: 'accountant', created: false, added: [] },
    });
    expect(audit.record.mock.calls[0][0].after.removed).toHaveLength(18);
    expect(out).toMatchObject({ applied: true, role: { id: accountant.id } });
    expect(out.presets).toHaveLength(7);
    expect(out.rules).toHaveLength(10);
  });

  it('creates a missing role through createRole, with its separation-of-duties pairs acknowledged', async () => {
    const { service, adminService } = world({ roles: [] });
    const create = jest
      .spyOn(adminService, 'createRole')
      .mockImplementation(async (_u, dto) => ({ id: `role-${dto.key}` }) as never);

    await service.applyPreset(admin(), 'finance_manager');

    expect(create).toHaveBeenCalledWith(
      admin(),
      expect.objectContaining({
        key: 'finance_manager',
        nameAr: 'الإدارة المالية',
        nameEn: 'Finance management',
        acknowledgeSod: true,
      }),
    );
    expect(create.mock.calls[0][1].permissions).toHaveLength(14);
    expect(audit.record.mock.calls[0][0].after).toMatchObject({
      preset: 'finance_manager',
      created: true,
      sodConflicts: [{ a: PERMISSIONS.INVOICE_WRITE, b: PERMISSIONS.PERIOD_MANAGE }],
      sodAcknowledged: true,
    });
  });

  it('is idempotent: the second apply finds the role equal to the preset and calls no role service, audits nothing', async () => {
    const roles = [role('site_engineer', [PERMISSIONS.WORKORDER_READ], { nameAr: 'مهندس موقع', nameEn: 'Site engineer' })];
    const { service, adminService } = world({ roles });
    const update = jest.spyOn(adminService, 'updateRole').mockImplementation(async (_u, id, dto) => {
      // What the real save leaves behind.
      Object.assign(roles[0], { nameAr: dto.nameAr, nameEn: dto.nameEn, permissions: dto.permissions });
      return { id } as never;
    });

    const first = await service.applyPreset(admin(), 'site_engineer');
    expect(first.applied).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledTimes(1);

    const second = await service.applyPreset(admin(), 'site_engineer');
    expect(second.applied).toBe(false);
    expect(update).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(second.presets.find((p) => p.key === 'site_engineer')!.status).toBe('same');
  });

  it('lets the role service refuse what the preview predicts (APPROVAL_SEAT), and records nothing of its own', async () => {
    const { service, adminService } = world({ roles: [role('pm', [PERMISSIONS.PROJECT_APPROVE])] });
    jest.spyOn(adminService, 'updateRole').mockRejectedValue(
      new BadRequestException({ code: 'APPROVAL_SEAT', rules: [], openRequests: 1 }),
    );
    await expect(service.applyPreset(admin(), 'pm')).rejects.toBeInstanceOf(BadRequestException);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('404 for a key with no preset (admin, sales, anything else)', async () => {
    const { service } = world({ roles: [] });
    await expect(service.applyPreset(admin(), 'admin')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.applyPreset(admin(), 'sales')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('RolePresetsService.applyRules', () => {
  const roles = () => [
    role('pm', [PERMISSIONS.PROCUREMENT_APPROVE, PERMISSIONS.PROJECT_APPROVE]),
    role('executive', [PERMISSIONS.PROPOSAL_APPROVE, PERMISSIONS.PROCUREMENT_APPROVE]),
  ];
  const users = [
    { id: 'u-pm', roleId: 'role-pm' },
    { id: 'u-ex', roleId: 'role-executive' },
  ];

  it('updates the first active rule of a type, switches the others off first, creates where none, skips same, reports blocked', async () => {
    const { service, approvals } = world({
      roles: roles(),
      users,
      rules: [
        { id: 'pr-low', documentType: 'PURCHASE_REQUISITION', minAmount: 0, maxAmount: 10000, isActive: true, steps: ['executive'] },
        { id: 'pr-high', documentType: 'PURCHASE_REQUISITION', minAmount: 10000, maxAmount: null, isActive: true, steps: ['pm'] },
        { id: 'pr-off', documentType: 'PURCHASE_REQUISITION', minAmount: 0, maxAmount: null, isActive: false, steps: ['pm'] },
        { id: 'co', documentType: 'CHANGE_ORDER', minAmount: 100000, maxAmount: null, isActive: true, steps: ['pm'] },
        { id: 'prop', documentType: 'PROPOSAL', minAmount: 0, maxAmount: null, isActive: true, steps: ['executive'] },
      ],
    });

    const { outcomes } = await service.applyRules(admin());

    expect(outcomes).toEqual([
      { documentType: 'PURCHASE_REQUISITION', outcome: 'updated', ruleId: 'pr-low', deactivated: ['pr-high'] },
      { documentType: 'PURCHASE_ORDER', outcome: 'created', ruleId: 'new-PURCHASE_ORDER' },
      { documentType: 'PROGRESS_CLAIM', outcome: 'created', ruleId: 'new-PROGRESS_CLAIM' },
      {
        documentType: 'CHANGE_ORDER',
        outcome: 'blocked',
        blockedBy: [{ code: 'ROLE_LACKS_KEY', role: 'executive', permission: PERMISSIONS.PROJECT_APPROVE }],
      },
      { documentType: 'PROPOSAL', outcome: 'same' },
    ]);
    // The other band goes off BEFORE the first widens to [0, ∞), or the band check would refuse it.
    expect(approvals.update.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ['pr-high', { isActive: false }],
      ['pr-low', { minAmount: 0, maxAmount: null, isActive: true, steps: [{ roleId: 'role-pm' }] }],
    ]);
    expect(approvals.create.mock.calls.map((c) => c[1])).toEqual([
      { documentType: 'PURCHASE_ORDER', minAmount: 0, maxAmount: null, isActive: true, steps: [{ roleId: 'role-executive' }] },
      {
        documentType: 'PROGRESS_CLAIM',
        minAmount: 0,
        maxAmount: null,
        isActive: true,
        steps: [{ roleId: 'role-pm' }, { roleId: 'role-executive' }],
      },
    ]);
    // Nothing touched the inactive rule, the blocked change order or the same proposal.
    const touched = approvals.update.mock.calls.map((c) => c[1]);
    expect(touched).not.toContain('pr-off');
    expect(touched).not.toContain('co');
    expect(touched).not.toContain('prop');
  });

  it('a refused update switches the rules it turned off back on and reports the failure', async () => {
    const { service, approvals } = world({
      roles: roles(),
      users,
      rules: [
        { id: 'pr-low', documentType: 'PURCHASE_REQUISITION', minAmount: 0, maxAmount: 10000, isActive: true, steps: ['pm'] },
        { id: 'pr-high', documentType: 'PURCHASE_REQUISITION', minAmount: 10000, maxAmount: null, isActive: true, steps: ['pm'] },
      ],
    });
    approvals.update.mockImplementation(async (_u: AuthUser, id: string, dto: unknown) => {
      if (id === 'pr-low') throw new BadRequestException('Role "pm" has no active users');
      return { id, dto };
    });

    const { outcomes } = await service.applyRules(admin());

    expect(outcomes[0]).toEqual({
      documentType: 'PURCHASE_REQUISITION',
      outcome: 'failed',
      error: 'Role "pm" has no active users',
      deactivated: [],
    });
    expect(approvals.update.mock.calls.slice(0, 3).map((c) => [c[1], c[2]])).toEqual([
      ['pr-high', { isActive: false }],
      ['pr-low', expect.objectContaining({ minAmount: 0, maxAmount: null })],
      ['pr-high', { isActive: true }],
    ]);
  });
});
