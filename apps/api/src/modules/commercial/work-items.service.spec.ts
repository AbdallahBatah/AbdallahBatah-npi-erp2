/**
 * Package 3 · P3-3 (ADR-03 §4-3) — the company's list of project work items.
 * Cost is cost data (finance.costs.view), only a MATERIAL item may stand for a
 * stock item of the same tenant, codes are unique, and nothing is deleted.
 */
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { WorkItemsService } from './work-items.service';
import type { AuthUser } from '../../common/auth-user';

const OFFICE = {
  userId: 'u1',
  organizationId: 'org1',
  permissions: ['commercial.item.read', 'commercial.item.write', 'finance.costs.view'],
} as unknown as AuthUser;
const NO_COSTS = { ...OFFICE, permissions: ['commercial.item.read', 'commercial.item.write'] } as unknown as AuthUser;

const ROW = {
  id: 'w1',
  organizationId: 'org1',
  code: 'WI-01',
  nameAr: 'ألواح شمسية',
  nameEn: 'Solar panels',
  kind: 'MATERIAL',
  uom: 'panel',
  defaultUnitCost: 400,
  itemId: null,
  sortOrder: 1,
  isActive: true,
};

function setup(opts: { existing?: unknown; found?: unknown; stockItem?: unknown } = {}) {
  const workItem = {
    findMany: jest.fn().mockResolvedValue([ROW]),
    findFirst: jest.fn().mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      where.code !== undefined ? (opts.existing ?? null) : opts.found === undefined ? ROW : opts.found,
    ),
    create: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'new', ...data })),
    update: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...ROW, ...data })),
  };
  const item = { findFirst: jest.fn().mockResolvedValue(opts.stockItem === undefined ? { id: 'i1' } : opts.stockItem) };
  const tx = { workItem };
  const prisma = { workItem, item, $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return { svc: new WorkItemsService(prisma as never, audit as never), workItem, item, audit, tx };
}

describe('WorkItemsService.list', () => {
  it('active only by default, in the company order, scoped to the organization', async () => {
    const { svc, workItem } = setup();
    await svc.list(OFFICE);
    const arg = workItem.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ organizationId: 'org1', isActive: true });
    expect(arg.orderBy).toEqual([{ sortOrder: 'asc' }, { code: 'asc' }]);
  });

  it('includes the switched-off ones when asked', async () => {
    const { svc, workItem } = setup();
    await svc.list(OFFICE, true);
    expect(workItem.findMany.mock.calls[0][0].where).toEqual({ organizationId: 'org1' });
  });
});

describe('WorkItemsService.create', () => {
  it('creates and audits in one transaction, trimming the names', async () => {
    const { svc, workItem, audit, tx } = setup();
    await svc.create(OFFICE, {
      code: ' WI-02 ',
      nameAr: ' تركيب ',
      nameEn: 'Installation',
      kind: 'LABOUR',
      uom: 'kW',
      defaultUnitCost: 35,
    });
    expect(workItem.create.mock.calls[0][0].data).toMatchObject({
      organizationId: 'org1',
      code: 'WI-02',
      nameAr: 'تركيب',
      kind: 'LABOUR',
      uom: 'kW',
      defaultUnitCost: 35,
      itemId: null,
    });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'WorkItem', action: 'CREATE' }), tx);
  });

  it('refuses to set a cost without finance.costs.view (403)', async () => {
    const { svc, workItem } = setup();
    await expect(
      svc.create(NO_COSTS, { code: 'X', nameAr: 'x', nameEn: 'x', kind: 'EXPENSE', defaultUnitCost: 5 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(workItem.create).not.toHaveBeenCalled();
  });

  it('refuses a code already in use (409)', async () => {
    const { svc, workItem } = setup({ existing: ROW });
    await expect(svc.create(OFFICE, { code: 'WI-01', nameAr: 'x', nameEn: 'x', kind: 'EXPENSE' })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(workItem.create).not.toHaveBeenCalled();
  });

  it('links a stock item only to a MATERIAL work item (400 otherwise)', async () => {
    const { svc } = setup();
    await expect(
      svc.create(OFFICE, { code: 'L', nameAr: 'x', nameEn: 'x', kind: 'LABOUR', itemId: 'i1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a stock item of another organization (400)', async () => {
    const { svc, item } = setup({ stockItem: null });
    await expect(
      svc.create(OFFICE, { code: 'M', nameAr: 'x', nameEn: 'x', kind: 'MATERIAL', itemId: 'foreign' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(item.findFirst.mock.calls[0][0].where).toEqual({ id: 'foreign', organizationId: 'org1' });
  });

  it('turns a racing duplicate (P2002) into the same 409', async () => {
    const { svc, workItem } = setup();
    workItem.create.mockRejectedValueOnce(Object.assign(new Error('Unique'), { code: 'P2002' }));
    await expect(svc.create(OFFICE, { code: 'Z', nameAr: 'x', nameEn: 'x', kind: 'EXPENSE' })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('WorkItemsService.update', () => {
  it('switches an item off (never deletes) and audits before/after', async () => {
    const { svc, workItem, audit } = setup();
    await svc.update(OFFICE, 'w1', { isActive: false });
    expect(workItem.update.mock.calls[0][0].data).toEqual({ isActive: false });
    expect(audit.record.mock.calls[0][0]).toMatchObject({ action: 'UPDATE', before: ROW });
  });

  it('a work item of another organization is not found (404)', async () => {
    const { svc } = setup({ found: null });
    await expect(svc.update(OFFICE, 'w-other', { nameAr: 'x' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('changing a linked MATERIAL item to LABOUR without unlinking is refused (400)', async () => {
    const { svc } = setup({ found: { ...ROW, itemId: 'i1' } });
    await expect(svc.update(OFFICE, 'w1', { kind: 'LABOUR' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('itemId null unlinks the stock item', async () => {
    const { svc, workItem } = setup({ found: { ...ROW, itemId: 'i1' } });
    await svc.update(OFFICE, 'w1', { itemId: null });
    expect(workItem.update.mock.calls[0][0].data).toEqual({ item: { disconnect: true } });
  });
});
