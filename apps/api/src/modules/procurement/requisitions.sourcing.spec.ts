/**
 * Package 4 · P4-4 (ADR-04 §4-4) — the projects GM sources a requisition while
 * its chain is open, and the last signature raises the purchase order already
 * APPROVED: adopted into the PO flow at APPROVED, po.approved emitted in the
 * same transaction (so the project commitment is booked), procurement told to
 * send it. Unsourced requisitions keep today's manual conversion.
 */
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@npi/db';
import { RequisitionsService } from './requisitions.service';
import type { AuthUser } from '../../common/auth-user';

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const PGM = { userId: 'u-pgm', organizationId: 'org1', roleId: 'r-pm', permissions: [] } as unknown as AuthUser;
const CEO = { userId: 'u-ceo', organizationId: 'org1', roleId: 'r-exec', permissions: [] } as unknown as AuthUser;

const requisition = (over: Record<string, unknown> = {}) => ({
  id: 'pr1',
  code: 'PR-00001',
  organizationId: 'org1',
  status: 'PENDING_APPROVAL',
  requestedById: 'u-wh',
  projectId: 'p1',
  departmentId: null,
  currency: 'SAR',
  estimatedTotal: D(1000),
  vendorId: null,
  deliveryLocationId: null,
  neededBy: null,
  purchaseOrderId: null,
  lines: [{ id: 'l1', itemId: 'cable', wbsElementId: 'w1', qty: D(10), estimatedUnitPrice: D(100) }],
  ...over,
});

function world(pr: Record<string, unknown>, chainAmount = 1000) {
  const tx = {
    purchaseRequisitionLine: { update: jest.fn() },
    purchaseRequisition: { update: jest.fn().mockImplementation(async ({ data }: { data: object }) => ({ ...pr, ...data })) },
    purchaseOrder: {
      create: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'po1', ...data, lines: [] })),
    },
  };
  const prisma = {
    purchaseRequisition: { findFirst: jest.fn().mockResolvedValue(pr) },
    vendor: { findFirst: jest.fn().mockResolvedValue({ id: 'v1' }) },
    location: { findFirst: jest.fn().mockResolvedValue({ id: 'site1' }) },
    $transaction: jest.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
  };
  const approvals = {
    forDocument: jest.fn().mockResolvedValue({ status: 'PENDING', amount: chainAmount }),
  };
  const engine = {
    transition: jest.fn().mockResolvedValue({ toState: 'APPROVED' }),
    adopt: jest.fn(),
    open: jest.fn(),
  };
  const outbox = { emit: jest.fn() };
  const notifications = { notifyBestEffort: jest.fn() };
  const svc = new RequisitionsService(
    prisma as never,
    { next: jest.fn().mockResolvedValue('PO-00001') } as never,
    { record: jest.fn() } as never,
    approvals as never,
    { standardVat: jest.fn().mockResolvedValue({ rate: 15 }) } as never,
    notifications as never,
    engine as never,
    undefined as never,
    outbox as never,
  );
  return { svc, tx, engine, outbox, notifications };
}

describe('sourcing during approval', () => {
  it('sets vendor, prices and the new total; audited', async () => {
    const { svc, tx } = world(requisition());
    await svc.source(PGM, 'pr1', { vendorId: 'v1', deliveryLocationId: 'site1', prices: [{ requisitionLineId: 'l1', unitPrice: 90 }] });
    expect(tx.purchaseRequisitionLine.update).toHaveBeenCalledWith({ where: { id: 'l1' }, data: { estimatedUnitPrice: 90, lineTotal: 900 } });
    expect(tx.purchaseRequisition.update.mock.calls[0][0].data).toMatchObject({
      vendorId: 'v1',
      deliveryLocationId: 'site1',
      estimatedTotal: 900,
      sourcedById: 'u-pgm',
    });
  });

  it('refuses a total above the amount the chain was opened for (409)', async () => {
    const { svc, tx } = world(requisition());
    await expect(
      svc.source(PGM, 'pr1', { vendorId: 'v1', prices: [{ requisitionLineId: 'l1', unitPrice: 120 }] }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.purchaseRequisition.update).not.toHaveBeenCalled();
  });

  it('only while awaiting approval (409), and never by the requester (403)', async () => {
    await expect(world(requisition({ status: 'APPROVED' })).svc.source(PGM, 'pr1', { vendorId: 'v1' })).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(
      world(requisition()).svc.source({ ...PGM, userId: 'u-wh' } as AuthUser, 'pr1', { vendorId: 'v1' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('the last signature', () => {
  it('raises the PO already APPROVED, adopted at APPROVED, po.approved emitted, procurement told', async () => {
    const pr = requisition({ vendorId: 'v1', deliveryLocationId: 'site1', neededBy: new Date('2026-11-15') });
    const { svc, tx, engine, outbox, notifications } = world(pr);
    const out = await svc.applyApproval(CEO, 'pr1');

    expect(out.status).toBe('CONVERTED');
    expect(tx.purchaseOrder.create.mock.calls[0][0].data).toMatchObject({
      vendorId: 'v1',
      projectId: 'p1',
      status: 'APPROVED',
      approvedById: 'u-ceo',
      deliveryLocationId: 'site1',
      subtotal: 1000,
      vatAmount: 150,
      total: 1150,
    });
    expect(engine.adopt.mock.calls[0][1]).toMatchObject({ flowCode: 'PURCHASE_ORDER', stateCode: 'APPROVED' });
    expect(engine.open).not.toHaveBeenCalled();
    expect(outbox.emit.mock.calls[0][1]).toMatchObject({ eventCode: 'po.approved', payload: { documentId: 'po1' } });
    expect(tx.purchaseRequisition.update).toHaveBeenCalledWith({ where: { id: 'pr1' }, data: { status: 'CONVERTED', purchaseOrderId: 'po1' } });
    expect(notifications.notifyBestEffort.mock.calls[0][0]).toMatchObject({ type: 'PURCHASE_ORDER_APPROVED' });
  });

  it('unsourced: stays APPROVED for manual conversion, no PO', async () => {
    const { svc, tx } = world(requisition());
    const out = await svc.applyApproval(CEO, 'pr1');
    expect(out.status).toBe('APPROVED');
    expect(tx.purchaseOrder.create).not.toHaveBeenCalled();
  });
});
