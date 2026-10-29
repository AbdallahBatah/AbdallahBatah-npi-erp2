/**
 * Package 4 · P4-2 / P4-3 (ADR-04 §4-2, §4-3) — the material request and the
 * issue voucher. The requester never approves; a voucher never exceeds what is
 * left on the request nor what the store holds net of vouchers in transit;
 * stock moves only when the engineer confirms; the shortage goes to purchasing.
 */
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@npi/db';
import { MaterialRequestsService } from './material-requests.service';
import type { AuthUser } from '../../common/auth-user';

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const ENG = { userId: 'u-eng', organizationId: 'org1', permissions: ['scm.requisition.write'] } as unknown as AuthUser;
const PGM = { userId: 'u-pgm', organizationId: 'org1', permissions: ['scm.procurement.approve'] } as unknown as AuthUser;
const KEEPER = { userId: 'u-wh', organizationId: 'org1', permissions: ['scm.procurement.write'] } as unknown as AuthUser;

const line = (over: Record<string, unknown> = {}) => ({
  id: 'l1',
  itemId: 'cable',
  wbsElementId: 'w1',
  qty: D(100),
  issuedQty: D(0),
  receivedQty: D(0),
  purchasedQty: D(0),
  item: { id: 'cable', sku: 'CBL-6', nameAr: 'كابل', nameEn: 'Cable', uom: 'm', isSerialised: false },
  ...over,
});
const request = (over: Record<string, unknown> = {}) => ({
  id: 'mr1',
  code: 'MR-00001',
  organizationId: 'org1',
  projectId: 'p1',
  requestedById: 'u-eng',
  status: 'APPROVED',
  project: { id: 'p1', code: 'PRJ-00001', nameAr: 'م', nameEn: 'P', projectManagerId: 'u-eng' },
  lines: [line()],
  issues: [],
  requisitions: [],
  ...over,
});

function world(mr: unknown, opts: { level?: number; pending?: number; issue?: unknown } = {}) {
  const tx = {
    materialRequest: { update: jest.fn().mockResolvedValue({}), create: jest.fn() },
    materialRequestLine: {
      update: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([{ qty: D(100), receivedQty: D(100) }]),
      deleteMany: jest.fn(),
    },
    materialIssue: {
      create: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'iss1', ...data })),
      update: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'iss1', ...data })),
    },
    stockLevel: {
      findFirst: jest.fn().mockResolvedValue({ id: 'sl1', qty: D(opts.level ?? 500) }),
      update: jest.fn(),
      upsert: jest.fn(),
    },
    stockMovement: { create: jest.fn(), createMany: jest.fn() },
    purchaseRequisition: { update: jest.fn() },
  };
  const prisma = {
    materialRequest: { findFirst: jest.fn().mockResolvedValue(mr) },
    materialIssue: { findFirst: jest.fn().mockResolvedValue(opts.issue ?? null) },
    materialIssueLine: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { qty: opts.pending === undefined ? null : D(opts.pending) } }),
      count: jest.fn().mockResolvedValue(0),
    },
    location: {
      findFirst: jest.fn().mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
        where.locationType === 'SITE' ? { id: 'site1', code: 'SITE-PRJ-00001' } : { id: 'wh1', code: 'WH-01' },
      ),
    },
    stockLevel: { findFirst: jest.fn().mockResolvedValue({ id: 'sl1', qty: D(opts.level ?? 500) }) },
    serialUnit: { count: jest.fn() },
    $transaction: jest.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
  };
  const notifications = { notifyBestEffort: jest.fn(), notifyUserBestEffort: jest.fn() };
  const requisitions = { create: jest.fn().mockResolvedValue({ id: 'pr1', code: 'PR-00001' }) };
  const svc = new MaterialRequestsService(
    prisma as never,
    { next: jest.fn().mockResolvedValue('MIS-00001') } as never,
    { record: jest.fn() } as never,
    notifications as never,
    requisitions as never,
  );
  return { svc, prisma, tx, notifications, requisitions };
}

describe('approval', () => {
  it('the requester cannot approve their own request (403)', async () => {
    const { svc } = world(request({ status: 'SUBMITTED' }));
    await expect(svc.approve({ ...PGM, userId: 'u-eng' } as AuthUser, 'mr1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('the projects GM approves a submitted request and the keepers are told', async () => {
    const { svc, tx, notifications } = world(request({ status: 'SUBMITTED' }));
    await svc.approve(PGM, 'mr1');
    expect(tx.materialRequest.update.mock.calls[0][0].data).toMatchObject({ status: 'APPROVED', approvedById: 'u-pgm' });
    expect(notifications.notifyBestEffort.mock.calls[0][0]).toMatchObject({ type: 'MATERIAL_REQUEST_APPROVED' });
  });
});

describe('issue voucher', () => {
  it('refuses more than is left on the request (400)', async () => {
    const { svc } = world(request({ lines: [line({ issuedQty: D(80) })] }));
    await expect(
      svc.issue(KEEPER, 'mr1', { fromLocationId: 'wh1', lines: [{ requestLineId: 'l1', qty: 30 }] }),
    ).rejects.toThrow(/only 20 left/);
  });

  it('counts vouchers still in transit from the same store against its stock (400)', async () => {
    const { svc } = world(request(), { level: 100, pending: 90 });
    await expect(
      svc.issue(KEEPER, 'mr1', { fromLocationId: 'wh1', lines: [{ requestLineId: 'l1', qty: 20 }] }),
    ).rejects.toThrow(/10 available at WH-01/);
  });

  it('issues to the project site and raises issuedQty — no stock moves yet', async () => {
    const { svc, tx, notifications } = world(request());
    await svc.issue(KEEPER, 'mr1', { fromLocationId: 'wh1', lines: [{ requestLineId: 'l1', qty: 60 }] });
    expect(tx.materialIssue.create.mock.calls[0][0].data).toMatchObject({ fromLocationId: 'wh1', toLocationId: 'site1' });
    expect(tx.materialRequestLine.update).toHaveBeenCalledWith({ where: { id: 'l1' }, data: { issuedQty: { increment: 60 } } });
    expect(tx.stockLevel.update).not.toHaveBeenCalled();
    expect(tx.stockMovement.create).not.toHaveBeenCalled();
    expect(notifications.notifyUserBestEffort.mock.calls[0][0]).toMatchObject({ userId: 'u-eng', type: 'MATERIAL_ISSUED' });
  });

  it('a request not yet approved cannot be issued against (409)', async () => {
    const { svc } = world(request({ status: 'SUBMITTED' }));
    await expect(
      svc.issue(KEEPER, 'mr1', { fromLocationId: 'wh1', lines: [{ requestLineId: 'l1', qty: 1 }] }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('receipt on site', () => {
  const issue = {
    id: 'iss1',
    code: 'MIS-00001',
    requestId: 'mr1',
    status: 'ISSUED',
    fromLocationId: 'wh1',
    toLocationId: 'site1',
    lines: [{ requestLineId: 'l1', itemId: 'cable', qty: D(100), serialUnitIds: [] }],
  };

  it('only the requester or the project engineer confirms (403)', async () => {
    const { svc } = world(request(), { issue });
    await expect(svc.confirmReceipt({ ...ENG, userId: 'u-other' } as AuthUser, 'iss1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('moves the stock store → site in the confirming transaction, and the request is FULFILLED', async () => {
    const { svc, tx } = world(request(), { issue });
    const out = await svc.confirmReceipt(ENG, 'iss1');
    expect(tx.stockLevel.update).toHaveBeenCalledWith({ where: { id: 'sl1' }, data: { qty: { decrement: D(100) } } });
    expect(tx.stockMovement.create.mock.calls[0][0].data).toMatchObject({
      fromLocationId: 'wh1',
      toLocationId: 'site1',
      movementType: 'TRANSFER',
      sourceType: 'MaterialIssue',
      sourceId: 'iss1',
    });
    expect(out.requestStatus).toBe('FULFILLED');
  });

  it('refuses when the store no longer holds it (409) — nothing is half-moved', async () => {
    const { svc, tx } = world(request(), { issue, level: 40 });
    await expect(svc.confirmReceipt(ENG, 'iss1')).rejects.toBeInstanceOf(ConflictException);
    expect(tx.materialIssue.update).not.toHaveBeenCalled();
  });
});

describe('shortage to purchasing', () => {
  it('raises one requisition for what is neither issued nor already being bought, on the project and budget line', async () => {
    const { svc, requisitions, tx } = world(request({ lines: [line({ issuedQty: D(30), purchasedQty: D(20) })] }));
    await svc.raiseShortage(KEEPER, 'mr1', {});
    expect(requisitions.create.mock.calls[0][1]).toMatchObject({
      projectId: 'p1',
      lines: [{ itemId: 'cable', qty: 50, wbsElementId: 'w1' }],
    });
    expect(tx.purchaseRequisition.update).toHaveBeenCalledWith({ where: { id: 'pr1' }, data: { materialRequestId: 'mr1' } });
  });

  it('nothing left to buy → 409, no requisition', async () => {
    const { svc, requisitions } = world(request({ lines: [line({ issuedQty: D(100) })] }));
    await expect(svc.raiseShortage(KEEPER, 'mr1', {})).rejects.toBeInstanceOf(ConflictException);
    expect(requisitions.create).not.toHaveBeenCalled();
  });

  it('a serialised line must name its units (400)', async () => {
    const serial = line({ item: { id: 'mod', sku: 'MOD-550', nameAr: 'لوح', nameEn: 'Module', uom: 'unit', isSerialised: true }, itemId: 'mod' });
    const { svc } = world(request({ lines: [serial] }));
    await expect(
      svc.issue(KEEPER, 'mr1', { fromLocationId: 'wh1', lines: [{ requestLineId: 'l1', qty: 2 }] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
