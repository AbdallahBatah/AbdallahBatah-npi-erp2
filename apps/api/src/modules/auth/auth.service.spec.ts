import { UnauthorizedException } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';

const PASSWORD = 'Correct@123';
const HASH = bcrypt.hashSync(PASSWORD, 10);

const baseUser = {
  id: 'u1',
  email: 'admin@npi.sa',
  passwordHash: HASH,
  isActive: true,
  organizationId: 'org1',
  nameAr: 'مدير',
  nameEn: 'Admin',
  locale: 'ar',
  role: { id: 'r-admin', key: 'admin', nameAr: 'مدير', nameEn: 'Admin', permissions: ['crm.lead.read'] },
  extraRoles: [] as Array<{ role: Record<string, unknown> }>,
  organization: {
    id: 'org1',
    legalNameAr: 'شركة',
    legalNameEn: 'Co',
    baseCurrency: 'SAR',
  },
};

const build = (user: unknown) => {
  const prisma = { user: { findUnique: jest.fn().mockResolvedValue(user) } };
  const jwt = { signAsync: jest.fn().mockResolvedValue('tok') };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const svc = new AuthService(prisma as never, jwt as never, audit as never);
  return { svc, prisma, jwt, audit };
};

describe('AuthService.login', () => {
  it('rejects an unknown email without writing any audit row', async () => {
    const { svc, audit } = build(null);
    await expect(
      svc.login({ email: 'ghost@npi.sa', password: PASSWORD }),
    ).rejects.toThrow(UnauthorizedException);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects a wrong password AND audits LOGIN_FAILED', async () => {
    const { svc, audit } = build(baseUser);
    await expect(
      svc.login({ email: baseUser.email, password: 'Wrong@123' }, '1.2.3.4'),
    ).rejects.toThrow(UnauthorizedException);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'LOGIN_FAILED', actorId: 'u1', ip: '1.2.3.4' }),
    );
  });

  it('rejects an inactive user and audits LOGIN_FAILED', async () => {
    const { svc, audit } = build({ ...baseUser, isActive: false });
    await expect(
      svc.login({ email: baseUser.email, password: PASSWORD }),
    ).rejects.toThrow(UnauthorizedException);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'LOGIN_FAILED' }),
    );
  });

  it('a failed audit write never masks the 401 itself', async () => {
    const { svc, audit } = build(baseUser);
    audit.record.mockRejectedValue(new Error('db down'));
    await expect(
      svc.login({ email: baseUser.email, password: 'Wrong@123' }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('returns a token + principal on success and audits LOGIN', async () => {
    const { svc, jwt, audit } = build(baseUser);
    const res = await svc.login({ email: baseUser.email, password: PASSWORD }, '5.6.7.8');
    expect(res.accessToken).toBe('tok');
    expect(res.user.roleKey).toBe('admin');
    expect(res.user.organization.baseCurrency).toBe('SAR');
    expect(jwt.signAsync).toHaveBeenCalledWith({ sub: 'u1', org: 'org1' });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'LOGIN', ip: '5.6.7.8' }),
    );
    expect(res.user.roles).toEqual([
      { id: 'r-admin', key: 'admin', nameAr: 'مدير', nameEn: 'Admin' },
    ]);
  });

  it('returns every role (primary first) and the union of their permissions', async () => {
    const withExtra = {
      ...baseUser,
      role: { ...baseUser.role, permissions: ['crm.lead.read', 'finance.ledger.read'] },
      extraRoles: [
        {
          role: {
            id: 'r-cost',
            key: 'cost_viewer',
            nameAr: 'تكاليف',
            nameEn: 'Cost viewer',
            permissions: ['finance.costs.view', 'crm.lead.read'],
          },
        },
      ],
    };
    const { svc } = build(withExtra);
    const res = await svc.login({ email: baseUser.email, password: PASSWORD });
    expect(res.user.roles.map((r) => r.key)).toEqual(['admin', 'cost_viewer']);
    expect(res.user.permissions).toEqual(['crm.lead.read', 'finance.costs.view', 'finance.ledger.read']);
    // roleKey stays the primary role
    expect(res.user.roleKey).toBe('admin');
  });
});
