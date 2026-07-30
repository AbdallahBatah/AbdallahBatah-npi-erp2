import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NumberingService } from '../../common/numbering.service';
import { AuditService } from '../../common/audit.service';
import { NotificationService } from '../../common/notification.service';
import type { AuthUser } from '../../common/auth-user';
import { CreateContractDto } from './dto';

@Injectable()
export class ContractsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  list(user: AuthUser) {
    return this.prisma.contract.findMany({
      where: { organizationId: user.organizationId },
      include: {
        customer: { select: { id: true, code: true, nameAr: true, nameEn: true } },
        _count: { select: { milestones: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(user: AuthUser, id: string) {
    const contract = await this.prisma.contract.findFirst({
      where: { id, organizationId: user.organizationId },
      include: {
        customer: true,
        opportunity: { select: { id: true, code: true, name: true } },
        proposalRevision: true,
        milestones: { orderBy: { sequence: 'asc' } },
      },
    });
    if (!contract) throw new NotFoundException('Contract not found');
    return contract;
  }

  /**
   * Create a contract. When a winning proposal revision is supplied, the
   * customer, opportunity, proposal and total value are inherited from it and
   * the source opportunity is moved to WON — the "lead → contract" chain closes.
   */
  async create(user: AuthUser, dto: CreateContractDto) {
    let customerId = dto.customerId;
    let opportunityId: string | undefined;
    let proposalId: string | undefined;
    let totalValue = dto.totalValue ?? 0;

    if (dto.proposalRevisionId) {
      const revision = await this.prisma.proposalRevision.findFirst({
        where: {
          id: dto.proposalRevisionId,
          proposal: { organizationId: user.organizationId },
        },
        include: { proposal: { include: { opportunity: true } }, contract: true },
      });
      if (!revision) throw new NotFoundException('Proposal revision not found');
      if (revision.contract) {
        throw new BadRequestException('This proposal revision already has a contract');
      }
      customerId = revision.proposal.opportunity.customerId;
      opportunityId = revision.proposal.opportunityId;
      proposalId = revision.proposalId;
      if (dto.totalValue === undefined) totalValue = Number(revision.totalAmount);
    }

    if (!customerId) {
      throw new BadRequestException('customerId or proposalRevisionId is required');
    }

    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, organizationId: user.organizationId },
    });
    if (!customer) throw new NotFoundException('Customer not found');

    return this.prisma.$transaction(async (tx) => {
      const code = await this.numbering.next(user.organizationId, 'CONTRACT', tx);
      const contract = await tx.contract.create({
        data: {
          organizationId: user.organizationId,
          code,
          customerId: customerId!,
          opportunityId,
          proposalId,
          proposalRevisionId: dto.proposalRevisionId,
          contractType: dto.contractType,
          status: 'DRAFT',
          startDate: dto.startDate ? new Date(dto.startDate) : null,
          endDate: dto.endDate ? new Date(dto.endDate) : null,
          totalValue,
          retentionPct: dto.retentionPct ?? 0,
          advancePct: dto.advancePct ?? 0,
          milestones: dto.milestones
            ? {
                create: dto.milestones.map((m) => ({
                  sequence: m.sequence,
                  descriptionAr: m.descriptionAr,
                  descriptionEn: m.descriptionEn,
                  triggerType: m.triggerType ?? 'PROGRESS',
                  amount: m.amount,
                  dueDate: m.dueDate ? new Date(m.dueDate) : null,
                })),
              }
            : undefined,
        },
        include: { milestones: true },
      });

      if (opportunityId) {
        await tx.opportunity.update({
          where: { id: opportunityId },
          data: { stage: 'WON' },
        });
      }

      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'Contract',
          entityId: contract.id,
          action: 'CREATE',
          after: contract,
        },
        tx,
      );

      return contract;
    });
  }

  async activate(user: AuthUser, id: string) {
    const contract = await this.get(user, id);
    if (contract.status !== 'DRAFT') {
      throw new BadRequestException('Only draft contracts can be activated');
    }
    const updated = await this.prisma.contract.update({
      where: { id: contract.id },
      data: { status: 'ACTIVE' },
    });
    await this.audit.record({
      organizationId: user.organizationId,
      actorId: user.userId,
      entityType: 'Contract',
      entityId: id,
      action: 'ACTIVATE',
      before: contract,
      after: updated,
    });
    return updated;
  }

  /**
   * Verify a milestone. This is the seam where milestone-triggered ZATCA
   * invoicing (FIN-04) hooks in during W3 — today it records verification only.
   */
  async verifyMilestone(user: AuthUser, contractId: string, milestoneId: string) {
    const milestone = await this.prisma.contractMilestone.findFirst({
      where: {
        id: milestoneId,
        contractId,
        contract: { organizationId: user.organizationId },
      },
    });
    if (!milestone) throw new NotFoundException('Milestone not found');
    if (milestone.status !== 'PENDING') {
      throw new BadRequestException('Milestone is not pending');
    }

    const updated = await this.prisma.contractMilestone.update({
      where: { id: milestoneId },
      data: {
        status: 'VERIFIED',
        verifiedAt: new Date(),
        verifiedById: user.userId,
      },
    });
    await this.audit.record({
      organizationId: user.organizationId,
      actorId: user.userId,
      entityType: 'ContractMilestone',
      entityId: milestoneId,
      action: 'VERIFY',
      before: milestone,
      after: updated,
    });
    // The people who can invoice are the ones who need to hear a milestone
    // just became billable.
    const contract = await this.prisma.contract.findUnique({
      where: { id: contractId },
      select: { code: true },
    });
    await this.notifications.notify({
      organizationId: user.organizationId,
      permission: 'finance.invoice.write',
      excludeUserId: user.userId,
      type: 'MILESTONE_VERIFIED',
      titleAr: `مرحلة معتمدة في العقد ${contract?.code ?? ''} — جاهزة للفوترة`,
      titleEn: `Milestone verified on ${contract?.code ?? ''} — ready to invoice`,
      bodyAr: milestone.descriptionAr,
      bodyEn: milestone.descriptionEn,
      linkPath: `/contracts/${contractId}`,
    });
    return updated;
  }
}
