import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PERMISSIONS } from '@npi/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { NumberingService } from '../../common/numbering.service';
import { AuditService } from '../../common/audit.service';
import { NotificationService } from '../../common/notification.service';
import type { AuthUser } from '../../common/auth-user';

export class DirectReceiptLineDto {
  @IsString() itemId!: string;
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) qty!: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) unitCost?: number;
}

export class CreateDirectReceiptDto {
  @IsString() vendorId!: string;
  /** A store, or a project's site location. */
  @IsString() locationId!: string;
  @IsOptional() @IsString() @MaxLength(80) deliveryNoteRef?: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true }) @Type(() => DirectReceiptLineDto)
  lines!: DirectReceiptLineDto[];
}

/**
 * P4-7 — «استلام مواد بدون أمر شراء» (owner work cycle step 15). The keeper
 * books the delivery; stock rises in the same transaction (movement RECEIPT,
 * source DirectReceipt) and finance is told to record and match the vendor's
 * invoice. No journal here: without an order there is no agreed price to
 * accrue, so the liability is booked when finance records the bill.
 */
@Injectable()
export class DirectReceiptsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  list(user: AuthUser) {
    return this.prisma.directReceipt.findMany({
      where: { organizationId: user.organizationId },
      include: {
        vendor: { select: { code: true, nameAr: true, nameEn: true } },
        location: { select: { code: true, nameAr: true, nameEn: true } },
        lines: { include: { item: { select: { sku: true, nameAr: true, nameEn: true, uom: true } } } },
      },
      orderBy: { receivedAt: 'desc' },
      take: 200,
    });
  }

  async create(user: AuthUser, dto: CreateDirectReceiptDto) {
    const [vendor, location, items] = await Promise.all([
      this.prisma.vendor.findFirst({ where: { id: dto.vendorId, organizationId: user.organizationId } }),
      this.prisma.location.findFirst({ where: { id: dto.locationId, organizationId: user.organizationId } }),
      this.prisma.item.findMany({
        where: { organizationId: user.organizationId, id: { in: dto.lines.map((l) => l.itemId) } },
        select: { id: true, sku: true, isSerialised: true },
      }),
    ]);
    if (!vendor) throw new NotFoundException('Vendor not found');
    if (!location) throw new NotFoundException('Location not found');
    const byId = new Map(items.map((i) => [i.id, i]));
    for (const l of dto.lines) {
      const item = byId.get(l.itemId);
      if (!item) throw new NotFoundException(`Item ${l.itemId} not found`);
      if (item.isSerialised) {
        throw new BadRequestException(`${item.sku} is serialised — receive it on a purchase order, where its units are registered`);
      }
    }

    const receipt = await this.prisma.$transaction(async (tx) => {
      const code = await this.numbering.next(user.organizationId, 'DIRECT_RECEIPT', tx);
      const r = await tx.directReceipt.create({
        data: {
          organizationId: user.organizationId,
          code,
          vendorId: vendor.id,
          locationId: location.id,
          projectId: location.projectId ?? null,
          deliveryNoteRef: dto.deliveryNoteRef?.trim() || null,
          notes: dto.notes?.trim() || null,
          receivedById: user.userId,
          lines: { create: dto.lines.map((l) => ({ itemId: l.itemId, qty: l.qty, unitCost: l.unitCost ?? null })) },
        },
      });
      for (const l of dto.lines) {
        await tx.stockLevel.upsert({
          where: { organizationId_itemId_locationId: { organizationId: user.organizationId, itemId: l.itemId, locationId: location.id } },
          update: { qty: { increment: l.qty } },
          create: { organizationId: user.organizationId, itemId: l.itemId, locationId: location.id, qty: l.qty },
        });
        await tx.stockMovement.create({
          data: {
            organizationId: user.organizationId,
            itemId: l.itemId,
            toLocationId: location.id,
            qty: l.qty,
            movementType: 'RECEIPT',
            sourceType: 'DirectReceipt',
            sourceId: r.id,
          },
        });
      }
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'DirectReceipt',
          entityId: r.id,
          action: 'RECEIVE',
          after: { code, vendorId: vendor.id, locationId: location.id, lines: dto.lines },
        },
        tx,
      );
      return r;
    });

    await this.notifications.notifyBestEffort({
      organizationId: user.organizationId,
      permission: PERMISSIONS.INVOICE_WRITE,
      type: 'DIRECT_RECEIPT',
      titleAr: `استلام بلا أمر شراء ${receipt.code} من ${vendor.nameAr} — سجّل فاتورة المورد وطابق حسابه`,
      titleEn: `Receipt without an order ${receipt.code} from ${vendor.nameEn} — record the vendor's invoice`,
      linkPath: '/procurement/direct-receipts',
    });
    return receipt;
  }
}
