import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NumberingService } from '../../common/numbering.service';
import { AuditService } from '../../common/audit.service';
import type { AuthUser } from '../../common/auth-user';
import { CreateOpportunityDto, UpdateOpportunityDto } from './dto';

@Injectable()
export class OpportunitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
  ) {}

  list(user: AuthUser, stage?: string) {
    return this.prisma.opportunity.findMany({
      where: {
        organizationId: user.organizationId,
        ...(stage ? { stage: stage as any } : {}),
      },
      include: {
        customer: { select: { id: true, nameAr: true, nameEn: true, code: true } },
        _count: { select: { proposals: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(user: AuthUser, id: string) {
    const opp = await this.prisma.opportunity.findFirst({
      where: { id, organizationId: user.organizationId },
      include: {
        customer: true,
        proposals: { include: { revisions: true } },
        designVersions: true,
      },
    });
    if (!opp) throw new NotFoundException('Opportunity not found');
    return opp;
  }

  async create(user: AuthUser, dto: CreateOpportunityDto) {
    // Ensure the customer belongs to this tenant.
    const customer = await this.prisma.customer.findFirst({
      where: { id: dto.customerId, organizationId: user.organizationId },
    });
    if (!customer) throw new NotFoundException('Customer not found');

    return this.prisma.$transaction(async (tx) => {
      const code = await this.numbering.next(user.organizationId, 'OPPORTUNITY', tx);
      const created = await tx.opportunity.create({
        data: {
          organizationId: user.organizationId,
          code,
          name: dto.name,
          customerId: dto.customerId,
          stage: dto.stage ?? 'PROSPECTING',
          estimatedKwp: dto.estimatedKwp,
          estimatedValue: dto.estimatedValue,
          expectedCloseDate: dto.expectedCloseDate ? new Date(dto.expectedCloseDate) : null,
          ownerId: user.userId,
        },
      });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'Opportunity',
          entityId: created.id,
          action: 'CREATE',
          after: created,
        },
        tx,
      );
      return created;
    });
  }

  async update(user: AuthUser, id: string, dto: UpdateOpportunityDto) {
    const existing = await this.get(user, id);
    const updated = await this.prisma.opportunity.update({
      where: { id: existing.id },
      data: {
        name: dto.name,
        stage: dto.stage as any,
        estimatedKwp: dto.estimatedKwp,
        estimatedValue: dto.estimatedValue,
        expectedCloseDate: dto.expectedCloseDate ? new Date(dto.expectedCloseDate) : undefined,
      },
    });
    await this.audit.record({
      organizationId: user.organizationId,
      actorId: user.userId,
      entityType: 'Opportunity',
      entityId: id,
      action: 'UPDATE',
      before: existing,
      after: updated,
    });
    return updated;
  }
}
