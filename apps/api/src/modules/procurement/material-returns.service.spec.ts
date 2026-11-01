/**
 * Package 5 · P5-4 — a return leaves the site only for what the site holds
 * (net of returns in transit); stock moves when the keeper receives it, and
 * the engineer who raised it does not receive it.
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@npi/db';
import { MaterialReturnsService } from './material-returns.service';
import type { AuthUser } from '../../common/auth-user';

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const ENG = { userId: 'u-eng', organizationId: 'org1', permissions: ['scm.requisition.write'] } as unknown as AuthUser;
const KEEPER = { userId: 'u-wh', organizationId: 'org1', permissions: ['scm.procurement.write'] } as unknown as AuthUser;
const cable = { id: 'cable', sku: 'CBL-6', nameAr: 'كابل', nameEn: 'Cable', uom: 'm', isSerialised: false };

function world(opts: { onSite?: number; inTransit?: number; ret?: Record<string, unknown> } = {}) {
  const tx = {
    stockLevel: { findFirst: jest.fn().mockResolvedValue({ id: 'sl', qty: D(opts.onSite ?? 50) }), update: jest.fn(), upsert: jest.fn() },
    stockMovement: { create: jest.fn() },
    materialReturn: {
      create: jest.fn().mockResolvedValue({ id: 'r1', code: 'MRT-00001' }),
      update: jest.fn(),
    },
  };
  const prisma = {
    project: { findFirst: jest.fn().mockResolvedValue({ id: 'p1', code: 'PRJ-00001' }) },
    location: {
      findFirst: jest.fn().mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
        where.locationType === 'SITE' ? { id: 'site1', code: 'SITE-PRJ-00001' } : { id: 'wh1', code: 'WH-01', locationType: 'WAREHOUSE' },
      ),
    },
    stockLevel: { findMany: jest.fn().mockResolvedValue([{ itemId: 'cable', qty: D(opts.onSite ?? 50), item: cable }]) },
    materialReturnLine: {
      groupBy: jest.fn().mockResolvedValue(opts.inTransit ? [{ itemId: 'cable', _sum: { qty: D(opts.inTransit) } }] : []),
      findMany: jest.fn().mockResolvedValue([]),
    },
    serialUnit: { findMany: jest.fn().mockResolvedValue([]) },
    materialReturn: {
      findFirst: jest.fn().mockResolvedValue(
        opts.ret ?? {
          id: 'r1', code: 'MRT-00001', status: 'RAISED', raisedById: 'u-eng', fromLocationId: 'site1', toLocationId: 'wh1',
          lines: [{ itemId: 'cable', qty: D(20), serialUnitIds: [] }],
        },
      ),
    },
    $transaction: jest.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
  };
  const svc = new MaterialReturnsService(
    prisma as never,
    { next: jest.fn().mockResolvedValue('MRT-00001') } as never,
    { record: jest.fn() } as never,
    { notifyBestEffort: jest.fn(), notifyUserBestEffort: jest.fn() } as never,
  );
  return { svc, tx };
}

describe('material return', () => {
  it('refuses more than the site holds net of returns in transit (400)', async () => {
    const { svc } = world({ onSite: 50, inTransit: 40 });
    await expect(svc.create(ENG, { projectId: 'p1', lines: [{ itemId: 'cable', qty: 20 }] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('raises to the main warehouse; no stock moves yet', async () => {
    const { svc, tx } = world();
    await svc.create(ENG, { projectId: 'p1', lines: [{ itemId: 'cable', qty: 20 }] });
    expect(tx.materialReturn.create.mock.calls[0][0].data).toMatchObject({ fromLocationId: 'site1', toLocationId: 'wh1' });
    expect(tx.stockLevel.update).not.toHaveBeenCalled();
  });

  it('the raiser cannot receive it (403)', async () => {
    const { svc } = world();
    await expect(svc.receive({ ...KEEPER, userId: 'u-eng' } as AuthUser, 'r1', {})).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('the keeper receives: stock moves site → store as MaterialReturn', async () => {
    const { svc, tx } = world();
    await svc.receive(KEEPER, 'r1', {});
    expect(tx.stockLevel.update).toHaveBeenCalledWith({ where: { id: 'sl' }, data: { qty: { decrement: D(20) } } });
    expect(tx.stockMovement.create.mock.calls[0][0].data).toMatchObject({
      fromLocationId: 'site1', toLocationId: 'wh1', sourceType: 'MaterialReturn', sourceId: 'r1',
    });
    expect(tx.materialReturn.update.mock.calls[0][0].data).toMatchObject({ status: 'RECEIVED', receivedById: 'u-wh' });
  });
});
