import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PERMISSIONS, normalizeArabicName, normalizeSaudiMobile } from '@npi/shared';
import type { Prisma } from '@npi/db';
import { PrismaService } from '../../prisma/prisma.service';
import { NumberingService } from '../../common/numbering.service';
import { AuditService } from '../../common/audit.service';
import type { AuthUser } from '../../common/auth-user';
import { CustomersService } from './customers.service';
import { ConvertLeadDto, CreateLeadDto, SetLeadStatusDto, UpdateLeadDto } from './dto';

@Injectable()
export class LeadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly customers: CustomersService,
  ) {}

  /**
   * A customer id coming from a request body must belong to the caller's
   * organization (404 otherwise, exactly like opportunities.create) and must not
   * be a duplicate that was already merged away (409).
   */
  private async assertCustomerUsable(
    organizationId: string,
    customerId: string,
    tx?: Prisma.TransactionClient,
  ) {
    const customer = await (tx ?? this.prisma).customer.findFirst({
      where: { id: customerId, organizationId },
      select: { id: true, mergedIntoId: true },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    if (customer.mergedIntoId) throw new ConflictException('Customer already merged');
  }

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
      include: {
        customer: true,
        owner: { select: { id: true, nameAr: true, nameEn: true } },
        rejectionReason: { select: { id: true, nameAr: true, nameEn: true } },
      },
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
      include: {
        customer: true,
        convertedOpportunity: true,
        rejectionReason: { select: { id: true, nameAr: true, nameEn: true } },
      },
    });
    if (!lead) throw new NotFoundException('Lead not found');
    return lead;
  }

  create(user: AuthUser, dto: CreateLeadDto) {
    return this.prisma.$transaction(async (tx) => {
      if (dto.customerId) await this.assertCustomerUsable(user.organizationId, dto.customerId, tx);
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
          address: dto.address,
          siteLocation: dto.siteLocation,
          siteLat: dto.siteLat,
          siteLng: dto.siteLng,
          status: 'NEGOTIATING',
          statusChangedAt: new Date(),
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
    if (dto.customerId) await this.assertCustomerUsable(user.organizationId, dto.customerId);
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
    if (lead.status === 'ACCEPTED') {
      throw new BadRequestException('Lead is already converted');
    }
    if (lead.status === 'REJECTED') {
      throw new ConflictException('Lead is rejected — reopen the negotiation first');
    }
    // Step 3: a tender opportunity always has its close date, however it is born.
    const opportunityType = dto.opportunityType ?? 'DIRECT';
    const tenderCloseDate = dto.tenderCloseDate ? new Date(dto.tenderCloseDate) : null;
    if (opportunityType === 'TENDER' && (!tenderCloseDate || Number.isNaN(tenderCloseDate.getTime()))) {
      throw new BadRequestException('Tender close date is required');
    }

    return this.prisma.$transaction(async (tx) => {
      let customerId = dto.customerId ?? lead.customerId ?? undefined;

      if (dto.customerId) await this.assertCustomerUsable(user.organizationId, dto.customerId, tx);

      if (!customerId) {
        // A customer born from a lead goes through the same duplicate check as
        // one typed in by hand: when the lead's CR / VAT / mobile already
        // belongs to someone, the user gets the 409 and picks that customer
        // (passing its id as `customerId`) instead of creating a twin.
        // The mandatory-key rule of `CustomersService.create` is NOT applied
        // here — a lead often has no CR or VAT yet, and refusing to convert it
        // would stall the pipeline; the customer page flags the missing key.
        const keys = this.customers.normalizeKeys({
          crNumber: dto.crNumber ?? null,
          vatNumber: dto.vatNumber ?? null,
          mobile: dto.mobile ?? normalizeSaudiMobile(lead.phone),
        });
        await this.customers.assertNoDuplicateKeys(tx, user.organizationId, keys);
        const name = lead.companyName ?? lead.contactName;
        const custCode = await this.numbering.next(user.organizationId, 'CUSTOMER', tx);
        const createdCustomer = await tx.customer.create({
          data: {
            organizationId: user.organizationId,
            code: custCode,
            nameAr: name,
            nameEn: name,
            nameNormalized: normalizeArabicName(name),
            entityKind: lead.companyName ? 'COMPANY' : 'INDIVIDUAL',
            customerType: 'CI',
            crNumber: keys.crNumber,
            vatNumber: keys.vatNumber,
            mobile: keys.mobile,
            phone: lead.phone,
            email: lead.email,
          },
        });
        customerId = createdCustomer.id;
        await this.audit.record(
          {
            organizationId: user.organizationId,
            actorId: user.userId,
            entityType: 'Customer',
            entityId: createdCustomer.id,
            action: 'CREATE',
            after: createdCustomer,
          },
          tx,
        );
      }

      const oppCode = await this.numbering.next(user.organizationId, 'OPPORTUNITY', tx);
      const opportunity = await tx.opportunity.create({
        data: {
          organizationId: user.organizationId,
          code: oppCode,
          name: dto.opportunityName ?? `${lead.contactName} — ${lead.code}`,
          customerId,
          stage: 'PROSPECTING',
          stageChangedAt: new Date(),
          opportunityType,
          tenderCloseDate: opportunityType === 'TENDER' ? tenderCloseDate : null,
          estimatedKwp: lead.estimatedKwp,
          estimatedValue: dto.estimatedValue,
          ownerId: user.userId,
        },
      });

      const updatedLead = await tx.lead.update({
        where: { id: lead.id },
        data: {
          // P3-1: acceptance and conversion are one step (owner work cycle step 3).
          status: 'ACCEPTED',
          statusChangedAt: new Date(),
          rejectionReasonId: null,
          rejectionNotes: null,
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

  /**
   * Package 3 · P3-1 — the negotiation outcome (ADR-03 §4-1, owner work cycle
   * steps 2–3). The only way a lead's status moves:
   *
   *   NEGOTIATING → ACCEPTED   converts at once (`convert`, same transaction,
   *                            same duplicate-customer check); needs the
   *                            opportunity write key too, like /convert.
   *   NEGOTIATING → REJECTED   needs an active loss reason of this tenant.
   *   REJECTED    → NEGOTIATING reopens; the reason is cleared (the audit row
   *                            keeps it).
   *   ACCEPTED is final: the opportunity carries the story from there.
   */
  async setStatus(user: AuthUser, id: string, dto: SetLeadStatusDto) {
    const lead = await this.get(user, id);
    if (lead.status === dto.status) {
      throw new ConflictException(`Lead is already ${dto.status}`);
    }

    if (dto.status === 'ACCEPTED') {
      if (!user.permissions.includes(PERMISSIONS.OPPORTUNITY_WRITE)) {
        throw new ForbiddenException('Accepting a lead creates its opportunity and needs crm.opportunity.write');
      }
      const { status: _status, rejectionReasonId: _r, rejectionNotes: _n, ...convertDto } = dto;
      return this.convert(user, id, convertDto);
    }

    if (lead.status === 'ACCEPTED') {
      throw new ConflictException('Lead is accepted and converted — its opportunity carries it from here');
    }

    let data: Prisma.LeadUpdateInput;
    if (dto.status === 'REJECTED') {
      if (!dto.rejectionReasonId) throw new BadRequestException('Rejection reason is required');
      const reason = await this.prisma.lossReason.findFirst({
        where: { id: dto.rejectionReasonId, organizationId: user.organizationId, isActive: true },
        select: { id: true },
      });
      if (!reason) throw new BadRequestException('Unknown or inactive rejection reason');
      data = {
        status: 'REJECTED',
        statusChangedAt: new Date(),
        rejectionReason: { connect: { id: reason.id } },
        rejectionNotes: dto.rejectionNotes?.trim() || null,
      };
    } else {
      data = {
        status: 'NEGOTIATING',
        statusChangedAt: new Date(),
        rejectionReason: { disconnect: true },
        rejectionNotes: null,
      };
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.lead.update({ where: { id: lead.id }, data });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'Lead',
          entityId: lead.id,
          action: 'STATUS_CHANGE',
          before: { status: lead.status, rejectionReasonId: lead.rejectionReasonId, rejectionNotes: lead.rejectionNotes },
          after: { status: updated.status, rejectionReasonId: updated.rejectionReasonId, rejectionNotes: updated.rejectionNotes },
        },
        tx,
      );
      return { lead: updated };
    });
  }
}
