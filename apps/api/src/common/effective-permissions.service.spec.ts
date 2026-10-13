/**
 * ADR-02 task 5 (P1-7) — the one loader: a user with their roles and their
 * overrides, evaluated by `effectivePermissions` from @npi/shared.
 */
import { EffectivePermissionsService, resolveEffectivePermissions } from './effective-permissions.service';

const role = (id: string, permissions: string[]) => ({ id, key: id, nameAr: id, nameEn: id, permissions });
const dbUser = (over: Record<string, unknown> = {}) => ({
  id: 'u1',
  organizationId: 'org1',
  isActive: true,
  role: role('r-primary', ['crm.lead.read', 'finance.ledger.read']),
  extraRoles: [{ role: role('r-extra', ['projects.project.read', 'crm.lead.read']) }],
  permissionOverrides: [] as Array<{ permission: string; effect: 'GRANT' | 'DENY' }>,
  ...over,
});

const serviceFor = (user: unknown) => {
  const prisma = { user: { findUnique: jest.fn().mockResolvedValue(user) } };
  return { svc: new EffectivePermissionsService(prisma as never), prisma };
};

describe('EffectivePermissionsService.forUser', () => {
  it('loads the user with the primary role, the extra roles and the overrides, in one query', async () => {
    const { svc, prisma } = serviceFor(dbUser());
    await svc.forUser('u1');
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'u1' },
      include: { role: true, extraRoles: { include: { role: true } }, permissionOverrides: true },
    });
  });

  it('answers the user, the roles primary first, the overrides and the sorted effective set', async () => {
    const user = dbUser({
      permissionOverrides: [
        { permission: 'fsm.workorder.read', effect: 'GRANT' },
        { permission: 'crm.lead.read', effect: 'DENY' },
      ],
    });
    const { svc } = serviceFor(user);
    const out = await svc.forUser('u1');
    expect(out?.user).toBe(user);
    expect(out?.roles.map((r) => r.id)).toEqual(['r-primary', 'r-extra']);
    expect(out?.overrides).toBe(user.permissionOverrides);
    expect(out?.permissions).toEqual(['finance.ledger.read', 'fsm.workorder.read', 'projects.project.read']);
  });

  it('is null for an unknown user — activity and organization stay the caller’s checks', async () => {
    await expect(serviceFor(null).svc.forUser('ghost')).resolves.toBeNull();
    const inactive = await serviceFor(dbUser({ isActive: false, organizationId: 'org2' })).svc.forUser('u1');
    expect(inactive?.permissions).toEqual(['crm.lead.read', 'finance.ledger.read', 'projects.project.read']);
  });
});

describe('resolveEffectivePermissions', () => {
  it('with no override rows is the sorted, de-duplicated union of the roles', () => {
    const { permissions } = resolveEffectivePermissions(dbUser() as never);
    expect(permissions).toEqual(['crm.lead.read', 'finance.ledger.read', 'projects.project.read']);
  });
});
