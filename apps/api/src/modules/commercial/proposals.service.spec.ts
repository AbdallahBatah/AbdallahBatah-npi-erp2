/**
 * CRM Phase 1 · Step 3 (contract §3): creating a proposal drives the
 * opportunity forward, and a closed opportunity takes no new proposal.
 * The stage rules themselves are pinned in opportunities.service.spec.ts; this
 * spec pins that the proposal service USES them, inside its own transaction.
 */
import { ConflictException } from '@nestjs/common';
import { ProposalsService } from './proposals.service';

describe('ProposalsService.create — opportunity stage', () => {
  const user = { organizationId: 'org1', userId: 'u1' } as never;

  function setup(advance: jest.Mock) {
    const tx = { proposal: { create: jest.fn().mockResolvedValue({ id: 'p1', code: 'PRP-00001' }) } };
    const prisma = {
      opportunity: { findFirst: jest.fn().mockResolvedValue({ id: 'opp1', organizationId: 'org1', stage: 'QUALIFICATION' }) },
      $transaction: jest.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
    };
    const numbering = { next: jest.fn().mockResolvedValue('PRP-00001') };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const opportunities = { advanceOnProposal: advance };
    const svc = new ProposalsService(prisma as never, numbering as never, audit as never, opportunities as never);
    return { svc, tx, prisma };
  }

  it('moves the opportunity on inside the same transaction as the proposal', async () => {
    const advance = jest.fn().mockResolvedValue(undefined);
    const { svc, tx } = setup(advance);
    await expect(svc.create(user, { opportunityId: 'opp1' } as never)).resolves.toMatchObject({ id: 'p1' });
    expect(advance).toHaveBeenCalledWith(tx, user, 'opp1');
    expect(tx.proposal.create).toHaveBeenCalledTimes(1);
  });

  it('a closed opportunity (409 from the stage rule) leaves no proposal behind', async () => {
    const advance = jest.fn().mockRejectedValue(new ConflictException('Opportunity is closed'));
    const { svc, tx } = setup(advance);
    await expect(svc.create(user, { opportunityId: 'opp1' } as never)).rejects.toThrow('Opportunity is closed');
    expect(tx.proposal.create).not.toHaveBeenCalled();
  });
});
