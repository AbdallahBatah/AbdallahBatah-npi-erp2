/**
 * CRM Phase 1 · Step 3 — the sales funnel against a real PostgreSQL (contract §7).
 *
 * A fresh organization is built so nothing here touches the seeded data. The
 * services under test are assembled by hand, like the other integration specs:
 * OpportunitiesService, ProposalsService, ContractsService, LossReasonsService.
 *
 * What a unit double cannot prove, and this spec does:
 *   - the new enum value and columns exist and round-trip,
 *   - a proposal or a contract moves the opportunity in the SAME transaction
 *     (a refusal leaves nothing behind),
 *   - the audit rows and outbox events are really written,
 *   - two simultaneous stage changes cannot both win.
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { NumberingService } from '../src/common/numbering.service';
import { AuditService } from '../src/common/audit.service';
import { NotificationService } from '../src/common/notification.service';
import { OutboxService } from '../src/common/workflow/outbox.service';
import { OpportunitiesService } from '../src/modules/crm/opportunities.service';
import { LossReasonsService } from '../src/modules/crm/loss-reasons.service';
import { ProposalsService } from '../src/modules/commercial/proposals.service';
import { ContractsService } from '../src/modules/commercial/contracts.service';
import type { AuthUser } from '../src/common/auth-user';

const prisma = new PrismaService();
const numbering = new NumberingService(prisma);
const audit = new AuditService(prisma);
const outbox = new OutboxService(prisma);
const opportunities = new OpportunitiesService(prisma, numbering, audit, outbox);
const lossReasons = new LossReasonsService(prisma, audit);
const proposals = new ProposalsService(prisma, numbering, audit, opportunities);
const contracts = new ContractsService(prisma, numbering, audit, new NotificationService(prisma), opportunities);

const suffix = `${Date.now()}`;
let ORG = '';
let USER: AuthUser;
let CUSTOMER = '';
let REASON_ACTIVE = '';
let REASON_OFF = '';

async function stageRows(opportunityId: string) {
  return prisma.auditLog.findMany({
    where: { organizationId: ORG, entityType: 'Opportunity', entityId: opportunityId, action: 'STAGE_CHANGE' },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
  });
}

async function events(eventCode: string, opportunityId: string) {
  return prisma.domainEvent.findMany({
    where: { organizationId: ORG, eventCode, payloadJson: { path: ['opportunityId'], equals: opportunityId } },
  });
}

/** A proposal revision the customer accepted, written directly so the scenario needs no pricing. */
async function acceptedRevision(proposalId: string, amount: number) {
  await prisma.proposal.update({ where: { id: proposalId }, data: { status: 'ACCEPTED' } });
  return prisma.proposalRevision.create({
    data: { proposalId, revisionNo: 1, status: 'ACCEPTED', isWinning: true, subtotal: amount, totalAmount: amount },
  });
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url || !['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname)) {
    throw new Error('Refusing to run against a non-local database');
  }
  const org = await prisma.organization.create({
    data: { legalNameAr: 'منشأة اختبار القمع', legalNameEn: `Funnel Test ${suffix}`, baseCurrency: 'SAR' },
  });
  ORG = org.id;
  const source = await prisma.organization.findFirstOrThrow({
    where: { id: { not: org.id }, numberingSequences: { some: { documentType: 'OPPORTUNITY' } } },
    select: { id: true },
  });
  const sequences = await prisma.numberingSequence.findMany({ where: { organizationId: source.id } });
  await prisma.numberingSequence.createMany({
    data: sequences.map((s) => ({
      organizationId: org.id, documentType: s.documentType, prefix: s.prefix, fiscalYear: s.fiscalYear, nextValue: 1, padding: s.padding,
    })),
  });
  // The owner of an opportunity is a real user (foreign key), so build one.
  const role = await prisma.role.create({
    data: { organizationId: org.id, key: 'admin', nameAr: 'مدير', nameEn: 'Admin', permissions: [] },
  });
  const owner = await prisma.user.create({
    data: {
      organizationId: org.id, email: `funnel-${suffix}@funnel.test`, passwordHash: 'x', nameAr: 'مالك', nameEn: 'Owner', roleId: role.id,
    },
  });
  USER = {
    userId: owner.id,
    organizationId: org.id,
    permissions: ['crm.opportunity.read', 'crm.opportunity.write', 'admin.org.manage', 'finance.costs.view'],
  } as unknown as AuthUser;
  const customer = await prisma.customer.create({
    data: { organizationId: org.id, code: `FC-${suffix}`, nameAr: 'مصنع الرياض للصناعات', nameEn: 'Riyadh Industries', crNumber: `8${suffix.slice(-9)}` },
  });
  CUSTOMER = customer.id;
  REASON_ACTIVE = (await lossReasons.create(USER, { nameAr: 'السعر', nameEn: 'Price', sortOrder: 1 })).id;
  REASON_OFF = (await lossReasons.create(USER, { nameAr: 'سبب قديم', nameEn: 'Old reason', sortOrder: 9 })).id;
  await lossReasons.update(USER, REASON_OFF, { isActive: false });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('the funnel, end to end: prospecting → qualification → proposal → negotiation → lost', () => {
  let oppId = '';
  let proposalId = '';

  it('is born PROSPECTING and DIRECT, with the Step 3 columns', async () => {
    const o = await opportunities.create(USER, { name: 'محطة المصنع 500 ك.و', customerId: CUSTOMER, estimatedValue: 1_250_000 } as never);
    oppId = o.id;
    expect(o).toMatchObject({ stage: 'PROSPECTING', opportunityType: 'DIRECT', closedAt: null });
    expect(o.code).toMatch(/^OPP-/);
  });

  it('moves to QUALIFICATION through /stage, stamping stageChangedAt, and audits it', async () => {
    const o = await opportunities.changeStage(USER, oppId, { stage: 'QUALIFICATION' });
    expect(o.stage).toBe('QUALIFICATION');
    expect(o.stageChangedAt).toBeInstanceOf(Date);
    expect((await stageRows(oppId)).map((r) => (r.afterJson as { stage: string }).stage)).toEqual(['QUALIFICATION']);
  });

  it('refuses to skip ahead (409 OPPORTUNITY_STAGE / SKIP)', async () => {
    const e = (await opportunities.changeStage(USER, oppId, { stage: 'NEGOTIATION' }).catch((x) => x)) as ConflictException;
    expect(e).toBeInstanceOf(ConflictException);
    expect(e.getResponse()).toMatchObject({ code: 'OPPORTUNITY_STAGE', from: 'QUALIFICATION', to: 'NEGOTIATION', reason: 'SKIP' });
  });

  it('creating a proposal carries it to PROPOSAL automatically, audited with via: proposal', async () => {
    const p = await proposals.create(USER, { opportunityId: oppId } as never);
    proposalId = p.id;
    expect((await prisma.opportunity.findUniqueOrThrow({ where: { id: oppId } })).stage).toBe('PROPOSAL');
    const rows = await stageRows(oppId);
    expect(rows).toHaveLength(2);
    expect(rows[1].afterJson).toMatchObject({ stage: 'PROPOSAL', via: 'proposal' });
  });

  it('a second proposal leaves the stage alone', async () => {
    await proposals.create(USER, { opportunityId: oppId } as never);
    expect((await stageRows(oppId))).toHaveLength(2);
  });

  it('goes on to NEGOTIATION, and may step back (audited backward: true) and forward again', async () => {
    await opportunities.changeStage(USER, oppId, { stage: 'NEGOTIATION' });
    await opportunities.changeStage(USER, oppId, { stage: 'PROPOSAL' });
    await opportunities.changeStage(USER, oppId, { stage: 'NEGOTIATION' });
    const rows = await stageRows(oppId);
    expect(rows.map((r) => Boolean((r.afterJson as { backward?: boolean }).backward))).toEqual([false, false, false, true, false]);
  });

  it('refuses LOST without a reason (400) and with a switched-off reason (404): still NEGOTIATION', async () => {
    await expect(opportunities.changeStage(USER, oppId, { stage: 'LOST' })).rejects.toThrow('Loss reason is required');
    await expect(opportunities.changeStage(USER, oppId, { stage: 'LOST', lossReasonId: REASON_OFF })).rejects.toBeInstanceOf(NotFoundException);
    expect((await prisma.opportunity.findUniqueOrThrow({ where: { id: oppId } })).stage).toBe('NEGOTIATION');
  });

  it('LOST with an active reason: closedAt, reason, notes and the opportunity.lost event', async () => {
    const o = await opportunities.changeStage(USER, oppId, { stage: 'LOST', lossReasonId: REASON_ACTIVE, lossNotes: 'اختاروا منافساً' });
    expect(o).toMatchObject({ stage: 'LOST', lossReasonId: REASON_ACTIVE, lossNotes: 'اختاروا منافساً' });
    expect(o.closedAt).toBeInstanceOf(Date);
    const ev = await events('opportunity.lost', oppId);
    expect(ev).toHaveLength(1);
    expect(ev[0].payloadJson).toMatchObject({ opportunityId: oppId, stage: 'LOST', lossReasonId: REASON_ACTIVE, customerId: CUSTOMER });
    expect(await events('opportunity.won', oppId)).toHaveLength(0);
  });

  it('a lost opportunity takes no new proposal (409), and nothing is left behind by the refusal', async () => {
    const before = await prisma.proposal.count({ where: { organizationId: ORG, opportunityId: oppId } });
    await expect(proposals.create(USER, { opportunityId: oppId } as never)).rejects.toThrow('Opportunity is closed');
    expect(await prisma.proposal.count({ where: { organizationId: ORG, opportunityId: oppId } })).toBe(before);
  });

  it('a lost opportunity takes no contract either (409), even from an accepted revision', async () => {
    const rev = await acceptedRevision(proposalId, 100_000);
    const before = await prisma.contract.count({ where: { organizationId: ORG } });
    await expect(contracts.create(USER, { proposalRevisionId: rev.id, contractType: 'EPC' } as never)).rejects.toThrow('Opportunity is closed');
    expect(await prisma.contract.count({ where: { organizationId: ORG } })).toBe(before);
  });

  it('cannot be reopened (409 TERMINAL) or edited beyond name and notes (409)', async () => {
    const e = (await opportunities.changeStage(USER, oppId, { stage: 'PROSPECTING' }).catch((x) => x)) as ConflictException;
    expect(e.getResponse()).toMatchObject({ code: 'OPPORTUNITY_STAGE', reason: 'TERMINAL' });
    await expect(opportunities.update(USER, oppId, { estimatedValue: 1 })).rejects.toThrow('Opportunity is closed');
    await expect(opportunities.update(USER, oppId, { name: 'اسم مصحَّح' })).resolves.toMatchObject({ name: 'اسم مصحَّح' });
  });
});

describe('a contract wins the opportunity', () => {
  it('PROPOSAL → WON through the contract, audited via: contract, event emitted; /stage then answers TERMINAL', async () => {
    const o = await opportunities.create(USER, { name: 'مشروع المستودع', customerId: CUSTOMER, estimatedValue: 300_000 } as never);
    const p = await proposals.create(USER, { opportunityId: o.id } as never);
    expect((await prisma.opportunity.findUniqueOrThrow({ where: { id: o.id } })).stage).toBe('PROPOSAL');
    const rev = await acceptedRevision(p.id, 138_000);

    await contracts.create(USER, { proposalRevisionId: rev.id, contractType: 'EPC' } as never);

    const won = await prisma.opportunity.findUniqueOrThrow({ where: { id: o.id } });
    expect(won.stage).toBe('WON');
    expect(won.closedAt).toBeInstanceOf(Date);
    const rows = await stageRows(o.id);
    expect(rows[rows.length - 1].afterJson).toMatchObject({ stage: 'WON', via: 'contract' });
    expect(await events('opportunity.won', o.id)).toHaveLength(1);

    const e = (await opportunities.changeStage(USER, o.id, { stage: 'LOST', lossReasonId: REASON_ACTIVE }).catch((x) => x)) as ConflictException;
    expect(e).toBeInstanceOf(ConflictException);
    expect(e.getResponse()).toMatchObject({ reason: 'TERMINAL', from: 'WON' });

    // CRM-S3-b: a won opportunity takes no second contract either — the
    // refusal happens before anything is written, and the single won event stays single.
    const rev2 = await prisma.proposalRevision.create({
      data: { proposalId: p.id, revisionNo: 2, status: 'ACCEPTED', isWinning: false, subtotal: 1, totalAmount: 1 },
    });
    const before = await prisma.contract.count({ where: { organizationId: ORG } });
    await expect(contracts.create(USER, { proposalRevisionId: rev2.id, contractType: 'EPC' } as never)).rejects.toThrow('Opportunity is closed');
    expect(await prisma.contract.count({ where: { organizationId: ORG } })).toBe(before);
    expect(await events('opportunity.won', o.id)).toHaveLength(1);
  });

  it('winning by hand is allowed from NEGOTIATION only, clearing loss data', async () => {
    const o = await prisma.opportunity.create({
      data: { organizationId: ORG, code: `MW-${suffix}`, name: 'فرصة يدوية', customerId: CUSTOMER, stage: 'PROPOSAL' },
    });
    await expect(opportunities.changeStage(USER, o.id, { stage: 'WON' })).rejects.toBeInstanceOf(ConflictException);
    await opportunities.changeStage(USER, o.id, { stage: 'NEGOTIATION' });
    const won = await opportunities.changeStage(USER, o.id, { stage: 'WON' });
    expect(won).toMatchObject({ stage: 'WON', lossReasonId: null });
    expect(await events('opportunity.won', o.id)).toHaveLength(1);
  });
});

describe('concurrency', () => {
  it('two simultaneous QUALIFICATION → PROPOSAL changes: exactly one wins, one audit row, one 409', async () => {
    const o = await prisma.opportunity.create({
      data: { organizationId: ORG, code: `CC-${suffix}`, name: 'سباق', customerId: CUSTOMER, stage: 'QUALIFICATION' },
    });
    const results = await Promise.allSettled([
      opportunities.changeStage(USER, o.id, { stage: 'PROPOSAL' }),
      opportunities.changeStage(USER, o.id, { stage: 'PROPOSAL' }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toBeInstanceOf(ConflictException);
    expect(await stageRows(o.id)).toHaveLength(1);
    expect((await prisma.opportunity.findUniqueOrThrow({ where: { id: o.id } })).stage).toBe('PROPOSAL');
  });

  it('a contract and a loss racing for the same opportunity: one of them wins, never both', async () => {
    const o = await prisma.opportunity.create({
      data: { organizationId: ORG, code: `CR-${suffix}`, name: 'سباق العقد', customerId: CUSTOMER, stage: 'PROPOSAL' },
    });
    const results = await Promise.allSettled([
      prisma.$transaction((tx) => opportunities.markWonViaContract(tx, USER, o.id)),
      opportunities.changeStage(USER, o.id, { stage: 'LOST', lossReasonId: REASON_ACTIVE }),
    ]);
    const final = await prisma.opportunity.findUniqueOrThrow({ where: { id: o.id } });
    expect(['WON', 'LOST']).toContain(final.stage);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await events('opportunity.won', o.id)).length + (await events('opportunity.lost', o.id)).length).toBe(1);
  });
});

describe('tenders and types', () => {
  it('a tender needs its close date; once saved it keeps the bid bond as a Decimal', async () => {
    await expect(
      opportunities.create(USER, { name: 'مناقصة', customerId: CUSTOMER, opportunityType: 'TENDER' } as never),
    ).rejects.toThrow('Tender close date is required');
    const o = await opportunities.create(USER, {
      name: 'مناقصة مدرسة', customerId: CUSTOMER, opportunityType: 'TENDER', tenderReference: 'T-114', tenderCloseDate: '2026-12-01',
      bidBondAmount: 12345.67, bidBondBank: 'الراجحي', bidBondExpiry: '2027-03-01', bidBondReference: 'BG-1',
    } as never);
    const row = await prisma.opportunity.findUniqueOrThrow({ where: { id: o.id } });
    expect(row.opportunityType).toBe('TENDER');
    expect(row.bidBondAmount?.toString()).toBe('12345.67');
    expect(row.tenderCloseDate?.toISOString().slice(0, 10)).toBe('2026-12-01');

    // Changing to a direct sale wipes the tender data; it is audited.
    await opportunities.update(USER, o.id, { opportunityType: 'DIRECT' });
    const wiped = await prisma.opportunity.findUniqueOrThrow({ where: { id: o.id } });
    expect([wiped.tenderReference, wiped.tenderCloseDate, wiped.bidBondAmount, wiped.bidBondBank]).toEqual([null, null, null, null]);
  });

  it('list filters by type and by open', async () => {
    const tenders = await opportunities.list(USER, { type: 'TENDER' });
    expect(tenders.every((x: { opportunityType: string }) => x.opportunityType === 'TENDER')).toBe(true);
    const open = await opportunities.list(USER, { open: true });
    expect(open.every((x: { stage: string }) => !['WON', 'LOST'].includes(x.stage))).toBe(true);
    expect(open.length).toBeGreaterThan(0);
  });
});

describe('the loss-reason list', () => {
  it('hides a switched-off reason from a salesperson, shows it to an administrator who asks, and never deletes', async () => {
    const sales = { ...USER, permissions: ['crm.opportunity.read', 'crm.opportunity.write'] } as AuthUser;
    expect((await lossReasons.list(sales, true)).map((r: { id: string }) => r.id)).not.toContain(REASON_OFF);
    expect((await lossReasons.list(USER, true)).map((r: { id: string }) => r.id)).toContain(REASON_OFF);
    expect((await lossReasons.list(USER, false)).map((r: { id: string }) => r.id)).toEqual([REASON_ACTIVE]);
  });

  it('a duplicate Arabic name is a 409', async () => {
    await expect(lossReasons.create(USER, { nameAr: 'السعر', nameEn: 'Price twin' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('the database refuses to delete a reason an opportunity points at (Restrict)', async () => {
    await expect(prisma.lossReason.delete({ where: { id: REASON_ACTIVE } })).rejects.toBeDefined();
  });
});
