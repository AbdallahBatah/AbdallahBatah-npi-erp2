/**
 * Shared wiring for the integration specs that touch proposals: the real kernel
 * (numbering, audit, matrix, workflow engine, outbox), the real services, built by
 * hand the way the other `*.int-spec.ts` files do. Not a spec itself (the Jest
 * integration config only matches `*.int-spec.ts`).
 */
import { PrismaService } from '../../src/prisma/prisma.service';
import { NumberingService } from '../../src/common/numbering.service';
import { AuditService } from '../../src/common/audit.service';
import { NotificationService } from '../../src/common/notification.service';
import { DelegationService } from '../../src/common/delegation.service';
import { EffectivePermissionsService } from '../../src/common/effective-permissions.service';
import { ApprovalService } from '../../src/common/approval.service';
import { OrgSettingsService } from '../../src/common/org-settings.service';
import { OutboxService } from '../../src/common/workflow/outbox.service';
import { WorkflowEngine } from '../../src/common/workflow/workflow.engine';
import { OpportunitiesService } from '../../src/modules/crm/opportunities.service';
import { ItemCostService } from '../../src/modules/commercial/item-cost.service';
import { ProposalsService } from '../../src/modules/commercial/proposals.service';
import { ProposalExpiryScheduler } from '../../src/modules/commercial/proposal-expiry.scheduler';
import { ContractsService } from '../../src/modules/commercial/contracts.service';
import type { AuthUser } from '../../src/common/auth-user';

export function buildProposalStack(prisma: PrismaService) {
  const numbering = new NumberingService(prisma);
  const audit = new AuditService(prisma);
  const notifications = new NotificationService(prisma);
  const delegations = new DelegationService(prisma);
  const approvals = new ApprovalService(prisma, audit, notifications, delegations, new EffectivePermissionsService(prisma));
  const outbox = new OutboxService(prisma);
  const engine = new WorkflowEngine(prisma, audit, outbox);
  const settings = new OrgSettingsService(prisma, audit);
  const opportunities = new OpportunitiesService(prisma, numbering, audit, outbox);
  const itemCosts = new ItemCostService(prisma);
  const proposals = new ProposalsService(prisma, numbering, audit, opportunities, engine, approvals, itemCosts, settings);
  // What Nest does on start: hand the matrix the proposal's applier and rejecter.
  proposals.onModuleInit();
  const contracts = new ContractsService(prisma, numbering, audit, notifications, opportunities);
  const expiry = new ProposalExpiryScheduler(prisma, proposals);
  return { numbering, audit, notifications, approvals, outbox, engine, settings, opportunities, itemCosts, proposals, contracts, expiry };
}

/** A real `AuthUser` from a real seeded user and their real role's permissions. */
export async function authUserFor(prisma: PrismaService, email: string): Promise<AuthUser> {
  const user = await prisma.user.findUniqueOrThrow({ where: { email }, include: { role: true, extraRoles: true } });
  return {
    userId: user.id,
    organizationId: user.organizationId,
    email: user.email,
    roleId: user.roleId,
    roleKey: user.role.key,
    roleIds: [user.roleId, ...user.extraRoles.map((r) => r.roleId)],
    permissions: user.role.permissions,
    locale: 'EN',
  };
}

/**
 * A fresh organization has no workflow definitions (the migration and the seed
 * write them for the organizations that exist). Copy the seeded PROPOSAL flow
 * into `toOrgId` so `proposals.create` can open its instance there.
 */
export async function cloneProposalFlow(prisma: PrismaService, toOrgId: string): Promise<void> {
  const source = await prisma.wfDefinition.findFirstOrThrow({
    where: { code: 'PROPOSAL', isActive: true, organizationId: { not: toOrgId } },
    include: { states: true, transitions: true },
  });
  const def = await prisma.wfDefinition.create({
    data: {
      organizationId: toOrgId, code: source.code, nameAr: source.nameAr, nameEn: source.nameEn,
      documentType: source.documentType, version: source.version,
    },
  });
  await prisma.wfState.createMany({
    data: source.states.map((s) => ({
      definitionId: def.id, code: s.code, nameAr: s.nameAr, nameEn: s.nameEn, kind: s.kind, sortOrder: s.sortOrder,
    })),
  });
  await prisma.wfTransition.createMany({
    data: source.transitions.map((t) => ({
      definitionId: def.id, fromState: t.fromState, toState: t.toState, actionCode: t.actionCode, nameAr: t.nameAr,
      nameEn: t.nameEn, requiredPermission: t.requiredPermission, conditionExpr: t.conditionExpr,
      emitsEvent: t.emitsEvent, requiresApproval: t.requiresApproval, sortOrder: t.sortOrder,
    })),
  });
}
