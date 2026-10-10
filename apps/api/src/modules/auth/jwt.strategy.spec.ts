import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';

jest.mock('./jwt.constants', () => ({ JWT_SECRET: () => 'test-secret' }));

const role = (id: string, key: string, permissions: string[]) => ({
  id,
  key,
  nameAr: key,
  nameEn: key,
  permissions,
});

const dbUser = (over: Record<string, unknown> = {}) => ({
  id: 'u1',
  organizationId: 'org1',
  email: 'a@b.c',
  isActive: true,
  locale: 'AR',
  roleId: 'r-sales',
  role: role('r-sales', 'sales', ['crm.lead.read', 'finance.ledger.read']),
  extraRoles: [] as Array<{ role: ReturnType<typeof role> }>,
  ...over,
});

const strategyFor = (user: unknown) => {
  const prisma = { user: { findUnique: jest.fn().mockResolvedValue(user) } };
  return { strategy: new JwtStrategy(prisma as never), prisma };
};

describe('JwtStrategy.validate', () => {
  it('a single-role user keeps roleIds = [primary] and its own permissions', async () => {
    const { strategy } = strategyFor(dbUser());
    const principal = await strategy.validate({ sub: 'u1', org: 'org1' });
    expect(principal.roleId).toBe('r-sales');
    expect(principal.roleKey).toBe('sales');
    expect(principal.roleIds).toEqual(['r-sales']);
    expect(principal.permissions).toEqual(['crm.lead.read', 'finance.ledger.read']);
  });

  it('primary first in roleIds; permissions are the sorted, de-duplicated union', async () => {
    const { strategy } = strategyFor(
      dbUser({
        extraRoles: [
          { role: role('r-cost', 'cost', ['finance.costs.view', 'crm.lead.read']) },
          { role: role('r-pm', 'pm', ['projects.project.read']) },
        ],
      }),
    );
    const principal = await strategy.validate({ sub: 'u1', org: 'org1' });
    expect(principal.roleIds).toEqual(['r-sales', 'r-cost', 'r-pm']);
    // roleId / roleKey stay the PRIMARY role
    expect(principal.roleId).toBe('r-sales');
    expect(principal.roleKey).toBe('sales');
    expect(principal.permissions).toEqual([
      'crm.lead.read',
      'finance.costs.view',
      'finance.ledger.read',
      'projects.project.read',
    ]);
  });

  it('rejects an inactive user or a token for another organization', async () => {
    await expect(
      strategyFor(dbUser({ isActive: false })).strategy.validate({ sub: 'u1', org: 'org1' }),
    ).rejects.toThrow(UnauthorizedException);
    await expect(
      strategyFor(dbUser()).strategy.validate({ sub: 'u1', org: 'other' }),
    ).rejects.toThrow(UnauthorizedException);
  });
});
