import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@npi/db';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../common/audit.service';
import type { AuthUser } from '../../common/auth-user';
import { CreateWorkItemDto, UpdateWorkItemDto } from './dto';
import { assertCanSetCosts } from './revision-pricing';

const ITEM_SELECT = { select: { id: true, sku: true, nameAr: true, nameEn: true } } as const;

/**
 * Package 3 · P3-3 (ADR-03 §4-3) — the company's list of project work items
 * («بنود المشاريع»), the rows an estimated budget is built from.
 *
 * Managed from the items screen under the item keys (the technical office and
 * the administrator hold commercial.item.write); read by the budget editor
 * through GET /reference/lookups/work-items. A work item is never deleted —
 * a budget written last year still points at it — only switched off.
 */
@Injectable()
export class WorkItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(user: AuthUser, includeInactive = false, search?: string) {
    const term = search?.trim();
    return this.prisma.workItem.findMany({
      where: {
        organizationId: user.organizationId,
        ...(includeInactive ? {} : { isActive: true }),
        ...(term
          ? {
              OR: [
                { code: { contains: term, mode: 'insensitive' } },
                { nameAr: { contains: term, mode: 'insensitive' } },
                { nameEn: { contains: term, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      include: { item: ITEM_SELECT },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    });
  }

  async create(user: AuthUser, dto: CreateWorkItemDto) {
    if (dto.defaultUnitCost !== undefined) assertCanSetCosts(user);
    const code = dto.code.trim();
    if (dto.itemId) await this.assertLinkableItem(user.organizationId, dto.kind, dto.itemId);
    const existing = await this.prisma.workItem.findFirst({
      where: { organizationId: user.organizationId, code },
      select: { id: true },
    });
    if (existing) throw new ConflictException('Work item code already in use');

    try {
      return await this.prisma.$transaction(async (tx) => {
        const created = await tx.workItem.create({
          data: {
            organizationId: user.organizationId,
            code,
            nameAr: dto.nameAr.trim(),
            nameEn: dto.nameEn.trim(),
            kind: dto.kind,
            uom: dto.uom?.trim() || 'unit',
            defaultUnitCost: dto.defaultUnitCost ?? 0,
            itemId: dto.itemId ?? null,
            sortOrder: dto.sortOrder ?? 0,
          },
          include: { item: ITEM_SELECT },
        });
        await this.audit.record(
          {
            organizationId: user.organizationId,
            actorId: user.userId,
            entityType: 'WorkItem',
            entityId: created.id,
            action: 'CREATE',
            after: created,
          },
          tx,
        );
        return created;
      });
    } catch (e) {
      // Two administrators adding the same code at once: the unique index decides.
      if ((e as { code?: string }).code === 'P2002') throw new ConflictException('Work item code already in use');
      throw e;
    }
  }

  async update(user: AuthUser, id: string, dto: UpdateWorkItemDto) {
    if (dto.defaultUnitCost !== undefined) assertCanSetCosts(user);
    const existing = await this.prisma.workItem.findFirst({
      where: { id, organizationId: user.organizationId },
    });
    if (!existing) throw new NotFoundException('Work item not found');

    const kind = dto.kind ?? existing.kind;
    const itemId = dto.itemId === undefined ? existing.itemId : dto.itemId;
    if (itemId) await this.assertLinkableItem(user.organizationId, kind, itemId);

    const data: Prisma.WorkItemUpdateInput = {
      ...(dto.nameAr !== undefined ? { nameAr: dto.nameAr.trim() } : {}),
      ...(dto.nameEn !== undefined ? { nameEn: dto.nameEn.trim() } : {}),
      ...(dto.kind !== undefined ? { kind: dto.kind } : {}),
      ...(dto.uom !== undefined ? { uom: dto.uom.trim() || 'unit' } : {}),
      ...(dto.defaultUnitCost !== undefined ? { defaultUnitCost: dto.defaultUnitCost } : {}),
      ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
      ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      ...(dto.itemId !== undefined
        ? { item: dto.itemId ? { connect: { id: dto.itemId } } : { disconnect: true } }
        : {}),
    };

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.workItem.update({ where: { id: existing.id }, data, include: { item: ITEM_SELECT } });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'WorkItem',
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

  /** Only a MATERIAL work item stands for a stock item, and only one of this tenant. */
  private async assertLinkableItem(organizationId: string, kind: string, itemId: string) {
    if (kind !== 'MATERIAL') {
      throw new BadRequestException('Only a MATERIAL work item can be linked to a stock item');
    }
    const item = await this.prisma.item.findFirst({ where: { id: itemId, organizationId }, select: { id: true } });
    if (!item) throw new BadRequestException('Unknown stock item');
  }
}
