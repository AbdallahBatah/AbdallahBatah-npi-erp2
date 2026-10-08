import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ApprovalService } from './approval.service';
import { APPROVAL_DOCUMENTS, bandsOverlap, inBand } from '@npi/shared';
import type { AuthUser } from './auth-user';

const user = (over: Partial<AuthUser> = {}): AuthUser => ({
  userId: 'u1',
  organizationId: 'org1',
  email: 'a@b.c',
  roleId: 'role-pm',
  roleKey: 'pm',
  permissions: [
    'scm.procurement.write',
    'scm.procurement.approve',
    'projects.project.write',
    'projects.project.approve',
  ],
  locale: 'AR',
  ...over,
  // The primary role is always one of the user's roles unless a test says otherwise.
  roleIds: over.roleIds ?? [over.roleId ?? 'role-pm'],
});

const audit = { record: jest.fn().mockResolvedValue(undefined) };
const notifications = {
  notifyBestEffort: jest.fn().mockResolvedValue(0),
  notify: jest.fn().mockResolvedValue(0),
};

/**
 * Prisma double: only the shapes ApprovalService actually reaches for.
 * $transaction hands the callback the same double, so writes made through the
 * transaction client land on the very mocks the assertions read.
 */
interface PrismaDouble {
  approvalRule: { findMany: jest.Mock };
  approvalRequest: {
    findFirst: jest.Mock;
    findUnique: jest.Mock;
    findMany: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    count: jest.Mock;
  };
  approvalStep: { update: jest.Mock };
  notification: { create: jest.Mock };
  user: { findUnique: jest.Mock };
  $transaction: jest.Mock;
}

const prismaWith = (over: Record<string, unknown> = {}): PrismaDouble => {
  const db: Record<string, unknown> = {
    approvalRule: { findMany: jest.fn().mockResolvedValue([]) },
    approvalRequest: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    approvalStep: { update: jest.fn() },
    notification: { create: jest.fn().mockResolvedValue({}) },
    // departmentOf(): no department unless a test says otherwise.
    user: { findUnique: jest.fn().mockResolvedValue({ departmentId: null }) },
    ...over,
  };
  db.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return db as unknown as PrismaDouble;
};

// M4: by default nobody holds a delegation, so every pre-existing test keeps
// exercising exactly the authority rules it was written for. The delegation
// cases below supply their own double.
const noDelegations = {
  rolesFor: jest.fn().mockResolvedValue([]),
  delegationFor: jest.fn().mockResolvedValue(null),
  delegatesOf: jest.fn().mockResolvedValue([]),
};

const make = (prisma: unknown, delegations: unknown = noDelegations) =>
  new ApprovalService(
    prisma as never,
    audit as never,
    notifications as never,
    delegations as never,
  );

beforeEach(() => jest.clearAllMocks());

// ── the band arithmetic everything else depends on ──────────────────────────

describe('amount bands', () => {
  it('is half-open, so a boundary amount belongs to exactly one band', () => {
    // 0–100k and 100k+ must partition the line: 100,000 is in the upper band
    // only. Inclusive-both would make approval depend on row order.
    expect(inBand(99_999.99, 0, 100_000)).toBe(true);
    expect(inBand(100_000, 0, 100_000)).toBe(false);
    expect(inBand(100_000, 100_000, null)).toBe(true);
    expect(inBand(5_000_000, 100_000, null)).toBe(true);
  });

  it('treats a null ceiling as unbounded when checking overlap', () => {
    expect(bandsOverlap({ min: 0, max: 100_000 }, { min: 100_000, max: null })).toBe(false);
    expect(bandsOverlap({ min: 0, max: 100_001 }, { min: 100_000, max: null })).toBe(true);
    expect(bandsOverlap({ min: 0, max: null }, { min: 500_000, max: 600_000 })).toBe(true);
    expect(bandsOverlap({ min: 0, max: 50 }, { min: 50, max: 100 })).toBe(false);
  });
});

// ── rule resolution ─────────────────────────────────────────────────────────

describe('ApprovalService.resolveRule', () => {
  it('returns null when nothing is configured — the pre-matrix behaviour', async () => {
    const svc = make(prismaWith());
    await expect(svc.resolveRule('org1', 'PURCHASE_ORDER', 5_000_000)).resolves.toBeNull();
  });

  it('picks the band the amount falls in', async () => {
    const prisma = prismaWith();
    prisma.approvalRule.findMany.mockResolvedValue([
      { id: 'r1', minAmount: 0, maxAmount: 100_000, steps: [{ sequence: 1, roleId: 'a' }] },
      { id: 'r2', minAmount: 100_000, maxAmount: null, steps: [{ sequence: 1, roleId: 'b' }] },
    ]);
    const svc = make(prisma);
    await expect(svc.resolveRule('org1', 'PURCHASE_ORDER', 500)).resolves.toMatchObject({ id: 'r1' });
    await expect(svc.resolveRule('org1', 'PURCHASE_ORDER', 5_000_000)).resolves.toMatchObject({
      id: 'r2',
    });
  });

  it('ignores a stepless rule rather than opening a chain nobody can close', async () => {
    const prisma = prismaWith();
    prisma.approvalRule.findMany.mockResolvedValue([
      { id: 'r1', minAmount: 0, maxAmount: null, steps: [] },
    ]);
    await expect(make(prisma).resolveRule('org1', 'PURCHASE_ORDER', 900)).resolves.toBeNull();
  });
});

// ── the gate ────────────────────────────────────────────────────────────────

describe('ApprovalService.gate', () => {
  const twoStepRule = {
    id: 'r1',
    minAmount: 100_000,
    maxAmount: null,
    steps: [
      { sequence: 1, roleId: 'role-pm' },
      { sequence: 2, roleId: 'role-fin' },
    ],
  };

  it('clears when no rule covers the amount — the document proceeds as before', async () => {
    const prisma = prismaWith();
    const verdict = await make(prisma).gate(user(), {
      documentType: 'PURCHASE_ORDER',
      documentId: 'po1',
      documentCode: 'PO-1',
      amount: 500,
    });
    expect(verdict).toEqual({ cleared: true, request: null });
    expect(prisma.approvalRequest.create).not.toHaveBeenCalled();
  });

  it('opens a chain and does NOT clear when a rule matches', async () => {
    const prisma = prismaWith();
    prisma.approvalRule.findMany.mockResolvedValue([twoStepRule]);
    prisma.approvalRequest.create.mockResolvedValue({
      id: 'req1',
      documentType: 'PURCHASE_ORDER',
      documentId: 'po1',
      documentCode: 'PO-1',
      amount: 250_000,
      status: 'PENDING',
      currentStep: 1,
      createdAt: new Date(),
      closedAt: null,
      raisedBy: null,
      steps: [],
    });

    const verdict = await make(prisma).gate(user(), {
      documentType: 'PURCHASE_ORDER',
      documentId: 'po1',
      documentCode: 'PO-1',
      amount: 250_000,
    });

    expect(verdict.cleared).toBe(false);
    // Both rule steps are materialised onto the request, in order.
    expect(prisma.approvalRequest.create.mock.calls[0][0].data.steps.create).toEqual([
      { sequence: 1, roleId: 'role-pm' },
      { sequence: 2, roleId: 'role-fin' },
    ]);
  });

  it('bands on the absolute amount — a large negative variation is not small', async () => {
    const prisma = prismaWith();
    prisma.approvalRule.findMany.mockResolvedValue([twoStepRule]);
    prisma.approvalRequest.create.mockResolvedValue({
      id: 'req1',
      documentType: 'CHANGE_ORDER',
      documentId: 'co1',
      documentCode: 'CO-1',
      amount: 900_000,
      status: 'PENDING',
      currentStep: 1,
      createdAt: new Date(),
      closedAt: null,
      raisedBy: null,
      steps: [],
    });

    const verdict = await make(prisma).gate(user(), {
      documentType: 'CHANGE_ORDER',
      documentId: 'co1',
      documentCode: 'CO-1',
      amount: -900_000,
    });

    expect(verdict.cleared).toBe(false);
    expect(prisma.approvalRequest.create.mock.calls[0][0].data.amount).toBe(900_000);
  });

  it('refuses to open a second chain for a document already in one', async () => {
    const prisma = prismaWith();
    prisma.approvalRule.findMany.mockResolvedValue([twoStepRule]);
    prisma.approvalRequest.findFirst.mockResolvedValue({
      id: 'req1',
      currentStep: 2,
      status: 'PENDING',
      steps: [],
    });

    await expect(
      make(prisma).gate(user(), {
        documentType: 'PURCHASE_ORDER',
        documentId: 'po1',
        documentCode: 'PO-1',
        amount: 250_000,
      }),
    ).rejects.toThrow(BadRequestException);
  });
});

// ── deciding: routing, separation of duties, and application ────────────────

describe('ApprovalService.decide', () => {
  interface StepRow {
    id: string;
    sequence: number;
    roleId: string;
    status: string;
    role: { id: string; nameAr: string; nameEn: string };
    decidedById: string | null;
    decidedBy: { id: string; nameAr: string; nameEn: string } | null;
    decidedAt: Date | null;
    note: string | null;
  }

  const pendingRequest = (over: Record<string, unknown> = {}): Record<string, unknown> & {
    steps: StepRow[];
  } => ({
    id: 'req1',
    organizationId: 'org1',
    documentType: 'PURCHASE_ORDER',
    documentId: 'po1',
    documentCode: 'PO-1',
    amount: 250_000,
    status: 'PENDING',
    currentStep: 1,
    createdAt: new Date(),
    closedAt: null,
    raisedById: 'u-buyer',
    raisedBy: null,
    steps: [
      {
        id: 's1',
        sequence: 1,
        roleId: 'role-pm',
        status: 'PENDING',
        role: { id: 'role-pm', nameAr: 'مدير', nameEn: 'PM' },
        decidedById: null,
        decidedBy: null,
        decidedAt: null,
        note: null,
      } as StepRow,
      {
        id: 's2',
        sequence: 2,
        roleId: 'role-fin',
        status: 'PENDING',
        role: { id: 'role-fin', nameAr: 'مالية', nameEn: 'Finance' },
        decidedById: null,
        decidedBy: null,
        decidedAt: null,
        note: null,
      } as StepRow,
    ],
    ...over,
  });

  const withRequest = (req: Record<string, unknown>, after: Record<string, unknown>) => {
    const prisma = prismaWith();
    prisma.approvalRequest.findFirst.mockResolvedValue(req);
    prisma.approvalRequest.update.mockResolvedValue({ ...req, ...after });
    prisma.approvalRequest.findUnique.mockResolvedValue({ ...req, ...after });
    return prisma;
  };

  it('refuses a role that is not the current step', async () => {
    const prisma = withRequest(pendingRequest(), {});
    await expect(
      make(prisma).decide(user({ roleId: 'role-fin' }), 'req1', 'APPROVE'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('refuses the submitter, even when their role IS the approver', async () => {
    // The control that makes the whole matrix worth having: a buyer who can
    // also sign as project manager would otherwise approve their own PO.
    const prisma = withRequest(pendingRequest({ raisedById: 'u1' }), {});
    await expect(make(prisma).decide(user(), 'req1', 'APPROVE')).rejects.toThrow(
      /submitted yourself/,
    );
  });

  it('refuses a second signature from someone who signed an earlier step', async () => {
    const req = pendingRequest({ currentStep: 2 });
    req.steps[0] = { ...req.steps[0], status: 'APPROVED', decidedById: 'u1' };
    const prisma = withRequest(req, {});
    await expect(
      make(prisma).decide(user({ roleId: 'role-fin' }), 'req1', 'APPROVE'),
    ).rejects.toThrow(/already signed/);
  });

  it('refuses a caller whose live permissions no longer cover the document', async () => {
    const prisma = withRequest(pendingRequest(), {});
    await expect(
      make(prisma).decide(user({ permissions: [] }), 'req1', 'APPROVE'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('refuses a caller who can write procurement but lacks the approve key', async () => {
    // CRM Phase 1: writing and approving are separate keys now.
    const prisma = withRequest(pendingRequest(), {});
    await expect(
      make(prisma).decide(user({ permissions: ['scm.procurement.write'] }), 'req1', 'APPROVE'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('lets a user sign through an EXTRA role even when the primary role is not the step', async () => {
    const prisma = withRequest(pendingRequest(), { currentStep: 2, status: 'PENDING' });
    const svc = make(prisma);
    svc.register('PURCHASE_ORDER', jest.fn());
    // primary = role-sales (not the step), extra = role-pm (the current step)
    const res = await svc.decide(
      user({ roleId: 'role-sales', roleIds: ['role-sales', 'role-pm'] }),
      'req1',
      'APPROVE',
    );
    expect(res.applied).toBe(false);
    expect(prisma.approvalRequest.update).toHaveBeenCalled();
  });

  it('still refuses when none of the roles the user holds is the current step', async () => {
    const prisma = withRequest(pendingRequest(), {});
    await expect(
      make(prisma).decide(
        user({ roleId: 'role-sales', roleIds: ['role-sales', 'role-hr'] }),
        'req1',
        'APPROVE',
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('advances to the next step without applying the document', async () => {
    const prisma = withRequest(pendingRequest(), { currentStep: 2, status: 'PENDING' });
    const svc = make(prisma);
    const applier = jest.fn();
    svc.register('PURCHASE_ORDER', applier);

    const res = await svc.decide(user(), 'req1', 'APPROVE');

    expect(res.applied).toBe(false);
    expect(applier).not.toHaveBeenCalled();
    // M4: the step clock restarts with the step. The next approver's
    // escalation window is their own, not the remainder of the last one's.
    const advance = prisma.approvalRequest.update.mock.calls[0][0].data;
    expect(advance.currentStep).toEqual({ increment: 1 });
    expect(advance.currentStepAt).toBeInstanceOf(Date);
    expect(Object.keys(advance).sort()).toEqual(['currentStep', 'currentStepAt']);
  });

  it('applies the document only when the last step signs', async () => {
    const req = pendingRequest({ currentStep: 2 });
    req.steps[0] = { ...req.steps[0], status: 'APPROVED', decidedById: 'u-pm' };
    const prisma = withRequest(req, { status: 'APPROVED' });
    const svc = make(prisma);
    const applier = jest.fn().mockResolvedValue({ ok: true });
    svc.register('PURCHASE_ORDER', applier);

    const res = await svc.decide(user({ roleId: 'role-fin' }), 'req1', 'APPROVE');

    expect(res.applied).toBe(true);
    expect(applier).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1' }), 'po1');
  });

  // ── M4: the rejection must move the document, not only close the chain ────

  it('runs the rejecter so a refused document does not strand in PENDING_APPROVAL', async () => {
    // Before M4 a rejected PO simply stayed in DRAFT and the chain closing was
    // the whole story. Now it waits in PENDING_APPROVAL, so a rejection that
    // only closes the chain would leave it in a state no transition leaves.
    const prisma = withRequest(pendingRequest(), { status: 'REJECTED' });
    const svc = make(prisma);
    const applier = jest.fn();
    const rejecter = jest.fn().mockResolvedValue(undefined);
    svc.register('PURCHASE_ORDER', applier, rejecter);

    await svc.decide(user(), 'req1', 'REJECT', 'price is wrong');

    expect(applier).not.toHaveBeenCalled();
    expect(rejecter).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1' }),
      'po1',
      'price is wrong',
    );
  });

  it('does not turn a failing rejecter into a 500 on an already-recorded refusal', async () => {
    // The rejection has committed. Throwing here would invite the approver to
    // click again and produce a second one.
    const prisma = withRequest(pendingRequest(), { status: 'REJECTED' });
    const svc = make(prisma);
    svc.register('PURCHASE_ORDER', jest.fn(), jest.fn().mockRejectedValue(new Error('boom')));

    await expect(svc.decide(user(), 'req1', 'REJECT', 'nope')).resolves.toMatchObject({
      applied: false,
    });
  });

  it('is content with no rejecter for a type whose refused state needs no move', async () => {
    const prisma = withRequest(pendingRequest(), { status: 'REJECTED' });
    const svc = make(prisma);
    svc.register('PURCHASE_ORDER', jest.fn());
    await expect(svc.decide(user(), 'req1', 'REJECT', 'nope')).resolves.toMatchObject({
      applied: false,
    });
  });

  it('rejects the whole chain on one rejection and never applies', async () => {
    const prisma = withRequest(pendingRequest(), { status: 'REJECTED' });
    const svc = make(prisma);
    const applier = jest.fn();
    svc.register('PURCHASE_ORDER', applier);

    const res = await svc.decide(user(), 'req1', 'REJECT', 'price is wrong');

    expect(res.applied).toBe(false);
    expect(applier).not.toHaveBeenCalled();
    expect(prisma.approvalStep.update.mock.calls[0][0].data).toMatchObject({
      status: 'REJECTED',
      note: 'price is wrong',
    });
  });

  it('refuses to decide an already-closed request', async () => {
    const prisma = withRequest(pendingRequest({ status: 'APPROVED' }), {});
    await expect(make(prisma).decide(user(), 'req1', 'APPROVE')).rejects.toThrow(
      /already been decided/,
    );
  });
});

// ── boot-time wiring ────────────────────────────────────────────────────────

describe('ApprovalService.onApplicationBootstrap', () => {
  it('refuses to start when a document type has no owner', () => {
    // Advertising a type the matrix cannot apply would collect every signature
    // and then fail — the worst possible moment to find out.
    const svc = make(prismaWith());
    svc.register('PURCHASE_ORDER', jest.fn());
    const unowned = APPROVAL_DOCUMENTS.map((d) => d.value).filter((v) => v !== 'PURCHASE_ORDER');
    expect(() => svc.onApplicationBootstrap()).toThrow(new RegExp(unowned.join(', ')));
  });

  it('starts once every advertised type is registered', () => {
    const svc = make(prismaWith());
    // Derived from the catalog rather than listed by hand: adding a document
    // type to APPROVAL_DOCUMENTS must fail the *first* test in this describe —
    // which is the guard — not silently pass this one because someone forgot
    // to extend a hardcoded list here too.
    for (const d of APPROVAL_DOCUMENTS) svc.register(d.value, jest.fn());
    expect(() => svc.onApplicationBootstrap()).not.toThrow();
  });
});

// ── inbox: visible but unsignable ───────────────────────────────────────────

describe('ApprovalService.inbox', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'req1',
    documentType: 'PURCHASE_ORDER',
    documentId: 'po1',
    documentCode: 'PO-1',
    amount: 250_000,
    status: 'PENDING',
    currentStep: 1,
    createdAt: new Date(),
    closedAt: null,
    raisedById: 'u-other',
    raisedBy: null,
    steps: [
      {
        sequence: 1,
        roleId: 'role-pm',
        status: 'PENDING',
        role: { id: 'role-pm', nameAr: 'مدير', nameEn: 'PM' },
        decidedById: null as string | null,
        decidedBy: null,
        decidedAt: null,
        note: null,
      },
    ],
    ...over,
  });

  const inboxOf = async (r: Record<string, unknown>) => {
    const prisma = prismaWith();
    prisma.approvalRequest.findMany.mockResolvedValue([r]);
    return make(prisma).inbox(user());
  };

  it('marks a row the caller can sign', async () => {
    const [item] = await inboxOf(row());
    expect(item.canDecide).toBe(true);
    expect(item.blockedReason).toBeUndefined();
  });

  it('shows a row waiting on an EXTRA role of the caller', async () => {
    const prisma = prismaWith();
    prisma.approvalRequest.findMany.mockResolvedValue([row()]);
    const items = await make(prisma).inbox(
      user({ roleId: 'role-sales', roleIds: ['role-sales', 'role-pm'] }),
    );
    expect(items).toHaveLength(1);
    expect(items[0].canDecide).toBe(true);
    expect(items[0].viaDelegationFrom).toBeUndefined();
    // the query asked for every role the user holds
    const where = prisma.approvalRequest.findMany.mock.calls[0][0].where;
    expect(where.steps.some.roleId.in).toEqual(expect.arrayContaining(['role-sales', 'role-pm']));
  });

  it('keeps a self-raised row visible but unsignable', async () => {
    // Hiding it would make a one-person-role chain vanish silently instead of
    // showing the organization that it is stuck.
    const [item] = await inboxOf(row({ raisedById: 'u1' }));
    expect(item.canDecide).toBe(false);
    expect(item.blockedReason).toBe('RAISED_BY_YOU');
  });

  it('does not count unsignable rows in the badge', async () => {
    const prisma = prismaWith();
    prisma.approvalRequest.findMany.mockResolvedValue([row(), row({ id: 'r2', raisedById: 'u1' })]);
    await expect(make(prisma).inboxCount(user())).resolves.toBe(1);
  });
});

// ── CRM Phase 1 · Step 4: the proposal joins the matrix ─────────────────────

describe('PROPOSAL in the approval matrix', () => {
  it('is an advertised document type, decided with the proposal approve key', () => {
    const meta = APPROVAL_DOCUMENTS.find((d) => d.value === 'PROPOSAL');
    expect(meta).toMatchObject({
      value: 'PROPOSAL',
      labelAr: 'عرض سعر',
      permission: 'commercial.proposal.approve',
    });
    expect(meta!.amountLabelAr).toContain('سعر البيع');
  });

  it('the boot gate demands an applier for it — forgetting the registration fails the start', () => {
    const svc = make(prismaWith());
    for (const d of APPROVAL_DOCUMENTS) if (d.value !== 'PROPOSAL') svc.register(d.value, jest.fn());
    expect(() => svc.onApplicationBootstrap()).toThrow(/PROPOSAL/);
    svc.register('PROPOSAL', jest.fn(), jest.fn());
    expect(() => svc.onApplicationBootstrap()).not.toThrow();
  });

  it('a procurement approver cannot sign a proposal — the key is the proposal’s own', async () => {
    const prisma = prismaWith();
    const req = {
      id: 'req9', organizationId: 'org1', documentType: 'PROPOSAL', documentId: 'p1', documentCode: 'PRP-1 R1',
      amount: 90_000, status: 'PENDING', currentStep: 1, currentStepAt: new Date(), createdAt: new Date(), closedAt: null,
      raisedById: 'u-sales', raisedBy: null,
      steps: [{
        id: 's1', sequence: 1, roleId: 'role-pm', status: 'PENDING',
        role: { id: 'role-pm', nameAr: 'م', nameEn: 'M' }, decidedById: null, decidedBy: null, decidedAt: null, note: null, escalatedAt: null,
      }],
    };
    (prisma.approvalRequest.findFirst as jest.Mock).mockResolvedValue(req);
    (prisma.approvalRequest.update as jest.Mock).mockResolvedValue({ ...req, status: 'PENDING' });
    (prisma.approvalRequest.findUnique as jest.Mock).mockResolvedValue({ ...req, status: 'PENDING' });
    await expect(make(prisma).decide(user(), 'req9', 'APPROVE')).rejects.toThrow(ForbiddenException);
  });
});
