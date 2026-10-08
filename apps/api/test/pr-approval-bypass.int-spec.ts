/**
 * T-00c — the purchase-requisition approval bypass, against a real PostgreSQL.
 *
 * `RequisitionsService.act()` used to route every action except SUBMIT
 * straight to `engine.transition()`, which checks only a static permission
 * (`scm.procurement.write`). That let any holder of it approve a requisition
 * while its signature chain (`ApprovalRequest`, status PENDING) was still
 * waiting on someone else, and let the requester approve their own request.
 *
 * This suite drives the real seeded matrix — the PURCHASE_REQUISITION band
 * (`minAmount: 10_000`, chain `['pm']`, see packages/db/prisma/seed.ts) —
 * through the real WorkflowEngine and ApprovalService, using the real seeded
 * users and their real role permissions. The point is to prove the fix
 * against the shipped configuration, not a hand-built stand-in for it.
 *
 * Not part of `npm test` — see jest.integration.config.js. The acceptance
 * gate runs `npm run test:int -- pr-approval-bypass`.
 */
import { ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { NumberingService } from '../src/common/numbering.service';
import { AuditService } from '../src/common/audit.service';
import { TaxService } from '../src/common/tax.service';
import { NotificationService } from '../src/common/notification.service';
import { DelegationService } from '../src/common/delegation.service';
import { ApprovalService } from '../src/common/approval.service';
import { OutboxService } from '../src/common/workflow/outbox.service';
import { WorkflowEngine } from '../src/common/workflow/workflow.engine';
import { EventDispatcher } from '../src/common/workflow/event-dispatcher.service';
import { RequisitionsService } from '../src/modules/procurement/requisitions.service';
import type { AuthUser } from '../src/common/auth-user';

const prisma = new PrismaService();
const audit = new AuditService(prisma);
const notifications = new NotificationService(prisma);
const numbering = new NumberingService(prisma);
const tax = new TaxService(prisma);
const delegations = new DelegationService(prisma);
const approvals = new ApprovalService(prisma, audit, notifications, delegations);
const outbox = new OutboxService(prisma);
const engine = new WorkflowEngine(prisma, audit, outbox);
const events = new EventDispatcher(prisma);
const requisitions = new RequisitionsService(
  prisma,
  numbering,
  audit,
  approvals,
  tax,
  notifications,
  engine,
  events,
);

/**
 * This suite writes real approval chains and workflow instances. It must
 * never be pointed at anything but a local throwaway database — same guard as
 * concurrency.int-spec.ts and tenant-isolation.int-spec.ts.
 */
function assertDisposableDatabase() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set — start the stack first (docker compose up -d postgres)',
    );
  }
  const host = new URL(url).hostname;
  if (!['localhost', '127.0.0.1', '::1', 'postgres'].includes(host)) {
    throw new Error(
      `Refusing to run destructive integration tests against host "${host}". ` +
        'Point DATABASE_URL at a local throwaway database.',
    );
  }
}

/**
 * A real `AuthUser`, assembled from a real seeded user row and their real
 * role's permission codes — never a hand-written permission list, so the test
 * proves the behaviour with the shipped configuration.
 */
async function authUserFor(email: string): Promise<AuthUser> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { email },
    include: { role: true },
  });
  return {
    userId: user.id,
    organizationId: user.organizationId,
    email: user.email,
    roleId: user.roleId,
    roleKey: user.role.key,
    roleIds: [user.roleId], // Step 1 added roleIds to AuthUser
    permissions: user.role.permissions,
    locale: 'EN',
  };
}

/**
 * accountant@npi.sa — holds both scm.requisition.write (can submit) and
 * scm.procurement.write (would pass the engine's bare permission check on
 * APPROVE). Deliberately NOT engineer@npi.sa: a site engineer never holds
 * scm.procurement.write at all, so using them as the requester would make the
 * self-approval case pass for the wrong reason (missing permission, not the
 * self-approval guard) and prove nothing about the actual defect.
 */
let REQUESTER: AuthUser;
/** admin@npi.sa — holds scm.procurement.write, but is not the chain's 'pm' step. */
let NON_STEP: AuthUser;
/** pm@npi.sa — the seeded chain's one step for PURCHASE_REQUISITION. */
let PM: AuthUser;
let itemId: string;

const createdPrIds: string[] = [];
const testStartedAt = new Date();

beforeAll(async () => {
  assertDisposableDatabase();
  // Registers the PURCHASE_REQUISITION applier/rejecter — approvals.decide()
  // throws without it (see ApprovalService.onApplicationBootstrap's guard,
  // which we deliberately do not call: it would demand every OTHER document
  // type's applier too, and nothing else is under test here).
  requisitions.onModuleInit();

  REQUESTER = await authUserFor('accountant@npi.sa');
  NON_STEP = await authUserFor('admin@npi.sa');
  PM = await authUserFor('pm@npi.sa');

  // Fail loudly here rather than produce a confusing assertion failure deep
  // in a test if the seed ever changes these roles' permissions.
  if (
    !REQUESTER.permissions.includes('scm.requisition.write') ||
    !REQUESTER.permissions.includes('scm.procurement.write')
  ) {
    throw new Error(
      'Fixture assumption broken: accountant@npi.sa must hold both scm.requisition.write ' +
        'and scm.procurement.write for the self-approval case to test the real guard',
    );
  }
  if (!NON_STEP.permissions.includes('scm.procurement.write') || NON_STEP.roleKey === 'pm') {
    throw new Error(
      'Fixture assumption broken: admin@npi.sa is not a valid non-step holder of scm.procurement.write',
    );
  }
  if (PM.roleKey !== 'pm') {
    throw new Error('Fixture assumption broken: pm@npi.sa is not in the pm role');
  }

  const item = await prisma.item.findFirstOrThrow({
    where: { organizationId: REQUESTER.organizationId, sku: 'INV-50K' },
    select: { id: true, unitCost: true },
  });
  itemId = item.id;
  if (Number(item.unitCost) * 2 < 10_000) {
    throw new Error(
      'Fixture assumption broken: 2x INV-50K no longer clears the PURCHASE_REQUISITION band',
    );
  }
});

afterAll(async () => {
  try {
    await prisma.approvalRequest.deleteMany({
      where: { documentType: 'PURCHASE_REQUISITION', documentId: { in: createdPrIds } },
    });
    await prisma.wfInstance.deleteMany({
      where: { documentType: 'PurchaseRequisition', documentId: { in: createdPrIds } },
    });
    await prisma.purchaseRequisition.deleteMany({ where: { id: { in: createdPrIds } } });
    await prisma.notification.deleteMany({
      where: {
        userId: { in: [REQUESTER.userId, NON_STEP.userId, PM.userId] },
        createdAt: { gte: testStartedAt },
      },
    });
  } catch (err) {
    // Best-effort: every assertion above has already run. Staying quiet here
    // would hide a real regression behind a green suite, so warn instead.
    console.warn('pr-approval-bypass cleanup failed:', err);
  }
  await prisma.$disconnect();
});

/** A fresh requisition, submitted, with its chain open and waiting on 'pm'. */
async function submittedRequisition(): Promise<string> {
  const pr = await requisitions.create(REQUESTER, {
    justification: 'T-00c approval-bypass fixture — solar inverters for site mobilisation',
    lines: [{ itemId, qty: 2 }],
  } as never);
  createdPrIds.push(pr.id);
  await requisitions.act(REQUESTER, pr.id, 'SUBMIT');
  return pr.id;
}

async function chainOf(prId: string) {
  return prisma.approvalRequest.findFirstOrThrow({
    where: { documentType: 'PURCHASE_REQUISITION', documentId: prId },
    include: { steps: { orderBy: { sequence: 'asc' } } },
  });
}

async function prOf(prId: string) {
  return prisma.purchaseRequisition.findUniqueOrThrow({ where: { id: prId } });
}

async function instanceOf(prId: string) {
  return prisma.wfInstance.findFirstOrThrow({
    where: { documentType: 'PurchaseRequisition', documentId: prId },
  });
}

describe('a purchase requisition cannot be approved outside its signature chain', () => {
  it('refuses a non-step user who holds scm.procurement.write but is not the chain step', async () => {
    const prId = await submittedRequisition();

    await expect(requisitions.act(NON_STEP, prId, 'APPROVE')).rejects.toThrow(
      ForbiddenException,
    );

    const pr = await prOf(prId);
    expect(pr.status).toBe('PENDING_APPROVAL');
    const chain = await chainOf(prId);
    expect(chain.status).toBe('PENDING');
    expect(chain.currentStep).toBe(1);
    const instance = await instanceOf(prId);
    expect(instance.currentState).toBe('PENDING_APPROVAL');
  });

  it('refuses the requester approving their own requisition', async () => {
    const prId = await submittedRequisition();

    await expect(requisitions.act(REQUESTER, prId, 'APPROVE')).rejects.toThrow(
      ForbiddenException,
    );

    const pr = await prOf(prId);
    expect(pr.status).toBe('PENDING_APPROVAL');
    const chain = await chainOf(prId);
    expect(chain.status).toBe('PENDING');
    expect(chain.currentStep).toBe(1);
    const instance = await instanceOf(prId);
    expect(instance.currentState).toBe('PENDING_APPROVAL');
  });

  it('lets the current step (pm) approve it — the positive control against over-blocking', async () => {
    const prId = await submittedRequisition();

    const result = await requisitions.act(PM, prId, 'APPROVE');
    expect(result.status).toBe('APPROVED');

    const pr = await prOf(prId);
    expect(pr.status).toBe('APPROVED');
    const chain = await chainOf(prId);
    expect(chain.status).toBe('APPROVED');
    expect(chain.closedAt).not.toBeNull();
    expect(chain.steps[0].decidedById).toBe(PM.userId);
  });
});
