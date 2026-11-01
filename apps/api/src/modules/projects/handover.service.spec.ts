/**
 * Package 7 (ADR-07) — the handover is submitted only when complete, and its
 * approval is what closes the project, starts warranties and makes the last
 * payment due.
 */
import { BadRequestException, ConflictException } from '@nestjs/common';
import { HANDOVER_CHECKLIST } from '@npi/shared';
import { HandoverService } from './handover.service';
import type { AuthUser } from '../../common/auth-user';

const ENG = { userId: 'u-eng', organizationId: 'org1', permissions: [] } as unknown as AuthUser;
const allOk = HANDOVER_CHECKLIST.map((c) => ({ key: c.key, ok: true }));
const handover = (over: Record<string, unknown> = {}) => ({
  id: 'h1', code: 'HND-00001', projectId: 'p1', status: 'DRAFT',
  completionDate: new Date('2026-10-20'), commissionedAt: new Date('2026-10-25'),
  checklist: allOk, readings: [], snags: null, snagsDueDate: null, clientRepName: 'Eng. Saad',
  warrantyYears: { PANELS_PRODUCT: 12, INVERTER: 5 }, submittedById: 'u-eng', ...over,
});

function world(opts: { stage?: string; files?: number; h?: Record<string, unknown>; cleared?: boolean } = {}) {
  const tx = {
    projectHandover: { update: jest.fn() },
    project: { update: jest.fn() },
    projectWarranty: { upsert: jest.fn() },
    contractMilestone: { update: jest.fn() },
  };
  const prisma = {
    project: {
      findFirst: jest.fn().mockResolvedValue({ id: 'p1', code: 'PRJ-00001', stage: opts.stage ?? 'COMMISSIONING', contract: { id: 'c1', totalValue: 500000 } }),
    },
    projectHandover: {
      findUnique: jest.fn().mockResolvedValue(handover(opts.h)),
      findFirst: jest.fn().mockResolvedValue({
        ...handover({ status: 'SUBMITTED', ...opts.h }),
        project: {
          code: 'PRJ-00001',
          contract: { id: 'c1', milestones: [
            { id: 'm1', sequence: 1, status: 'INVOICED', dueDate: null },
            { id: 'm3', sequence: 3, status: 'PENDING', dueDate: null },
          ] },
        },
      }),
      update: jest.fn(),
    },
    attachment: { count: jest.fn().mockResolvedValue(opts.files ?? 3) },
    executionOverrun: { count: jest.fn().mockResolvedValue(0) },
    materialReturn: { count: jest.fn().mockResolvedValue(0) },
    $transaction: jest.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
  };
  const approvals = {
    register: jest.fn(),
    gate: jest.fn().mockResolvedValue(opts.cleared ? { cleared: true, request: null } : { cleared: false, request: { id: 'ar' } }),
  };
  const notifications = { notifyBestEffort: jest.fn(), notifyUserBestEffort: jest.fn() };
  const svc = new HandoverService(prisma as never, {} as never, { record: jest.fn() } as never, approvals as never, notifications as never);
  const applier = () => approvals.register.mock.calls[0][1] as (u: AuthUser, id: string) => Promise<unknown>;
  svc.onModuleInit();
  return { svc, tx, prisma, approvals, notifications, applier };
}

describe('submit', () => {
  it('goes to the matrix as PROJECT_CLOSURE on the contract value', async () => {
    const { svc, approvals } = world();
    await svc.submit(ENG, 'p1');
    expect(approvals.gate.mock.calls[0][1]).toMatchObject({ documentType: 'PROJECT_CLOSURE', amount: 500000 });
  });

  it('refuses without a file on the project (photos / client acceptance)', async () => {
    const { svc } = world({ files: 0 });
    await expect(svc.submit(ENG, 'p1')).rejects.toThrow(/photos/);
  });

  it('a failed item needs snags and a deadline', async () => {
    const { svc } = world({ h: { checklist: [...allOk.slice(1), { key: allOk[0].key, ok: false }] } });
    await expect(svc.submit(ENG, 'p1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('only from the commissioning stage (409)', async () => {
    const { svc } = world({ stage: 'EXECUTION' });
    await expect(svc.submit(ENG, 'p1')).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('approval', () => {
  it('closes the project, starts warranties from commissioning, makes the last pending milestone due', async () => {
    const { tx, applier, notifications } = world();
    await applier()(ENG, 'h1');
    expect(tx.project.update).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { stage: 'CLOSED' } });
    const inverter = tx.projectWarranty.upsert.mock.calls.find((c) => c[0].create.kind === 'INVERTER')[0];
    expect(inverter.create.startsAt).toEqual(new Date('2026-10-25'));
    expect(inverter.create.endsAt).toEqual(new Date('2031-10-25'));
    expect(tx.contractMilestone.update.mock.calls[0][0]).toMatchObject({ where: { id: 'm3' }, data: { status: 'VERIFIED' } });
    expect(notifications.notifyBestEffort.mock.calls[0][0]).toMatchObject({ type: 'FINAL_PAYMENT_DUE' });
  });
});
