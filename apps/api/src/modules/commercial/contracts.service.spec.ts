import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@npi/db';
import { ContractsService, defaultMilestones } from './contracts.service';
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
      { register: jest.fn(), gate: jest.fn(), inbox: jest.fn() } as never,
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
    // P2-3: a contract from a quote starts with the owner's 50 / 30 / 20 schedule.
    expect(
      tx.contract.create.mock.calls[0][0].data.milestones.create.map((m: { amount: unknown }) => String(m.amount)),
    ).toEqual(['69000', '41400', '27600']);
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

// ───────────── Package 2 (ADR-01 as amended 2026-10-29) ─────────────

const D = (v: string | number) => new Prisma.Decimal(v);
const PM = { userId: 'u-pm', organizationId: 'org1', permissions: ['commercial.contract.write'] } as never;
const GM = { userId: 'u-gm', organizationId: 'org1', permissions: ['commercial.proposal.approve'] } as never;

function world(contract: Record<string, unknown> | null, opts: { gate?: unknown; signed?: unknown } = {}) {
  const rows = { current: contract };
  const contractTable = {
    findFirst: jest.fn().mockImplementation(async () => rows.current),
    update: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      rows.current = { ...rows.current, ...data };
      return rows.current;
    }),
    create: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'c-new', ...data })),
  };
  const tx = {
    contract: contractTable,
    contractMilestone: { deleteMany: jest.fn().mockResolvedValue({ count: 3 }) },
  };
  const prisma = {
    contract: contractTable,
    attachment: { findFirst: jest.fn().mockResolvedValue(opts.signed === undefined ? { id: 'att1' } : opts.signed) },
    $transaction: jest.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
  };
  const approvals = {
    register: jest.fn(),
    gate: jest.fn().mockResolvedValue(opts.gate ?? { cleared: false, request: { id: 'req1' } }),
    inbox: jest.fn().mockResolvedValue([]),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const notifications = { notifyBestEffort: jest.fn().mockResolvedValue(1) };
  const svc = new ContractsService(
    prisma as never,
    { next: jest.fn().mockResolvedValue('CTR-00009') } as never,
    audit as never,
    notifications as never,
    { markWonViaContract: jest.fn() } as never,
    approvals as never,
  );
  return { svc, prisma, tx, approvals, audit, notifications, rows };
}

const draft = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  organizationId: 'org1',
  code: 'CTR-00009',
  status: 'DRAFT',
  totalValue: D('1000000.00'),
  proposalRevisionId: 'rev1',
  approvedAt: null,
  milestones: defaultMilestones('1000000.00').map((m, i) => ({ id: `m${i}`, ...m })),
  ...over,
});

describe('defaultMilestones — 50 / 30 / 20, always summing to the value', () => {
  it('puts the rounding on the last payment', () => {
    const ms = defaultMilestones('100000.01');
    expect(ms.map((m) => String(m.amount))).toEqual(['50000.01', '30000', '20000']);
    expect(ms.reduce((s, m) => s.add(m.amount), D(0)).toFixed(2)).toBe('100000.01');
  });
});

describe('ContractsService.update — a draft only', () => {
  it('replaces the payments and audits before / after', async () => {
    const { svc, tx, audit } = world(draft());
    await svc.update(PM, 'c1', {
      milestones: [
        { sequence: 1, descriptionAr: 'مقدم', descriptionEn: 'Advance', amount: 400000 },
        { sequence: 2, descriptionAr: 'نهائي', descriptionEn: 'Final', amount: 600000 },
      ],
    });
    expect(tx.contractMilestone.deleteMany).toHaveBeenCalledWith({ where: { contractId: 'c1' } });
    expect(audit.record.mock.calls[0][0]).toMatchObject({ action: 'UPDATE', entityType: 'Contract' });
  });

  it('refuses a contract that is no longer a draft (409)', async () => {
    const { svc } = world(draft({ status: 'PENDING_APPROVAL' }));
    await expect(svc.update(PM, 'c1', { retentionPct: 5 })).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses payments numbered with a gap (400)', async () => {
    const { svc } = world(draft());
    await expect(
      svc.update(PM, 'c1', { milestones: [{ sequence: 2, descriptionAr: 'x', descriptionEn: 'x', amount: 1 }] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('ContractsService.submit — one signature, the general manager', () => {
  it('refuses payments that do not add up to the value (400), before any chain opens', async () => {
    const ms = defaultMilestones('1000000');
    ms[2].amount = D('199999');
    const { svc, approvals } = world(draft({ milestones: ms }));
    await expect(svc.submit(PM, 'c1')).rejects.toThrow(/add up to 999999.00, not the contract value 1000000.00/);
    expect(approvals.gate).not.toHaveBeenCalled();
  });

  it('opens the CONTRACT chain on the value and waits', async () => {
    const { svc, approvals, rows } = world(draft());
    const out = await svc.submit(PM, 'c1');
    expect(approvals.gate).toHaveBeenCalledWith(PM, {
      documentType: 'CONTRACT',
      documentId: 'c1',
      documentCode: 'CTR-00009',
      amount: 1000000,
    });
    expect(rows.current).toMatchObject({ status: 'PENDING_APPROVAL' });
    expect(out).toMatchObject({ pendingApproval: { id: 'req1' } });
  });

  it('with no band, someone without the approve key cannot clear it themselves (403)', async () => {
    const { svc, rows } = world(draft(), { gate: { cleared: true } });
    await expect(svc.submit(PM, 'c1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(rows.current).toMatchObject({ status: 'DRAFT' });
  });

  it('the approval lands: APPROVED under the approver, and contract writers are told what is next', async () => {
    const { svc, approvals, rows, notifications } = world(draft({ status: 'PENDING_APPROVAL' }));
    svc.onModuleInit();
    const [, apply] = approvals.register.mock.calls.find((c) => c[0] === 'CONTRACT')!;
    await apply(GM, 'c1');
    expect(rows.current).toMatchObject({ status: 'APPROVED', approvedById: 'u-gm' });
    expect(notifications.notifyBestEffort.mock.calls[0][0]).toMatchObject({ type: 'CONTRACT_APPROVED' });
  });

  it('a rejected chain sends it back to DRAFT', async () => {
    const { svc, approvals, rows } = world(draft({ status: 'PENDING_APPROVAL', submittedAt: new Date() }));
    svc.onModuleInit();
    const [, , reject] = approvals.register.mock.calls.find((c) => c[0] === 'CONTRACT')!;
    await reject(GM, 'c1', 'الدفعة الأولى مرتفعة');
    expect(rows.current).toMatchObject({ status: 'DRAFT', submittedAt: null });
  });
});

describe('ContractsService.activate — approved, with the signed copy', () => {
  const getFor = (svc: ContractsService, c: unknown) =>
    jest.spyOn(svc, 'get').mockResolvedValue(c as never);

  it('a contract from a quote that is still a draft cannot be activated (400)', async () => {
    const { svc } = world(draft());
    getFor(svc, draft());
    await expect(svc.activate(PM, 'c1')).rejects.toThrow('Only an approved contract can be activated');
  });

  it("an approved one without the customer's signed copy filed since approval is refused (400)", async () => {
    const approvedAt = new Date('2026-10-29T10:00:00Z');
    const { svc, prisma } = world(draft({ status: 'APPROVED', approvedAt }), { signed: null });
    getFor(svc, draft({ status: 'APPROVED', approvedAt }));
    await expect(svc.activate(PM, 'c1')).rejects.toThrow(/signed copy/);
    expect(prisma.attachment.findFirst.mock.calls[0][0].where).toMatchObject({
      entityType: 'CONTRACT',
      entityId: 'c1',
      createdAt: { gte: approvedAt },
    });
  });

  it('approved + signed copy → ACTIVE, and finance and projects are told their next step', async () => {
    const { svc, rows, notifications } = world(draft({ status: 'APPROVED', approvedAt: new Date() }));
    getFor(svc, draft({ status: 'APPROVED', approvedAt: new Date() }));
    await svc.activate(PM, 'c1');
    expect(rows.current).toMatchObject({ status: 'ACTIVE' });
    expect(notifications.notifyBestEffort.mock.calls.map((c) => c[0].type)).toEqual([
      'CONTRACT_ACTIVATED_FINANCE',
      'CONTRACT_ACTIVATED_PROJECTS',
    ]);
  });

  it('a hand-written contract with no quote keeps the old DRAFT → ACTIVE move', async () => {
    const manual = draft({ proposalRevisionId: null });
    const { svc, rows, prisma } = world(manual);
    getFor(svc, manual);
    await svc.activate(PM, 'c1');
    expect(rows.current).toMatchObject({ status: 'ACTIVE' });
    expect(prisma.attachment.findFirst).not.toHaveBeenCalled();
  });
});
