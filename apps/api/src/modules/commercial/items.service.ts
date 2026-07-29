import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../../common/auth-user';
import { CreateItemDto, UpdateItemDto } from './dto';

@Injectable()
export class ItemsService {
  constructor(private readonly prisma: PrismaService) {}

  list(user: AuthUser, search?: string) {
    return this.prisma.item.findMany({
      where: {
        organizationId: user.organizationId,
        ...(search
          ? {
              OR: [
                { sku: { contains: search, mode: 'insensitive' } },
                { nameAr: { contains: search, mode: 'insensitive' } },
                { nameEn: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: { sku: 'asc' },
    });
  }

  async create(user: AuthUser, dto: CreateItemDto) {
    return this.prisma.item.create({
      data: {
        organizationId: user.organizationId,
        sku: dto.sku,
        nameAr: dto.nameAr,
        nameEn: dto.nameEn,
        itemCategory: dto.itemCategory,
        uom: dto.uom ?? 'unit',
        isSerialised: dto.isSerialised ?? false,
        unitCost: dto.unitCost ?? 0,
      },
    });
  }

  async update(user: AuthUser, id: string, dto: UpdateItemDto) {
    const existing = await this.prisma.item.findFirst({
      where: { id, organizationId: user.organizationId },
    });
    if (!existing) throw new NotFoundException('Item not found');
    return this.prisma.item.update({
      where: { id: existing.id },
      data: dto,
    });
  }
}
