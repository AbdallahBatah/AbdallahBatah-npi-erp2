import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { normalizeSaudiMobile } from '@npi/shared';
import type { Prisma } from '@npi/db';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../common/audit.service';
import type { AuthUser } from '../../common/auth-user';
import { CreateContactDto, UpdateContactDto } from './dto';

const clean = (v: string | null | undefined): string | null => {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
};

/** A contact's mobile is stored canonical when it is a Saudi mobile, as typed otherwise (foreign numbers exist). */
const contactMobile = (v: string | null | undefined): string | null => {
  const raw = clean(v);
  return raw === null ? null : (normalizeSaudiMobile(raw) ?? raw);
};

/**
 * The people at a customer. Any number per customer, at most one primary.
 * Deleting a contact is a real delete (a contact is not a financial document)
 * and is audited with the full pre-delete row.
 */
@Injectable()
export class CustomerContactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** 404 unless the customer is in the caller's organization; 409 if it was merged away. */
  private async customerFor(
    tx: Prisma.TransactionClient | PrismaService,
    user: AuthUser,
    customerId: string,
    forWrite: boolean,
  ) {
    const customer = await tx.customer.findFirst({
      where: { id: customerId, organizationId: user.organizationId },
      select: { id: true, mergedIntoId: true },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    if (forWrite && customer.mergedIntoId) throw new ConflictException('Customer already merged');
    return customer;
  }

  async list(user: AuthUser, customerId: string) {
    await this.customerFor(this.prisma, user, customerId, false);
    return this.prisma.customerContact.findMany({
      where: { organizationId: user.organizationId, customerId },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });
  }

  async create(user: AuthUser, customerId: string, dto: CreateContactDto) {
    return this.prisma.$transaction(async (tx) => {
      await this.customerFor(tx, user, customerId, true);
      if (dto.isPrimary) await this.clearPrimary(tx, user.organizationId, customerId);
      const created = await tx.customerContact.create({
        data: {
          organizationId: user.organizationId,
          customerId,
          name: dto.name.trim(),
          title: clean(dto.title),
          phone: clean(dto.phone),
          mobile: contactMobile(dto.mobile),
          email: clean(dto.email),
          isPrimary: dto.isPrimary ?? false,
          notes: clean(dto.notes),
        },
      });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'CustomerContact',
          entityId: created.id,
          action: 'CREATE',
          after: created,
        },
        tx,
      );
      return created;
    });
  }

  async update(user: AuthUser, customerId: string, contactId: string, dto: UpdateContactDto) {
    return this.prisma.$transaction(async (tx) => {
      await this.customerFor(tx, user, customerId, true);
      const existing = await tx.customerContact.findFirst({
        where: { id: contactId, customerId, organizationId: user.organizationId },
      });
      if (!existing) throw new NotFoundException('Contact not found');
      if (dto.isPrimary) await this.clearPrimary(tx, user.organizationId, customerId, contactId);

      const data: Prisma.CustomerContactUpdateInput = {};
      if (dto.name !== undefined) data.name = dto.name.trim();
      if (dto.title !== undefined) data.title = clean(dto.title);
      if (dto.phone !== undefined) data.phone = clean(dto.phone);
      if (dto.mobile !== undefined) data.mobile = contactMobile(dto.mobile);
      if (dto.email !== undefined) data.email = clean(dto.email);
      if (dto.notes !== undefined) data.notes = clean(dto.notes);
      if (dto.isPrimary !== undefined) data.isPrimary = dto.isPrimary;

      const updated = await tx.customerContact.update({ where: { id: existing.id }, data });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'CustomerContact',
          entityId: existing.id,
          action: 'UPDATE',
          before: existing,
          after: updated,
        },
        tx,
      );
      return updated;
    });
  }

  async remove(user: AuthUser, customerId: string, contactId: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.customerFor(tx, user, customerId, true);
      const existing = await tx.customerContact.findFirst({
        where: { id: contactId, customerId, organizationId: user.organizationId },
      });
      if (!existing) throw new NotFoundException('Contact not found');
      await tx.customerContact.delete({ where: { id: existing.id } });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'CustomerContact',
          entityId: existing.id,
          action: 'DELETE',
          before: existing,
        },
        tx,
      );
    });
    return { deleted: true };
  }

  /** Make room for a new primary: every other contact of the customer stops being one. */
  private async clearPrimary(
    tx: Prisma.TransactionClient,
    organizationId: string,
    customerId: string,
    exceptId?: string,
  ) {
    await tx.customerContact.updateMany({
      where: {
        organizationId,
        customerId,
        isPrimary: true,
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      data: { isPrimary: false },
    });
  }
}
