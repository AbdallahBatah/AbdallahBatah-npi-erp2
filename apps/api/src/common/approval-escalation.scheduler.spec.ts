import { ApprovalEscalationScheduler } from './approval-escalation.scheduler';

const HOUR = 3_600_000;

const request = (over: Record<string, unknown> = {}) => ({
  id: 'req1',
  organizationId: 'org1',
  documentType: 'PURCHASE_ORDER',
  documentCode: 'PO-00042',
  status: 'PENDING',
  currentStep: 1,
  currentStepAt: new Date(Date.now() - 72 * HOUR),
  raisedById: 'u-raiser',
  rule: { escalationHours: 48 },
  steps: [
    { id: 's1', sequence: 1, roleId: 'role-fin', status: 'PENDING', escalatedAt: null },
    { id: 's2', sequence: 2, roleId: 'role-ceo', status: 'PENDING', escalatedAt: null },
  ],
  ...over,
});

const prismaWith = (rows: Array<Record<string, unknown>>) => ({
  approvalRequest: { findMany: jest.fn().mockResolvedValue(rows) },
  approvalStep: { update: jest.fn().mockResolvedValue({}) },
});

const notifications = { notifyBestEffort: jest.fn().mockResolvedValue(1) };

const make = (prisma: unknown) =>
  new ApprovalEscalationScheduler(prisma as never, notifications as never);

beforeEach(() => jest.clearAllMocks());

describe('automatic escalation — §5, التصعيد الآلي', () => {
  it('escalates a step that has waited past its window', async () => {
    const prisma = prismaWith([request()]);
    await expect(make(prisma).sweep()).resolves.toBe(1);

    expect(prisma.approvalStep.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 's1' },
        data: { escalatedAt: expect.any(Date) },
      }),
    );
  });

  it('does not escalate before the window has passed', async () => {
    const prisma = prismaWith([
      request({ currentStepAt: new Date(Date.now() - 47 * HOUR) }),
    ]);
    await expect(make(prisma).sweep()).resolves.toBe(0);
    expect(prisma.approvalStep.update).not.toHaveBeenCalled();
    expect(notifications.notifyBestEffort).not.toHaveBeenCalled();
  });

  it('measures from when the step became current, not when the chain opened', async () => {
    // A chain whose first step was signed promptly must give the second
    // approver their own full window — otherwise step two escalates the
    // instant it opens on any chain that took a while to reach it.
    const prisma = prismaWith([
      request({
        currentStep: 2,
        currentStepAt: new Date(Date.now() - 2 * HOUR),
        steps: [
          { id: 's1', sequence: 1, roleId: 'role-fin', status: 'APPROVED', escalatedAt: null },
          { id: 's2', sequence: 2, roleId: 'role-ceo', status: 'PENDING', escalatedAt: null },
        ],
      }),
    ]);
    await expect(make(prisma).sweep()).resolves.toBe(0);
  });

  it('escalates only once, however long the step then sits', async () => {
    // An escalation that repeats every hour is spam, and spam is how a real
    // escalation ends up ignored.
    const prisma = prismaWith([
      request({
        steps: [
          {
            id: 's1',
            sequence: 1,
            roleId: 'role-fin',
            status: 'PENDING',
            escalatedAt: new Date(Date.now() - 10 * HOUR),
          },
        ],
      }),
    ]);
    await expect(make(prisma).sweep()).resolves.toBe(0);
    expect(notifications.notifyBestEffort).not.toHaveBeenCalled();
  });

  it('ignores a chain whose rule sets no window', async () => {
    const prisma = prismaWith([request({ rule: { escalationHours: null } })]);
    await expect(make(prisma).sweep()).resolves.toBe(0);
  });

  it('ignores a chain whose rule was deleted rather than inventing a deadline', async () => {
    const prisma = prismaWith([request({ rule: null })]);
    await expect(make(prisma).sweep()).resolves.toBe(0);
  });

  it('ignores a zero or negative window instead of escalating everything at once', async () => {
    const prisma = prismaWith([request({ rule: { escalationHours: 0 } })]);
    await expect(make(prisma).sweep()).resolves.toBe(0);
  });

  it('never signs, skips or advances the chain — it only notifies', async () => {
    // The control this preserves: an escalation that approves things by itself
    // when nobody is looking is a delay before an automatic yes, and would make
    // "the CEO approved this" a claim the audit trail cannot support.
    const prisma = prismaWith([request()]) as ReturnType<typeof prismaWith> &
      Record<string, unknown>;
    await make(prisma).sweep();

    // Nothing but the escalation stamp was written.
    expect(prisma.approvalStep.update).toHaveBeenCalledTimes(1);
    expect(prisma.approvalStep.update.mock.calls[0][0].data).toEqual({
      escalatedAt: expect.any(Date),
    });
    expect(prisma).not.toHaveProperty('approvalRequest.update');
  });

  it('tells the approver and the administrators, and not the person who raised it', async () => {
    const prisma = prismaWith([request()]);
    await make(prisma).sweep();

    expect(notifications.notifyBestEffort).toHaveBeenCalledTimes(2);
    const [approverCall, adminCall] = notifications.notifyBestEffort.mock.calls.map((c) => c[0]);

    // The role that owes the signature — narrowed, not fanned out to everyone
    // who can read purchase orders.
    expect(approverCall).toMatchObject({
      roleId: 'role-fin',
      excludeUserId: 'u-raiser',
      type: 'APPROVAL_ESCALATED',
    });
    // And the people who can unstick it: reassign, delegate, or reconfigure.
    expect(adminCall).toMatchObject({ permission: 'admin.approval.manage' });
    expect(adminCall.bodyAr).toMatch(/تفويض/);
  });

  it('stamps the step before notifying, so a broken bell cannot re-fire it hourly', async () => {
    const prisma = prismaWith([request()]);
    notifications.notifyBestEffort.mockRejectedValueOnce(new Error('smtp down'));
    // notifyBestEffort swallows its own failures in production; here we assert
    // the ordering that makes that safe.
    await expect(make(prisma).sweep()).rejects.toThrow('smtp down');
    expect(prisma.approvalStep.update).toHaveBeenCalledTimes(1);
  });

  it('sweeps several chains and counts them', async () => {
    const prisma = prismaWith([
      request({ id: 'r1' }),
      request({ id: 'r2', steps: [{ id: 's9', sequence: 1, roleId: 'role-fin', status: 'PENDING', escalatedAt: null }] }),
      request({ id: 'r3', currentStepAt: new Date() }),
    ]);
    await expect(make(prisma).sweep()).resolves.toBe(2);
  });
});
