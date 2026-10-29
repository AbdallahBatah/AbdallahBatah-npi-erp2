/**
 * CRM Phase 1 · Step 3 — opportunities and the sales funnel (contract §3, §7).
 *
 * The doubles stand in for Prisma, so these specs pin the RULES — which input
 * is refused with which status, what is written and in which order. That the
 * database really serialises two simultaneous stage changes is the integration
 * spec's job (test/opportunity-stages.int-spec.ts).
 */
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@npi/db';
import { OpportunitiesService } from './opportunities.service';
import type { AuthUser } from '../../common/auth-user';

const USER = {
  userId: 'u1',
  organizationId: 'org1',
  permissions: ['crm.opportunity.read', 'crm.opportunity.write'],
} as unknown as AuthUser;

function opp(over: Record<string, unknown> = {}) {
  return {
    id: 'o1',
    organizationId: 'org1',
    code: 'OPP-00001',
    name: 'محطة المصنع',
    customerId: 'c1',
    stage: 'PROSPECTING',
    opportunityType: 'DIRECT',
    estimatedKwp: null,
    estimatedValue: null,
    currency: 'SAR',
    expectedCloseDate: null,
    tenderReference: null,
    tenderCloseDate: null,
    bidBondAmount: null,
    bidBondBank: null,
    bidBondExpiry: null,
    bidBondReference: null,
    lossReasonId: null,
    lossNotes: null,
    closedAt: null,
    stageChangedAt: null,
    ...over,
  };
}

/** A transaction client whose single opportunity row is `row` (or absent). */
function makeTx(opts: { row?: Record<string, unknown> | null; lossReason?: unknown; updateCount?: number } = {}) {
  const row = opts.row === undefined ? opp() : opts.row;
  return {
    opportunity: {
      findFirst: jest.fn().mockResolvedValue(row),
      updateMany: jest.fn().mockResolvedValue({ count: opts.updateCount ?? 1 }),
      findUniqueOrThrow: jest.fn().mockImplementation(async () => ({ ...row, __reread: true })),
      update: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...row, ...data })),
      create: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'new', ...data })),
    },
    lossReason: { findFirst: jest.fn().mockResolvedValue(opts.lossReason ?? null) },
  };
}

function setup(tx: ReturnType<typeof makeTx>, customer: unknown = { id: 'c1', mergedIntoId: null }) {
  const prisma = {
    $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    customer: { findFirst: jest.fn().mockResolvedValue(customer) },
    opportunity: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(opp()) },
  };
  const numbering = { next: jest.fn().mockResolvedValue('OPP-00002') };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const outbox = { emit: jest.fn().mockResolvedValue('evt1') };
  const svc = new OpportunitiesService(prisma as never, numbering as never, audit as never, outbox as never);
  return { svc, prisma, numbering, audit, outbox };
}

async function thrown(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

const ACTIVE_REASON = { id: 'lr1', organizationId: 'org1', isActive: true, nameAr: 'السعر', nameEn: 'Price' };

describe('OpportunitiesService.changeStage — the funnel rules', () => {
  it('refuses LOST without a loss reason (400) before touching the database', async () => {
    const tx = makeTx({ row: opp({ stage: 'NEGOTIATION' }) });
    const { svc, prisma } = setup(tx);
    const e = await thrown(svc.changeStage(USER, 'o1', { stage: 'LOST' }));
    expect(e).toBeInstanceOf(BadRequestException);
    expect((e as Error).message).toBe('Loss reason is required');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.opportunity.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a loss reason that is switched off, or belongs to another organization (404)', async () => {
    const tx = makeTx({ row: opp({ stage: 'NEGOTIATION' }), lossReason: null });
    const { svc } = setup(tx);
    const e = await thrown(svc.changeStage(USER, 'o1', { stage: 'LOST', lossReasonId: 'lr-other' }));
    expect(e).toBeInstanceOf(NotFoundException);
    expect((e as Error).message).toBe('Loss reason not found');
    // The lookup itself carries both guards — that is what makes "inactive" and
    // "someone else's" indistinguishable from "does not exist".
    expect(tx.lossReason.findFirst.mock.calls[0][0].where).toEqual({
      id: 'lr-other',
      organizationId: 'org1',
      isActive: true,
    });
    expect(tx.opportunity.updateMany).not.toHaveBeenCalled();
  });

  it('closes a lost opportunity: reason, notes, closedAt, stageChangedAt, audit and the opportunity.lost event', async () => {
    const tx = makeTx({ row: opp({ stage: 'NEGOTIATION', estimatedValue: '250000.00' }), lossReason: ACTIVE_REASON });
    const { svc, audit, outbox } = setup(tx);
    await svc.changeStage(USER, 'o1', { stage: 'LOST', lossReasonId: 'lr1', lossNotes: 'اختاروا منافساً أرخص' });

    const call = tx.opportunity.updateMany.mock.calls[0][0];
    // Optimistic guard: only if the stage is still the one we read.
    expect(call.where).toEqual({ id: 'o1', organizationId: 'org1', stage: 'NEGOTIATION' });
    expect(call.data).toMatchObject({ stage: 'LOST', lossReasonId: 'lr1', lossNotes: 'اختاروا منافساً أرخص' });
    expect(call.data.closedAt).toBeInstanceOf(Date);
    expect(call.data.stageChangedAt).toBeInstanceOf(Date);

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'Opportunity', entityId: 'o1', action: 'STAGE_CHANGE' }),
      tx,
    );
    expect(outbox.emit).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        organizationId: 'org1',
        eventCode: 'opportunity.lost',
        payload: expect.objectContaining({ opportunityId: 'o1', code: 'OPP-00001', stage: 'LOST', lossReasonId: 'lr1' }),
      }),
    );
  });

  it('wins by hand from NEGOTIATION: clears any loss data, sets closedAt, emits opportunity.won', async () => {
    const tx = makeTx({ row: opp({ stage: 'NEGOTIATION' }) });
    const { svc, outbox } = setup(tx);
    await svc.changeStage(USER, 'o1', { stage: 'WON', lossReasonId: 'ignored', lossNotes: 'ignored' });
    const data = tx.opportunity.updateMany.mock.calls[0][0].data;
    expect(data).toMatchObject({ stage: 'WON', lossReasonId: null, lossNotes: null });
    expect(data.closedAt).toBeInstanceOf(Date);
    expect(outbox.emit.mock.calls[0][1].eventCode).toBe('opportunity.won');
  });

  it('an ordinary move between open stages is audited, not announced, and closes nothing', async () => {
    const tx = makeTx({ row: opp({ stage: 'PROSPECTING' }) });
    const { svc, audit, outbox } = setup(tx);
    await svc.changeStage(USER, 'o1', { stage: 'COST_STUDY' });
    const data = tx.opportunity.updateMany.mock.calls[0][0].data;
    expect(data.stage).toBe('COST_STUDY');
    expect(data.closedAt).toBeUndefined();
    expect(outbox.emit).not.toHaveBeenCalled();
    expect(audit.record.mock.calls[0][0].action).toBe('STAGE_CHANGE');
    expect(audit.record.mock.calls[0][0].after.backward).toBeUndefined();
  });

  it('a step back is allowed and says so in the audit trail (backward: true)', async () => {
    const tx = makeTx({ row: opp({ stage: 'NEGOTIATION' }) });
    const { svc, audit } = setup(tx);
    await svc.changeStage(USER, 'o1', { stage: 'PROPOSAL' });
    expect(audit.record.mock.calls[0][0].after).toMatchObject({ backward: true });
  });

  it.each([
    ['PROSPECTING', 'PROPOSAL', 'SKIP'],
    ['COST_STUDY', 'WON', 'SKIP'],
    ['WON', 'PROPOSAL', 'TERMINAL'],
    ['LOST', 'PROSPECTING', 'TERMINAL'],
  ])('refuses %s → %s with 409 "Invalid stage transition" (%s)', async (from, to, reason) => {
    const tx = makeTx({ row: opp({ stage: from }) });
    const { svc } = setup(tx);
    const e = (await thrown(svc.changeStage(USER, 'o1', { stage: to as never }))) as ConflictException;
    expect(e).toBeInstanceOf(ConflictException);
    const body = e.getResponse() as Record<string, unknown>;
    expect(String(body.message)).toMatch(/^Invalid stage transition:/);
    expect(body).toMatchObject({ code: 'OPPORTUNITY_STAGE', from, to, reason });
    expect(tx.opportunity.updateMany).not.toHaveBeenCalled();
  });

  it('loses the race (another request moved it first: updateMany matches no row) → 409, nothing audited or emitted', async () => {
    const tx = makeTx({ row: opp({ stage: 'COST_STUDY' }), updateCount: 0 });
    const { svc, audit, outbox } = setup(tx);
    const e = (await thrown(svc.changeStage(USER, 'o1', { stage: 'PROPOSAL' }))) as ConflictException;
    expect(e).toBeInstanceOf(ConflictException);
    expect(String((e.getResponse() as Record<string, unknown>).message)).toMatch(/^Invalid stage transition:/);
    expect(audit.record).not.toHaveBeenCalled();
    expect(outbox.emit).not.toHaveBeenCalled();
  });

  it('404s an opportunity of another organization (the lookup is scoped to the caller\'s)', async () => {
    const tx = makeTx({ row: null });
    const { svc } = setup(tx);
    await expect(svc.changeStage(USER, 'o-other', { stage: 'COST_STUDY' })).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.opportunity.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'o-other', organizationId: 'org1' });
  });
});

describe('OpportunitiesService.create — types and tenders', () => {
  const base = { name: 'مناقصة المستشفى', customerId: 'c1' };

  it('a tender without a close date is refused (400)', async () => {
    const { svc, prisma } = setup(makeTx());
    const e = await thrown(svc.create(USER, { ...base, opportunityType: 'TENDER' }));
    expect(e).toBeInstanceOf(BadRequestException);
    expect((e as Error).message).toBe('Tender close date is required');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('a tender keeps its reference, close date and bid bond; it is born PROSPECTING', async () => {
    const tx = makeTx();
    const { svc } = setup(tx);
    await svc.create(USER, {
      ...base,
      opportunityType: 'TENDER',
      tenderReference: 'T-2026-114',
      tenderCloseDate: '2026-12-01',
      bidBondAmount: 25000,
      bidBondBank: 'الراجحي',
      bidBondExpiry: '2027-03-01',
      bidBondReference: 'BG-778',
    });
    const data = tx.opportunity.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      opportunityType: 'TENDER',
      stage: 'PROSPECTING',
      tenderReference: 'T-2026-114',
      bidBondBank: 'الراجحي',
      bidBondReference: 'BG-778',
    });
    expect(data.tenderCloseDate).toEqual(new Date('2026-12-01'));
    expect(data.bidBondExpiry).toEqual(new Date('2027-03-01'));
    // Money is a Decimal, never a float.
    expect(String(data.bidBondAmount)).toBe('25000');
    expect(data.bidBondAmount).toBeInstanceOf(Prisma.Decimal);
  });

  it('a direct opportunity stores no tender data even if some was sent (the type decides)', async () => {
    const tx = makeTx();
    const { svc } = setup(tx);
    await svc.create(USER, { ...base, tenderReference: 'T-1', tenderCloseDate: '2026-12-01', bidBondAmount: 5 });
    const data = tx.opportunity.create.mock.calls[0][0].data;
    expect(data.opportunityType).toBe('DIRECT');
    expect(data.tenderReference).toBeNull();
    expect(data.tenderCloseDate).toBeNull();
    expect(data.bidBondAmount).toBeNull();
  });
});

describe('OpportunitiesService.update', () => {
  it('rejects a stage in the PATCH body (400): stage changes go through /stage', async () => {
    const tx = makeTx();
    const { svc, prisma } = setup(tx);
    const e = await thrown(svc.update(USER, 'o1', { stage: 'WON' } as never));
    expect(e).toBeInstanceOf(BadRequestException);
    expect((e as Error).message).toMatch(/^Stage changes go through/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses to edit a closed opportunity beyond its name and loss notes (409)', async () => {
    for (const stage of ['WON', 'LOST']) {
      const tx = makeTx({ row: opp({ stage }) });
      const { svc } = setup(tx);
      const e = await thrown(svc.update(USER, 'o1', { estimatedValue: 1 }));
      expect(e).toBeInstanceOf(ConflictException);
      expect((e as Error).message).toBe('Opportunity is closed');
      expect(tx.opportunity.update).not.toHaveBeenCalled();
    }
  });

  it('still lets a closed opportunity be renamed and its loss notes corrected', async () => {
    const tx = makeTx({ row: opp({ stage: 'LOST' }) });
    const { svc, audit } = setup(tx);
    await svc.update(USER, 'o1', { name: 'اسم أصح', lossNotes: 'تصحيح' });
    expect(tx.opportunity.update.mock.calls[0][0].data).toMatchObject({ name: 'اسم أصح', lossNotes: 'تصحيح' });
    // The audit row is written in the same transaction as the change.
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'UPDATE' }), tx);
  });

  it('changing the type from tender to direct wipes the tender and bid-bond fields, audited', async () => {
    const tx = makeTx({
      row: opp({
        opportunityType: 'TENDER',
        tenderReference: 'T-9',
        tenderCloseDate: new Date('2026-12-01'),
        bidBondAmount: '5000.00',
        bidBondBank: 'الأهلي',
        bidBondExpiry: new Date('2027-01-01'),
        bidBondReference: 'BG-1',
      }),
    });
    const { svc, audit } = setup(tx);
    await svc.update(USER, 'o1', { opportunityType: 'DIRECT' });
    expect(tx.opportunity.update.mock.calls[0][0].data).toMatchObject({
      opportunityType: 'DIRECT',
      tenderReference: null,
      tenderCloseDate: null,
      bidBondAmount: null,
      bidBondBank: null,
      bidBondExpiry: null,
      bidBondReference: null,
    });
    expect(audit.record.mock.calls[0][0]).toMatchObject({ action: 'UPDATE', before: expect.objectContaining({ tenderReference: 'T-9' }) });
  });

  it('turning a direct opportunity into a tender needs a close date (400)', async () => {
    const tx = makeTx();
    const { svc } = setup(tx);
    await expect(svc.update(USER, 'o1', { opportunityType: 'TENDER' })).rejects.toThrow('Tender close date is required');
    await expect(
      svc.update(USER, 'o1', { opportunityType: 'TENDER', tenderCloseDate: '2026-12-01' }),
    ).resolves.toBeDefined();
  });
});

describe('OpportunitiesService.markWonViaContract (the contract path)', () => {
  it('refuses a LOST opportunity (409 "Opportunity is closed") and changes nothing', async () => {
    const tx = makeTx({ row: opp({ stage: 'LOST' }) });
    const { svc, outbox } = setup(tx);
    const e = await thrown(svc.markWonViaContract(tx as never, USER, 'o1'));
    expect(e).toBeInstanceOf(ConflictException);
    expect((e as Error).message).toBe('Opportunity is closed');
    expect(tx.opportunity.updateMany).not.toHaveBeenCalled();
    expect(outbox.emit).not.toHaveBeenCalled();
  });

  it('wins an open opportunity from ANY open stage, tagged via: contract, with the won event', async () => {
    for (const stage of ['PROSPECTING', 'COST_STUDY', 'PROPOSAL', 'NEGOTIATION']) {
      const tx = makeTx({ row: opp({ stage }) });
      const { svc, audit, outbox } = setup(tx);
      await svc.markWonViaContract(tx as never, USER, 'o1');
      const call = tx.opportunity.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'o1', organizationId: 'org1', stage });
      expect(call.data).toMatchObject({ stage: 'WON', lossReasonId: null, lossNotes: null });
      expect(call.data.closedAt).toBeInstanceOf(Date);
      expect(audit.record.mock.calls[0][0]).toMatchObject({ action: 'STAGE_CHANGE', after: expect.objectContaining({ via: 'contract' }) });
      expect(outbox.emit.mock.calls[0][1].eventCode).toBe('opportunity.won');
    }
  });

  it('refuses a second contract on an already-won opportunity (409 "Opportunity is closed", CRM-S3-b) and changes nothing', async () => {
    const tx = makeTx({ row: opp({ stage: 'WON' }) });
    const { svc, outbox } = setup(tx);
    const e = await thrown(svc.markWonViaContract(tx as never, USER, 'o1'));
    expect(e).toBeInstanceOf(ConflictException);
    expect((e as Error).message).toBe('Opportunity is closed');
    expect(tx.opportunity.updateMany).not.toHaveBeenCalled();
    expect(outbox.emit).not.toHaveBeenCalled();
  });

  it('loses a race to a concurrent stage change (409)', async () => {
    const tx = makeTx({ row: opp({ stage: 'PROPOSAL' }), updateCount: 0 });
    const { svc } = setup(tx);
    await expect(svc.markWonViaContract(tx as never, USER, 'o1')).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('OpportunitiesService.advanceOnProposal (the proposal path)', () => {
  it.each(['PROSPECTING', 'COST_STUDY'])('moves a %s opportunity to PROPOSAL, tagged via: proposal', async (stage) => {
    const tx = makeTx({ row: opp({ stage }) });
    const { svc, audit, outbox } = setup(tx);
    await svc.advanceOnProposal(tx as never, USER, 'o1');
    const call = tx.opportunity.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'o1', organizationId: 'org1', stage });
    expect(call.data.stage).toBe('PROPOSAL');
    expect(audit.record.mock.calls[0][0]).toMatchObject({ action: 'STAGE_CHANGE', after: expect.objectContaining({ via: 'proposal' }) });
    expect(outbox.emit).not.toHaveBeenCalled();
  });

  it.each(['PROPOSAL', 'NEGOTIATION'])('leaves a %s opportunity where it is', async (stage) => {
    const tx = makeTx({ row: opp({ stage }) });
    const { svc, audit } = setup(tx);
    await svc.advanceOnProposal(tx as never, USER, 'o1');
    expect(tx.opportunity.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each(['WON', 'LOST'])('refuses a %s opportunity (409 "Opportunity is closed")', async (stage) => {
    const tx = makeTx({ row: opp({ stage }) });
    const { svc } = setup(tx);
    const e = await thrown(svc.advanceOnProposal(tx as never, USER, 'o1'));
    expect(e).toBeInstanceOf(ConflictException);
    expect((e as Error).message).toBe('Opportunity is closed');
  });
});

describe('OpportunitiesService.list', () => {
  it('filters by type and by "open only" using the shared definition of open', async () => {
    const tx = makeTx();
    const { svc, prisma } = setup(tx);
    await svc.list(USER, { type: 'TENDER', open: true });
    const where = prisma.opportunity.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ organizationId: 'org1', opportunityType: 'TENDER' });
    expect(where.stage).toEqual({ in: ['PROSPECTING', 'COST_STUDY', 'PROPOSAL', 'NEGOTIATION'] });
  });
});
