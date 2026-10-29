/**
 * CRM Phase 1 · Step 4 — the proposal lifecycle against a real PostgreSQL (contract §8).
 *
 * The real kernel (matrix, workflow engine, outbox) and the real seeded users
 * (`sales@npi.sa` raises, `ceo@npi.sa` is the seeded «executive» who signs) drive
 * the shipped PROPOSAL flow and the shipped «every proposal → executive» rule.
 * What a unit double cannot prove, and this spec does:
 *   - costs come from a real accepted receipt / approved order / the catalogue,
 *     in the proposal's currency only,
 *   - the matrix really parks the proposal, refuses the wrong signer, and the
 *     last signature really approves it under the approver's name,
 *   - a new revision locks the previous one as superseded and re-enters approval,
 *   - the nightly sweep expires approved / sent revisions the day after their
 *     valid-until day, with no actor, and leaves drafts alone,
 *   - two simultaneous submits open exactly one signature chain.
 *
 * Not part of `npm test` — see jest.integration.config.js.
 */
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { rolePreset } from '@npi/shared';
import { PrismaService } from '../src/prisma/prisma.service';
import type { AuthUser } from '../src/common/auth-user';
import { authUserFor, buildProposalStack } from './support/proposal-stack';

const prisma = new PrismaService();
const stack = buildProposalStack(prisma);
const { proposals, approvals, contracts, expiry, opportunities } = stack;

const suffix = `${Date.now()}`;
let SALES: AuthUser;
let CEO: AuthUser;
/** The seeded executive does not hold commercial.proposal.write, so a CEO who raises a proposal himself needs it granted. */
let CEO_WRITER: AuthUser;
let ORG = '';
let CUSTOMER = '';
let ITEM_A = '';
let ITEM_B = '';
let VENDOR = '';

const created = { proposals: [] as string[], opportunities: [] as string[], pos: [] as string[], grns: [] as string[] };
const testStartedAt = new Date();

/** A calendar day in Riyadh as YYYY-MM-DD, `offset` days from today. */
const day = (offset: number) => new Date(Date.now() + 3 * 3_600_000 + offset * 86_400_000).toISOString().slice(0, 10);
const utcMidnight = (d: string) => new Date(`${d}T00:00:00.000Z`);

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url || !['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname)) {
    throw new Error('Refusing to run against a non-local database');
  }
  SALES = await authUserFor(prisma, 'sales@npi.sa');
  CEO = await authUserFor(prisma, 'ceo@npi.sa');
  ORG = SALES.organizationId;
  CEO_WRITER = { ...CEO, permissions: [...CEO.permissions, 'commercial.proposal.write'] };

  // Fixture assumptions, failed loudly rather than as a confusing assertion later.
  if (!SALES.permissions.includes('commercial.proposal.write') || !SALES.permissions.includes('finance.costs.view')) {
    throw new Error('Fixture assumption broken: sales@npi.sa must hold commercial.proposal.write and finance.costs.view');
  }
  if (!CEO.permissions.includes('commercial.proposal.approve') || CEO.roleKey !== 'executive') {
    throw new Error('Fixture assumption broken: ceo@npi.sa must be an executive holding commercial.proposal.approve');
  }
  const exec = await prisma.role.findFirstOrThrow({ where: { organizationId: ORG, key: 'executive' } });
  const otherExecutives = await prisma.user.count({
    where: {
      organizationId: ORG, isActive: true, id: { not: CEO.userId },
      OR: [{ roleId: exec.id }, { extraRoles: { some: { roleId: exec.id } } }],
    },
  });
  if (otherExecutives > 0) {
    throw new Error('Fixture assumption broken: ceo@npi.sa must be the ONLY active holder of the executive role for the self-approval case');
  }
  const rule = await prisma.approvalRule.findFirst({
    where: { organizationId: ORG, documentType: 'PROPOSAL' as never, isActive: true },
    include: { steps: true },
  });
  if (!rule || Number(rule.minAmount) !== 0 || rule.maxAmount !== null || rule.steps.length !== 1 || rule.steps[0].roleId !== exec.id) {
    throw new Error('Fixture assumption broken: the shipped PROPOSAL rule is [0, ∞) with the single step «executive» (migration 0027 / seed)');
  }

  const customer = await prisma.customer.create({
    data: { organizationId: ORG, code: `T4C-${suffix}`, nameAr: 'مصنع الرياض للصناعات (اختبار)', nameEn: `Riyadh Industries T4 ${suffix}`, crNumber: `6${suffix.slice(-9)}` },
  });
  CUSTOMER = customer.id;

  const itemA = await prisma.item.create({
    data: { organizationId: ORG, sku: `T4-A-${suffix}`, nameAr: 'لوح شمسي اختبار', nameEn: 'T4 module', itemCategory: 'MODULE', unitCost: 80 },
  });
  const itemB = await prisma.item.create({
    data: { organizationId: ORG, sku: `T4-B-${suffix}`, nameAr: 'كابل اختبار', nameEn: 'T4 cable', itemCategory: 'CABLE', unitCost: 50 },
  });
  ITEM_A = itemA.id;
  ITEM_B = itemB.id;

  // Item A: an ACCEPTED receipt 10 days ago on an approved SAR order at 95.00 — and, newer and dearer,
  // an ACCEPTED receipt on a USD order at 999.00 that a SAR proposal must ignore.
  const vendor = await prisma.vendor.create({
    data: { organizationId: ORG, code: `V-T4-${suffix}`, nameAr: 'مورد اختبار', nameEn: 'T4 vendor' },
  });
  VENDOR = vendor.id;
  const mk = async (code: string, currency: string, unitPrice: number, receivedDaysAgo: number) => {
    const po = await prisma.purchaseOrder.create({
      data: {
        organizationId: ORG, code, vendorId: vendor.id, currency, status: 'APPROVED', approvedAt: new Date(Date.now() - (receivedDaysAgo + 2) * 86_400_000),
        lines: { create: [{ itemId: ITEM_A, qty: 5, unitPrice, lineTotal: 5 * unitPrice }] },
      },
      include: { lines: true },
    });
    const grn = await prisma.goodsReceipt.create({
      data: {
        organizationId: ORG, code: `${code}-G`, purchaseOrderId: po.id, status: 'ACCEPTED', receivedAt: new Date(Date.now() - receivedDaysAgo * 86_400_000),
        lines: { create: [{ purchaseOrderLineId: po.lines[0].id, qty: 5 }] },
      },
    });
    created.pos.push(po.id);
    created.grns.push(grn.id);
  };
  await mk(`T4PO-SAR-${suffix}`, 'SAR', 95, 10);
  await mk(`T4PO-USD-${suffix}`, 'USD', 999, 1);
});

afterAll(async () => {
  // Best-effort and step by step: a refusal in one (a contract with milestones, say)
  // must not leave the rest behind. Every assertion has already run by now.
  const ids = created.proposals;
  const steps: Array<[string, () => Promise<unknown>]> = [
    ['approval requests', () => prisma.approvalRequest.deleteMany({ where: { documentType: 'PROPOSAL' as never, documentId: { in: ids } } })],
    ['workflow instances', () => prisma.wfInstance.deleteMany({ where: { documentType: 'Proposal', documentId: { in: ids } } })],
    ['contracts', () => prisma.contract.deleteMany({ where: { proposalId: { in: ids } } })],
    ['proposals', () => prisma.proposal.deleteMany({ where: { id: { in: ids } } })],
    ['opportunities', () => prisma.opportunity.deleteMany({ where: { id: { in: created.opportunities } } })],
    ['receipts', () => prisma.goodsReceipt.deleteMany({ where: { id: { in: created.grns } } })],
    ['orders', () => prisma.purchaseOrder.deleteMany({ where: { id: { in: created.pos } } })],
    ['vendor', () => prisma.vendor.deleteMany({ where: { id: VENDOR } })],
    ['items', () => prisma.item.deleteMany({ where: { id: { in: [ITEM_A, ITEM_B] } } })],
    ['customer', () => prisma.customer.deleteMany({ where: { id: CUSTOMER } })],
    ['notifications', () => prisma.notification.deleteMany({ where: { userId: { in: [SALES.userId, CEO.userId] }, createdAt: { gte: testStartedAt } } })],
  ];
  for (const [what, run] of steps) {
    try {
      await run();
    } catch (err) {
      console.warn(`proposal-lifecycle cleanup (${what}) failed - local test data left behind:`, (err as Error).message);
    }
  }
  await prisma.$disconnect();
});

async function newOpportunity(user: AuthUser, name: string) {
  const o = await opportunities.create(user, { name, customerId: CUSTOMER, estimatedValue: 500_000 } as never);
  created.opportunities.push(o.id);
  return o.id;
}

/** A proposal with one draft revision of 10 x A at 120 and 4 x B at 80 (valid for 30 days). */
async function draftProposal(user: AuthUser = SALES, validUntil = day(30)) {
  const oppId = await newOpportunity(user, `فرصة ${suffix}-${created.proposals.length}`);
  const p = await proposals.create(user, { opportunityId: oppId } as never);
  created.proposals.push(p.id);
  const rev = await proposals.addRevision(user, p.id, {
    validUntil,
    bomLines: [
      { itemId: ITEM_A, qty: 10, unitPrice: 120 },
      { itemId: ITEM_B, qty: 4, unitPrice: 80 },
    ],
  });
  return { proposalId: p.id, oppId, revisionId: rev.id as string };
}

const requestOf = (proposalId: string, status = 'PENDING') =>
  prisma.approvalRequest.findFirstOrThrow({
    where: { documentType: 'PROPOSAL' as never, documentId: proposalId, status: status as never },
    include: { steps: { include: { role: true }, orderBy: { sequence: 'asc' } } },
    orderBy: { createdAt: 'desc' },
  });
const revOf = (id: string) => prisma.proposalRevision.findUniqueOrThrow({ where: { id }, include: { bomLines: true } });
const propOf = (id: string) => prisma.proposal.findUniqueOrThrow({ where: { id } });
const instanceOf = (id: string) => prisma.wfInstance.findFirstOrThrow({ where: { documentType: 'Proposal', documentId: id } });
const historyOf = async (id: string) =>
  prisma.wfHistory.findMany({ where: { instanceId: (await instanceOf(id)).id }, orderBy: { createdAt: 'asc' } });

/** Raise, get the executive's signature, and send. */
async function toSent(proposalId: string) {
  await proposals.submit(SALES, proposalId);
  await approvals.decide(CEO, (await requestOf(proposalId)).id, 'APPROVE');
  await proposals.send(SALES, proposalId);
}

describe('the full road: cost capture → approval → sent → a new revision → approval → accepted → contract', () => {
  let proposalId = '';
  let oppId = '';
  let rev1 = '';
  let rev2 = '';

  it('prices the lines at their last purchase cost, with source and age, ignoring other currencies', async () => {
    ({ proposalId, oppId, revisionId: rev1 } = await draftProposal());
    const rev = await revOf(rev1);
    const a = rev.bomLines.find((l) => l.itemId === ITEM_A)!;
    const b = rev.bomLines.find((l) => l.itemId === ITEM_B)!;
    expect(a).toMatchObject({ costSource: 'GRN', costAgeDays: 10 });
    expect(a.unitCost!.toFixed(2)).toBe('95.00'); // the SAR receipt, not the dearer USD one
    expect(a.originalUnitCost!.toFixed(2)).toBe('95.00');
    expect(a.costDate).toBeInstanceOf(Date);
    expect(b).toMatchObject({ costSource: 'CATALOGUE', costDate: null, costAgeDays: null });
    expect(b.unitCost!.toFixed(2)).toBe('50.00');
    expect(rev.subtotal.toFixed(2)).toBe('1150.00'); // 10x95 + 4x50
    expect(rev.totalAmount.toFixed(2)).toBe('1520.00'); // 10x120 + 4x80
    expect(rev.marginAmount.toFixed(2)).toBe('370.00');
    expect(rev).toMatchObject({ status: 'DRAFT', revisionNo: 1, createdById: SALES.userId });
    expect(rev.validUntil!.toISOString().slice(0, 10)).toBe(day(30));
    expect((await propOf(proposalId)).status).toBe('DRAFT');
    expect((await instanceOf(proposalId)).currentState).toBe('DRAFT');
  });

  it('the cost-lookup endpoint reports the same sources and ages', async () => {
    const out = await proposals.costLookup(SALES, { itemIds: [ITEM_A, ITEM_B], currency: 'SAR' });
    const byId = new Map(out.map((r) => [r.itemId, r]));
    expect(byId.get(ITEM_A)).toMatchObject({ costSource: 'GRN', costAgeDays: 10, stale: false });
    expect(byId.get(ITEM_B)).toMatchObject({ costSource: 'CATALOGUE', costAgeDays: null, stale: true });
  });

  it('the draft’s page names who will be asked to sign it, offers SUBMIT, and carries the settings the form needs', async () => {
    const got = await proposals.get(SALES, proposalId);
    // The seeded executive role carries its preset's name since P1-13 («المدير العام»).
    expect(got.submitTo).toMatchObject({ nameEn: rolePreset('executive')!.nameEn });
    expect(got.settings).toMatchObject({ validityDays: expect.any(Number), costAgeWarnDays: expect.any(Number) });
    expect(got.actions.map((a: { actionCode: string }) => a.actionCode)).toEqual(['SUBMIT']);
    expect(got.currentRevisionNo).toBe(1);
  });

  it('a manual cost needs a reason (400); with one the original, the new cost, who and why are kept', async () => {
    const lines = (reason?: string) => [
      { itemId: ITEM_A, qty: 10, unitPrice: 120, unitCost: 90, costOverrideReason: reason },
      { itemId: ITEM_B, qty: 4, unitPrice: 80 },
    ];
    await expect(proposals.updateRevision(SALES, proposalId, rev1, { validUntil: day(30), bomLines: lines() })).rejects.toThrow(
      new BadRequestException('Cost override reason is required'),
    );
    await proposals.updateRevision(SALES, proposalId, rev1, { validUntil: day(30), bomLines: lines('عرض مورّد رقم 4411') });
    const rev = await revOf(rev1);
    const a = rev.bomLines.find((l) => l.itemId === ITEM_A)!;
    expect(a).toMatchObject({ costSource: 'MANUAL', costOverrideReason: 'عرض مورّد رقم 4411', costOverriddenById: SALES.userId });
    expect(a.unitCost!.toFixed(2)).toBe('90.00');
    expect(a.originalUnitCost!.toFixed(2)).toBe('95.00'); // the original is never lost
    expect(a.costOverriddenAt).toBeInstanceOf(Date);
    expect(rev.subtotal.toFixed(2)).toBe('1100.00'); // 10x90 + 4x50
    expect(rev.totalAmount.toFixed(2)).toBe('1520.00');
    expect(rev.bomLines).toHaveLength(2); // replaced, not appended
    const get = await proposals.get(SALES, proposalId);
    expect(get.revisions[0].bomLines.find((l: { itemId: string }) => l.itemId === ITEM_A)).toMatchObject({ costSource: 'MANUAL' });
  });

  it('submitting parks it awaiting approval: a chain of one step (executive) for the SELLING total, assigned to that role', async () => {
    const out = await proposals.submit(SALES, proposalId);
    expect(out.pendingApproval).toMatchObject({ documentType: 'PROPOSAL', documentId: proposalId });
    const req = await requestOf(proposalId);
    expect(Number(req.amount)).toBe(1520);
    expect(req.documentCode).toMatch(/^PRP-\d+ R1$/);
    expect(req.steps).toHaveLength(1);
    expect(req.steps[0].role.key).toBe('executive');
    expect(req.raisedById).toBe(SALES.userId);
    expect((await revOf(rev1)).status).toBe('PENDING_APPROVAL');
    expect((await revOf(rev1)).submittedAt).toBeInstanceOf(Date);
    expect((await propOf(proposalId)).status).toBe('PENDING_APPROVAL');
    const inst = await instanceOf(proposalId);
    expect(inst.currentState).toBe('PENDING_APPROVAL');
    expect(inst.assigneeRoleId).toBe(req.steps[0].roleId);
    expect(await stack.approvals.pendingFor(ORG, 'PROPOSAL', [proposalId])).toHaveProperty('size', 1);
  });

  it('while parked it takes no edit, no new revision and no second submit', async () => {
    await expect(proposals.addRevision(SALES, proposalId, { validUntil: day(30), bomLines: [{ itemId: ITEM_A, qty: 1, unitPrice: 1 }] })).rejects.toThrow(
      new ConflictException('Previous revision is awaiting approval'),
    );
    await expect(proposals.updateRevision(SALES, proposalId, rev1, { validUntil: day(30), bomLines: [{ itemId: ITEM_A, qty: 1, unitPrice: 1 }] })).rejects.toThrow(
      'Only a draft revision can be edited — add a new revision',
    );
    await expect(proposals.submit(SALES, proposalId)).rejects.toThrow(ConflictException);
    await expect(proposals.send(SALES, proposalId)).rejects.toThrow(ConflictException);
  });

  it('the raiser cannot sign it (the matrix refuses), and neither can anyone outside the approver role', async () => {
    const req = await requestOf(proposalId);
    await expect(approvals.decide(SALES, req.id, 'APPROVE')).rejects.toThrow(ForbiddenException);
    const admin = await authUserFor(prisma, 'admin@npi.sa'); // holds the approve key, not the executive role
    await expect(approvals.decide(admin, req.id, 'APPROVE')).rejects.toThrow(ForbiddenException);
    expect((await revOf(rev1)).status).toBe('PENDING_APPROVAL');
    expect((await requestOf(proposalId)).status).toBe('PENDING');
  });

  it('the executive’s signature approves it under his name, with the history row and the proposal.approved event', async () => {
    const req = await requestOf(proposalId);
    const res = await approvals.decide(CEO, req.id, 'APPROVE');
    expect(res.applied).toBe(true);
    const rev = await revOf(rev1);
    expect(rev.status).toBe('APPROVED');
    expect(rev.approvedAt).toBeInstanceOf(Date);
    expect((await propOf(proposalId)).status).toBe('APPROVED');
    expect((await instanceOf(proposalId)).currentState).toBe('APPROVED');
    const hist = await historyOf(proposalId);
    expect(hist.map((h) => [h.actionCode, h.actorId])).toEqual([
      ['OPEN', null],
      ['SUBMIT', SALES.userId],
      ['APPROVE', CEO.userId],
    ]);
    const ev = await prisma.domainEvent.findMany({
      where: { organizationId: ORG, eventCode: 'proposal.approved', payloadJson: { path: ['documentId'], equals: proposalId } },
    });
    expect(ev).toHaveLength(1);
    expect(ev[0].payloadJson).toMatchObject({ proposalId, revisionNo: 1, opportunityId: oppId, totalAmount: 1520 });
  });

  it('the page’s actions offer SEND and REVISE (never APPROVE / RETURN / EXPIRE, which belong to the matrix and the clock)', async () => {
    const got = await proposals.get(SALES, proposalId);
    expect(got.actions.map((a: { actionCode: string }) => a.actionCode).sort()).toEqual(['REVISE', 'SEND']);
  });

  it('sending marks it SENT', async () => {
    await proposals.send(SALES, proposalId);
    const rev = await revOf(rev1);
    expect(rev.status).toBe('SENT');
    expect(rev.sentAt).toBeInstanceOf(Date);
    expect((await propOf(proposalId)).status).toBe('SENT');
  });

  it('a change after sending is a NEW numbered revision: R2 is a draft, R1 is locked as superseded, the proposal is a draft again', async () => {
    const r2 = await proposals.addRevision(SALES, proposalId, {
      validUntil: day(45),
      bomLines: [
        { itemId: ITEM_A, qty: 10, unitPrice: 115 },
        { itemId: ITEM_B, qty: 4, unitPrice: 80 },
      ],
    });
    rev2 = r2.id;
    const first = await revOf(rev1);
    expect(first).toMatchObject({ status: 'SUPERSEDED', supersededById: rev2 });
    expect(first.closedAt).toBeInstanceOf(Date);
    expect(await revOf(rev2)).toMatchObject({ revisionNo: 2, status: 'DRAFT' });
    expect((await propOf(proposalId)).status).toBe('DRAFT');
    expect((await instanceOf(proposalId)).currentState).toBe('DRAFT');
    expect((await historyOf(proposalId)).map((h) => h.actionCode)).toContain('REVISE');
    // the locked revision keeps its figures
    expect((await revOf(rev1)).totalAmount.toFixed(2)).toBe('1520.00');
  });

  it('R2 must be approved again, from the start, by a fresh signature', async () => {
    await proposals.submit(SALES, proposalId);
    const req2 = await requestOf(proposalId);
    expect(req2.documentCode).toMatch(/ R2$/);
    expect(Number(req2.amount)).toBe(1470);
    await approvals.decide(CEO, req2.id, 'APPROVE');
    expect((await revOf(rev2)).status).toBe('APPROVED');
    expect(await prisma.approvalRequest.count({ where: { documentType: 'PROPOSAL' as never, documentId: proposalId } })).toBe(2);
  });

  it('only the current sent revision can be accepted; once accepted nothing but a change order may alter it', async () => {
    await proposals.send(SALES, proposalId);
    await expect(proposals.acceptRevision(SALES, proposalId, rev1)).rejects.toThrow(
      new ConflictException('Only the current sent revision can be accepted'),
    );
    // P3-8: not without the customer's approval filed on the proposal since it was sent.
    await expect(proposals.acceptRevision(SALES, proposalId, rev2)).rejects.toThrow(
      "Attach the customer's approval to the proposal before accepting it",
    );
    await prisma.attachment.create({
      data: {
        organizationId: ORG,
        entityType: 'PROPOSAL' as never,
        entityId: proposalId,
        fileName: 'customer-approval.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1,
        storageKey: `int-spec/${proposalId}-approval.pdf`,
      },
    });
    await proposals.acceptRevision(SALES, proposalId, rev2);
    expect(await revOf(rev2)).toMatchObject({ status: 'ACCEPTED', isWinning: true });
    expect((await propOf(proposalId)).status).toBe('ACCEPTED');
    expect((await instanceOf(proposalId)).closedAt).toBeInstanceOf(Date);
    await expect(
      proposals.addRevision(SALES, proposalId, { validUntil: day(30), bomLines: [{ itemId: ITEM_A, qty: 1, unitPrice: 1 }] }),
    ).rejects.toThrow('Proposal is accepted — changes go through a change order');
  });

  it('a contract can be created from the accepted revision (D-01) and it wins the opportunity', async () => {
    const c = await contracts.create(SALES, { proposalRevisionId: rev2, contractType: 'EPC' } as never);
    expect(Number(c.totalValue)).toBe(1470);
    expect((await prisma.opportunity.findUniqueOrThrow({ where: { id: oppId } })).stage).toBe('WON');
  });
});

describe('defaults', () => {
  it('a revision with no validity date gets today plus the configured number of days (30 as shipped)', async () => {
    const days = await stack.settings.get(ORG, 'crm.proposal.validityDays', 30);
    const oppId = await newOpportunity(SALES, `فرصة افتراضية ${suffix}`);
    const p = await proposals.create(SALES, { opportunityId: oppId } as never);
    created.proposals.push(p.id);
    const rev = await proposals.addRevision(SALES, p.id, { bomLines: [{ itemId: ITEM_B, qty: 1, unitPrice: 70 }] });
    expect((await revOf(rev.id)).validUntil!.toISOString().slice(0, 10)).toBe(day(days));
  });
});

describe('the approver is never the raiser', () => {
  it('a proposal raised by the only executive cannot be submitted: nobody else could sign it (409), and nothing changes', async () => {
    const { proposalId, revisionId } = await draftProposal(CEO_WRITER);
    await expect(proposals.submit(CEO_WRITER, proposalId)).rejects.toThrow(
      new ConflictException('No other approver is available for this proposal'),
    );
    expect(await prisma.approvalRequest.count({ where: { documentType: 'PROPOSAL' as never, documentId: proposalId } })).toBe(0);
    expect((await revOf(revisionId)).status).toBe('DRAFT');
    expect((await instanceOf(proposalId)).currentState).toBe('DRAFT');
  });

  it('lending his own authority to someone else does not help him: a delegation from the raiser does not count (409)', async () => {
    const { proposalId } = await draftProposal(CEO_WRITER);
    const delegate = await authUserFor(prisma, 'admin@npi.sa');
    const delegation = await prisma.approvalDelegation.create({
      data: {
        organizationId: ORG, fromUserId: CEO.userId, toUserId: delegate.userId, isActive: true,
        startsAt: new Date(Date.now() - 3_600_000), endsAt: new Date(Date.now() + 3_600_000),
      },
    });
    try {
      await expect(proposals.submit(CEO_WRITER, proposalId)).rejects.toThrow('No other approver is available for this proposal');
    } finally {
      await prisma.approvalDelegation.delete({ where: { id: delegation.id } });
    }
  });

  it('while the executive is away, a delegate he named signs a SALESPERSON’s proposal in his place — the temporary delegation, not a standing deputy', async () => {
    const { proposalId } = await draftProposal();
    const delegate = await authUserFor(prisma, 'admin@npi.sa'); // holds the approve key, not the executive role
    const delegation = await prisma.approvalDelegation.create({
      data: {
        organizationId: ORG, fromUserId: CEO.userId, toUserId: delegate.userId, isActive: true,
        startsAt: new Date(Date.now() - 3_600_000), endsAt: new Date(Date.now() + 3_600_000),
      },
    });
    try {
      await proposals.submit(SALES, proposalId);
      const inbox = await approvals.inbox(delegate);
      expect(inbox.some((r) => r.documentId === proposalId && r.canDecide)).toBe(true);
      const res = await approvals.decide(delegate, (await requestOf(proposalId)).id, 'APPROVE');
      expect(res.applied).toBe(true);
      const step = (await requestOf(proposalId, 'APPROVED')).steps[0];
      expect(step.decidedById).toBe(delegate.userId);
      expect(step.delegationId).toBe(delegation.id);
    } finally {
      await prisma.approvalDelegation.delete({ where: { id: delegation.id } });
    }
  });
});

describe('the approver’s refusal sends it back to be fixed', () => {
  it('a rejection returns the proposal to DRAFT with the note on the history; it can be edited and raised again', async () => {
    const { proposalId, revisionId } = await draftProposal();
    await proposals.submit(SALES, proposalId);
    const first = await requestOf(proposalId);
    const res = await approvals.decide(CEO, first.id, 'REJECT', 'الهامش ضعيف');
    expect(res.applied).toBe(false);
    expect((await revOf(revisionId)).status).toBe('DRAFT');
    expect((await propOf(proposalId)).status).toBe('DRAFT');
    const hist = await historyOf(proposalId);
    expect(hist[hist.length - 1]).toMatchObject({ actionCode: 'RETURN', actorId: CEO.userId, comment: 'الهامش ضعيف' });
    expect((await requestOf(proposalId, 'REJECTED')).id).toBe(first.id);

    // fixable and re-raisable: a fresh chain opens
    await proposals.updateRevision(SALES, proposalId, revisionId, {
      validUntil: day(30),
      bomLines: [{ itemId: ITEM_A, qty: 10, unitPrice: 140 }, { itemId: ITEM_B, qty: 4, unitPrice: 90 }],
    });
    await proposals.submit(SALES, proposalId);
    const second = await requestOf(proposalId);
    expect(second.id).not.toBe(first.id);
    expect(Number(second.amount)).toBe(1760);
  });
});

describe('time: a proposal revision expires the day after its valid-until day', () => {
  it('the sweep expires a SENT and an APPROVED revision whose day has passed — actor null, event emitted, author told', async () => {
    const sent = await draftProposal();
    await toSent(sent.proposalId);
    const approvedOnly = await draftProposal();
    await proposals.submit(SALES, approvedOnly.proposalId);
    await approvals.decide(CEO, (await requestOf(approvedOnly.proposalId)).id, 'APPROVE');

    for (const r of [sent.revisionId, approvedOnly.revisionId]) {
      await prisma.proposalRevision.update({ where: { id: r }, data: { validUntil: utcMidnight(day(-1)) } });
    }
    const n = await expiry.sweep();
    expect(n).toBeGreaterThanOrEqual(2);

    for (const p of [sent, approvedOnly]) {
      const rev = await revOf(p.revisionId);
      expect(rev.status).toBe('EXPIRED');
      expect(rev.closedAt).toBeInstanceOf(Date);
      expect((await propOf(p.proposalId)).status).toBe('EXPIRED');
      const hist = await historyOf(p.proposalId);
      const last = hist[hist.length - 1];
      expect(last).toMatchObject({ actionCode: 'EXPIRE', actorId: null });
      expect(last.comment).toMatch(/automatically/i);
      const ev = await prisma.domainEvent.findMany({
        where: { organizationId: ORG, eventCode: 'proposal.expired', payloadJson: { path: ['documentId'], equals: p.proposalId } },
      });
      expect(ev).toHaveLength(1);
    }
    expect(await prisma.notification.count({ where: { userId: SALES.userId, type: 'PROPOSAL_EXPIRED', createdAt: { gte: testStartedAt } } })).toBeGreaterThanOrEqual(2);
    // sweeping again finds nothing of ours
    await expiry.sweep();
    expect((await historyOf(sent.proposalId)).filter((h) => h.actionCode === 'EXPIRE')).toHaveLength(1);
  });

  it('the valid-until day itself is still valid; drafts and revisions awaiting approval are never swept', async () => {
    const today = await draftProposal();
    await toSent(today.proposalId);
    await prisma.proposalRevision.update({ where: { id: today.revisionId }, data: { validUntil: utcMidnight(day(0)) } });

    const draft = await draftProposal();
    await prisma.proposalRevision.update({ where: { id: draft.revisionId }, data: { validUntil: utcMidnight(day(-5)) } });

    const parked = await draftProposal();
    await proposals.submit(SALES, parked.proposalId);
    await prisma.proposalRevision.update({ where: { id: parked.revisionId }, data: { validUntil: utcMidnight(day(-5)) } });

    await expiry.sweep();
    expect((await revOf(today.revisionId)).status).toBe('SENT');
    expect((await revOf(draft.revisionId)).status).toBe('DRAFT');
    expect((await revOf(parked.revisionId)).status).toBe('PENDING_APPROVAL');
  });

  it('sending an approved revision after its validity expires it and refuses (409); a new revision then starts from EXPIRED', async () => {
    const p = await draftProposal();
    await proposals.submit(SALES, p.proposalId);
    await approvals.decide(CEO, (await requestOf(p.proposalId)).id, 'APPROVE');
    await prisma.proposalRevision.update({ where: { id: p.revisionId }, data: { validUntil: utcMidnight(day(-1)) } });

    await expect(proposals.send(SALES, p.proposalId)).rejects.toThrow(new ConflictException('Proposal revision has expired'));
    expect((await revOf(p.revisionId)).status).toBe('EXPIRED');
    expect((await instanceOf(p.proposalId)).currentState).toBe('EXPIRED');
    expect((await historyOf(p.proposalId)).filter((h) => h.actionCode === 'SEND')).toHaveLength(0);

    const r2 = await proposals.addRevision(SALES, p.proposalId, {
      validUntil: day(20),
      bomLines: [{ itemId: ITEM_A, qty: 1, unitPrice: 130 }],
    });
    expect(await revOf(p.revisionId)).toMatchObject({ status: 'SUPERSEDED', supersededById: r2.id });
    expect((await propOf(p.proposalId)).status).toBe('DRAFT');
  });

  it('a validity date that is today or earlier is refused (400)', async () => {
    const d = await draftProposal();
    await expect(
      proposals.updateRevision(SALES, d.proposalId, d.revisionId, { validUntil: day(0), bomLines: [{ itemId: ITEM_A, qty: 1, unitPrice: 1 }] }),
    ).rejects.toThrow('Validity date must be in the future');
    await expect(
      proposals.updateRevision(SALES, d.proposalId, d.revisionId, { validUntil: day(1), bomLines: [{ itemId: ITEM_A, qty: 1, unitPrice: 1 }] }),
    ).resolves.toBeDefined();
  });
});

describe('concurrency', () => {
  it('two simultaneous submits: exactly one succeeds and exactly one signature chain is opened', async () => {
    const { proposalId } = await draftProposal();
    const results = await Promise.allSettled([proposals.submit(SALES, proposalId), proposals.submit(SALES, proposalId)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await prisma.approvalRequest.count({ where: { documentType: 'PROPOSAL' as never, documentId: proposalId } })).toBe(1);
    expect((await instanceOf(proposalId)).currentState).toBe('PENDING_APPROVAL');
  });
});

describe('what the list shows', () => {
  it('the current revision, its validity, and the open signature chain on the rows that wait', async () => {
    const { proposalId } = await draftProposal();
    await proposals.submit(SALES, proposalId);
    const rows = await proposals.list(SALES);
    const mine = rows.find((r: { id: string }) => r.id === proposalId)!;
    expect(mine.revisions[0]).toMatchObject({ revisionNo: 1, status: 'PENDING_APPROVAL' });
    expect(mine.revisions[0].validUntil).toBeInstanceOf(Date);
    expect(mine.pendingApproval).toMatchObject({ documentType: 'PROPOSAL' });
  });
});
