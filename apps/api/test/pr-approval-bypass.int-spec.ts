/**
 * T-00c — the purchase-requisition approval bypass, against a real PostgreSQL.
 *
 * `RequisitionsService.act()` used to route every action except SUBMIT
 * straight to `engine.transition()`, which checks only a static permission
 * (`scm.procurement.write`). That let any holder of it approve a requisition
 * while its signature chain (`ApprovalRequest`, status PENDING) was still
 * waiting on someone else, and let the requester approve their own request.
 *
 * This suite drives the real seeded matrix — the PURCHASE_REQUISITION rule
 * (from 0 SAR, chain `['pm']`: PROPOSED_APPROVAL_RULES, which
 * packages/db/prisma/seed.ts writes since P1-13) — through the real
 * WorkflowEngine and ApprovalService, using the real seeded
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
import { EffectivePermissionsService } from '../src/common/effective-permissions.service';
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
const approvals = new ApprovalService(prisma, audit, notifications, delegations, new EffectivePermissionsService(prisma));
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
  outbox,
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
 * admin@npi.sa — holds scm.requisition.write (can submit) and every approve
 * key (would pass the engine's bare permission check on APPROVE), and is not
 * the chain's 'pm' step. Since P1-13 the company's seven roles are the seed's
 * default and none of them both raises a requisition and holds
 * scm.procurement.write, so the administrator is the requester. Deliberately
 * NOT engineer@npi.sa: a site engineer holds no procurement key at all, so
 * using them as the requester would make the self-approval case pass for the
 * wrong reason (missing permission, not the self-approval guard) and prove
 * nothing about the actual defect.
 */
let REQUESTER: AuthUser;
/**
 * ceo@npi.sa (the executive) — holds scm.procurement.approve, the APPROVE
 * transition's key, but is not the chain's *current* step while it waits on
 * 'pm'. Since P4-4 the executive is the chain's last step.
 */
let NON_STEP: AuthUser;
/** pm@npi.sa — the seeded chain's first step for PURCHASE_REQUISITION. */
let PM: AuthUser;
/** finance@npi.sa — P4-4: the seeded chain's second step (pm → finance_manager → executive). */
let FINANCE: AuthUser;
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

  REQUESTER = await authUserFor('admin@npi.sa');
  NON_STEP = await authUserFor('ceo@npi.sa');
  PM = await authUserFor('pm@npi.sa');
  FINANCE = await authUserFor('finance@npi.sa');

  // Fail loudly here rather than produce a confusing assertion failure deep
  // in a test if the seed ever changes these roles' permissions.
  if (
    !REQUESTER.permissions.includes('scm.requisition.write') ||
    !REQUESTER.permissions.includes('scm.procurement.approve') ||
    REQUESTER.roleKey === 'pm'
  ) {
    throw new Error(
      'Fixture assumption broken: admin@npi.sa must hold scm.requisition.write and ' +
        'scm.procurement.approve outside the pm role for the self-approval case to test the real guard',
    );
  }
  if (!NON_STEP.permissions.includes('scm.procurement.approve') || NON_STEP.roleKey === 'pm') {
    throw new Error(
      'Fixture assumption broken: ceo@npi.sa is not a valid non-step holder of scm.procurement.approve',
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
  const band = await prisma.approvalRule.findFirstOrThrow({
    where: { organizationId: REQUESTER.organizationId, documentType: 'PURCHASE_REQUISITION', isActive: true },
    orderBy: { minAmount: 'asc' },
    select: { minAmount: true },
  });
  if (Number(item.unitCost) * 2 < Number(band.minAmount)) {
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
        userId: { in: [REQUESTER.userId, NON_STEP.userId, PM.userId, FINANCE.userId] },
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
  it('refuses a non-step user who holds scm.procurement.approve but is not the chain step', async () => {
    const prId = await submittedRequisition();

    const refused = requisitions.act(NON_STEP, prId, 'APPROVE');
    await expect(refused).rejects.toThrow(ForbiddenException);
    await expect(refused).rejects.toThrow('Your role is not the approver at this step');

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

    const refused = requisitions.act(REQUESTER, prId, 'APPROVE');
    await expect(refused).rejects.toThrow(ForbiddenException);
    await expect(refused).rejects.toThrow('You cannot approve a requisition you raised yourself');

    const pr = await prOf(prId);
    expect(pr.status).toBe('PENDING_APPROVAL');
    const chain = await chainOf(prId);
    expect(chain.status).toBe('PENDING');
    expect(chain.currentStep).toBe(1);
    const instance = await instanceOf(prId);
    expect(instance.currentState).toBe('PENDING_APPROVAL');
  });

  it('lets each current step sign in turn (pm → finance → executive) — the positive control against over-blocking', async () => {
    const prId = await submittedRequisition();

    const first = await requisitions.act(PM, prId, 'APPROVE');
    expect(first.status).toBe('PENDING_APPROVAL');
    expect((await chainOf(prId)).currentStep).toBe(2);
    // The executive signs last, never ahead of finance.
    await expect(requisitions.act(NON_STEP, prId, 'APPROVE')).rejects.toThrow(ForbiddenException);
    const second = await requisitions.act(FINANCE, prId, 'APPROVE');
    expect(second.status).toBe('PENDING_APPROVAL');
    expect((await chainOf(prId)).currentStep).toBe(3);

    // Unsourced (no vendor), so the last signature leaves it APPROVED for manual conversion.
    const result = await requisitions.act(NON_STEP, prId, 'APPROVE');
    expect(result.status).toBe('APPROVED');

    const pr = await prOf(prId);
    expect(pr.status).toBe('APPROVED');
    const chain = await chainOf(prId);
    expect(chain.status).toBe('APPROVED');
    expect(chain.closedAt).not.toBeNull();
    expect(chain.steps[0].decidedById).toBe(PM.userId);
  });
});
