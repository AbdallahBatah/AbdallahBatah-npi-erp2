import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@npi/db';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../common/audit.service';
import type { AuthUser } from '../../common/auth-user';
import { BudgetTemplateLineDto, CreateBudgetTemplateDto, UpdateBudgetTemplateDto } from './dto';

const LINES_INCLUDE = {
  lines: {
    orderBy: { sortOrder: 'asc' },
    include: { workItem: { select: { id: true, code: true, nameAr: true, nameEn: true, kind: true, uom: true } } },
  },
} as const;

/**
 * Package 3 · P3-5 (ADR-03 §4-5) — standard estimated budgets (the company's
 * 990-panel and 1230-panel models, and any other). A template is work items
 * with quantities; the budget editor copies them into a draft once. Managed on
 * the items screen under its keys, like the work items themselves.
 */
@Injectable()
export class BudgetTemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(user: AuthUser, includeInactive = false) {
    return this.prisma.budgetTemplate.findMany({
      where: { organizationId: user.organizationId, ...(includeInactive ? {} : { isActive: true }) },
      include: LINES_INCLUDE,
      orderBy: { code: 'asc' },
    });
  }

  async create(user: AuthUser, dto: CreateBudgetTemplateDto) {
    const code = dto.code.trim();
    await this.assertWorkItems(user.organizationId, dto.lines);
    const existing = await this.prisma.budgetTemplate.findFirst({
      where: { organizationId: user.organizationId, code },
      select: { id: true },
    });
    if (existing) throw new ConflictException('Budget template code already in use');

    try {
      return await this.prisma.$transaction(async (tx) => {
        const created = await tx.budgetTemplate.create({
          data: {
            organizationId: user.organizationId,
            code,
            nameAr: dto.nameAr.trim(),
            nameEn: dto.nameEn.trim(),
            panelCount: dto.panelCount ?? null,
            capacityKwp: dto.capacityKwp ?? null,
            notes: dto.notes?.trim() || null,
            lines: { create: this.lineRows(dto.lines) },
          },
          include: LINES_INCLUDE,
        });
        await this.audit.record(
          {
            organizationId: user.organizationId,
            actorId: user.userId,
            entityType: 'BudgetTemplate',
            entityId: created.id,
            action: 'CREATE',
            after: created,
          },
          tx,
        );
        return created;
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') throw new ConflictException('Budget template code already in use');
      throw e;
    }
  }

  async update(user: AuthUser, id: string, dto: UpdateBudgetTemplateDto) {
    const existing = await this.prisma.budgetTemplate.findFirst({
      where: { id, organizationId: user.organizationId },
      include: LINES_INCLUDE,
    });
    if (!existing) throw new NotFoundException('Budget template not found');
    if (dto.lines) await this.assertWorkItems(user.organizationId, dto.lines);

    const data: Prisma.BudgetTemplateUpdateInput = {
      ...(dto.nameAr !== undefined ? { nameAr: dto.nameAr.trim() } : {}),
      ...(dto.nameEn !== undefined ? { nameEn: dto.nameEn.trim() } : {}),
      ...(dto.panelCount !== undefined ? { panelCount: dto.panelCount } : {}),
      ...(dto.capacityKwp !== undefined ? { capacityKwp: dto.capacityKwp } : {}),
      ...(dto.notes !== undefined ? { notes: dto.notes?.trim() || null } : {}),
      ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
    };

    return this.prisma.$transaction(async (tx) => {
      if (dto.lines) {
        await tx.budgetTemplateLine.deleteMany({ where: { templateId: existing.id } });
        data.lines = { create: this.lineRows(dto.lines) };
      }
      const updated = await tx.budgetTemplate.update({ where: { id: existing.id }, data, include: LINES_INCLUDE });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'BudgetTemplate',
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

  private lineRows(lines: BudgetTemplateLineDto[]) {
    return lines.map((l, i) => ({
      workItemId: l.workItemId,
      qty: l.qty,
      description: l.description?.trim() || null,
      sortOrder: i,
    }));
  }

  /** Every work item of a template belongs to the caller's organization. */
  private async assertWorkItems(organizationId: string, lines: BudgetTemplateLineDto[]) {
    const ids = [...new Set(lines.map((l) => l.workItemId))];
    if (ids.length === 0) return;
    const found = await this.prisma.workItem.count({ where: { id: { in: ids }, organizationId } });
    if (found !== ids.length) throw new BadRequestException('One or more work items are invalid for this tenant');
  }
}
