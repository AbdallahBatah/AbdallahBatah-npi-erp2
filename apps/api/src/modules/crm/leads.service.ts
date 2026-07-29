import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NumberingService } from '../../common/numbering.service';
import { AuditService } from '../../common/audit.service';
import type { AuthUser } from '../../common/auth-user';
import { ConvertLeadDto, CreateLeadDto, UpdateLeadDto } from './dto';

@Injectable()
export class LeadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
  ) {}

  async list(
    user: AuthUser,
    status?: string,
    search?: string,
    take?: number,
    skip?: number,
  ) {
    const where = {
      organizationId: user.organizationId,
      ...(status ? { status: status as any } : {}),
      ...(search
        ? {
            OR: [
              { contactName: { contains: search, mode: 'insensitive' as const } },
              { companyName: { contains: search, mode: 'insensitive' as const } },
              { code: { contains: search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const query = {
      where,
      include: { customer: true, owner: { select: { id: true, nameAr: true, nameEn: true } } },
      orderBy: { createdAt: 'desc' as const },
    };
    // With `take`, return a paginated envelope; otherwise the legacy array.
    if (take !== undefined) {
      const [rows, total] = await Promise.all([
        this.prisma.lead.findMany({ ...query, take, skip: skip ?? 0 }),
        this.prisma.lead.count({ where }),
      ]);
      return { rows, total };
    }
    return this.prisma.lead.findMany(query);
  }

  async get(user: AuthUser, id: string) {
    const lead = await this.prisma.lead.findFirst({
      where: { id, organizationId: user.organizationId },
      include: { customer: true, convertedOpportunity: true },
    });
    if (!lead) throw new NotFoundException('Lead not found');
    return lead;
  }

  async create(user: AuthUser, dto: CreateLeadDto) {
    return this.prisma.$transaction(async (tx) => {
      const code = await this.numbering.next(user.organizationId, 'LEAD', tx);
      const created = await tx.lead.create({
        data: {
          organizationId: user.organizationId,
          code,
          contactName: dto.contactName,
          companyName: dto.companyName,
          source: dto.source ?? 'DIRECT',
          estimatedKwp: dto.estimatedKwp,
          phone: dto.phone,
          email: dto.email,
          notes: dto.notes,
          customerId: dto.customerId,
          ownerId: user.userId,
        },
      });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'Lead',
          entityId: created.id,
          action: 'CREATE',
          after: created,
        },
        tx,
      );
      return created;
    });
  }

  async update(user: AuthUser, id: string, dto: UpdateLeadDto) {
    const existing = await this.get(user, id);
    const updated = await this.prisma.lead.update({
      where: { id: existing.id },
      data: dto as any,
    });
    await this.audit.record({
      organizationId: user.organizationId,
      actorId: user.userId,
      entityType: 'Lead',
      entityId: id,
      action: 'UPDATE',
      before: existing,
      after: updated,
    });
    return updated;
  }

  /**
   * Convert a qualified lead into an opportunity. Creates a customer from the
   * lead when none is linked, sets the lead to CONVERTED, and links the two.
   */
  async convert(user: AuthUser, id: string, dto: ConvertLeadDto) {
    const lead = await this.get(user, id);
    if (lead.status === 'CONVERTED') {
      throw new BadRequestException('Lead is already converted');
    }

    return this.prisma.$transaction(async (tx) => {
      let customerId = dto.customerId ?? lead.customerId ?? undefined;

      if (!customerId) {
        const custCode = await this.numbering.next(user.organizationId, 'CUSTOMER', tx);
        const customer = await tx.customer.create({
          data: {
            organizationId: user.organizationId,
            code: custCode,
            nameAr: lead.companyName ?? lead.contactName,
            nameEn: lead.companyName ?? lead.contactName,
            customerType: 'CI',
            phone: lead.phone,
            email: lead.email,
          },
        });
        customerId = customer.id;
      }

      const oppCode = await this.numbering.next(user.organizationId, 'OPPORTUNITY', tx);
      const opportunity = await tx.opportunity.create({
        data: {
          organizationId: user.organizationId,
          code: oppCode,
          name: dto.opportunityName ?? `${lead.contactName} — ${lead.code}`,
          customerId,
          stage: 'PROSPECTING',
          estimatedKwp: lead.estimatedKwp,
          estimatedValue: dto.estimatedValue,
          ownerId: user.userId,
        },
      });

      const updatedLead = await tx.lead.update({
        where: { id: lead.id },
        data: {
          status: 'CONVERTED',
          customerId,
          convertedOpportunityId: opportunity.id,
        },
      });

      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'Lead',
          entityId: lead.id,
          action: 'CONVERT',
          before: lead,
          after: updatedLead,
        },
        tx,
      );

      return { lead: updatedLead, opportunity };
    });
  }
}
