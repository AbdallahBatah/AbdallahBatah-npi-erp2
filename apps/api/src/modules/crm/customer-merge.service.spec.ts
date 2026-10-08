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

// ── CRM Phase 1 · Step 5 (contract §1-9, §8): the communication log and the tasks follow the merge ──

function mergeSetup() {
  const survivor = { id: 's', code: 'CUS-00001', mergedIntoId: null, vatNumber: null, crNumber: null, mobile: null, phone: null, email: null, nameEn: 'S' };
  const merged = { id: 'm1', code: 'CUS-00002', mergedIntoId: null, vatNumber: null, crNumber: null, mobile: null, phone: null, email: null, nameEn: 'M' };
  const count = (n: number) => jest.fn().mockResolvedValue({ count: n });
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    customer: {
      findFirst: jest.fn().mockImplementation(async ({ where }: { where: { id: string } }) => (where.id === 's' ? survivor : merged)),
      update: jest.fn().mockResolvedValue(survivor),
    },
    lead: { updateMany: count(0) },
    opportunity: { updateMany: count(0) },
    contract: { updateMany: count(0) },
    invoice: { updateMany: count(0) },
    customerContact: { count: jest.fn().mockResolvedValue(0), updateMany: count(0) },
    attachment: { updateMany: count(0) },
    activity: { updateMany: count(4) },
    followUpTask: { updateMany: count(2) },
    customerMergeLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    customer: {
      findMany: jest.fn().mockResolvedValue([{ id: 's', mergedIntoId: null }, { id: 'm1', mergedIntoId: null }]),
    },
    $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const outbox = { emit: jest.fn().mockResolvedValue('evt') };
  const settings = { get: jest.fn().mockResolvedValue(true) };
  const svc = new CustomerMergeService(prisma as never, audit as never, outbox as never, settings as never, { threshold: jest.fn().mockResolvedValue(0.8) } as never);
  return { svc, prisma, tx, outbox };
}

describe('CustomerMergeService.merge — Step 5 documents', () => {
  it('moves the duplicate’s activities and follow-up tasks to the survivor, inside the same organization', async () => {
    const { svc, tx } = mergeSetup();
    await svc.merge(ADMIN, DTO);
    expect(tx.activity.updateMany).toHaveBeenCalledWith({ where: { organizationId: 'org1', customerId: 'm1' }, data: { customerId: 's' } });
    expect(tx.followUpTask.updateMany).toHaveBeenCalledWith({ where: { organizationId: 'org1', customerId: 'm1' }, data: { customerId: 's' } });
  });

  it('reports them in movedJson (and in the outbox event) when there were any', async () => {
    const { svc, tx, outbox } = mergeSetup();
    const res = await svc.merge(ADMIN, DTO);
    expect(res.merged[0].moved).toMatchObject({ Activity: 4, FollowUpTask: 2 });
    expect(tx.customerMergeLog.create.mock.calls[0][0].data.movedJson).toMatchObject({ Activity: 4, FollowUpTask: 2 });
    expect(outbox.emit.mock.calls[0][1].payload.moved).toMatchObject({ Activity: 4, FollowUpTask: 2 });
  });

  it('leaves the keys out when there was nothing to move (the shape of every earlier merge is unchanged)', async () => {
    const { svc, tx } = mergeSetup();
    tx.activity.updateMany.mockResolvedValue({ count: 0 });
    tx.followUpTask.updateMany.mockResolvedValue({ count: 0 });
    const res = await svc.merge(ADMIN, DTO);
    expect(Object.keys(res.merged[0].moved).sort()).toEqual(['Attachment', 'Contract', 'CustomerContact', 'Invoice', 'Lead', 'Opportunity']);
  });
});

describe('CustomerMergeService.duplicates — Step 5 documents', () => {
  it('counts activities and follow-up tasks per member and adds them to totalDocuments', async () => {
    const dup = (id: string) => ({
      id, code: `CUS-${id}`, nameAr: 'مصنع الرياض', nameEn: 'Riyadh', nameNormalized: 'مصنع الرياض',
      crNumber: '1010123456', vatNumber: null, mobile: null, createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    const group = (rows: Array<{ customerId: string; n: number }>) => rows.map((r) => ({ customerId: r.customerId, _count: { _all: r.n } }));
    const prisma = {
      customer: { findMany: jest.fn().mockResolvedValue([dup('a'), dup('b')]) },
      lead: { groupBy: jest.fn().mockResolvedValue([]) },
      opportunity: { groupBy: jest.fn().mockResolvedValue([]) },
      contract: { groupBy: jest.fn().mockResolvedValue([]) },
      invoice: { groupBy: jest.fn().mockResolvedValue([]) },
      customerContact: { groupBy: jest.fn().mockResolvedValue([]) },
      activity: { groupBy: jest.fn().mockResolvedValue(group([{ customerId: 'a', n: 3 }])) },
      followUpTask: { groupBy: jest.fn().mockResolvedValue(group([{ customerId: 'b', n: 5 }])) },
    };
    const svc = new CustomerMergeService(
      prisma as never, { record: jest.fn() } as never, { emit: jest.fn() } as never,
      { get: jest.fn().mockResolvedValue(false) } as never, { threshold: jest.fn().mockResolvedValue(0.8) } as never,
    );
    const res = await svc.duplicates(ADMIN);
    const members = res.groups[0].members;
    const a = members.find((m) => m.id === 'a')!;
    const b = members.find((m) => m.id === 'b')!;
    expect(a.counts).toMatchObject({ activities: 3, followUpTasks: 0 });
    expect(b.counts).toMatchObject({ activities: 0, followUpTasks: 5 });
    expect(a.totalDocuments).toBe(3);
    expect(b.totalDocuments).toBe(5);
    expect(res.groups[0].suggestedSurvivorId).toBe('b');
  });
});
