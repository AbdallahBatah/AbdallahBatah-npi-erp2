import { BadRequestException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PERMISSIONS } from '@npi/shared';
import { AdminService } from './admin.service';
import { SetUserPermissionsDto } from './dto';
import { EffectivePermissionsService } from '../../common/effective-permissions.service';
import { holdsEffectively } from '../../common/permission-predicates';
import type { AuthUser } from '../../common/auth-user';

const admin = (): AuthUser => ({
  userId: 'admin1',
  organizationId: 'org1',
  email: 'admin@npi.sa',
  roleId: 'role-admin',
  roleKey: 'admin',
  roleIds: ['role-admin'],
  permissions: [PERMISSIONS.USER_MANAGE],
  locale: 'AR',
});

const role = (id: string, permissions: string[] = []) => ({
  id,
  key: id,
  nameAr: id,
  nameEn: id,
  permissions,
});

const audit = { record: jest.fn().mockResolvedValue(undefined) };

/**
 * Prisma double: $transaction hands the callback the same double, so a write
 * made through the transaction lands on the very mocks the assertions read.
 * `user.count` answers the lockout post-condition: 1 (an administrator remains)
 * unless a test says 0.
 */
const prismaWith = (over: Record<string, unknown> = {}) => {
  const db: Record<string, unknown> = {
    user: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn(),
      count: jest.fn().mockResolvedValue(1),
    },
    role: {
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn(),
      delete: jest.fn(),
    },
    userRole: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      count: jest.fn().mockResolvedValue(0),
    },
    userPermissionOverride: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    approvalRuleStep: { count: jest.fn().mockResolvedValue(0) },
    approvalStep: { count: jest.fn().mockResolvedValue(0) },
    $executeRaw: jest.fn().mockResolvedValue(0),
    ...over,
  };
  db.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return db as {
    user: Record<string, jest.Mock>;
    role: Record<string, jest.Mock>;
    userRole: Record<string, jest.Mock>;
    userPermissionOverride: Record<string, jest.Mock>;
    approvalRuleStep: Record<string, jest.Mock>;
    approvalStep: Record<string, jest.Mock>;
    $executeRaw: jest.Mock;
    $transaction: jest.Mock;
  };
};

const make = (prisma: unknown) =>
  new AdminService(prisma as never, audit as never, new EffectivePermissionsService(prisma as never));

/** The lockout post-condition's filter: active users of org1 who hold admin.user.manage effectively. */
const LOCKOUT_WHERE = {
  organizationId: 'org1',
  isActive: true,
  AND: [holdsEffectively(PERMISSIONS.USER_MANAGE)],
};

/** The tagged-template SQL of a `$executeRaw` call, with its parameters. */
const rawSql = (call: unknown[]) => ({
  sql: (call[0] as TemplateStringsArray).join('?'),
  params: call.slice(1),
});

const row = (over: Record<string, unknown> = {}) => ({
  id: 'u2',
  email: 'x@npi.sa',
  nameAr: 'س',
  nameEn: 'X',
  locale: 'AR',
  isActive: true,
  createdAt: new Date(),
  role: role('role-sales'),
  extraRoles: [] as Array<{ role: ReturnType<typeof role> }>,
  ...over,
});

beforeEach(() => jest.clearAllMocks());

describe('AdminService.listUsers', () => {
  it('flattens extraRoles into roles: [primary, ...extras]', async () => {
    const prisma = prismaWith();
    prisma.user.findMany.mockResolvedValue([
      row({ extraRoles: [{ role: role('role-cost') }, { role: role('role-pm') }] }),
    ]);
    const [u] = await make(prisma).listUsers(admin());
    expect(u.roles.map((r) => r.id)).toEqual(['role-sales', 'role-cost', 'role-pm']);
    expect(u.role.id).toBe('role-sales');
    expect('extraRoles' in u).toBe(false);
  });
});

describe('AdminService.updateUser - extra roles', () => {
  const target = (over: Record<string, unknown> = {}) => ({
    id: 'u2',
    organizationId: 'org1',
    roleId: 'role-sales',
    isActive: true,
    nameAr: 'س',
    role: role('role-sales'),
    extraRoles: [] as Array<{ roleId: string; role: ReturnType<typeof role> }>,
    ...over,
  });

  it('REPLACES the whole set inside one transaction (deleteMany then createMany) and audits before/after', async () => {
    const prisma = prismaWith();
    prisma.user.findFirst.mockResolvedValue(
      target({ extraRoles: [{ roleId: 'role-old', role: role('role-old') }] }),
    );
    prisma.role.count.mockResolvedValue(2);
    prisma.user.findUniqueOrThrow.mockResolvedValue(row());
    await make(prisma).updateUser(admin(), 'u2', { extraRoleIds: ['role-cost', 'role-pm'] });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.userRole.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u2' } });
    expect(prisma.userRole.createMany).toHaveBeenCalledWith({
      data: [
        { userId: 'u2', roleId: 'role-cost' },
        { userId: 'u2', roleId: 'role-pm' },
      ],
    });
    const call = audit.record.mock.calls[0][0];
    expect(call.before.extraRoleIds).toEqual(['role-old']);
    expect(call.after.extraRoleIds).toEqual(['role-cost', 'role-pm']);
    // hard rule 3: the audit row is written through the transaction
    expect(audit.record.mock.calls[0][1]).toBe(prisma);
  });

  it('an empty array clears the set; an omitted field leaves it untouched', async () => {
    const prisma = prismaWith();
    prisma.user.findFirst.mockResolvedValue(
      target({ extraRoles: [{ roleId: 'role-old', role: role('role-old') }] }),
    );
    prisma.user.findUniqueOrThrow.mockResolvedValue(row());
    await make(prisma).updateUser(admin(), 'u2', { extraRoleIds: [] });
    expect(prisma.userRole.deleteMany).toHaveBeenCalled();
    expect(prisma.userRole.createMany).not.toHaveBeenCalled();

    prisma.userRole.deleteMany.mockClear();
    await make(prisma).updateUser(admin(), 'u2', { nameEn: 'Y' });
    expect(prisma.userRole.deleteMany).not.toHaveBeenCalled();
  });

  it('refuses an extra role equal to the primary role, and one from another organization', async () => {
    const prisma = prismaWith();
    prisma.user.findFirst.mockResolvedValue(target());
    await expect(
      make(prisma).updateUser(admin(), 'u2', { extraRoleIds: ['role-sales'] }),
    ).rejects.toThrow(BadRequestException);
    prisma.role.count.mockResolvedValue(0); // none owned by this org
    await expect(
      make(prisma).updateUser(admin(), 'u2', { extraRoleIds: ['foreign'] }),
    ).rejects.toThrow(NotFoundException);
    expect(prisma.userRole.deleteMany).not.toHaveBeenCalled();
  });

  it('lockout post-condition: dropping the extra user-manager role is rolled back if nobody else manages users', async () => {
    const prisma = prismaWith();
    prisma.user.findFirst.mockResolvedValue(
      target({
        role: role('role-sales'),
        extraRoles: [
          { roleId: 'role-mgr', role: role('role-mgr', [PERMISSIONS.USER_MANAGE]) },
        ],
      }),
    );
    prisma.user.count.mockResolvedValue(0); // nobody holds the key after the write
    await expect(
      make(prisma).updateUser(admin(), 'u2', { extraRoleIds: [] }),
    ).rejects.toThrow(new BadRequestException('Cannot remove the last active administrator'));
    // the write happened INSIDE the transaction, the count after it, and the
    // throw rolls both back; nothing was audited
    expect(prisma.userRole.deleteMany).toHaveBeenCalled();
    expect(prisma.userRole.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.user.count.mock.invocationCallOrder[0],
    );
    expect(prisma.user.count.mock.calls[0][0].where).toEqual(LOCKOUT_WHERE);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('does not trip the guard when an administrator remains after the write', async () => {
    const prisma = prismaWith();
    prisma.user.findFirst.mockResolvedValue(
      target({
        extraRoles: [{ roleId: 'role-mgr', role: role('role-mgr', [PERMISSIONS.USER_MANAGE]) }],
      }),
    );
    prisma.role.count.mockResolvedValue(1);
    prisma.user.findUniqueOrThrow.mockResolvedValue(row());
    await expect(
      make(prisma).updateUser(admin(), 'u2', { extraRoleIds: ['role-mgr2'] }),
    ).resolves.toBeDefined();
    expect(prisma.user.count).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });
});

describe('AdminService.updateUser - the lockout post-condition (ADR-02 hard rule 4)', () => {
  const target = (over: Record<string, unknown> = {}) => ({
    id: 'u2',
    organizationId: 'org1',
    roleId: 'role-admin',
    isActive: true,
    nameAr: 'س',
    extraRoles: [] as Array<{ roleId: string }>,
    ...over,
  });

  it('deactivating the last effective administrator answers 400 and audits nothing', async () => {
    const prisma = prismaWith();
    prisma.user.findFirst.mockResolvedValue(target());
    prisma.user.count.mockResolvedValue(0);
    await expect(make(prisma).updateUser(admin(), 'u2', { isActive: false })).rejects.toThrow(
      new BadRequestException('Cannot remove the last active administrator'),
    );
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'u2' }, data: expect.objectContaining({ isActive: false }) }),
    );
    expect(prisma.user.count.mock.calls[0][0].where).toEqual(LOCKOUT_WHERE);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('changing the last administrator’s primary role away answers 400', async () => {
    const prisma = prismaWith();
    prisma.user.findFirst.mockResolvedValue(target());
    prisma.role.findFirst.mockResolvedValue(role('role-sales'));
    prisma.user.count.mockResolvedValue(0);
    await expect(make(prisma).updateUser(admin(), 'u2', { roleId: 'role-sales' })).rejects.toThrow(
      /last active administrator/,
    );
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ roleId: 'role-sales' }) }),
    );
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('takes the organization’s advisory lock first, inside the transaction', async () => {
    const prisma = prismaWith();
    prisma.user.findFirst.mockResolvedValue(target());
    prisma.user.findUniqueOrThrow.mockResolvedValue(row());
    await make(prisma).updateUser(admin(), 'u2', { isActive: false });
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const { sql, params } = rawSql(prisma.$executeRaw.mock.calls[0]);
    expect(sql).toBe('SELECT pg_advisory_xact_lock(hashtext(?))');
    expect(params).toEqual(['user-admin:org1']);
    expect(prisma.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.user.update.mock.invocationCallOrder[0],
    );
    // the audit row is written through the transaction (hard rule 3)
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'UPDATE' }), prisma);
  });

  it('a rename cannot take user management away: no lock, no count', async () => {
    const prisma = prismaWith();
    prisma.user.findFirst.mockResolvedValue(target());
    prisma.user.findUniqueOrThrow.mockResolvedValue(row());
    await make(prisma).updateUser(admin(), 'u2', { nameEn: 'Renamed', locale: 'EN' });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(prisma.user.count).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'UPDATE' }), prisma);
  });
});

describe('AdminService.updateRole - the lockout post-condition', () => {
  const adminRole = () => ({ ...role('role-admin', [PERMISSIONS.USER_MANAGE, 'crm.lead.read']), organizationId: 'org1' });

  it('stripping admin.user.manage from the last administrator role answers 400 after the write, audits nothing', async () => {
    const prisma = prismaWith();
    prisma.role.findFirst.mockResolvedValue(adminRole());
    prisma.role.update.mockResolvedValue({ ...adminRole(), permissions: ['crm.lead.read'] });
    prisma.user.count.mockResolvedValue(0);
    await expect(
      make(prisma).updateRole(admin(), 'role-admin', { permissions: ['crm.lead.read'] }),
    ).rejects.toThrow(new BadRequestException('Cannot remove user management from the last administrator role'));
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma.role.update.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.user.count.mock.invocationCallOrder[0],
    );
    expect(prisma.user.count.mock.calls[0][0].where).toEqual(LOCKOUT_WHERE);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('passes when someone still holds the key effectively (a GRANT counts), and audits inside the transaction', async () => {
    const prisma = prismaWith();
    prisma.role.findFirst.mockResolvedValue(adminRole());
    prisma.role.update.mockResolvedValue({ ...adminRole(), permissions: ['crm.lead.read'] });
    await expect(
      make(prisma).updateRole(admin(), 'role-admin', { permissions: ['crm.lead.read'] }),
    ).resolves.toMatchObject({ permissions: ['crm.lead.read'] });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'Role', action: 'UPDATE' }),
      prisma,
    );
  });

  it('keeping the key, adding keys or renaming takes no lock and counts nobody', async () => {
    const prisma = prismaWith();
    prisma.role.findFirst.mockResolvedValue(adminRole());
    prisma.role.update.mockResolvedValue(adminRole());
    await make(prisma).updateRole(admin(), 'role-admin', {
      nameAr: 'مدير',
      permissions: [PERMISSIONS.USER_MANAGE, 'crm.lead.read', 'crm.task.read'],
    });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(prisma.user.count).not.toHaveBeenCalled();
  });
});

describe('AdminService - per-user permission overrides (ADR-02 §3-1)', () => {
  const ENGINEER = {
    id: 'u2',
    organizationId: 'org1',
    isActive: true,
    roleId: 'role-eng',
    role: role('role-eng', ['scm.requisition.write', 'projects.project.read']),
    extraRoles: [{ role: role('role-cost', ['finance.costs.view']) }],
    permissionOverrides: [
      {
        permission: 'scm.requisition.write',
        effect: 'DENY' as const,
        reason: 'on leave',
        createdById: 'admin1',
        createdAt: new Date('2026-10-12T08:00:00Z'),
      },
      {
        permission: 'crm.lead.read',
        effect: 'GRANT' as const,
        reason: null,
        createdById: null,
        createdAt: new Date('2026-10-11T08:00:00Z'),
      },
    ],
  };

  describe('GET', () => {
    it('answers the roles (primary first, with their keys), the overrides by key with their author, and the effective set', async () => {
      const prisma = prismaWith();
      prisma.user.findUnique.mockResolvedValue(ENGINEER);
      prisma.user.findMany.mockResolvedValue([{ id: 'admin1', nameAr: 'مدير', nameEn: 'Admin' }]);
      const out = await make(prisma).getUserPermissions(admin(), 'u2');
      expect(out).toEqual({
        roles: [
          { id: 'role-eng', key: 'role-eng', nameAr: 'role-eng', nameEn: 'role-eng', permissions: ['scm.requisition.write', 'projects.project.read'] },
          { id: 'role-cost', key: 'role-cost', nameAr: 'role-cost', nameEn: 'role-cost', permissions: ['finance.costs.view'] },
        ],
        overrides: [
          { permission: 'crm.lead.read', effect: 'GRANT', reason: null, createdAt: ENGINEER.permissionOverrides[1].createdAt, createdBy: null },
          {
            permission: 'scm.requisition.write',
            effect: 'DENY',
            reason: 'on leave',
            createdAt: ENGINEER.permissionOverrides[0].createdAt,
            createdBy: { id: 'admin1', nameAr: 'مدير', nameEn: 'Admin' },
          },
        ],
        effective: ['crm.lead.read', 'finance.costs.view', 'projects.project.read'],
      });
      // the authors are looked up inside the caller's organization only
      expect(prisma.user.findMany.mock.calls[0][0].where).toEqual({ id: { in: ['admin1'] }, organizationId: 'org1' });
    });

    it('404s on a user of another organization, and on an unknown one', async () => {
      const prisma = prismaWith();
      prisma.user.findUnique.mockResolvedValue({ ...ENGINEER, organizationId: 'org2' });
      await expect(make(prisma).getUserPermissions(admin(), 'u2')).rejects.toThrow(NotFoundException);
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(make(prisma).getUserPermissions(admin(), 'nobody')).rejects.toThrow(NotFoundException);
    });
  });

  describe('PUT', () => {
    const withTarget = (current: Array<{ permission: string; effect: 'GRANT' | 'DENY'; reason: string | null }> = []) => {
      const prisma = prismaWith();
      prisma.user.findFirst.mockResolvedValue({ id: 'u2' });
      prisma.userPermissionOverride.findMany.mockResolvedValue(current);
      prisma.user.findUnique.mockResolvedValue({ ...ENGINEER, permissionOverrides: [] });
      return prisma;
    };

    it('REPLACES the whole set in one transaction — lock, deleteMany, createMany, post-condition, audit — and answers the GET shape', async () => {
      const prisma = withTarget([{ permission: 'crm.lead.read', effect: 'GRANT', reason: null }]);
      const out = await make(prisma).setUserPermissions(admin(), 'u2', {
        overrides: [
          { permission: 'scm.requisition.write', effect: 'DENY', reason: '  on leave  ' },
          { permission: 'fsm.workorder.read', effect: 'GRANT' },
        ],
      });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(rawSql(prisma.$executeRaw.mock.calls[0]).params).toEqual(['user-admin:org1']);
      // the set being replaced is read under the lock, for the audit's "before"
      expect(prisma.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.userPermissionOverride.findMany.mock.invocationCallOrder[0],
      );
      expect(prisma.userPermissionOverride.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u2' } });
      expect(prisma.userPermissionOverride.createMany).toHaveBeenCalledWith({
        data: [
          { organizationId: 'org1', userId: 'u2', permission: 'fsm.workorder.read', effect: 'GRANT', reason: null, createdById: 'admin1' },
          { organizationId: 'org1', userId: 'u2', permission: 'scm.requisition.write', effect: 'DENY', reason: 'on leave', createdById: 'admin1' },
        ],
      });
      const order = [
        prisma.$executeRaw.mock.invocationCallOrder[0],
        prisma.userPermissionOverride.deleteMany.mock.invocationCallOrder[0],
        prisma.userPermissionOverride.createMany.mock.invocationCallOrder[0],
        prisma.user.count.mock.invocationCallOrder[0],
        audit.record.mock.invocationCallOrder[0],
      ];
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(prisma.user.count.mock.calls[0][0].where).toEqual(LOCKOUT_WHERE);
      // ONE audit row, on the user, inside the transaction, before and after
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(
        {
          organizationId: 'org1',
          actorId: 'admin1',
          entityType: 'User',
          entityId: 'u2',
          action: 'PERMISSION_OVERRIDE',
          before: { overrides: [{ permission: 'crm.lead.read', effect: 'GRANT', reason: null }] },
          after: {
            overrides: [
              { permission: 'fsm.workorder.read', effect: 'GRANT', reason: null },
              { permission: 'scm.requisition.write', effect: 'DENY', reason: 'on leave' },
            ],
          },
        },
        prisma,
      );
      expect(Object.keys(out)).toEqual(['roles', 'overrides', 'effective']);
    });

    it('an empty set clears every override', async () => {
      const prisma = withTarget([{ permission: 'crm.lead.read', effect: 'GRANT', reason: null }]);
      await make(prisma).setUserPermissions(admin(), 'u2', { overrides: [] });
      expect(prisma.userPermissionOverride.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u2' } });
      expect(prisma.userPermissionOverride.createMany).not.toHaveBeenCalled();
      expect(audit.record.mock.calls[0][0].after).toEqual({ overrides: [] });
    });

    it('saving the set already there writes nothing and audits nothing', async () => {
      const prisma = withTarget([
        { permission: 'scm.requisition.write', effect: 'DENY', reason: 'on leave' },
        { permission: 'crm.lead.read', effect: 'GRANT', reason: null },
      ]);
      await expect(
        make(prisma).setUserPermissions(admin(), 'u2', {
          overrides: [
            { permission: 'crm.lead.read', effect: 'GRANT', reason: '' },
            { permission: 'scm.requisition.write', effect: 'DENY', reason: 'on leave' },
          ],
        }),
      ).resolves.toMatchObject({ effective: expect.any(Array) });
      expect(prisma.userPermissionOverride.deleteMany).not.toHaveBeenCalled();
      expect(prisma.userPermissionOverride.createMany).not.toHaveBeenCalled();
      expect(prisma.user.count).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('DENY of admin.user.manage on the last effective administrator answers 400 and audits nothing', async () => {
      const prisma = withTarget();
      prisma.user.count.mockResolvedValue(0);
      await expect(
        make(prisma).setUserPermissions(admin(), 'u2', {
          overrides: [{ permission: PERMISSIONS.USER_MANAGE, effect: 'DENY' }],
        }),
      ).rejects.toThrow(new BadRequestException('Cannot remove the last active administrator'));
      expect(prisma.userPermissionOverride.createMany).toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('refuses an unknown key and a key named twice (400) before touching anything', async () => {
      const prisma = withTarget();
      await expect(
        make(prisma).setUserPermissions(admin(), 'u2', {
          overrides: [{ permission: 'admin.everything', effect: 'GRANT' }],
        }),
      ).rejects.toThrow(new BadRequestException('Unknown permission key: admin.everything'));
      await expect(
        make(prisma).setUserPermissions(admin(), 'u2', {
          overrides: [
            { permission: 'crm.lead.read', effect: 'GRANT' },
            { permission: 'crm.lead.read', effect: 'DENY' },
          ],
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('404s on a user of another organization, writing nothing', async () => {
      const prisma = withTarget();
      prisma.user.findFirst.mockResolvedValue(null);
      await expect(
        make(prisma).setUserPermissions(admin(), 'u-other-org', {
          overrides: [{ permission: 'crm.lead.read', effect: 'GRANT' }],
        }),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.user.findFirst.mock.calls[0][0].where).toEqual({ id: 'u-other-org', organizationId: 'org1' });
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('SetUserPermissionsDto', () => {
    const errorsOf = async (body: unknown) =>
      (await validate(plainToInstance(SetUserPermissionsDto, body))).map((e) => JSON.stringify(e));

    it('accepts known keys, GRANT / DENY and an optional reason', async () => {
      await expect(
        errorsOf({
          overrides: [
            { permission: 'crm.lead.read', effect: 'GRANT' },
            { permission: 'scm.requisition.write', effect: 'DENY', reason: 'on leave' },
          ],
        }),
      ).resolves.toEqual([]);
      await expect(errorsOf({ overrides: [] })).resolves.toEqual([]);
    });

    it('refuses an unknown key, a duplicate key, an unknown effect and a reason over 500 characters', async () => {
      const unknownKey = await errorsOf({ overrides: [{ permission: 'admin.everything', effect: 'GRANT' }] });
      expect(unknownKey.join()).toContain('Unknown permission key');
      const duplicate = await errorsOf({
        overrides: [
          { permission: 'crm.lead.read', effect: 'GRANT' },
          { permission: 'crm.lead.read', effect: 'DENY' },
        ],
      });
      expect(duplicate.join()).toContain('same permission twice');
      expect(await errorsOf({ overrides: [{ permission: 'crm.lead.read', effect: 'MAYBE' }] })).not.toEqual([]);
      expect(
        await errorsOf({ overrides: [{ permission: 'crm.lead.read', effect: 'DENY', reason: 'x'.repeat(501) }] }),
      ).not.toEqual([]);
      expect(await errorsOf({})).not.toEqual([]);
    });
  });
});

describe('AdminService.deleteRole', () => {
  it('refuses a role held only as someone\'s extra role, with the same message', async () => {
    const prisma = prismaWith();
    prisma.role.findFirst.mockResolvedValue(role('role-cost'));
    prisma.user.count.mockResolvedValue(0);
    prisma.userRole.count.mockResolvedValue(1);
    await expect(make(prisma).deleteRole(admin(), 'role-cost')).rejects.toThrow(
      'Role still has users assigned',
    );
    expect(prisma.role.delete).not.toHaveBeenCalled();
  });
});
