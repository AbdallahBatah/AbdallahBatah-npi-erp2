import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DepartmentsService } from './departments.service';
import type { AuthUser } from '../../common/auth-user';

const admin = (over: Partial<AuthUser> = {}): AuthUser => ({
  userId: 'admin1',
  organizationId: 'org1',
  email: 'admin@npi.sa',
  roleId: 'role-admin',
  roleKey: 'admin',
  permissions: ['admin.department.manage'],
  locale: 'AR',
  ...over,
});

const audit = { record: jest.fn().mockResolvedValue(undefined) };

/**
 * Prisma double over the department tree. `tree` maps id → parentId, which is
 * all the cycle guard walks; $transaction hands the callback the same double
 * so the audit row lands on the mock the assertions read.
 */
const prismaWith = (tree: Record<string, string | null> = {}, over: Record<string, unknown> = {}) => {
  const db: Record<string, unknown> = {
    department: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn(async ({ where }: any) =>
        where.id in tree ? { id: where.id, parentId: tree[where.id], nameAr: where.id } : null,
      ),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(Object.keys(tree).length),
      create: jest.fn(async ({ data }: any) => ({ id: 'new', ...data })),
      update: jest.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
    },
    user: {
      findFirst: jest.fn(async ({ where }: any) => ({ id: where.id, isActive: true })),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn(async ({ where }: any) => where.id?.in?.length ?? 0),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    ...over,
  };
  db.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return db;
};

const make = (prisma: unknown) => new DepartmentsService(prisma as never, audit as never);

beforeEach(() => jest.clearAllMocks());

describe('create', () => {
  const dto = { code: 'ENG', nameAr: 'الهندسة', nameEn: 'Engineering' };

  it('refuses a code already used in this organization', async () => {
    const prisma = prismaWith();
    (prisma.department as any).findUnique.mockResolvedValue({ id: 'existing' });
    await expect(make(prisma).create(admin(), dto as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('stamps the organization from the token and falls back to the Arabic name', async () => {
    const prisma = prismaWith();
    await make(prisma).create(admin(), { code: 'eng', nameAr: 'الهندسة' } as never);
    expect((prisma.department as any).create.mock.calls[0][0].data).toMatchObject({
      organizationId: 'org1',
      // The code is the tenant-visible key; normalising it here keeps "eng"
      // and "ENG" from becoming two departments.
      code: 'ENG',
      nameAr: 'الهندسة',
      nameEn: 'الهندسة',
      isActive: true,
    });
  });

  it('refuses a manager who is not a user of this organization', async () => {
    const prisma = prismaWith({}, { user: { findFirst: jest.fn().mockResolvedValue(null) } });
    await expect(
      make(prisma).create(admin(), { ...dto, managerId: 'ghost' } as never),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses a deactivated manager', async () => {
    const prisma = prismaWith(
      {},
      { user: { findFirst: jest.fn().mockResolvedValue({ id: 'u1', isActive: false }) } },
    );
    await expect(
      make(prisma).create(admin(), { ...dto, managerId: 'u1' } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('records the creation inside the same transaction', async () => {
    const prisma = prismaWith();
    await make(prisma).create(admin(), dto as never);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0][0]).toMatchObject({
      entityType: 'Department',
      action: 'CREATE',
      actorId: 'admin1',
    });
    expect(audit.record.mock.calls[0][1]).toBe(prisma);
  });
});

// ── the hierarchy must stay a tree ──────────────────────────────────────────

describe('parent cycles', () => {
  it('refuses a department as its own parent', async () => {
    const prisma = prismaWith({ a: null });
    await expect(
      make(prisma).update(admin(), 'a', { parentId: 'a' } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a parent that is a descendant — the loop it would close', async () => {
    // a → b → c. Making c the parent of a closes the ring, and anything that
    // walks the chain afterwards never terminates.
    const prisma = prismaWith({ a: null, b: 'a', c: 'b' });
    await expect(
      make(prisma).update(admin(), 'a', { parentId: 'c' } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a parent on another branch', async () => {
    const prisma = prismaWith({ a: null, b: 'a', x: null });
    await expect(
      make(prisma).update(admin(), 'b', { parentId: 'x' } as never),
    ).resolves.toBeDefined();
  });

  it('terminates on a pre-existing cycle instead of hanging', async () => {
    // A row hand-inserted into the database can already form a loop. The guard
    // is bounded by the department count so it reports a problem rather than
    // becoming one.
    const prisma = prismaWith({ a: null, p: 'q', q: 'p' });
    await expect(
      make(prisma).update(admin(), 'a', { parentId: 'p' } as never),
    ).resolves.toBeDefined();
  });

  it('404s on a department belonging to another organization', async () => {
    const prisma = prismaWith({});
    await expect(make(prisma).update(admin(), 'a', {} as never)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

// ── membership ──────────────────────────────────────────────────────────────

describe('setMembers', () => {
  it('detaches everyone absent from the list and attaches everyone in it', async () => {
    const prisma = prismaWith({ d1: null });
    (prisma.user as any).findMany.mockResolvedValue([{ id: 'u1' }, { id: 'u2' }]);
    await make(prisma).setMembers(admin(), 'd1', { userIds: ['u2', 'u3'] } as never);

    const [detach, attach] = (prisma.user as any).updateMany.mock.calls.map((c: any) => c[0]);
    expect(detach).toMatchObject({
      where: { organizationId: 'org1', departmentId: 'd1', id: { notIn: ['u2', 'u3'] } },
      data: { departmentId: null },
    });
    expect(attach).toMatchObject({
      where: { organizationId: 'org1', id: { in: ['u2', 'u3'] } },
      data: { departmentId: 'd1' },
    });
  });

  it('empties the department when given an empty list', async () => {
    const prisma = prismaWith({ d1: null });
    (prisma.user as any).findMany.mockResolvedValue([{ id: 'u1' }]);
    await make(prisma).setMembers(admin(), 'd1', { userIds: [] } as never);
    const calls = (prisma.user as any).updateMany.mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0].data).toEqual({ departmentId: null });
  });

  it('refuses a user id that does not belong to this organization', async () => {
    // The id list comes from the client. Without this check the attach query
    // would silently no-op on a foreign id — or, worse, match one.
    const prisma = prismaWith({ d1: null });
    (prisma.user as any).count.mockResolvedValue(1);
    await expect(
      make(prisma).setMembers(admin(), 'd1', { userIds: ['u1', 'foreign'] } as never),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect((prisma.user as any).updateMany).not.toHaveBeenCalled();
  });

  it('records the before and after membership on the trail', async () => {
    const prisma = prismaWith({ d1: null });
    (prisma.user as any).findMany.mockResolvedValue([{ id: 'u1' }]);
    await make(prisma).setMembers(admin(), 'd1', { userIds: ['u2'] } as never);
    expect(audit.record.mock.calls[0][0]).toMatchObject({
      entityType: 'Department',
      entityId: 'd1',
      action: 'SET_MEMBERS',
      before: { userIds: ['u1'] },
      after: { userIds: ['u2'] },
    });
    expect(audit.record.mock.calls[0][1]).toBe(prisma);
  });
});
