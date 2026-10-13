import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';
import { EffectivePermissionsService } from '../../common/effective-permissions.service';

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
  permissionOverrides: [] as Array<{ permission: string; effect: 'GRANT' | 'DENY' }>,
  ...over,
});

const strategyFor = (user: unknown) => {
  const prisma = { user: { findUnique: jest.fn().mockResolvedValue(user) } };
  return {
    strategy: new JwtStrategy(new EffectivePermissionsService(prisma as never)),
    prisma,
  };
};

const grant = (permission: string) => ({ permission, effect: 'GRANT' as const });
const deny = (permission: string) => ({ permission, effect: 'DENY' as const });

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

  it('loads the overrides with the roles, in the one query it always made', async () => {
    const { strategy, prisma } = strategyFor(dbUser());
    await strategy.validate({ sub: 'u1', org: 'org1' });
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.user.findUnique.mock.calls[0][0]).toEqual({
      where: { id: 'u1' },
      include: { role: true, extraRoles: { include: { role: true } }, permissionOverrides: true },
    });
  });

  it('with no override rows the principal is exactly what it was before overrides existed', async () => {
    const extras = [{ role: role('r-cost', 'cost', ['finance.costs.view', 'crm.lead.read']) }];
    const { strategy } = strategyFor(dbUser({ extraRoles: extras }));
    const principal = await strategy.validate({ sub: 'u1', org: 'org1' });
    expect(principal).toEqual({
      userId: 'u1',
      organizationId: 'org1',
      email: 'a@b.c',
      roleId: 'r-sales',
      roleKey: 'sales',
      roleIds: ['r-sales', 'r-cost'],
      // today's expression: the sorted, de-duplicated union of the roles
      permissions: [...new Set(['crm.lead.read', 'finance.ledger.read', 'finance.costs.view', 'crm.lead.read'])].sort(
        (a, b) => a.localeCompare(b, 'en'),
      ),
      locale: 'AR',
    });
  });

  it('a GRANT adds its key, in sorted place', async () => {
    const { strategy } = strategyFor(dbUser({ permissionOverrides: [grant('crm.customer.read')] }));
    const principal = await strategy.validate({ sub: 'u1', org: 'org1' });
    expect(principal.permissions).toEqual(['crm.customer.read', 'crm.lead.read', 'finance.ledger.read']);
    // a key is never a seat: the roles are unchanged
    expect(principal.roleIds).toEqual(['r-sales']);
  });

  it('a DENY beats the primary role, an extra role and a GRANT alike', async () => {
    const { strategy } = strategyFor(
      dbUser({
        extraRoles: [{ role: role('r-pm', 'pm', ['projects.project.read', 'crm.lead.read']) }],
        permissionOverrides: [
          deny('crm.lead.read'), // held by the primary AND the extra role
          deny('projects.project.read'), // held by the extra role only
          grant('fsm.workorder.read'),
          deny('fsm.workorder.read'), // the table forbids both on one key; the evaluator still lets DENY win
        ],
      }),
    );
    const principal = await strategy.validate({ sub: 'u1', org: 'org1' });
    expect(principal.permissions).toEqual(['finance.ledger.read']);
    expect(principal.roleIds).toEqual(['r-sales', 'r-pm']);
  });

  it('rejects an unknown user', async () => {
    await expect(strategyFor(null).strategy.validate({ sub: 'ghost', org: 'org1' })).rejects.toThrow(
      UnauthorizedException,
    );
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
