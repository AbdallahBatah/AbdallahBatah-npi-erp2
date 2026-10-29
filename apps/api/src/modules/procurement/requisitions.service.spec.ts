import { ForbiddenException } from '@nestjs/common';
import { RequisitionsService } from './requisitions.service';

/**
 * T-00c: `act()` used to route every action except SUBMIT straight to
 * `engine.transition()`, which only checks the caller's static permission
 * (`scm.procurement.write`). That let any holder of that permission approve a
 * requisition while its signature chain was still PENDING — the document
 * became APPROVED while the chain stayed open — and let the requester approve
 * their own request. These tests pin the fix: APPROVE must consult the open
 * chain (and refuse the requester) before it may ever reach the engine.
 */
describe('RequisitionsService.act — APPROVE bypass', () => {
  const PR = {
    id: 'pr1',
    code: 'PR-00001',
    estimatedTotal: 50_000 as unknown as never,
    departmentId: 'dept1',
    requestedById: 'requester-1',
  };

  function service(
    overrides: {
      forDocument?: jest.Mock;
      decide?: jest.Mock;
      transition?: jest.Mock;
      assertCan?: jest.Mock;
      pr?: typeof PR;
    } = {},
  ) {
    const prisma = {
      purchaseRequisition: {
        findFirst: jest.fn().mockResolvedValue(overrides.pr ?? PR),
      },
    };
    const approvals = {
      forDocument: overrides.forDocument ?? jest.fn().mockResolvedValue(null),
      decide: overrides.decide ?? jest.fn(),
    };
    const engine = {
      assertCan: overrides.assertCan ?? jest.fn().mockResolvedValue({ toState: 'APPROVED' }),
      transition:
        overrides.transition ??
        jest.fn().mockResolvedValue({
          instanceId: 'wf1',
          fromState: 'PENDING_APPROVAL',
          toState: 'APPROVED',
          actionCode: 'APPROVE',
          closed: false,
          eventId: null,
        }),
    };
    const svc = new RequisitionsService(
      prisma as never,
      undefined as never, // numbering
      undefined as never, // audit
      approvals as never,
      undefined as never, // tax
      undefined as never, // notifications
      engine as never,
      undefined as never, // events
      undefined as never, // outbox
    );
    return { svc, prisma, approvals, engine };
  }

  const requester = {
    userId: 'requester-1',
    organizationId: 'org1',
    roleId: 'role-req',
  } as never;
  const approver = { userId: 'approver-1', organizationId: 'org1', roleId: 'role-pm' } as never;

  it('rejects the requester approving their own requisition, without touching the engine or the matrix', async () => {
    const { svc, engine, approvals } = service();

    await expect(svc.act(requester, 'pr1', 'APPROVE')).rejects.toThrow(ForbiddenException);
    expect(engine.transition).not.toHaveBeenCalled();
    expect(engine.assertCan).not.toHaveBeenCalled();
    expect(approvals.decide).not.toHaveBeenCalled();
    expect(approvals.forDocument).not.toHaveBeenCalled();
  });

  it('routes to approvals.decide when an open PENDING chain exists, and never calls engine.transition directly', async () => {
    const chain = { id: 'chain1', status: 'PENDING' };
    const forDocument = jest.fn().mockResolvedValue(chain);
    const decide = jest
      .fn()
      .mockResolvedValue({ applied: true, request: { ...chain, status: 'APPROVED' } });
    const { svc, engine } = service({ forDocument, decide });

    await svc.act(approver, 'pr1', 'APPROVE', 'looks fine');

    expect(decide).toHaveBeenCalledWith(approver, 'chain1', 'APPROVE', 'looks fine');
    expect(engine.transition).not.toHaveBeenCalled();
  });

  it('propagates a ForbiddenException from decide unchanged (e.g. a non-step user)', async () => {
    const chain = { id: 'chain1', status: 'PENDING' };
    const forDocument = jest.fn().mockResolvedValue(chain);
    const decide = jest
      .fn()
      .mockRejectedValue(new ForbiddenException('Your role is not the approver at this step'));
    const { svc, engine } = service({ forDocument, decide });

    await expect(svc.act(approver, 'pr1', 'APPROVE')).rejects.toThrow(ForbiddenException);
    expect(engine.transition).not.toHaveBeenCalled();
  });

  it('returns PENDING_APPROVAL with the pending request when decide resolves applied:false', async () => {
    const chain = { id: 'chain1', status: 'PENDING' };
    const pendingRequest = { id: 'chain1', status: 'PENDING', currentStep: 2 };
    const forDocument = jest.fn().mockResolvedValue(chain);
    const decide = jest.fn().mockResolvedValue({ applied: false, request: pendingRequest });
    const { svc } = service({ forDocument, decide });

    const result = await svc.act(approver, 'pr1', 'APPROVE');

    expect(result).toMatchObject({
      status: 'PENDING_APPROVAL',
      applied: false,
      pendingApproval: pendingRequest,
    });
  });

  it('returns APPROVED with pendingApproval null when decide resolves applied:true', async () => {
    const chain = { id: 'chain1', status: 'PENDING' };
    const closedRequest = { id: 'chain1', status: 'APPROVED' };
    const forDocument = jest.fn().mockResolvedValue(chain);
    const decide = jest.fn().mockResolvedValue({ applied: true, request: closedRequest });
    const { svc } = service({ forDocument, decide });

    const result = await svc.act(approver, 'pr1', 'APPROVE');

    expect(result).toMatchObject({ status: 'APPROVED', applied: true, pendingApproval: null });
  });

  it.each([
    ['no chain at all', null],
    ['a closed APPROVED request', { id: 'chain0', status: 'APPROVED' }],
    ['a closed REJECTED request', { id: 'chain0', status: 'REJECTED' }],
  ])(
    'falls through to engine.transition when forDocument returns %s',
    async (_label, chainValue) => {
      const forDocument = jest.fn().mockResolvedValue(chainValue);
      const decide = jest.fn();
      const { svc, engine } = service({ forDocument, decide });

      const result = await svc.act(approver, 'pr1', 'APPROVE');

      expect(decide).not.toHaveBeenCalled();
      expect(engine.transition).toHaveBeenCalledTimes(1);
      expect(engine.transition.mock.calls[0][1]).toMatchObject({
        documentType: 'PurchaseRequisition',
        documentId: 'pr1',
        actionCode: 'APPROVE',
      });
      expect(result.status).toBe('APPROVED');
    },
  );

  it('still routes a non-APPROVE action (RETURN) straight to engine.transition, never consulting the matrix', async () => {
    const transition = jest.fn().mockResolvedValue({
      instanceId: 'wf1',
      fromState: 'PENDING_APPROVAL',
      toState: 'RETURNED',
      actionCode: 'RETURN',
      closed: false,
      eventId: null,
    });
    const { svc, engine, approvals } = service({ transition });

    const result = await svc.act(approver, 'pr1', 'RETURN', 'missing quote');

    expect(engine.transition).toHaveBeenCalledTimes(1);
    expect(engine.transition.mock.calls[0][1]).toMatchObject({ actionCode: 'RETURN' });
    expect(approvals.forDocument).not.toHaveBeenCalled();
    expect(approvals.decide).not.toHaveBeenCalled();
    expect(result.status).toBe('RETURNED');
  });
});
