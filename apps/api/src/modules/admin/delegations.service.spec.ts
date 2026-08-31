import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DelegationsService, delegationState } from './delegations.service';
import type { AuthUser } from '../../common/auth-user';

const admin = (over: Partial<AuthUser> = {}): AuthUser => ({
  userId: 'admin1',
  organizationId: 'org1',
  email: 'admin@npi.sa',
  roleId: 'role-admin',
  roleKey: 'admin',
  permissions: ['admin.delegation.manage'],
  locale: 'AR',
  ...over,
});

const audit = { record: jest.fn().mockResolvedValue(undefined) };

const activeUser = (id: string) => ({ id, isActive: true, nameAr: id });

/**
 * Prisma double: only what DelegationsService reaches for. $transaction hands
 * the callback the same double, so writes made through the transaction client
 * land on the mocks the assertions read — including the audit row.
 */
const prismaWith = (over: Record<string, unknown> = {}) => {
  const db: Record<string, unknown> = {
    user: { findFirst: jest.fn(async ({ where }: any) => activeUser(where.id)) },
    approvalDelegation: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(async ({ data }: any) => ({ id: 'd1', reason: null, ...data })),
      update: jest.fn(async ({ data }: any) => ({
        id: 'd1',
        startsAt: new Date(),
        endsAt: new Date(),
        ...data,
      })),
    },
    ...over,
  };
  db.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return db;
};

const make = (prisma: unknown) => new DelegationsService(prisma as never, audit as never);

const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

beforeEach(() => jest.clearAllMocks());

// ── the state a row is in, derived rather than stored ───────────────────────

describe('delegationState', () => {
  const at = new Date('2026-06-15T12:00:00Z');

  it('is REVOKED whatever the dates say, once the flag is down', () => {
    expect(
      delegationState(
        {
          isActive: false,
          startsAt: new Date('2026-06-01T00:00:00Z'),
          endsAt: new Date('2026-07-01T00:00:00Z'),
        },
        at,
      ),
    ).toBe('REVOKED');
  });

  it('is EXPIRED once the window has passed, even with the flag still up', () => {
    // The flag is never lowered by a job, so a delegation whose window closed
    // must read as expired from the dates alone — otherwise a failed nightly
    // task would leave borrowed authority looking live.
    expect(
      delegationState(
        {
          isActive: true,
          startsAt: new Date('2026-05-01T00:00:00Z'),
          endsAt: new Date('2026-06-01T00:00:00Z'),
        },
        at,
      ),
    ).toBe('EXPIRED');
  });

  it('separates a window not yet open from one currently open', () => {
    const future = {
      isActive: true,
      startsAt: new Date('2026-07-01T00:00:00Z'),
      endsAt: new Date('2026-08-01T00:00:00Z'),
    };
    const now = {
      isActive: true,
      startsAt: new Date('2026-06-01T00:00:00Z'),
      endsAt: new Date('2026-07-01T00:00:00Z'),
    };
    expect(delegationState(future, at)).toBe('SCHEDULED');
    expect(delegationState(now, at)).toBe('ACTIVE');
  });
});

// ── creation guards ─────────────────────────────────────────────────────────

describe('create', () => {
  const dto = (over: Record<string, unknown> = {}) => ({
    fromUserId: 'u-from',
    toUserId: 'u-to',
    startsAt: days(1),
    endsAt: days(10),
    ...over,
  });

  it('refuses self-delegation', async () => {
    const svc = make(prismaWith());
    await expect(
      svc.create(admin(), dto({ fromUserId: 'u1', toUserId: 'u1' }) as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a window that ends before it starts', async () => {
    const svc = make(prismaWith());
    await expect(
      svc.create(admin(), dto({ startsAt: days(10), endsAt: days(1) }) as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a window that has already passed', async () => {
    const svc = make(prismaWith());
    await expect(
      svc.create(admin(), dto({ startsAt: days(-20), endsAt: days(-10) }) as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a delegation involving a deactivated user', async () => {
    const prisma = prismaWith({
      user: {
        findFirst: jest.fn(async ({ where }: any) => ({
          id: where.id,
          nameAr: where.id,
          isActive: where.id !== 'u-to',
        })),
      },
    });
    await expect(make(prisma).create(admin(), dto() as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses a user from another organization', async () => {
    const prisma = prismaWith({ user: { findFirst: jest.fn().mockResolvedValue(null) } });
    await expect(make(prisma).create(admin(), dto() as never)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('refuses a second delegation overlapping an active one for the same pair', async () => {
    const prisma = prismaWith();
    (prisma.approvalDelegation as any).findFirst.mockResolvedValue({ id: 'existing' });
    await expect(make(prisma).create(admin(), dto() as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    // The overlap query must be half-open and pair-scoped, or it either misses
    // clashes or refuses two unrelated delegations.
    const where = (prisma.approvalDelegation as any).findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({
      organizationId: 'org1',
      fromUserId: 'u-from',
      toUserId: 'u-to',
      isActive: true,
    });
    expect(where.startsAt).toHaveProperty('lt');
    expect(where.endsAt).toHaveProperty('gt');
  });

  it('allows a window that begins exactly where the previous one ended', async () => {
    // Half-open: a holiday ending the day the next begins must be expressible.
    // The double returns null for the overlap probe, which is what the real
    // query would do for touching windows.
    const prisma = prismaWith();
    await expect(make(prisma).create(admin(), dto() as never)).resolves.toMatchObject({
      fromUserId: 'u-from',
      toUserId: 'u-to',
    });
  });

  it('stamps the organization from the token, never from the body', async () => {
    const prisma = prismaWith();
    await make(prisma).create(
      admin(),
      { ...dto(), organizationId: 'other-org' } as never,
    );
    expect((prisma.approvalDelegation as any).create.mock.calls[0][0].data).toMatchObject({
      organizationId: 'org1',
      createdById: 'admin1',
    });
  });

  it('records the grant on the audit trail inside the same transaction', async () => {
    const prisma = prismaWith();
    await make(prisma).create(admin(), dto() as never);
    expect(audit.record).toHaveBeenCalledTimes(1);
    const [entry, tx] = audit.record.mock.calls[0];
    expect(entry).toMatchObject({
      organizationId: 'org1',
      actorId: 'admin1',
      entityType: 'ApprovalDelegation',
      action: 'CREATE',
    });
    // Same client the write went through — an audit row written outside the
    // transaction can survive a rolled-back grant, or vanish with a committed one.
    expect(tx).toBe(prisma);
  });

  it('does not refuse a delegation from someone who is already a delegate', async () => {
    // Delegation does not chain: A→B and B→C lends C nothing of A's, so
    // refusing B→C would be theatre rather than a control.
    const prisma = prismaWith();
    await expect(
      make(prisma).create(admin(), dto({ fromUserId: 'u-b', toUserId: 'u-c' }) as never),
    ).resolves.toBeDefined();
  });
});

// ── revocation ──────────────────────────────────────────────────────────────

describe('revoke', () => {
  const live = {
    id: 'd1',
    isActive: true,
    startsAt: new Date(Date.now() - 86_400_000),
    endsAt: new Date(Date.now() + 86_400_000),
  };

  it('404s on a delegation belonging to another organization', async () => {
    const prisma = prismaWith();
    await expect(make(prisma).revoke(admin(), 'd1')).rejects.toBeInstanceOf(NotFoundException);
    expect((prisma.approvalDelegation as any).findFirst.mock.calls[0][0].where).toMatchObject({
      id: 'd1',
      organizationId: 'org1',
    });
  });

  it('refuses to revoke twice', async () => {
    const prisma = prismaWith();
    (prisma.approvalDelegation as any).findFirst.mockResolvedValue({ ...live, isActive: false });
    await expect(make(prisma).revoke(admin(), 'd1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lowers the flag and leaves the granted window untouched', async () => {
    const prisma = prismaWith();
    (prisma.approvalDelegation as any).findFirst.mockResolvedValue(live);
    await make(prisma).revoke(admin(), 'd1');
    // The row is evidence of what was handed over and for how long; rewriting
    // endsAt would edit that evidence after the fact.
    expect((prisma.approvalDelegation as any).update.mock.calls[0][0].data).toEqual({
      isActive: false,
    });
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0][0]).toMatchObject({
      entityType: 'ApprovalDelegation',
      action: 'REVOKE',
    });
    expect(audit.record.mock.calls[0][1]).toBe(prisma);
  });
});
