/**
 * Package 6 · P6-2 — petty cash: funded by the accountant, settled by the
 * custodian within what he holds, posted on the projects GM's approval.
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@npi/db';
import { PettyCashService } from './petty-cash.service';
import type { AuthUser } from '../../common/auth-user';

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const ACC = { userId: 'u-acc', organizationId: 'org1', permissions: ['finance.payment.read', 'finance.payment.write'] } as unknown as AuthUser;
const ENG = { userId: 'u-eng', organizationId: 'org1', permissions: ['projects.project.read'] } as unknown as AuthUser;

function world(balance = 1000, pending = 0) {
  const tx = {
    pettyCashMovement: {
      create: jest.fn().mockImplementation(async ({ data }: { data: object }) => ({ id: 'm1', ...data })),
      update: jest.fn(),
    },
    pettyCashLine: { createMany: jest.fn() },
    pettyCashCustody: { update: jest.fn() },
    projectCostEntry: { createMany: jest.fn() },
  };
  const prisma = {
    pettyCashCustody: {
      findFirst: jest.fn().mockResolvedValue({ id: 'c1', code: 'PCC-00001', custodianId: 'u-eng', status: 'OPEN', balance: D(balance) }),
    },
    pettyCashMovement: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { amount: pending ? D(pending) : null } }),
      findFirst: jest.fn().mockResolvedValue({
        id: 'm1', code: 'PCM-00001', custodyId: 'c1', status: 'PENDING', amount: D(300),
        custody: { code: 'PCC-00001', custodianId: 'u-eng' },
        lines: [
          { projectId: 'p1', wbsElementId: 'w1', amount: D(200), description: 'fuel' },
          { projectId: 'p2', wbsElementId: null, amount: D(100), description: 'water' },
        ],
      }),
      delete: jest.fn(),
    },
    project: { findMany: jest.fn().mockResolvedValue([{ id: 'p1' }]) },
    wbsElement: { findFirst: jest.fn().mockResolvedValue({ id: 'w1' }) },
    $transaction: jest.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
  };
  const approvals = { register: jest.fn(), gate: jest.fn().mockResolvedValue({ cleared: false, request: { id: 'ar' } }) };
  const posting = {
    accounts: jest.fn().mockResolvedValue({ PETTY_CASH: 'acc-pc', BANK: 'acc-bank', WIP: 'acc-wip' }),
    journal: jest.fn(),
  };
  const svc = new PettyCashService(
    prisma as never,
    { next: jest.fn().mockResolvedValue('PCM-00001') } as never,
    { record: jest.fn() } as never,
    approvals as never,
    { notifyUserBestEffort: jest.fn() } as never,
    posting as never,
  );
  svc.onModuleInit();
  return { svc, tx, posting, approvals };
}

const line = { projectId: 'p1', wbsElementId: 'w1', description: 'fuel', amount: 200, spentOn: '2026-10-30' };

it('funding posts Dr petty cash / Cr bank and raises the balance', async () => {
  const { svc, tx, posting } = world();
  await svc.fund(ACC, 'c1', { amount: 500 });
  expect(posting.journal.mock.calls[0][1].lines).toEqual([
    { accountId: 'acc-pc', debit: 500, credit: 0 },
    { accountId: 'acc-bank', debit: 0, credit: 500 },
  ]);
  expect(tx.pettyCashCustody.update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { balance: { increment: 500 } } });
});

it('only the custodian settles (403)', async () => {
  const { svc } = world();
  await expect(svc.settle(ACC, 'c1', { lines: [line] })).rejects.toBeInstanceOf(ForbiddenException);
});

it('a settlement cannot exceed the cash held net of pending settlements (400)', async () => {
  const { svc } = world(1000, 900);
  await expect(svc.settle(ENG, 'c1', { lines: [line] })).rejects.toBeInstanceOf(BadRequestException);
});

it('approval posts one WIP journal per project and the cost on the budget line', async () => {
  const { tx, posting, approvals } = world();
  const apply = approvals.register.mock.calls[0][1] as (u: AuthUser, id: string) => Promise<unknown>;
  await apply(ACC, 'm1');
  expect(posting.journal).toHaveBeenCalledTimes(2);
  expect(posting.journal.mock.calls[0][1]).toMatchObject({ projectId: 'p1', lines: [{ accountId: 'acc-wip', debit: 200 }, { accountId: 'acc-pc', credit: 200 }] });
  expect(tx.projectCostEntry.createMany.mock.calls[0][0].data[0]).toMatchObject({ projectId: 'p1', wbsElementId: 'w1', sourceType: 'PettyCashMovement' });
  expect(tx.pettyCashCustody.update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { balance: { decrement: D(300) } } });
});
