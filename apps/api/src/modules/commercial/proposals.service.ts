import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NumberingService } from '../../common/numbering.service';
import { AuditService } from '../../common/audit.service';
import type { AuthUser } from '../../common/auth-user';
import { CreateProposalDto, CreateRevisionDto } from './dto';

@Injectable()
export class ProposalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
  ) {}

  list(user: AuthUser) {
    return this.prisma.proposal.findMany({
      where: { organizationId: user.organizationId },
      include: {
        opportunity: { select: { id: true, code: true, name: true } },
        revisions: { orderBy: { revisionNo: 'desc' }, take: 1 },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(user: AuthUser, id: string) {
    const proposal = await this.prisma.proposal.findFirst({
      where: { id, organizationId: user.organizationId },
      include: {
        opportunity: { include: { customer: true } },
        revisions: {
          orderBy: { revisionNo: 'asc' },
          include: {
            bomLines: { include: { item: true } },
            designVersion: true,
            pricingScheme: true,
          },
        },
      },
    });
    if (!proposal) throw new NotFoundException('Proposal not found');
    return proposal;
  }

  async create(user: AuthUser, dto: CreateProposalDto) {
    const opp = await this.prisma.opportunity.findFirst({
      where: { id: dto.opportunityId, organizationId: user.organizationId },
    });
    if (!opp) throw new NotFoundException('Opportunity not found');

    return this.prisma.$transaction(async (tx) => {
      const code = await this.numbering.next(user.organizationId, 'PROPOSAL', tx);
      const created = await tx.proposal.create({
        data: {
          organizationId: user.organizationId,
          code,
          opportunityId: dto.opportunityId,
          currency: dto.currency ?? 'SAR',
          status: 'DRAFT',
        },
      });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'Proposal',
          entityId: created.id,
          action: 'CREATE',
          after: created,
        },
        tx,
      );
      return created;
    });
  }

  /**
   * Add a new revision: prices the BOM, applies the pricing-scheme margin,
   * optionally records the imported design version, and stores the totals.
   */
  async addRevision(user: AuthUser, proposalId: string, dto: CreateRevisionDto) {
    const proposal = await this.prisma.proposal.findFirst({
      where: { id: proposalId, organizationId: user.organizationId },
      include: { opportunity: true },
    });
    if (!proposal) throw new NotFoundException('Proposal not found');

    // Validate all BOM items belong to this tenant.
    const itemIds = dto.bomLines.map((l) => l.itemId);
    const items = await this.prisma.item.findMany({
      where: { id: { in: itemIds }, organizationId: user.organizationId },
      select: { id: true },
    });
    if (items.length !== new Set(itemIds).size) {
      throw new BadRequestException('One or more BOM items are invalid for this tenant');
    }

    // Resolve the margin: explicit override wins, else the pricing scheme's.
    let marginPct = dto.marginPct ?? 0;
    if (dto.pricingSchemeId) {
      const scheme = await this.prisma.pricingScheme.findFirst({
        where: { id: dto.pricingSchemeId, organizationId: user.organizationId },
      });
      if (!scheme) throw new NotFoundException('Pricing scheme not found');
      if (dto.marginPct === undefined) marginPct = Number(scheme.marginPct);
    }

    const subtotal = dto.bomLines.reduce((sum, l) => sum + l.qty * l.unitPrice, 0);
    const marginAmount = +(subtotal * (marginPct / 100)).toFixed(2);
    const totalAmount = +(subtotal + marginAmount).toFixed(2);

    return this.prisma.$transaction(async (tx) => {
      const lastRev = await tx.proposalRevision.findFirst({
        where: { proposalId },
        orderBy: { revisionNo: 'desc' },
      });
      const revisionNo = (lastRev?.revisionNo ?? 0) + 1;

      let designVersionId: string | undefined;
      if (dto.designVersion) {
        const dv = await tx.designVersion.create({
          data: {
            organizationId: user.organizationId,
            opportunityId: proposal.opportunityId,
            sourceTool: dto.designVersion.sourceTool ?? 'manual',
            externalRef: dto.designVersion.externalRef,
            versionNo: revisionNo,
            capacityKwp: dto.designVersion.capacityKwp ?? 0,
            expectedAnnualKwh: dto.designVersion.expectedAnnualKwh ?? 0,
          },
        });
        designVersionId = dv.id;
      }

      const revision = await tx.proposalRevision.create({
        data: {
          proposalId,
          revisionNo,
          designVersionId,
          pricingSchemeId: dto.pricingSchemeId,
          subtotal,
          marginAmount,
          totalAmount,
          status: 'DRAFT',
          bomLines: {
            create: dto.bomLines.map((l) => ({
              itemId: l.itemId,
              qty: l.qty,
              unitPrice: l.unitPrice,
              isAdder: l.isAdder ?? false,
              lineTotal: +(l.qty * l.unitPrice).toFixed(2),
            })),
          },
        },
        include: { bomLines: true },
      });

      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'ProposalRevision',
          entityId: revision.id,
          action: 'CREATE',
          after: { revisionNo, subtotal, marginAmount, totalAmount },
        },
        tx,
      );

      return revision;
    });
  }

  /** Mark a revision as the winning one and accept the proposal. */
  async acceptRevision(user: AuthUser, proposalId: string, revisionId: string) {
    const revision = await this.prisma.proposalRevision.findFirst({
      where: { id: revisionId, proposalId, proposal: { organizationId: user.organizationId } },
    });
    if (!revision) throw new NotFoundException('Proposal revision not found');

    return this.prisma.$transaction(async (tx) => {
      await tx.proposalRevision.updateMany({
        where: { proposalId },
        data: { isWinning: false },
      });
      const winning = await tx.proposalRevision.update({
        where: { id: revisionId },
        data: { isWinning: true, status: 'ACCEPTED' },
      });
      await tx.proposal.update({
        where: { id: proposalId },
        data: { status: 'ACCEPTED' },
      });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'ProposalRevision',
          entityId: revisionId,
          action: 'ACCEPT',
          after: winning,
        },
        tx,
      );
      return winning;
    });
  }
}
