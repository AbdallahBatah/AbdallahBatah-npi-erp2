import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NumberingService } from '../../common/numbering.service';
import { AuditService } from '../../common/audit.service';
import type { AuthUser } from '../../common/auth-user';
import { CreateCustomerDto, UpdateCustomerDto } from './dto';

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
  ) {}

  list(user: AuthUser, search?: string) {
    return this.prisma.customer.findMany({
      where: {
        organizationId: user.organizationId,
        ...(search
          ? {
              OR: [
                { nameAr: { contains: search, mode: 'insensitive' } },
                { nameEn: { contains: search, mode: 'insensitive' } },
                { code: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(user: AuthUser, id: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id, organizationId: user.organizationId },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    return customer;
  }

  async create(user: AuthUser, dto: CreateCustomerDto) {
    const customer = await this.prisma.$transaction(async (tx) => {
      const code = await this.numbering.next(user.organizationId, 'CUSTOMER', tx);
      const created = await tx.customer.create({
        data: {
          organizationId: user.organizationId,
          code,
          nameAr: dto.nameAr,
          nameEn: dto.nameEn,
          customerType: dto.customerType ?? 'CI',
          vatNumber: dto.vatNumber,
          crNumber: dto.crNumber,
          creditTermsDays: dto.creditTermsDays ?? 0,
          phone: dto.phone,
          email: dto.email,
        },
      });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'Customer',
          entityId: created.id,
          action: 'CREATE',
          after: created,
        },
        tx,
      );
      return created;
    });
    return customer;
  }

  async update(user: AuthUser, id: string, dto: UpdateCustomerDto) {
    const existing = await this.get(user, id);
    const updated = await this.prisma.customer.update({
      where: { id: existing.id },
      data: dto,
    });
    await this.audit.record({
      organizationId: user.organizationId,
      actorId: user.userId,
      entityType: 'Customer',
      entityId: id,
      action: 'UPDATE',
      before: existing,
      after: updated,
    });
    return updated;
  }
}
