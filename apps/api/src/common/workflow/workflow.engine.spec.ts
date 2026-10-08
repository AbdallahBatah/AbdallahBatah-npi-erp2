import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { WorkflowEngine } from './workflow.engine';
import type { AuthUser } from '../auth-user';

const user = (over: Partial<AuthUser> = {}): AuthUser => ({
  userId: 'u1',
  organizationId: 'org1',
  email: 'a@b.c',
  roleId: 'role-pm',
  roleKey: 'pm',
  permissions: ['scm.procurement.write', 'scm.requisition.write'],
  locale: 'AR',
  ...over,
  roleIds: over.roleIds ?? [over.roleId ?? 'role-pm'],
});

const audit = { record: jest.fn().mockResolvedValue(undefined) };
const outbox = { emit: jest.fn().mockResolvedValue('evt1') };

const STATES = [
  { code: 'DRAFT', nameEn: 'Draft', kind: 'INITIAL' },
  { code: 'PENDING_APPROVAL', nameEn: 'Pending approval', kind: 'INTERMEDIATE' },
  { code: 'APPROVED', nameEn: 'Approved', kind: 'INTERMEDIATE' },
  { code: 'REJECTED', nameEn: 'Rejected', kind: 'FINAL' },
];

const instance = (over: Record<string, unknown> = {}) => ({
  id: 'wf1',
  organizationId: 'org1',
  definitionId: 'def1',
  documentType: 'PurchaseRequisition',
  documentId: 'pr1',
  documentCode: 'PR-00001',
  currentState: 'DRAFT',
  assigneeRoleId: null,
  closedAt: null,
  definition: { id: 'def1', code: 'PURCHASE_REQUISITION', states: STATES },
  ...over,
});

const transition = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  definitionId: 'def1',
  fromState: 'DRAFT',
  toState: 'PENDING_APPROVAL',
  actionCode: 'SUBMIT',
  nameAr: 'رفع للاعتماد',
  nameEn: 'Submit for approval',
  requiredPermission: 'scm.requisition.write',
  conditionExpr: null,
  emitsEvent: null,
  requiresApproval: false,
  sortOrder: 0,
  ...over,
});

/**
 * Prisma double: only the shapes the engine reaches for. $transaction hands
 * the callback the same double, so writes made through the transaction client
 * land on the mocks the assertions read.
 */
const prismaWith = (over: Record<string, unknown> = {}) => {
  const db: Record<string, unknown> = {
    wfInstance: {
      findFirst: jest.fn().mockResolvedValue(instance()),
      findUnique: jest.fn().mockResolvedValue({ currentState: 'DRAFT', closedAt: null }),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'wf1', currentState: 'DRAFT' }),
      update: jest.fn().mockResolvedValue({}),
    },
    wfTransition: {
      findUnique: jest.fn().mockResolvedValue(transition()),
      findMany: jest.fn().mockResolvedValue([]),
    },
    wfHistory: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
    wfState: { findMany: jest.fn().mockResolvedValue(STATES) },
    wfDefinition: { findFirst: jest.fn().mockResolvedValue({ id: 'def1', documentType: 'PurchaseRequisition', states: STATES }) },
    auditLog: { create: jest.fn() },
    ...over,
  };
  db.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return db as never;
};

const make = (prisma: unknown) =>
  new WorkflowEngine(prisma as never, audit as never, outbox as never);

beforeEach(() => jest.clearAllMocks());

// ── the refusals: what the engine exists to make impossible ─────────────────

describe('WorkflowEngine.transition — illegal moves', () => {
  it('refuses an action that is not a row in wf_transitions', async () => {
    // The whole point of the table: an unlisted move cannot happen, regardless
    // of what the caller holds or what the UI offered them.
    const prisma = prismaWith();
    (prisma as never as { wfTransition: { findUnique: jest.Mock } }).wfTransition.findUnique.mockResolvedValue(
      null,
    );
    const engine = make(prisma);

    await expect(
      engine.transition(user(), {
        documentType: 'PurchaseRequisition',
        documentId: 'pr1',
        actionCode: 'APPROVE', // legal from PENDING_APPROVAL, not from DRAFT
      }),
    ).rejects.toThrow(/not a legal action/);
  });

  it('names the state it refused from, so the error is actionable', async () => {
    const prisma = prismaWith();
    (prisma as never as { wfTransition: { findUnique: jest.Mock } }).wfTransition.findUnique.mockResolvedValue(
      null,
    );
    await expect(
      make(prisma).transition(user(), {
        documentType: 'PurchaseRequisition',
        documentId: 'pr1',
        actionCode: 'PAY',
      }),
    ).rejects.toThrow(/PR-00001 while it is Draft/);
  });

  it('writes nothing when it refuses', async () => {
    const prisma = prismaWith();
    (prisma as never as { wfTransition: { findUnique: jest.Mock } }).wfTransition.findUnique.mockResolvedValue(
      null,
    );
    const apply = jest.fn();
    await expect(
      make(prisma).transition(user(), {
        documentType: 'PurchaseRequisition',
        documentId: 'pr1',
        actionCode: 'APPROVE',
        apply,
      }),
    ).rejects.toThrow();

    const db = prisma as never as Record<string, { create?: jest.Mock; update?: jest.Mock }>;
    expect(apply).not.toHaveBeenCalled();
    expect(db.wfHistory.create).not.toHaveBeenCalled();
    expect(db.wfInstance.update).not.toHaveBeenCalled();
    expect(outbox.emit).not.toHaveBeenCalled();
  });

  it('refuses when there is no open flow for the document', async () => {
    const prisma = prismaWith();
    (prisma as never as { wfInstance: { findFirst: jest.Mock } }).wfInstance.findFirst.mockResolvedValue(
      null,
    );
    await expect(
      make(prisma).transition(user(), {
        documentType: 'PurchaseRequisition',
        documentId: 'gone',
        actionCode: 'SUBMIT',
      }),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('WorkflowEngine.transition — authority', () => {
  it('refuses a caller missing the transition’s permission', async () => {
    const prisma = prismaWith();
    await expect(
      make(prisma).transition(user({ permissions: ['scm.procurement.read'] }), {
        documentType: 'PurchaseRequisition',
        documentId: 'pr1',
        actionCode: 'SUBMIT',
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('checks permissions against the caller’s live set, not the seeded role', async () => {
    // The same role whose permissions were edited this morning must be judged
    // on what it holds now — which is why the check reads user.permissions.
    const prisma = prismaWith();
    await expect(
      make(prisma).transition(user({ permissions: [] }), {
        documentType: 'PurchaseRequisition',
        documentId: 'pr1',
        actionCode: 'SUBMIT',
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('does not leak which permission was missing', async () => {
    const prisma = prismaWith();
    await expect(
      make(prisma).transition(user({ permissions: [] }), {
        documentType: 'PurchaseRequisition',
        documentId: 'pr1',
        actionCode: 'SUBMIT',
      }),
    ).rejects.toThrow('Insufficient permissions');
  });

  it('checks legality before authority, so a bad action is not a permission probe', async () => {
    const prisma = prismaWith();
    (prisma as never as { wfTransition: { findUnique: jest.Mock } }).wfTransition.findUnique.mockResolvedValue(
      null,
    );
    await expect(
      make(prisma).transition(user({ permissions: [] }), {
        documentType: 'PurchaseRequisition',
        documentId: 'pr1',
        actionCode: 'APPROVE',
      }),
    ).rejects.toThrow(/not a legal action/);
  });
});

describe('WorkflowEngine.transition — conditions and comments', () => {
  it('refuses a move whose condition the document does not meet', async () => {
    const prisma = prismaWith();
    (prisma as never as { wfTransition: { findUnique: jest.Mock } }).wfTransition.findUnique.mockResolvedValue(
      transition({ conditionExpr: 'estimatedTotal > 0' }),
    );
    await expect(
      make(prisma).transition(user(), {
        documentType: 'PurchaseRequisition',
        documentId: 'pr1',
        actionCode: 'SUBMIT',
        context: { estimatedTotal: 0 },
      }),
    ).rejects.toThrow(/does not meet the condition/);
  });

  it('allows the same move once the condition holds', async () => {
    const prisma = prismaWith();
    (prisma as never as { wfTransition: { findUnique: jest.Mock } }).wfTransition.findUnique.mockResolvedValue(
      transition({ conditionExpr: 'estimatedTotal > 0' }),
    );
    await expect(
      make(prisma).transition(user(), {
        documentType: 'PurchaseRequisition',
        documentId: 'pr1',
        actionCode: 'SUBMIT',
        context: { estimatedTotal: 5000 },
      }),
    ).resolves.toMatchObject({ toState: 'PENDING_APPROVAL' });
  });

  it('requires a reason on a rejection', async () => {
    const prisma = prismaWith();
    (prisma as never as { wfTransition: { findUnique: jest.Mock } }).wfTransition.findUnique.mockResolvedValue(
      transition({
        actionCode: 'REJECT',
        toState: 'REJECTED',
        requiredPermission: 'scm.procurement.write',
      }),
    );
    await expect(
      make(prisma).transition(user(), {
        documentType: 'PurchaseRequisition',
        documentId: 'pr1',
        actionCode: 'REJECT',
      }),
    ).rejects.toThrow(/requires a reason/);

    await expect(
      make(prisma).transition(user(), {
        documentType: 'PurchaseRequisition',
        documentId: 'pr1',
        actionCode: 'REJECT',
        comment: 'Budget exhausted for this quarter',
      }),
    ).resolves.toMatchObject({ toState: 'REJECTED' });
  });

  it('does not accept whitespace as a reason', async () => {
    const prisma = prismaWith();
    (prisma as never as { wfTransition: { findUnique: jest.Mock } }).wfTransition.findUnique.mockResolvedValue(
      transition({ actionCode: 'REJECT', toState: 'REJECTED' }),
    );
    await expect(
      make(prisma).transition(user(), {
        documentType: 'PurchaseRequisition',
        documentId: 'pr1',
        actionCode: 'REJECT',
        comment: '    ',
      }),
    ).rejects.toThrow(/requires a reason/);
  });
});

// ── what a successful move must do, all of it, together ─────────────────────

describe('WorkflowEngine.transition — the atomic write', () => {
  it('moves the instance, appends history and emits the event in one transaction', async () => {
    const prisma = prismaWith();
    (prisma as never as { wfTransition: { findUnique: jest.Mock } }).wfTransition.findUnique.mockResolvedValue(
      transition({ emitsEvent: 'pr.approved' }),
    );
    const applied: string[] = [];
    const engine = make(prisma);

    const res = await engine.transition(user(), {
      documentType: 'PurchaseRequisition',
      documentId: 'pr1',
      actionCode: 'SUBMIT',
      comment: 'please review',
      assigneeRoleId: 'role-fin',
      eventPayload: { estimatedTotal: 5000 },
      apply: async () => {
        applied.push('document');
      },
    });

    const db = prisma as never as Record<string, { create: jest.Mock; update: jest.Mock }>;
    expect(applied).toEqual(['document']);
    expect(db.wfInstance.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          currentState: 'PENDING_APPROVAL',
          assigneeRoleId: 'role-fin',
          closedAt: null,
        }),
      }),
    );
    expect(db.wfHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fromState: 'DRAFT',
          toState: 'PENDING_APPROVAL',
          actionCode: 'SUBMIT',
          actorId: 'u1',
          comment: 'please review',
        }),
      }),
    );
    expect(outbox.emit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventCode: 'pr.approved',
        payload: expect.objectContaining({
          estimatedTotal: 5000,
          documentId: 'pr1',
          fromState: 'DRAFT',
          toState: 'PENDING_APPROVAL',
        }),
      }),
    );
    expect(res).toMatchObject({ closed: false, eventId: 'evt1' });
  });

  it('emits nothing when the transition declares no event', async () => {
    const prisma = prismaWith();
    await make(prisma).transition(user(), {
      documentType: 'PurchaseRequisition',
      documentId: 'pr1',
      actionCode: 'SUBMIT',
    });
    expect(outbox.emit).not.toHaveBeenCalled();
  });

  it('closes the instance and clears the assignee on a FINAL state', async () => {
    const prisma = prismaWith();
    (prisma as never as { wfTransition: { findUnique: jest.Mock } }).wfTransition.findUnique.mockResolvedValue(
      transition({ actionCode: 'REJECT', toState: 'REJECTED' }),
    );
    const res = await make(prisma).transition(user(), {
      documentType: 'PurchaseRequisition',
      documentId: 'pr1',
      actionCode: 'REJECT',
      comment: 'not needed',
      // Even if the caller asks for an assignee, a closed flow owes nobody
      // anything — otherwise finished documents sit in a task box forever.
      assigneeRoleId: 'role-fin',
    });

    const db = prisma as never as Record<string, { update: jest.Mock }>;
    expect(res.closed).toBe(true);
    expect(db.wfInstance.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ assigneeRoleId: null, closedAt: expect.any(Date) }),
      }),
    );
  });

  it('records the delegated role on the history row when one was used', async () => {
    const prisma = prismaWith();
    await make(prisma).transition(user(), {
      documentType: 'PurchaseRequisition',
      documentId: 'pr1',
      actionCode: 'SUBMIT',
      onBehalfOfRoleId: 'role-fin',
    });
    const db = prisma as never as Record<string, { create: jest.Mock }>;
    expect(db.wfHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ onBehalfOfRoleId: 'role-fin' }) }),
    );
  });
});

// ── the race the re-read inside the transaction exists to lose ──────────────

describe('WorkflowEngine.transition — concurrency', () => {
  it('refuses when the document moved between the check and the write', async () => {
    // Two approvers click at the same instant. Both pass the checks; only one
    // may apply. The loser must be told to reload, not silently overwrite.
    const prisma = prismaWith();
    (prisma as never as { wfInstance: { findUnique: jest.Mock } }).wfInstance.findUnique.mockResolvedValue(
      { currentState: 'PENDING_APPROVAL', closedAt: null },
    );
    const apply = jest.fn();

    await expect(
      make(prisma).transition(user(), {
        documentType: 'PurchaseRequisition',
        documentId: 'pr1',
        actionCode: 'SUBMIT',
        apply,
      }),
    ).rejects.toThrow(/moved while this action was in flight/);
    expect(apply).not.toHaveBeenCalled();
  });

  it('refuses when the flow closed between the check and the write', async () => {
    const prisma = prismaWith();
    (prisma as never as { wfInstance: { findUnique: jest.Mock } }).wfInstance.findUnique.mockResolvedValue(
      { currentState: 'DRAFT', closedAt: new Date() },
    );
    await expect(
      make(prisma).transition(user(), {
        documentType: 'PurchaseRequisition',
        documentId: 'pr1',
        actionCode: 'SUBMIT',
      }),
    ).rejects.toThrow(BadRequestException);
  });
});

// ── opening, and what the buttons show ──────────────────────────────────────

describe('WorkflowEngine.open', () => {
  it('starts a document at its flow’s INITIAL state', async () => {
    const prisma = prismaWith();
    const db = prisma as never as Record<string, { create: jest.Mock }>;
    await make(prisma).open(prisma as never, {
      organizationId: 'org1',
      flowCode: 'PURCHASE_REQUISITION',
      documentId: 'pr9',
      documentCode: 'PR-00009',
      assigneeRoleId: 'role-pm',
    });
    expect(db.wfInstance.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ currentState: 'DRAFT' }) }),
    );
  });

  it('refuses a flow with no INITIAL state rather than guessing one', async () => {
    const prisma = prismaWith({
      wfDefinition: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'def1',
          documentType: 'X',
          states: [{ code: 'A', kind: 'INTERMEDIATE' }],
        }),
      },
    });
    await expect(
      make(prisma).open(prisma as never, {
        organizationId: 'org1',
        flowCode: 'BROKEN',
        documentId: 'x1',
        documentCode: 'X-1',
      }),
    ).rejects.toThrow(/no INITIAL state/);
  });

  it('refuses when the organization has no active definition for the flow', async () => {
    const prisma = prismaWith({ wfDefinition: { findFirst: jest.fn().mockResolvedValue(null) } });
    await expect(
      make(prisma).open(prisma as never, {
        organizationId: 'org1',
        flowCode: 'PURCHASE_REQUISITION',
        documentId: 'x1',
        documentCode: 'X-1',
      }),
    ).rejects.toThrow(/run the seed/);
  });
});

describe('WorkflowEngine.available', () => {
  it('offers only the moves this caller could actually make', async () => {
    const prisma = prismaWith({
      wfTransition: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([
          transition({ actionCode: 'SUBMIT', requiredPermission: 'scm.requisition.write' }),
          transition({ actionCode: 'APPROVE', requiredPermission: 'finance.payment.write' }),
          transition({ actionCode: 'CANCEL', conditionExpr: 'estimatedTotal > 999999' }),
        ]),
      },
    });
    const actions = await make(prisma).available(
      user(),
      'PurchaseRequisition',
      'pr1',
      { estimatedTotal: 5000 },
    );
    // APPROVE filtered by permission, CANCEL by its unmet condition.
    expect(actions.map((a) => a.actionCode)).toEqual(['SUBMIT']);
  });

  it('returns nothing for a document with no open flow', async () => {
    const prisma = prismaWith();
    (prisma as never as { wfInstance: { findFirst: jest.Mock } }).wfInstance.findFirst.mockResolvedValue(
      null,
    );
    await expect(make(prisma).available(user(), 'PurchaseRequisition', 'pr1')).resolves.toEqual([]);
  });

  it('flags which offered actions will demand a reason', async () => {
    const prisma = prismaWith({
      wfTransition: {
        findUnique: jest.fn(),
        findMany: jest
          .fn()
          .mockResolvedValue([
            transition({ actionCode: 'REJECT', requiredPermission: 'scm.requisition.write' }),
          ]),
      },
    });
    const [action] = await make(prisma).available(user(), 'PurchaseRequisition', 'pr1');
    expect(action.requiresComment).toBe(true);
  });
});

// ── CRM Phase 1 · Step 4: adopting an existing document, and the system actor ──

describe('WorkflowEngine.adopt — taking an existing document into a flow at the state it is in', () => {
  const adoptInput = (stateCode: string) => ({
    organizationId: 'org1',
    flowCode: 'PURCHASE_REQUISITION',
    documentId: 'pr9',
    documentCode: 'PR-00009',
    stateCode,
  });
  const noInstance = () =>
    prismaWith({
      wfInstance: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn().mockResolvedValue({ id: 'wf9', currentState: 'APPROVED' }),
        update: jest.fn(),
      },
    });

  it('creates the instance in that state with an ADOPT history row that has no actor', async () => {
    const prisma = noInstance();
    const res = await make(prisma).adopt(prisma as never, adoptInput('APPROVED'));
    const db = prisma as never as Record<string, { create: jest.Mock }>;
    expect(db.wfInstance.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          documentId: 'pr9',
          documentCode: 'PR-00009',
          currentState: 'APPROVED',
          closedAt: null,
        }),
      }),
    );
    expect(db.wfHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ actionCode: 'ADOPT', fromState: 'APPROVED', toState: 'APPROVED', actorId: null }),
      }),
    );
    expect(res.state).toBe('APPROVED');
  });

  it('closes the instance at once when the state is FINAL, so history never parks in a task box', async () => {
    const prisma = noInstance();
    await make(prisma).adopt(prisma as never, adoptInput('REJECTED'));
    const db = prisma as never as Record<string, { create: jest.Mock }>;
    expect(db.wfInstance.create.mock.calls[0][0].data.closedAt).toBeInstanceOf(Date);
  });

  it('refuses a state the flow does not have', async () => {
    const prisma = noInstance();
    await expect(make(prisma).adopt(prisma as never, adoptInput('NOPE'))).rejects.toThrow(BadRequestException);
  });

  it('is idempotent: a document that already has an instance keeps it', async () => {
    const prisma = prismaWith(); // wfInstance.findFirst returns an existing instance
    const res = await make(prisma).adopt(prisma as never, adoptInput('APPROVED'));
    const db = prisma as never as Record<string, { create: jest.Mock }>;
    expect(db.wfInstance.create).not.toHaveBeenCalled();
    expect(res.id).toBe('wf1');
  });
});

describe('WorkflowEngine.transition — the system actor (expiry only)', () => {
  const system = { system: true as const, organizationId: 'org1' };
  const expire = (over: Record<string, unknown> = {}) =>
    transition({ actionCode: 'EXPIRE', toState: 'APPROVED', requiredPermission: 'scm.requisition.write', emitsEvent: 'proposal.expired', ...over });

  it('skips the permission check and records no actor in the history, the audit or the event', async () => {
    const prisma = prismaWith();
    (prisma as never as { wfTransition: { findUnique: jest.Mock } }).wfTransition.findUnique.mockResolvedValue(expire());
    const res = await make(prisma).transition(system, {
      documentType: 'PurchaseRequisition',
      documentId: 'pr1',
      actionCode: 'EXPIRE',
      comment: 'Expired automatically — validity passed',
    });
    expect(res.actionCode).toBe('EXPIRE');
    const db = prisma as never as Record<string, { create: jest.Mock }>;
    expect(db.wfHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ actorId: null, comment: 'Expired automatically — validity passed' }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ actorId: null, organizationId: 'org1', action: 'EXPIRE' }), expect.anything());
    expect(outbox.emit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: 'org1', payload: expect.objectContaining({ actorId: null }) }),
    );
  });

  it('is for expiry alone: any other action by the system is forbidden, and nothing is written', async () => {
    const prisma = prismaWith();
    (prisma as never as { wfTransition: { findUnique: jest.Mock } }).wfTransition.findUnique.mockResolvedValue(
      transition({ actionCode: 'APPROVE' }),
    );
    const apply = jest.fn();
    await expect(
      make(prisma).transition(system, {
        documentType: 'PurchaseRequisition',
        documentId: 'pr1',
        actionCode: 'APPROVE',
        apply,
      }),
    ).rejects.toThrow(ForbiddenException);
    expect(apply).not.toHaveBeenCalled();
  });

  it('still scopes the lookup to its organization', async () => {
    const prisma = prismaWith();
    (prisma as never as { wfTransition: { findUnique: jest.Mock } }).wfTransition.findUnique.mockResolvedValue(expire());
    await make(prisma).transition(system, { documentType: 'PurchaseRequisition', documentId: 'pr1', actionCode: 'EXPIRE' });
    const db = prisma as never as { wfInstance: { findFirst: jest.Mock } };
    expect(db.wfInstance.findFirst.mock.calls[0][0].where).toMatchObject({ organizationId: 'org1', documentId: 'pr1' });
  });
});
