import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PERMISSIONS } from '@npi/shared';
import { AdminService } from './admin.service';
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

/** Prisma double: $transaction hands the callback the same double. */
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
      delete: jest.fn(),
    },
    userRole: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      count: jest.fn().mockResolvedValue(0),
    },
    approvalRuleStep: { count: jest.fn().mockResolvedValue(0) },
    approvalStep: { count: jest.fn().mockResolvedValue(0) },
    ...over,
  };
  db.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return db as {
    user: Record<string, jest.Mock>;
    role: Record<string, jest.Mock>;
    userRole: Record<string, jest.Mock>;
    approvalRuleStep: Record<string, jest.Mock>;
    approvalStep: Record<string, jest.Mock>;
    $transaction: jest.Mock;
  };
};

const make = (prisma: unknown) => new AdminService(prisma as never, audit as never);

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

  it('lockout guard counts an extra role: dropping the extra user-manager role is refused if nobody else manages users', async () => {
    const prisma = prismaWith();
    prisma.user.findFirst.mockResolvedValue(
      target({
        role: role('role-sales'),
        extraRoles: [
          { roleId: 'role-mgr', role: role('role-mgr', [PERMISSIONS.USER_MANAGE]) },
        ],
      }),
    );
    prisma.user.count.mockResolvedValue(0); // no OTHER manager
    await expect(
      make(prisma).updateUser(admin(), 'u2', { extraRoleIds: [] }),
    ).rejects.toThrow(/last active administrator/);
    expect(prisma.userRole.deleteMany).not.toHaveBeenCalled();
    // the check looked for managers via primary OR extra roles
    const where = prisma.user.count.mock.calls[0][0].where;
    expect(JSON.stringify(where)).toContain('extraRoles');
  });

  it('does not trip the guard when the user keeps user-management through the new set', async () => {
    const prisma = prismaWith();
    prisma.user.findFirst.mockResolvedValue(
      target({
        extraRoles: [{ roleId: 'role-mgr', role: role('role-mgr', [PERMISSIONS.USER_MANAGE]) }],
      }),
    );
    prisma.role.count.mockResolvedValue(1);
    prisma.role.findMany.mockResolvedValue([role('role-mgr2', [PERMISSIONS.USER_MANAGE])]);
    prisma.user.findUniqueOrThrow.mockResolvedValue(row());
    await expect(
      make(prisma).updateUser(admin(), 'u2', { extraRoleIds: ['role-mgr2'] }),
    ).resolves.toBeDefined();
    expect(prisma.user.count).not.toHaveBeenCalled();
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
