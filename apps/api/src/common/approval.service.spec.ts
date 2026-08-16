import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ApprovalService } from './approval.service';
import { bandsOverlap, inBand } from '@npi/shared';
import type { AuthUser } from './auth-user';

const user = (over: Partial<AuthUser> = {}): AuthUser => ({
  userId: 'u1',
  organizationId: 'org1',
  email: 'a@b.c',
  roleId: 'role-pm',
  roleKey: 'pm',
  permissions: ['scm.procurement.write', 'projects.project.write'],
  locale: 'AR',
  ...over,
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
    ...over,
  };
  db.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return db as unknown as PrismaDouble;
};

const make = (prisma: unknown) =>
  new ApprovalService(prisma as never, audit as never, notifications as never);

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

  it('advances to the next step without applying the document', async () => {
    const prisma = withRequest(pendingRequest(), { currentStep: 2, status: 'PENDING' });
    const svc = make(prisma);
    const applier = jest.fn();
    svc.register('PURCHASE_ORDER', applier);

    const res = await svc.decide(user(), 'req1', 'APPROVE');

    expect(res.applied).toBe(false);
    expect(applier).not.toHaveBeenCalled();
    expect(prisma.approvalRequest.update.mock.calls[0][0].data).toEqual({
      currentStep: { increment: 1 },
    });
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
    expect(() => svc.onApplicationBootstrap()).toThrow(/PROGRESS_CLAIM, CHANGE_ORDER/);
  });

  it('starts once every advertised type is registered', () => {
    const svc = make(prismaWith());
    svc.register('PURCHASE_ORDER', jest.fn());
    svc.register('PROGRESS_CLAIM', jest.fn());
    svc.register('CHANGE_ORDER', jest.fn());
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
