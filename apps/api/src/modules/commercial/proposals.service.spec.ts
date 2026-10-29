/**
 * CRM Phase 1 · Step 3 (contract §3) — creating a proposal drives the opportunity
 * forward, and a closed opportunity takes no new proposal.
 * CRM Phase 1 · Step 4 (contract §5, §8) — the proposal lifecycle: costs fetched by
 * the server, a manual cost needs a reason, a validity date is mandatory, every state
 * change goes through the workflow engine, every approval through the matrix.
 *
 * Doubles only: the real tables, the real matrix and the real engine are exercised
 * in test/proposal-lifecycle.int-spec.ts.
 */
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@npi/db';
import { PERMISSIONS, WF_ACTIONS } from '@npi/shared';
import type { AuthUser } from '../../common/auth-user';
import { holdsEffectively, holdsRole } from '../../common/permission-predicates';
import { fixtureUser, matchesWhere } from '../../common/testing/user-where';
import { ProposalsService } from './proposals.service';

const D = (v: string | number) => new Prisma.Decimal(v);

const user = (permissions: string[], over: Partial<AuthUser> = {}): AuthUser => ({
  userId: 'u-sales',
  organizationId: 'org1',
  email: 's@x.sa',
  roleId: 'role-sales',
  roleKey: 'sales',
  roleIds: ['role-sales'],
  permissions,
  locale: 'AR',
  ...over,
});
const WRITE = PERMISSIONS.PROPOSAL_WRITE;
const APPROVE = PERMISSIONS.PROPOSAL_APPROVE;
const COSTS = PERMISSIONS.COSTS_VIEW;
const sales = user([WRITE, COSTS, PERMISSIONS.PROPOSAL_READ]);
const salesNoCosts = user([WRITE, PERMISSIONS.PROPOSAL_READ]);

const FUTURE = '2099-01-01';
const PAST = '2020-01-01';

const revision = (over: Record<string, unknown> = {}) => ({
  id: 'rev1',
  proposalId: 'p1',
  revisionNo: 1,
  status: 'DRAFT',
  validUntil: new Date('2099-01-01T00:00:00Z'),
  totalAmount: D('1000.00'),
  designVersionId: null,
  bomLines: [{ id: 'l1' }],
  ...over,
});
const proposalRow = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  code: 'PRP-00001',
  organizationId: 'org1',
  opportunityId: 'opp1',
  status: 'DRAFT',
  currency: 'SAR',
  opportunity: { id: 'opp1', stage: 'PROPOSAL' },
  revisions: [] as unknown[],
  contracts: [] as unknown[],
  ...over,
});
const COST = (n: string) => ({ unitCost: D(n), costSource: 'GRN', costDate: new Date('2026-09-20T00:00:00Z') });

function build(over: { proposal?: unknown; costs?: Map<string, unknown>; approver?: number; rule?: unknown; gate?: unknown } = {}) {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(0),
    proposal: { create: jest.fn().mockResolvedValue({ id: 'p1', code: 'PRP-00001' }), update: jest.fn() },
    proposalRevision: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'rev-new', ...data })),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    bomLine: { deleteMany: jest.fn(), createMany: jest.fn() },
    designVersion: { create: jest.fn().mockResolvedValue({ id: 'dv1' }), update: jest.fn() },
  };
  const prisma = {
    proposal: { findFirst: jest.fn().mockResolvedValue(over.proposal ?? proposalRow()), findMany: jest.fn().mockResolvedValue([]) },
    opportunity: { findFirst: jest.fn().mockResolvedValue({ id: 'opp1', organizationId: 'org1', stage: 'COST_STUDY' }) },
    item: { findMany: jest.fn().mockResolvedValue([{ id: 'i1' }]) },
    // Package 3 · P3-4: a labour work item (no stock item) and a material one bringing i1.
    workItem: {
      findMany: jest.fn().mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
        [
          { id: 'w-lab', itemId: null, uom: 'kW', defaultUnitCost: D('35.00') },
          { id: 'w-mat', itemId: 'i1', uom: 'panel', defaultUnitCost: D('0') },
        ].filter((w) => where.id.in.includes(w.id)),
      ),
    },
    pricingScheme: { findFirst: jest.fn().mockResolvedValue(null) },
    user: {
      findUnique: jest.fn().mockResolvedValue({ departmentId: null, roleId: 'role-sales' }),
      count: jest.fn().mockResolvedValue(over.approver ?? 1),
    },
    approvalDelegation: { count: jest.fn().mockResolvedValue(0) },
    notification: { create: jest.fn().mockResolvedValue({}) },
    // P3-8: the customer's approval, filed on the proposal after it was sent.
    attachment: { findFirst: jest.fn().mockResolvedValue({ id: 'att1', fileName: 'موافقة العميل.pdf' }) },
    $transaction: jest.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
  };
  const numbering = { next: jest.fn().mockResolvedValue('PRP-00001') };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const opportunities = { advanceOnProposal: jest.fn().mockResolvedValue(undefined) };
  const engine = {
    open: jest.fn().mockResolvedValue({ id: 'wf1', state: 'DRAFT' }),
    adopt: jest.fn().mockResolvedValue({ id: 'wf1', state: 'DRAFT' }),
    instanceFor: jest.fn().mockResolvedValue({ id: 'wf1', currentState: 'DRAFT' }),
    assertCan: jest.fn().mockResolvedValue({ toState: 'PENDING_APPROVAL' }),
    transition: jest.fn().mockImplementation(async (_actor: unknown, input: { apply?: (t: unknown) => Promise<void> }) => {
      if (input.apply) await input.apply(tx);
      return { toState: 'X' };
    }),
    available: jest.fn().mockResolvedValue([]),
    history: jest.fn().mockResolvedValue([]),
  };
  const approvals = {
    register: jest.fn(),
    resolveRule: jest.fn().mockResolvedValue('rule' in over ? over.rule : { id: 'rule1', steps: [{ sequence: 1, roleId: 'role-exec' }] }),
    gate: jest.fn().mockResolvedValue(
      'gate' in over ? over.gate : { cleared: false, request: { id: 'req1', currentStep: 1, steps: [{ sequence: 1, role: { id: 'role-exec' } }] } },
    ),
    forDocument: jest.fn().mockResolvedValue(null),
    pendingFor: jest.fn().mockResolvedValue(new Map()),
  };
  const itemCosts = {
    lastPurchaseCosts: jest.fn().mockResolvedValue(over.costs ?? new Map([['i1', COST('100.00')]])),
  };
  const settings = { get: jest.fn().mockImplementation(async (_o: string, _k: string, d: number) => d) };
  const notifications = { notifyBestEffort: jest.fn().mockResolvedValue(1) };
  // Package 2 · P2-3: acceptance creates the draft contract in its transaction.
  const contracts = { draftFromAcceptance: jest.fn().mockResolvedValue({ id: 'c1', code: 'CTR-00009' }) };
  const svc = new ProposalsService(
    prisma as never, numbering as never, audit as never, opportunities as never,
    engine as never, approvals as never, itemCosts as never, settings as never,
    notifications as never, contracts as never,
  );
  return { svc, prisma, tx, engine, approvals, itemCosts, audit, opportunities, settings, notifications, contracts };
}

// ───────────────────────────── Step 3 (kept) ─────────────────────────────
describe('ProposalsService.create — opportunity stage', () => {
  it('moves the opportunity on inside the same transaction as the proposal, and opens the flow there too', async () => {
    const { svc, tx, opportunities, engine } = build();
    await expect(svc.create(sales, { opportunityId: 'opp1' } as never)).resolves.toMatchObject({ id: 'p1' });
    expect(opportunities.advanceOnProposal).toHaveBeenCalledWith(tx, sales, 'opp1');
    expect(tx.proposal.create).toHaveBeenCalledTimes(1);
    expect(engine.open).toHaveBeenCalledWith(tx, expect.objectContaining({ flowCode: 'PROPOSAL', documentId: 'p1', documentCode: 'PRP-00001' }));
  });

  it('a closed opportunity (409 from the stage rule) leaves no proposal behind', async () => {
    const { svc, tx, opportunities } = build();
    opportunities.advanceOnProposal.mockRejectedValue(new ConflictException('Opportunity is closed'));
    await expect(svc.create(sales, { opportunityId: 'opp1' } as never)).rejects.toThrow('Opportunity is closed');
    expect(tx.proposal.create).not.toHaveBeenCalled();
  });
});

// ───────────────────────────── Step 4 ─────────────────────────────
describe('ProposalsService.onModuleInit — the matrix hands the final sign-off back to us', () => {
  it('registers an applier and a rejecter for PROPOSAL (without them the app refuses to boot)', () => {
    const { svc, approvals } = build();
    svc.onModuleInit();
    expect(approvals.register).toHaveBeenCalledWith('PROPOSAL', expect.any(Function), expect.any(Function));
  });
});

describe('ProposalsService.addRevision — what is refused before anything is written', () => {
  const line = { itemId: 'i1', qty: 2, unitPrice: 130 };

  it('a manual cost without a reason is refused (400)', async () => {
    const { svc, tx } = build();
    await expect(
      svc.addRevision(sales, 'p1', { validUntil: FUTURE, bomLines: [{ ...line, unitCost: 90 }] }),
    ).rejects.toThrow(new BadRequestException('Cost override reason is required'));
    expect(tx.proposalRevision.create).not.toHaveBeenCalled();
  });

  it('a blank reason is no reason', async () => {
    const { svc } = build();
    await expect(
      svc.addRevision(sales, 'p1', { validUntil: FUTURE, bomLines: [{ ...line, unitCost: 90, costOverrideReason: '   ' }] }),
    ).rejects.toThrow('Cost override reason is required');
  });

  it('a validity date that is not after today is refused (400)', async () => {
    const { svc } = build();
    await expect(svc.addRevision(sales, 'p1', { validUntil: PAST, bomLines: [line] })).rejects.toThrow(
      new BadRequestException('Validity date must be in the future'),
    );
  });

  it('text that is not a date is refused (400)', async () => {
    const { svc } = build();
    await expect(svc.addRevision(sales, 'p1', { validUntil: 'soon', bomLines: [line] })).rejects.toThrow(BadRequestException);
  });

  it('a caller without costs.view must send the selling price (400)', async () => {
    const { svc } = build();
    await expect(
      svc.addRevision(salesNoCosts, 'p1', { validUntil: FUTURE, bomLines: [{ itemId: 'i1', qty: 1 }] }),
    ).rejects.toThrow(new BadRequestException('Selling price is required'));
  });

  it('a caller without costs.view cannot set a cost either (403)', async () => {
    const { svc, prisma } = build();
    await expect(
      svc.addRevision(salesNoCosts, 'p1', { validUntil: FUTURE, bomLines: [{ ...line, unitCost: 5 }] }),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.proposal.findFirst).not.toHaveBeenCalled();
  });

  it('a revision cannot be added while the previous one awaits approval (409)', async () => {
    const { svc } = build({ proposal: proposalRow({ status: 'PENDING_APPROVAL', revisions: [revision({ status: 'PENDING_APPROVAL' })] }) });
    await expect(svc.addRevision(sales, 'p1', { validUntil: FUTURE, bomLines: [line] })).rejects.toThrow(
      new ConflictException('Previous revision is awaiting approval'),
    );
  });

  it('nor on an accepted proposal — after a win only a change order may alter it (409)', async () => {
    const { svc } = build({ proposal: proposalRow({ status: 'ACCEPTED', revisions: [revision({ status: 'ACCEPTED' })] }) });
    await expect(svc.addRevision(sales, 'p1', { validUntil: FUTURE, bomLines: [line] })).rejects.toThrow(
      new ConflictException('Proposal is accepted — changes go through a change order'),
    );
  });

  it('nor once a contract exists on it (409)', async () => {
    const { svc } = build({ proposal: proposalRow({ revisions: [revision({ status: 'SENT' })], contracts: [{ id: 'c1' }] }) });
    await expect(svc.addRevision(sales, 'p1', { validUntil: FUTURE, bomLines: [line] })).rejects.toThrow(
      'Proposal is accepted — changes go through a change order',
    );
  });

  it('nor on a closed opportunity (409)', async () => {
    const { svc } = build({ proposal: proposalRow({ opportunity: { id: 'opp1', stage: 'LOST' } }) });
    await expect(svc.addRevision(sales, 'p1', { validUntil: FUTURE, bomLines: [line] })).rejects.toThrow(
      new ConflictException('Opportunity is closed'),
    );
  });

  it('a draft revision is edited in place, not duplicated (409)', async () => {
    const { svc } = build({ proposal: proposalRow({ revisions: [revision({ status: 'DRAFT' })] }) });
    await expect(svc.addRevision(sales, 'p1', { validUntil: FUTURE, bomLines: [line] })).rejects.toThrow(
      new ConflictException('Current revision is still a draft — edit it instead'),
    );
  });
});

describe('ProposalsService.addRevision — pricing and cost capture', () => {
  it('fetches the cost on the server and prices the first revision in Decimal', async () => {
    const { svc, tx, itemCosts, engine } = build();
    await svc.addRevision(sales, 'p1', {
      validUntil: FUTURE,
      bomLines: [{ itemId: 'i1', qty: 2, unitPrice: 130 }],
    });
    expect(itemCosts.lastPurchaseCosts).toHaveBeenCalledWith('org1', ['i1'], 'SAR');
    const data = tx.proposalRevision.create.mock.calls[0][0].data;
    expect(data.revisionNo).toBe(1);
    expect(data.status).toBe('DRAFT');
    expect(data.createdById).toBe('u-sales');
    expect(new Prisma.Decimal(data.subtotal).toFixed(2)).toBe('200.00'); // 2 x cost 100
    expect(new Prisma.Decimal(data.totalAmount).toFixed(2)).toBe('260.00'); // 2 x price 130
    expect(new Prisma.Decimal(data.marginAmount).toFixed(2)).toBe('60.00');
    const lineData = data.bomLines.create[0];
    expect(lineData).toMatchObject({ itemId: 'i1', costSource: 'GRN' });
    expect(new Prisma.Decimal(lineData.unitCost).toFixed(2)).toBe('100.00');
    expect(new Prisma.Decimal(lineData.originalUnitCost).toFixed(2)).toBe('100.00');
    expect(lineData.costOverrideReason ?? null).toBeNull();
    expect(typeof lineData.costAgeDays).toBe('number');
    // The very first revision is no transition: the proposal is a draft already.
    expect(engine.transition).not.toHaveBeenCalled();
  });

  it('with no selling price, the price is cost plus the margin', async () => {
    const { svc, tx } = build();
    await svc.addRevision(sales, 'p1', { validUntil: FUTURE, marginPct: 10, bomLines: [{ itemId: 'i1', qty: 1 }] });
    const data = tx.proposalRevision.create.mock.calls[0][0].data;
    expect(new Prisma.Decimal(data.totalAmount).toFixed(2)).toBe('110.00');
  });

  it('a manual cost is kept as MANUAL beside the original, with the reason and who changed it', async () => {
    const { svc, tx } = build();
    await svc.addRevision(sales, 'p1', {
      validUntil: FUTURE,
      bomLines: [{ itemId: 'i1', qty: 1, unitPrice: 130, unitCost: 90, costOverrideReason: 'Supplier quote 4411' }],
    });
    const line = tx.proposalRevision.create.mock.calls[0][0].data.bomLines.create[0];
    expect(line.costSource).toBe('MANUAL');
    expect(new Prisma.Decimal(line.unitCost).toFixed(2)).toBe('90.00');
    expect(new Prisma.Decimal(line.originalUnitCost).toFixed(2)).toBe('100.00'); // what the system fetched
    expect(line.costOverrideReason).toBe('Supplier quote 4411');
    expect(line.costOverriddenById).toBe('u-sales');
    expect(line.costOverriddenAt).toBeInstanceOf(Date);
  });

  it('a cost equal to the fetched one is not an override, and its reason is ignored', async () => {
    const { svc, tx } = build();
    await svc.addRevision(sales, 'p1', {
      validUntil: FUTURE,
      bomLines: [{ itemId: 'i1', qty: 1, unitPrice: 130, unitCost: 100, costOverrideReason: 'unneeded' }],
    });
    const line = tx.proposalRevision.create.mock.calls[0][0].data.bomLines.create[0];
    expect(line.costSource).toBe('GRN');
    expect(line.costOverrideReason ?? null).toBeNull();
  });

  it('a caller without costs.view still gets the server-fetched cost stored', async () => {
    const { svc, tx } = build();
    await svc.addRevision(salesNoCosts, 'p1', { validUntil: FUTURE, bomLines: [{ itemId: 'i1', qty: 1, unitPrice: 140 }] });
    const line = tx.proposalRevision.create.mock.calls[0][0].data.bomLines.create[0];
    expect(new Prisma.Decimal(line.unitCost).toFixed(2)).toBe('100.00');
    expect(line.costSource).toBe('GRN');
  });

  it('defaults the validity to today plus the configured number of days', async () => {
    const { svc, tx, settings } = build();
    settings.get.mockResolvedValue(45);
    await svc.addRevision(sales, 'p1', { bomLines: [{ itemId: 'i1', qty: 1, unitPrice: 130 }] });
    const validUntil: Date = tx.proposalRevision.create.mock.calls[0][0].data.validUntil;
    const days = Math.round((validUntil.getTime() - Date.now()) / 86_400_000);
    expect(days).toBeGreaterThanOrEqual(44);
    expect(days).toBeLessThanOrEqual(46);
  });

  it('a new revision on a sent one is a REVISE transition that locks the previous revision as superseded', async () => {
    const { svc, tx, engine } = build({
      proposal: proposalRow({ status: 'SENT', revisions: [revision({ status: 'SENT' })] }),
    });
    tx.proposalRevision.findFirst.mockResolvedValue(revision({ status: 'SENT' }));
    await svc.addRevision(sales, 'p1', { validUntil: FUTURE, bomLines: [{ itemId: 'i1', qty: 1, unitPrice: 130 }] });

    expect(engine.transition).toHaveBeenCalledTimes(1);
    expect(engine.transition.mock.calls[0][1]).toMatchObject({ documentType: 'Proposal', documentId: 'p1', actionCode: WF_ACTIONS.REVISE });
    expect(tx.proposalRevision.create.mock.calls[0][0].data.revisionNo).toBe(2);
    expect(tx.proposalRevision.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'rev1' },
        data: expect.objectContaining({ status: 'SUPERSEDED', supersededById: 'rev-new', closedAt: expect.any(Date) }),
      }),
    );
    expect(tx.proposal.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'DRAFT' } }));
  });
});

describe('ProposalsService.updateRevision', () => {
  const dto = { validUntil: FUTURE, bomLines: [{ itemId: 'i1', qty: 1, unitPrice: 130 }] };

  it('only the current DRAFT revision can be edited (409)', async () => {
    const sent = build({ proposal: proposalRow({ status: 'SENT', revisions: [revision({ status: 'SENT' })] }) });
    await expect(sent.svc.updateRevision(sales, 'p1', 'rev1', dto)).rejects.toThrow(
      new ConflictException('Only a draft revision can be edited — add a new revision'),
    );
    const old = build({ proposal: proposalRow({ revisions: [revision({ id: 'rev2', revisionNo: 2 })] }) });
    await expect(old.svc.updateRevision(sales, 'p1', 'rev1', dto)).rejects.toThrow(
      'Only a draft revision can be edited — add a new revision',
    );
  });

  it('replaces the lines of a draft inside one transaction and audits before / after', async () => {
    const { svc, tx, audit } = build({ proposal: proposalRow({ revisions: [revision()] }) });
    tx.proposalRevision.update.mockResolvedValue({ id: 'rev1', totalAmount: D('130.00') });
    await svc.updateRevision(sales, 'p1', 'rev1', dto);
    expect(tx.bomLine.deleteMany).toHaveBeenCalledWith({ where: { proposalRevisionId: 'rev1' } });
    expect(tx.proposalRevision.update).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'ProposalRevision', action: 'UPDATE' }), tx);
  });
});

describe('ProposalsService.submit — the gate in front of the matrix', () => {
  const draft = () => proposalRow({ revisions: [revision()] });

  it('needs at least one line (400) and a validity date after today (400)', async () => {
    const empty = build({ proposal: proposalRow({ revisions: [revision({ bomLines: [] })] }) });
    await expect(empty.svc.submit(sales, 'p1')).rejects.toThrow(BadRequestException);
    const stale = build({ proposal: proposalRow({ revisions: [revision({ validUntil: new Date('2020-01-01T00:00:00Z') })] }) });
    await expect(stale.svc.submit(sales, 'p1')).rejects.toThrow(
      new BadRequestException('Validity date must be in the future'),
    );
  });

  it('only a draft can be submitted (409)', async () => {
    const { svc } = build({ proposal: proposalRow({ status: 'SENT', revisions: [revision({ status: 'SENT' })] }) });
    await expect(svc.submit(sales, 'p1')).rejects.toThrow(ConflictException);
  });

  it('refuses when the raiser is the only holder of the approver role — nobody else could sign (409)', async () => {
    const { svc, approvals, engine, prisma } = build({ proposal: draft(), approver: 0 });
    await expect(svc.submit(sales, 'p1')).rejects.toThrow(
      new ConflictException('No other approver is available for this proposal'),
    );
    // asked about the first step's role, never counting the raiser
    expect(prisma.user.count.mock.calls[0][0].where).toMatchObject({ organizationId: 'org1', isActive: true, id: { not: 'u-sales' } });
    // and refused before a chain was opened or the state touched
    expect(approvals.gate).not.toHaveBeenCalled();
    expect(engine.transition).not.toHaveBeenCalled();
  });

  it('a delegate who is not the raiser counts as another approver; the raiser’s own delegation does not', async () => {
    const { svc, prisma, approvals } = build({ proposal: draft(), approver: 0 });
    prisma.approvalDelegation.count.mockResolvedValue(1);
    await svc.submit(sales, 'p1');
    expect(approvals.gate).toHaveBeenCalled();
    const where = prisma.approvalDelegation.count.mock.calls[0][0].where;
    expect(where.toUserId).toEqual({ not: 'u-sales' });
    expect(where.fromUserId).toEqual({ not: 'u-sales' });
  });

  it('opens the chain for the total and parks the proposal awaiting approval', async () => {
    const { svc, approvals, engine, tx } = build({ proposal: draft() });
    const out = await svc.submit(sales, 'p1');
    expect(approvals.gate).toHaveBeenCalledWith(
      sales,
      expect.objectContaining({ documentType: 'PROPOSAL', documentId: 'p1', documentCode: 'PRP-00001 R1', amount: 1000 }),
    );
    expect(engine.assertCan).toHaveBeenCalledWith(sales, expect.objectContaining({ actionCode: WF_ACTIONS.SUBMIT }));
    expect(engine.transition.mock.calls[0][1]).toMatchObject({ actionCode: WF_ACTIONS.SUBMIT, assigneeRoleId: 'role-exec' });
    expect(tx.proposalRevision.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PENDING_APPROVAL', submittedAt: expect.any(Date) }) }),
    );
    expect(out).toMatchObject({ pendingApproval: { id: 'req1' } });
  });

  it('with no rule and no approve key, it refuses rather than let the author approve alone (403)', async () => {
    const { svc, engine } = build({ proposal: draft(), rule: null, gate: { cleared: true, request: null } });
    await expect(svc.submit(sales, 'p1')).rejects.toThrow(ForbiddenException);
    expect(engine.transition).not.toHaveBeenCalled();
  });

  it('with no rule but the approve key, the proposal is approved straight away', async () => {
    const approver = user([WRITE, APPROVE, COSTS]);
    const { svc, engine } = build({ proposal: draft(), rule: null, gate: { cleared: true, request: null } });
    // the applier re-reads: the second read sees the parked revision
    const row = proposalRow({ status: 'PENDING_APPROVAL', revisions: [revision({ status: 'PENDING_APPROVAL' })] });
    (svc as never as { prisma: { proposal: { findFirst: jest.Mock } } }).prisma.proposal.findFirst
      .mockResolvedValueOnce(draft())
      .mockResolvedValue(row);
    await svc.submit(approver, 'p1');
    expect(engine.transition.mock.calls.map((c) => c[1].actionCode)).toEqual([WF_ACTIONS.SUBMIT, WF_ACTIONS.APPROVE]);
  });

  it('is serialised per proposal, so two simultaneous submits cannot both open a chain', async () => {
    const { svc, tx } = build({ proposal: draft() });
    await svc.submit(sales, 'p1');
    expect(tx.$executeRaw).toHaveBeenCalled(); // pg_advisory_xact_lock
  });
});

describe('ProposalsService.submit — another approver is counted on the EFFECTIVE set (ADR-02, P1-7)', () => {
  const draft = () => proposalRow({ revisions: [revision()] });
  const EXEC = { id: 'role-exec', permissions: [APPROVE] };
  const EXEC_NO_KEY = { id: 'role-exec', permissions: [PERMISSIONS.PROPOSAL_READ] };
  const SALES = { id: 'role-sales', permissions: [WRITE] };
  /** `user.count` answers from fixture users through the real where-clause. */
  const withUsers = (users: ReturnType<typeof fixtureUser>[]) => {
    const b = build({ proposal: draft() });
    b.prisma.user.count.mockImplementation(async ({ where }: { where: object }) =>
      users.filter((u) => matchesWhere(where, u)).length,
    );
    return b;
  };

  it('asks for: holds the step role (primary or extra) AND holds the approve key effectively', async () => {
    const { svc, prisma } = withUsers([fixtureUser('u-exec', EXEC)]);
    await svc.submit(sales, 'p1');
    expect(prisma.user.count.mock.calls[0][0].where).toEqual({
      organizationId: 'org1',
      isActive: true,
      id: { not: 'u-sales' },
      AND: [holdsRole('role-exec'), holdsEffectively(APPROVE)],
    });
  });

  it('the only other executive DENIED the approve key is no approver (409)', async () => {
    const { svc, approvals } = withUsers([
      fixtureUser('u-exec', EXEC, { permissionOverrides: [{ permission: APPROVE, effect: 'DENY' }] }),
    ]);
    await expect(svc.submit(sales, 'p1')).rejects.toThrow(
      new ConflictException('No other approver is available for this proposal'),
    );
    expect(approvals.gate).not.toHaveBeenCalled();
  });

  it('an executive whose role lacks the key but who was GRANTED it counts', async () => {
    const { svc, approvals } = withUsers([
      fixtureUser('u-exec', EXEC_NO_KEY, { permissionOverrides: [{ permission: APPROVE, effect: 'GRANT' }] }),
    ]);
    await svc.submit(sales, 'p1');
    expect(approvals.gate).toHaveBeenCalled();
  });

  it('a GRANT of the key without the step role is no seat (409)', async () => {
    const { svc } = withUsers([
      fixtureUser('u-other', SALES, { permissionOverrides: [{ permission: APPROVE, effect: 'GRANT' }] }),
    ]);
    await expect(svc.submit(sales, 'p1')).rejects.toThrow(ConflictException);
  });

  it('a delegate must hold the key effectively, and so must the delegator (beside the role seat)', async () => {
    const { svc, prisma } = build({ proposal: draft(), approver: 0 });
    prisma.approvalDelegation.count.mockResolvedValue(1);
    await svc.submit(sales, 'p1');
    const where = prisma.approvalDelegation.count.mock.calls[0][0].where;
    expect(where.toUser).toEqual({ isActive: true, AND: [holdsEffectively(APPROVE)] });
    expect(where.fromUser).toEqual({ isActive: true, roleId: 'role-exec', AND: [holdsEffectively(APPROVE)] });
  });
});

describe('the matrix callbacks (applier / rejecter)', () => {
  function registered() {
    const ctx = build({ proposal: proposalRow({ status: 'DRAFT', revisions: [revision({ status: 'DRAFT' })] }) });
    ctx.svc.onModuleInit();
    const [, applier, rejecter] = ctx.approvals.register.mock.calls[0] as [string, (u: AuthUser, id: string) => Promise<unknown>, (u: AuthUser, id: string, n: string) => Promise<unknown>];
    return { ...ctx, applier, rejecter };
  }
  const ceo = user([APPROVE, COSTS], { userId: 'u-ceo', roleId: 'role-exec', roleIds: ['role-exec'] });

  it('the applier does nothing to a revision that is not awaiting approval', async () => {
    const { applier, engine, tx } = registered();
    await applier(ceo, 'p1');
    expect(engine.transition).not.toHaveBeenCalled();
    expect(tx.proposalRevision.update).not.toHaveBeenCalled();
    expect(tx.proposal.update).not.toHaveBeenCalled();
  });

  it('the rejecter does nothing either — the proposal was never parked', async () => {
    const { rejecter, engine } = registered();
    await rejecter(ceo, 'p1', 'no');
    expect(engine.transition).not.toHaveBeenCalled();
  });

  it('the applier approves a parked revision under the approver’s identity, and emits the event payload', async () => {
    const { svc, applier, engine, tx } = registered();
    (svc as never as { prisma: { proposal: { findFirst: jest.Mock } } }).prisma.proposal.findFirst.mockResolvedValue(
      proposalRow({ status: 'PENDING_APPROVAL', revisions: [revision({ status: 'PENDING_APPROVAL', createdById: 'u-sales' })] }),
    );
    await applier(ceo, 'p1');
    expect(engine.transition).toHaveBeenCalledWith(
      ceo,
      expect.objectContaining({
        actionCode: WF_ACTIONS.APPROVE,
        eventPayload: expect.objectContaining({ proposalId: 'p1', code: 'PRP-00001', revisionNo: 1, opportunityId: 'opp1' }),
      }),
    );
    expect(tx.proposalRevision.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'APPROVED', approvedAt: expect.any(Date) }) }),
    );
  });

  it('an approval that lands after the validity has passed is followed at once by an automatic expiry', async () => {
    const { svc, applier, engine } = registered();
    (svc as never as { prisma: { proposal: { findFirst: jest.Mock } } }).prisma.proposal.findFirst.mockResolvedValue(
      proposalRow({ status: 'PENDING_APPROVAL', revisions: [revision({ status: 'PENDING_APPROVAL', validUntil: new Date('2020-01-01T00:00:00Z') })] }),
    );
    await applier(ceo, 'p1');
    expect(engine.transition.mock.calls.map((c) => c[1].actionCode)).toEqual([WF_ACTIONS.APPROVE, WF_ACTIONS.EXPIRE]);
    expect(engine.transition.mock.calls[1][0]).toEqual({ system: true, organizationId: 'org1' });
  });

  it('the rejecter returns a parked proposal to draft with the approver’s note', async () => {
    const { svc, rejecter, engine, tx } = registered();
    (svc as never as { prisma: { proposal: { findFirst: jest.Mock } } }).prisma.proposal.findFirst.mockResolvedValue(
      proposalRow({ status: 'PENDING_APPROVAL', revisions: [revision({ status: 'PENDING_APPROVAL' })] }),
    );
    await rejecter(ceo, 'p1', 'Margin too thin');
    expect(engine.transition).toHaveBeenCalledWith(
      ceo,
      expect.objectContaining({ actionCode: WF_ACTIONS.RETURN, comment: 'Margin too thin' }),
    );
    expect(tx.proposalRevision.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'DRAFT' }) }),
    );
  });
});

describe('ProposalsService.send / acceptRevision / rejectByCustomer', () => {
  const approved = (over: Record<string, unknown> = {}) =>
    proposalRow({ status: 'APPROVED', revisions: [revision({ status: 'APPROVED', ...over })] });
  const sent = (over: Record<string, unknown> = {}) =>
    proposalRow({ status: 'SENT', revisions: [revision({ status: 'SENT', ...over })] });

  it('sends an approved revision', async () => {
    const { svc, engine, tx } = build({ proposal: approved() });
    await svc.send(sales, 'p1');
    expect(engine.transition.mock.calls[0][1]).toMatchObject({ actionCode: WF_ACTIONS.SEND });
    expect(tx.proposalRevision.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'SENT', sentAt: expect.any(Date) }) }),
    );
  });

  it('send after the validity expires the revision (system actor) and then refuses (409)', async () => {
    const { svc, engine } = build({ proposal: approved({ validUntil: new Date('2020-01-01T00:00:00Z') }) });
    await expect(svc.send(sales, 'p1')).rejects.toThrow(new ConflictException('Proposal revision has expired'));
    const expire = engine.transition.mock.calls.find((c) => c[1].actionCode === WF_ACTIONS.EXPIRE)!;
    expect(expire[0]).toEqual({ system: true, organizationId: 'org1' });
    expect(engine.transition.mock.calls.some((c) => c[1].actionCode === WF_ACTIONS.SEND)).toBe(false);
  });

  it('only an approved revision can be sent (409)', async () => {
    const { svc } = build({ proposal: proposalRow({ revisions: [revision({ status: 'DRAFT' })] }) });
    await expect(svc.send(sales, 'p1')).rejects.toThrow(ConflictException);
  });

  it('accepts only the current, sent revision (409 otherwise)', async () => {
    const draftOne = build({ proposal: proposalRow({ revisions: [revision({ status: 'DRAFT' })] }) });
    await expect(draftOne.svc.acceptRevision(sales, 'p1', 'rev1')).rejects.toThrow(
      new ConflictException('Only the current sent revision can be accepted'),
    );
    const notCurrent = build({ proposal: sent({ id: 'rev2', revisionNo: 2 }) });
    await expect(notCurrent.svc.acceptRevision(sales, 'p1', 'rev1')).rejects.toThrow(
      'Only the current sent revision can be accepted',
    );
    const ok = build({ proposal: sent() });
    await ok.svc.acceptRevision(sales, 'p1', 'rev1');
    expect(ok.engine.transition.mock.calls[0][1]).toMatchObject({ actionCode: WF_ACTIONS.ACCEPT });
    expect(ok.tx.proposalRevision.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'ACCEPTED', isWinning: true, closedAt: expect.any(Date) }) }),
    );
  });

  it('the customer’s refusal needs a reason and moves a sent revision to REJECTED', async () => {
    const { svc, engine, tx } = build({ proposal: sent() });
    await svc.rejectByCustomer(sales, 'p1', { reason: 'Chose a competitor' });
    expect(engine.transition.mock.calls[0][1]).toMatchObject({ actionCode: WF_ACTIONS.REJECT, comment: 'Chose a competitor' });
    expect(tx.proposalRevision.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'REJECTED', closedAt: expect.any(Date) }) }),
    );
    const blank = build({ proposal: sent() });
    await expect(blank.svc.rejectByCustomer(sales, 'p1', { reason: '  ' })).rejects.toThrow(BadRequestException);
    const draft = build({ proposal: proposalRow({ revisions: [revision()] }) });
    await expect(draft.svc.rejectByCustomer(sales, 'p1', { reason: 'x' })).rejects.toThrow(ConflictException);
  });

  it('adopts a legacy proposal that has no workflow instance, at the state it is in', async () => {
    const { svc, engine } = build({ proposal: sent() });
    engine.instanceFor.mockResolvedValue(null);
    await svc.rejectByCustomer(sales, 'p1', { reason: 'late' });
    expect(engine.adopt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ flowCode: 'PROPOSAL', documentId: 'p1', stateCode: 'SENT' }),
    );
  });
});

describe('ProposalsService.expireBySystem', () => {
  it('expires an approved or sent revision as the system actor and tells its author', async () => {
    const { svc, engine, tx, prisma } = build({
      proposal: proposalRow({ status: 'SENT', revisions: [revision({ status: 'SENT', createdById: 'u-sales', validUntil: new Date('2020-01-01T00:00:00Z') })] }),
    });
    await expect(svc.expireBySystem('org1', 'p1')).resolves.toBe(true);
    expect(engine.transition).toHaveBeenCalledWith(
      { system: true, organizationId: 'org1' },
      expect.objectContaining({ actionCode: WF_ACTIONS.EXPIRE, comment: expect.stringMatching(/automatically/i) }),
    );
    expect(tx.proposalRevision.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'EXPIRED', closedAt: expect.any(Date) }) }),
    );
    expect(prisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: 'u-sales', type: 'PROPOSAL_EXPIRED' }) }),
    );
  });

  it('leaves a draft or a parked revision alone', async () => {
    const { svc, engine } = build({ proposal: proposalRow({ revisions: [revision({ status: 'PENDING_APPROVAL' })] }) });
    await expect(svc.expireBySystem('org1', 'p1')).resolves.toBe(false);
    expect(engine.transition).not.toHaveBeenCalled();
  });
});

describe('ProposalsService.costLookup', () => {
  it('returns the cost, its source, age and whether it is stale; unknown age is stale', async () => {
    const { svc, itemCosts, settings } = build();
    itemCosts.lastPurchaseCosts.mockResolvedValue(
      new Map([
        ['i1', { unitCost: D('100'), costSource: 'GRN', costDate: new Date(Date.now() - 5 * 86_400_000) }],
        ['i2', { unitCost: D('50'), costSource: 'CATALOGUE', costDate: null }],
        ['i3', { unitCost: D('70'), costSource: 'PO', costDate: new Date(Date.now() - 90 * 86_400_000) }],
      ]),
    );
    settings.get.mockResolvedValue(30);
    const out = await svc.costLookup(sales, { itemIds: ['i1', 'i2', 'i3'], currency: 'SAR' });
    const byId = new Map(out.map((r) => [r.itemId, r]));
    expect(byId.get('i1')).toMatchObject({ costSource: 'GRN', costAgeDays: 5, stale: false, warnDays: 30 });
    expect(byId.get('i2')).toMatchObject({ costSource: 'CATALOGUE', costAgeDays: null, stale: true });
    expect(byId.get('i3')).toMatchObject({ costAgeDays: 90, stale: true });
    expect(Number(byId.get('i1')!.unitCost)).toBe(100);
  });

  it('is for those who may see costs (403)', async () => {
    const { svc } = build();
    await expect(svc.costLookup(salesNoCosts, { itemIds: ['i1'], currency: 'SAR' })).rejects.toThrow(ForbiddenException);
  });
});

// ─────────────── Package 3 · P3-4: the estimated budget (ADR-03 §4-4) ───────────────
describe('ProposalsService.addRevision — budget lines and lump-sum pricing', () => {
  it('a labour work item without a stock item is costed from its default cost (CATALOGUE)', async () => {
    const { svc, tx, itemCosts } = build();
    await svc.addRevision(sales, 'p1', {
      validUntil: FUTURE,
      pricingMode: 'LUMP_SUM',
      sellingTotal: 5000,
      bomLines: [{ workItemId: 'w-lab', qty: 100 }],
    });
    // no stock item to look up
    expect(itemCosts.lastPurchaseCosts).not.toHaveBeenCalled();
    const data = tx.proposalRevision.create.mock.calls[0][0].data;
    const line = data.bomLines.create[0];
    expect(line).toMatchObject({ itemId: null, workItemId: 'w-lab', uom: 'kW', costSource: 'CATALOGUE' });
    expect(new Prisma.Decimal(line.unitCost).toFixed(2)).toBe('35.00');
    expect(new Prisma.Decimal(line.unitPrice).toFixed(2)).toBe('0.00');
    expect(data.pricingMode).toBe('LUMP_SUM');
    expect(new Prisma.Decimal(data.subtotal).toFixed(2)).toBe('3500.00');
    expect(new Prisma.Decimal(data.totalAmount).toFixed(2)).toBe('5000.00');
    expect(new Prisma.Decimal(data.marginAmount).toFixed(2)).toBe('1500.00');
  });

  it('a material work item brings its stock item, costed from the last purchase', async () => {
    const { svc, tx, itemCosts } = build();
    await svc.addRevision(sales, 'p1', {
      validUntil: FUTURE,
      pricingMode: 'LUMP_SUM',
      sellingTotal: 1000,
      contingencyPct: 10,
      bomLines: [{ workItemId: 'w-mat', qty: 2 }],
    });
    expect(itemCosts.lastPurchaseCosts).toHaveBeenCalledWith('org1', ['i1'], 'SAR');
    const data = tx.proposalRevision.create.mock.calls[0][0].data;
    expect(data.bomLines.create[0]).toMatchObject({ itemId: 'i1', workItemId: 'w-mat', costSource: 'GRN' });
    expect(new Prisma.Decimal(data.contingencyAmount).toFixed(2)).toBe('20.00'); // 10 % of 200
    expect(new Prisma.Decimal(data.marginAmount).toFixed(2)).toBe('780.00'); // 1000 − 200 − 20
  });

  it('refuses a line naming neither a work item nor a stock item (400)', async () => {
    const { svc, tx } = build();
    await expect(svc.addRevision(sales, 'p1', { validUntil: FUTURE, bomLines: [{ qty: 1 }] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(tx.proposalRevision.create).not.toHaveBeenCalled();
  });

  it('refuses a work item of another organization (400)', async () => {
    const { svc } = build();
    await expect(
      svc.addRevision(sales, 'p1', { validUntil: FUTURE, bomLines: [{ workItemId: 'w-foreign', qty: 1 }] }),
    ).rejects.toThrow('One or more work items are invalid for this tenant');
  });

  it('refuses line prices in a lump-sum budget (400)', async () => {
    const { svc } = build();
    await expect(
      svc.addRevision(sales, 'p1', {
        validUntil: FUTURE,
        pricingMode: 'LUMP_SUM',
        bomLines: [{ workItemId: 'w-lab', qty: 1, unitPrice: 50 }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a stock item that contradicts the work item is refused (400)', async () => {
    const { svc } = build();
    await expect(
      svc.addRevision(sales, 'p1', { validUntil: FUTURE, bomLines: [{ workItemId: 'w-mat', itemId: 'i2', qty: 1 }] }),
    ).rejects.toThrow('The stock item does not match the work item');
  });

  it('contingency and risk notes are cost inputs: refused without finance.costs.view (403)', async () => {
    const { svc } = build();
    await expect(
      svc.addRevision(salesNoCosts, 'p1', {
        validUntil: FUTURE,
        pricingMode: 'LUMP_SUM',
        sellingTotal: 100,
        contingencyPct: 5,
        bomLines: [{ workItemId: 'w-lab', qty: 1 }],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('ProposalsService.submit — a budget needs a price (P3-4)', () => {
  it('refuses to raise a revision whose selling total is zero (400), before any chain opens', async () => {
    const { svc, approvals } = build({
      proposal: proposalRow({ revisions: [revision({ status: 'DRAFT', totalAmount: D('0.00') })] }),
    });
    await expect(svc.submit(sales, 'p1')).rejects.toThrow(
      'The budget needs a selling price before it is raised for approval',
    );
    expect(approvals.gate).not.toHaveBeenCalled();
  });
});

describe('ProposalsService.awaitingMyApproval — the general manager card (P3-6)', () => {
  const exec = user([PERMISSIONS.PROPOSAL_APPROVE, PERMISSIONS.PROPOSAL_READ, COSTS], { userId: 'u-exec' });
  const req = (over: Record<string, unknown> = {}) => ({
    id: 'req1',
    documentType: 'PROPOSAL',
    documentId: 'p1',
    canDecide: true,
    raisedBy: { id: 'u-sales', nameAr: 'م', nameEn: 'S' },
    currentStepAt: new Date('2026-10-29T08:00:00Z'),
    ...over,
  });
  const loaded = {
    id: 'p1',
    code: 'PRP-00001',
    opportunity: { id: 'opp1', name: 'مزرعة', customer: { nameAr: 'ع', nameEn: 'C' } },
    revisions: [
      {
        revisionNo: 2,
        pricingMode: 'LUMP_SUM',
        totalAmount: D('1000000.00'),
        subtotal: D('850000.00'),
        contingencyAmount: D('42500.00'),
        marginAmount: D('107500.00'),
        designVersion: { capacityKwp: D('643.500') },
      },
    ],
  };

  function withInbox(rows: unknown[]) {
    const b = build();
    (b.approvals as Record<string, unknown>).inbox = jest.fn().mockResolvedValue(rows);
    (b.prisma.proposal.findMany as jest.Mock).mockResolvedValue([loaded]);
    return b;
  }

  it('lists only proposals the caller can sign now, with margin % and the 15 % floor flag', async () => {
    const { svc, prisma } = withInbox([
      req(),
      req({ id: 'req2', documentId: 'p2', canDecide: false }), // raised by them, or already signed
      req({ id: 'req3', documentType: 'PURCHASE_ORDER', documentId: 'po1' }),
    ]);
    const out = await svc.awaitingMyApproval(exec);
    expect(prisma.proposal.findMany.mock.calls[0][0].where).toEqual({ id: { in: ['p1'] }, organizationId: 'org1' });
    expect(out.minMarginPct).toBe(15);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({
      requestId: 'req1',
      code: 'PRP-00001',
      revisionNo: 2,
      totalAmount: '1000000.00',
      estimatedCost: '850000.00',
      contingencyAmount: '42500.00',
      marginAmount: '107500.00',
      marginPct: 10.8,
      belowFloor: true,
    });
  });

  it('without finance.costs.view the cost figures are null — the price stays', async () => {
    const { svc } = withInbox([req()]);
    const out = await svc.awaitingMyApproval(user([PERMISSIONS.PROPOSAL_APPROVE], { userId: 'u-x' }));
    expect(out.rows[0]).toMatchObject({
      totalAmount: '1000000.00',
      estimatedCost: null,
      marginAmount: null,
      marginPct: null,
      belowFloor: null,
    });
  });

  it('nothing waiting → no proposal read at all', async () => {
    const { svc, prisma } = withInbox([]);
    await expect(svc.awaitingMyApproval(exec)).resolves.toEqual({ minMarginPct: 15, rows: [] });
    expect(prisma.proposal.findMany).not.toHaveBeenCalled();
  });
});

describe('ProposalsService.acceptRevision — the customer approval is attached (P3-8)', () => {
  const sentAt = new Date('2026-10-20T09:00:00Z');
  const sentProposal = () =>
    proposalRow({ status: 'SENT', revisions: [revision({ id: 'rev1', status: 'SENT', sentAt, revisionNo: 3 })] });

  it('refuses acceptance without a file filed on the proposal since it was sent (400), and moves nothing', async () => {
    const { svc, prisma, engine } = build({ proposal: sentProposal() });
    prisma.attachment.findFirst.mockResolvedValue(null);
    await expect(svc.acceptRevision(sales, 'p1', 'rev1')).rejects.toThrow(
      "Attach the customer's approval to the proposal before accepting it",
    );
    expect(prisma.attachment.findFirst.mock.calls[0][0].where).toEqual({
      organizationId: 'org1',
      entityType: 'PROPOSAL',
      entityId: 'p1',
      createdAt: { gte: sentAt },
    });
    expect(engine.transition).not.toHaveBeenCalled();
  });

  it('with the approval attached it accepts and tells the approvers (not the one who accepted)', async () => {
    const { svc, engine, notifications } = build({ proposal: sentProposal() });
    await svc.acceptRevision(sales, 'p1', 'rev1');
    expect(engine.transition.mock.calls[0][1].actionCode).toBe(WF_ACTIONS.ACCEPT);
    expect(notifications.notifyBestEffort).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org1',
        permission: PERMISSIONS.PROPOSAL_APPROVE,
        excludeUserId: 'u-sales',
        type: 'PROPOSAL_ACCEPTED',
        linkPath: '/contracts/c1',
      }),
    );
  });

  it('creates the draft contract inside the acceptance transaction and returns its id (P2-3)', async () => {
    const { svc, tx, contracts } = build({ proposal: sentProposal() });
    const out = await svc.acceptRevision(sales, 'p1', 'rev1');
    expect(contracts.draftFromAcceptance).toHaveBeenCalledWith(tx, sales, 'rev1');
    expect(out).toMatchObject({ contractId: 'c1' });
  });
});
