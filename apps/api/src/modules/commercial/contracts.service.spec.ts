import { BadRequestException } from '@nestjs/common';
import { ContractsService } from './contracts.service';

/**
 * D-01 from the 2026-08-01 UAT round: the API created a contract from a
 * proposal revision that was never accepted, locking in a price nobody
 * approved. The UI only offers the winning revision, but the endpoint is
 * reachable directly — so the rule lives in the service and is pinned here.
 */
describe('ContractsService.create — proposal revision guard', () => {
  const numbering = { next: jest.fn().mockResolvedValue('CTR-00001') };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const notifications = { notifyBestEffort: jest.fn().mockResolvedValue(undefined) };

  function service(revision: unknown) {
    const tx = {
      contract: { create: jest.fn().mockResolvedValue({ id: 'c1', milestones: [] }) },
      opportunity: { update: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      proposalRevision: { findFirst: jest.fn().mockResolvedValue(revision) },
      customer: { findFirst: jest.fn().mockResolvedValue({ id: 'cus1' }) },
      $transaction: jest.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
    };
    const svc = new ContractsService(
      prisma as never,
      numbering as never,
      audit as never,
      notifications as never,
    );
    return { svc, prisma, tx };
  }

  const user = { organizationId: 'org1', userId: 'u1' } as never;
  const dto = { proposalRevisionId: 'rev1', contractType: 'EPC' } as never;

  const acceptedRevision = {
    status: 'ACCEPTED',
    contract: null,
    proposalId: 'prop1',
    totalAmount: 138000,
    proposal: { opportunityId: 'opp1', opportunity: { customerId: 'cus1' } },
  };

  it.each(['DRAFT', 'SENT', 'REJECTED'])(
    'refuses a %s revision — the case that was exploitable',
    async (status) => {
      const { svc, prisma } = service({ ...acceptedRevision, status });
      await expect(svc.create(user, dto)).rejects.toThrow(
        /requires an accepted proposal revision/i,
      );
      // Refused before any writes: the transaction never opened.
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it('still refuses an accepted revision that already has a contract', async () => {
    const { svc } = service({ ...acceptedRevision, contract: { id: 'c0' } });
    await expect(svc.create(user, dto)).rejects.toThrow(BadRequestException);
  });

  it('creates the contract from an accepted revision, inheriting its value', async () => {
    const { svc, tx } = service(acceptedRevision);
    await expect(svc.create(user, dto)).resolves.toMatchObject({ id: 'c1' });
    expect(tx.contract.create).toHaveBeenCalledTimes(1);
    expect(tx.contract.create.mock.calls[0][0].data).toMatchObject({
      customerId: 'cus1',
      totalValue: 138000,
      status: 'DRAFT',
    });
    // The chain closes: winning the contract moves the opportunity to WON.
    expect(tx.opportunity.update).toHaveBeenCalledWith({
      where: { id: 'opp1' },
      data: { stage: 'WON' },
    });
  });
});
