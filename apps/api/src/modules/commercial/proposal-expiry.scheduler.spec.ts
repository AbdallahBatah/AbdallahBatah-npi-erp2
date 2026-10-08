/**
 * CRM Phase 1 · Step 4 (contract §5, §8) — an approved or sent proposal revision
 * passes to «منتهي الصلاحية» by itself once its whole valid-until day is over.
 * The sweep selects; the proposal service performs the move (engine, system actor).
 * Which side of "today" counts as expired is proved against real rows in
 * test/proposal-lifecycle.int-spec.ts.
 */
import { riyadhDayStart } from '@npi/shared';
import { ProposalExpiryScheduler } from './proposal-expiry.scheduler';

const NOW = new Date('2026-10-08T10:00:00Z'); // 13:00 on the 8th in Riyadh

const row = (proposalId: string, organizationId = 'org1') => ({ id: `rev-${proposalId}`, proposalId, proposal: { organizationId } });

function setup(rows: unknown[], expire = jest.fn().mockResolvedValue(true)) {
  const prisma = { proposalRevision: { findMany: jest.fn().mockResolvedValue(rows) } };
  const proposals = { expireBySystem: expire };
  return { sched: new ProposalExpiryScheduler(prisma as never, proposals as never), prisma, proposals };
}

describe('ProposalExpiryScheduler.sweep', () => {
  it('asks for approved and sent revisions whose valid-until day ended before today began (Riyadh)', async () => {
    const { sched, prisma } = setup([]);
    await sched.sweep(NOW);
    const where = prisma.proposalRevision.findMany.mock.calls[0][0].where;
    expect(where.status).toEqual({ in: ['APPROVED', 'SENT'] });
    expect(where.validUntil).toEqual({ lt: riyadhDayStart(NOW) });
  });

  it('never selects drafts or revisions awaiting approval', async () => {
    const { sched, prisma } = setup([]);
    await sched.sweep(NOW);
    const statuses: string[] = prisma.proposalRevision.findMany.mock.calls[0][0].where.status.in;
    expect(statuses).not.toContain('DRAFT');
    expect(statuses).not.toContain('PENDING_APPROVAL');
  });

  it('expires each one through the proposal service, per organization, and counts them', async () => {
    const { sched, proposals } = setup([row('p1'), row('p2', 'org2')]);
    await expect(sched.sweep(NOW)).resolves.toBe(2);
    expect(proposals.expireBySystem).toHaveBeenCalledWith('org1', 'p1', NOW);
    expect(proposals.expireBySystem).toHaveBeenCalledWith('org2', 'p2', NOW);
  });

  it('counts only the moves that happened (a revision that changed under it is skipped)', async () => {
    const expire = jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { sched } = setup([row('p1'), row('p2')], expire);
    await expect(sched.sweep(NOW)).resolves.toBe(1);
  });

  it('one failing proposal does not stop the others', async () => {
    const expire = jest.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(true);
    const { sched } = setup([row('p1'), row('p2')], expire);
    await expect(sched.sweep(NOW)).resolves.toBe(1);
    expect(expire).toHaveBeenCalledTimes(2);
  });

  it('the nightly entry point never throws into the scheduler', async () => {
    const prisma = { proposalRevision: { findMany: jest.fn().mockRejectedValue(new Error('db down')) } };
    const sched = new ProposalExpiryScheduler(prisma as never, {} as never);
    await expect(sched.scheduledSweep()).resolves.toBeUndefined();
  });
});
