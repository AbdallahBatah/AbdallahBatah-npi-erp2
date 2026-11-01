/**
 * Package 5 (ADR-05) — the cap on a budget line is its quantity plus approved
 * overruns; beyond it, nothing is recorded until both signatures land; an
 * overrun with no rule in the matrix is refused rather than cleared.
 */
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@npi/db';
import { ExecutionService } from './execution.service';
import type { AuthUser } from '../../common/auth-user';

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const ENG = { userId: 'u-eng', organizationId: 'org1', permissions: ['projects.project.write'] } as unknown as AuthUser;
const wbs = (over: Record<string, unknown> = {}) => ({
  id: 'w1', code: 'WI-PILES', projectId: 'p1', qty: D(100), uom: 'pc', budgetAmount: D(10000), ...over,
});

function world(opts: { done?: number; extra?: number; line?: Record<string, unknown>; cleared?: boolean } = {}) {
  const tx = {
    workProgressEntry: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { qty: opts.done === undefined ? null : D(opts.done) } }),
      create: jest.fn().mockImplementation(async ({ data }: { data: object }) => ({ id: 'e1', ...data })),
    },
    executionOverrun: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { extraQty: opts.extra === undefined ? null : D(opts.extra) } }),
      create: jest.fn().mockImplementation(async ({ data }: { data: object }) => ({ id: 'o1', ...data })),
    },
  };
  const prisma = {
    project: { findFirst: jest.fn().mockResolvedValue({ id: 'p1', stage: 'EXECUTION' }) },
    wbsElement: {
      findMany: jest.fn().mockResolvedValue([wbs(opts.line)]),
      findFirst: jest.fn().mockResolvedValue(wbs(opts.line)),
    },
    executionOverrun: { count: jest.fn().mockResolvedValue(0), delete: jest.fn() },
    $transaction: jest.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
  };
  const approvals = {
    register: jest.fn(),
    gate: jest.fn().mockResolvedValue(opts.cleared ? { cleared: true, request: null } : { cleared: false, request: { id: 'ar1' } }),
  };
  const svc = new ExecutionService(
    prisma as never,
    { next: jest.fn().mockResolvedValue('OVR-00001') } as never,
    { record: jest.fn() } as never,
    approvals as never,
    { notifyUserBestEffort: jest.fn() } as never,
    {} as never,
  );
  return { svc, tx, prisma, approvals };
}

const today = new Date().toISOString().slice(0, 10);

describe('daily progress against the cap', () => {
  it('records within the approved quantity', async () => {
    const { svc, tx } = world({ done: 60 });
    await svc.recordProgress(ENG, 'p1', { workDate: today, lines: [{ wbsElementId: 'w1', qty: 40 }] });
    expect(tx.workProgressEntry.create).toHaveBeenCalledTimes(1);
  });

  it('refuses beyond the quantity (409) and names what is left', async () => {
    const { svc, tx } = world({ done: 90 });
    await expect(
      svc.recordProgress(ENG, 'p1', { workDate: today, lines: [{ wbsElementId: 'w1', qty: 11 }] }),
    ).rejects.toThrow(/only 10 pc left/);
    expect(tx.workProgressEntry.create).not.toHaveBeenCalled();
  });

  it('an approved overrun raises the cap', async () => {
    const { svc, tx } = world({ done: 90, extra: 20 });
    await svc.recordProgress(ENG, 'p1', { workDate: today, lines: [{ wbsElementId: 'w1', qty: 30 }] });
    expect(tx.workProgressEntry.create).toHaveBeenCalled();
  });

  it('a line with no planned quantity has no cap', async () => {
    const { svc, tx } = world({ line: { qty: null } });
    await svc.recordProgress(ENG, 'p1', { workDate: today, lines: [{ wbsElementId: 'w1', qty: 5000 }] });
    expect(tx.workProgressEntry.aggregate).not.toHaveBeenCalled();
    expect(tx.workProgressEntry.create).toHaveBeenCalled();
  });
});

describe('overrun request', () => {
  it('is banded on extra × budgeted unit cost and sent to the matrix', async () => {
    const { svc, tx, approvals } = world();
    await svc.requestOverrun(ENG, 'p1', { wbsElementId: 'w1', extraQty: 5, reason: 'soil rock layer' });
    expect(tx.executionOverrun.create.mock.calls[0][0].data).toMatchObject({ amount: 500, code: 'OVR-00001' });
    expect(approvals.gate.mock.calls[0][1]).toMatchObject({ documentType: 'EXECUTION_OVERRUN', amount: 500 });
  });

  it('with no rule in the matrix: withdrawn and refused, never cleared (409)', async () => {
    const { svc, prisma } = world({ cleared: true });
    await expect(
      svc.requestOverrun(ENG, 'p1', { wbsElementId: 'w1', extraQty: 5, reason: 'soil rock layer' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.executionOverrun.delete).toHaveBeenCalledWith({ where: { id: 'o1' } });
  });
});
