import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { CustomerMergeService } from './customer-merge.service';
import type { AuthUser } from '../../common/auth-user';

const ADMIN = {
  userId: 'u1',
  organizationId: 'org1',
  permissions: ['crm.customer.merge'],
} as unknown as AuthUser;

function setup(opts: { enabled: boolean; found?: Array<{ id: string; mergedIntoId: string | null }> }) {
  const prisma = {
    customer: { findMany: jest.fn().mockResolvedValue(opts.found ?? []) },
    $transaction: jest.fn(),
  };
  const settings = { get: jest.fn().mockResolvedValue(opts.enabled) };
  const svc = new CustomerMergeService(
    prisma as never,
    { record: jest.fn() } as never,
    { emit: jest.fn() } as never,
    settings as never,
    { threshold: jest.fn().mockResolvedValue(0.8) } as never,
  );
  return { svc, prisma, settings };
}

const DTO = { survivorId: 's', mergedIds: ['m1'], backupRef: 'npi-2026-10-06.dump' };

describe('CustomerMergeService.merge', () => {
  it('is refused with 403 "Customer merge is disabled" while the switch is off, before anything is read or written', async () => {
    const { svc, prisma, settings } = setup({ enabled: false });
    const e = await svc.merge(ADMIN, DTO).catch((x) => x);
    expect(e).toBeInstanceOf(ForbiddenException);
    expect((e as Error).message).toBe('Customer merge is disabled');
    expect(settings.get).toHaveBeenCalledWith('org1', 'crm.customer.mergeEnabled', false);
    expect(prisma.customer.findMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('treats a missing setting as OFF (the default is false)', async () => {
    const { svc, settings } = setup({ enabled: false });
    await svc.merge(ADMIN, DTO).catch(() => undefined);
    expect(settings.get.mock.calls[0][2]).toBe(false);
  });

  it('rejects an empty or short backupRef with 400 once enabled', async () => {
    const { svc } = setup({ enabled: true });
    await expect(svc.merge(ADMIN, { ...DTO, backupRef: '' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.merge(ADMIN, { ...DTO, backupRef: '  short ' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects merging the survivor into itself with 400', async () => {
    const { svc } = setup({ enabled: true });
    await expect(svc.merge(ADMIN, { ...DTO, mergedIds: ['s'] })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('404s an id outside the organization and 409s one already merged — before any write', async () => {
    const missing = setup({ enabled: true, found: [{ id: 's', mergedIntoId: null }] });
    await expect(missing.svc.merge(ADMIN, DTO)).rejects.toBeInstanceOf(NotFoundException);
    expect(missing.prisma.customer.findMany.mock.calls[0][0].where).toMatchObject({ organizationId: 'org1' });

    const done = setup({
      enabled: true,
      found: [{ id: 's', mergedIntoId: null }, { id: 'm1', mergedIntoId: 'x' }],
    });
    await expect(done.svc.merge(ADMIN, DTO)).rejects.toBeInstanceOf(ConflictException);
    expect(done.prisma.$transaction).not.toHaveBeenCalled();
  });
});
