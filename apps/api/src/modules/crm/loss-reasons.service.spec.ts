/**
 * CRM Phase 1 · Step 3 — the editable list of loss reasons (contract §3, §7).
 * A reason is never deleted: an opportunity lost last year still points at it.
 * Switching it off is the only way to retire it.
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import { LossReasonsService } from './loss-reasons.service';
import type { AuthUser } from '../../common/auth-user';

const ADMIN = { userId: 'u1', organizationId: 'org1', permissions: ['crm.opportunity.read', 'admin.org.manage'] } as unknown as AuthUser;
const SALES = { userId: 'u2', organizationId: 'org1', permissions: ['crm.opportunity.read', 'crm.opportunity.write'] } as unknown as AuthUser;

const ROW = { id: 'lr1', organizationId: 'org1', nameAr: 'السعر', nameEn: 'Price', isActive: true, sortOrder: 1 };

function setup(opts: { existing?: unknown; found?: unknown } = {}) {
  const lossReason = {
    findMany: jest.fn().mockResolvedValue([ROW]),
    findFirst: jest.fn().mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      // a lookup by name is the duplicate pre-check; a lookup by id is the row itself
      where.nameAr !== undefined ? (opts.existing ?? null) : (opts.found === undefined ? ROW : opts.found),
    ),
    create: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'new', ...data })),
    update: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...ROW, ...data })),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  };
  const tx = { lossReason };
  const prisma = { lossReason, $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return { svc: new LossReasonsService(prisma as never, audit as never), prisma, lossReason, audit, tx };
}

describe('LossReasonsService.list', () => {
  it('returns only the active reasons by default, in the configured order, scoped to the organization', async () => {
    const { svc, lossReason } = setup();
    await svc.list(SALES, false);
    const arg = lossReason.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ organizationId: 'org1', isActive: true });
    expect(arg.orderBy).toEqual([{ sortOrder: 'asc' }, { nameAr: 'asc' }]);
  });

  it('includes the switched-off ones when an administrator asks for all', async () => {
    const { svc, lossReason } = setup();
    await svc.list(ADMIN, true);
    expect(lossReason.findMany.mock.calls[0][0].where).toEqual({ organizationId: 'org1' });
  });

  it('ignores "all" for someone without admin.org.manage — a salesperson still sees active reasons only', async () => {
    const { svc, lossReason } = setup();
    await svc.list(SALES, true);
    expect(lossReason.findMany.mock.calls[0][0].where).toEqual({ organizationId: 'org1', isActive: true });
  });
});

describe('LossReasonsService.create', () => {
  it('creates an active reason for the caller\'s organization and audits it in the same transaction', async () => {
    const { svc, lossReason, audit, tx } = setup();
    await svc.create(ADMIN, { nameAr: ' عدم توفر التمويل ', nameEn: 'No funding', sortOrder: 4 });
    expect(lossReason.create.mock.calls[0][0].data).toMatchObject({
      organizationId: 'org1', nameAr: 'عدم توفر التمويل', nameEn: 'No funding', sortOrder: 4, isActive: true,
    });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'LossReason', action: 'CREATE' }), tx);
  });

  it('refuses a name already in the list (409), without writing', async () => {
    const { svc, lossReason } = setup({ existing: ROW });
    const e = await svc.create(ADMIN, { nameAr: 'السعر', nameEn: 'Price again' }).catch((x) => x);
    expect(e).toBeInstanceOf(ConflictException);
    expect((e as Error).message).toMatch(/already in use/i);
    expect(lossReason.create).not.toHaveBeenCalled();
  });

  it('turns the database\'s unique violation (two administrators racing) into the same 409', async () => {
    const { svc, lossReason } = setup();
    lossReason.create.mockRejectedValueOnce(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));
    await expect(svc.create(ADMIN, { nameAr: 'السعر', nameEn: 'Price' })).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('LossReasonsService.update', () => {
  it('switching a reason off keeps the row — isActive=false, no delete — and audits before/after', async () => {
    const { svc, lossReason, audit } = setup();
    const out = await svc.update(ADMIN, 'lr1', { isActive: false });
    expect(lossReason.update.mock.calls[0][0].data).toEqual({ isActive: false });
    expect(out.isActive).toBe(false);
    expect(lossReason.delete).not.toHaveBeenCalled();
    expect(lossReason.deleteMany).not.toHaveBeenCalled();
    expect(audit.record.mock.calls[0][0]).toMatchObject({
      entityType: 'LossReason',
      entityId: 'lr1',
      action: 'UPDATE',
      before: expect.objectContaining({ isActive: true }),
    });
  });

  it('renames a reason, refusing a name another reason already has (409)', async () => {
    const { svc } = setup({ existing: { ...ROW, id: 'lr2' } });
    await expect(svc.update(ADMIN, 'lr1', { nameAr: 'اختيار منافس' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('keeping its own name is not a clash', async () => {
    const { svc, lossReason } = setup();
    await expect(svc.update(ADMIN, 'lr1', { nameAr: 'السعر', sortOrder: 9 })).resolves.toBeDefined();
    expect(lossReason.update.mock.calls[0][0].data).toMatchObject({ nameAr: 'السعر', sortOrder: 9 });
  });

  it('404s a reason of another organization', async () => {
    const { svc, lossReason } = setup({ found: null });
    await expect(svc.update(ADMIN, 'lr-other', { isActive: false })).rejects.toBeInstanceOf(NotFoundException);
    expect(lossReason.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'lr-other', organizationId: 'org1' });
    expect(lossReason.update).not.toHaveBeenCalled();
  });

  it('exposes no delete at all', () => {
    const { svc } = setup();
    expect((svc as unknown as Record<string, unknown>).remove).toBeUndefined();
    expect((svc as unknown as Record<string, unknown>).delete).toBeUndefined();
  });
});
