import { BadRequestException, ConflictException } from '@nestjs/common';
import { ContractsService } from './contracts.service';
import { OpportunitiesService } from '../crm/opportunities.service';

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

  /** `oppStage` is the stage the opportunity row has when the contract is created. */
  function service(revision: unknown, oppStage = 'NEGOTIATION') {
    const tx = {
      contract: { create: jest.fn().mockResolvedValue({ id: 'c1', milestones: [] }) },
      opportunity: {
        findFirst: jest.fn().mockResolvedValue({ id: 'opp1', organizationId: 'org1', code: 'OPP-00001', customerId: 'cus1', stage: oppStage, estimatedValue: null }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'opp1', stage: 'WON' }),
      },
    };
    const prisma = {
      proposalRevision: { findFirst: jest.fn().mockResolvedValue(revision) },
      customer: { findFirst: jest.fn().mockResolvedValue({ id: 'cus1' }) },
      $transaction: jest.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
    };
    const outbox = { emit: jest.fn().mockResolvedValue('evt1') };
    // The real opportunity rules, on the same transaction double: the contract
    // path to WON is a rule of the opportunity, not of the contract.
    const opportunities = new OpportunitiesService(prisma as never, numbering as never, audit as never, outbox as never);
    const svc = new ContractsService(
      prisma as never,
      numbering as never,
      audit as never,
      notifications as never,
      opportunities,
    );
    return { svc, prisma, tx, outbox };
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
    const { svc, tx, outbox } = service(acceptedRevision);
    await expect(svc.create(user, dto)).resolves.toMatchObject({ id: 'c1' });
    expect(tx.contract.create).toHaveBeenCalledTimes(1);
    expect(tx.contract.create.mock.calls[0][0].data).toMatchObject({
      customerId: 'cus1',
      totalValue: 138000,
      status: 'DRAFT',
    });
    // The chain closes: winning the contract moves the opportunity to WON —
    // through the shared rule (guarded update, audit tagged via: contract, event).
    expect(tx.opportunity.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.opportunity.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: 'opp1', organizationId: 'org1', stage: 'NEGOTIATION' },
      data: { stage: 'WON' },
    });
    expect(outbox.emit.mock.calls[0][1].eventCode).toBe('opportunity.won');
  });

  it('refuses a contract on an opportunity that was LOST (409) — nothing is created', async () => {
    const { svc, tx, outbox } = service(acceptedRevision, 'LOST');
    const e = await svc.create(user, dto).catch((x) => x);
    expect(e).toBeInstanceOf(ConflictException);
    expect((e as Error).message).toBe('Opportunity is closed');
    expect(tx.contract.create).not.toHaveBeenCalled();
    expect(tx.opportunity.updateMany).not.toHaveBeenCalled();
    expect(outbox.emit).not.toHaveBeenCalled();
  });

  it('refuses a second contract on an already WON opportunity (409, CRM-S3-b) — nothing is created', async () => {
    const { svc, tx } = service(acceptedRevision, 'WON');
    const e = await svc.create(user, dto).catch((x) => x);
    expect(e).toBeInstanceOf(ConflictException);
    expect((e as Error).message).toBe('Opportunity is closed');
    expect(tx.contract.create).not.toHaveBeenCalled();
    expect(tx.opportunity.updateMany).not.toHaveBeenCalled();
  });
});
