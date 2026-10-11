import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PERMISSIONS } from '@npi/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../common/audit.service';
import type { AuthUser } from '../../common/auth-user';
import { CreateLossReasonDto, UpdateLossReasonDto } from './dto';

const DUPLICATE = 'Loss reason name already in use';

/**
 * The organization's editable list of reasons an opportunity is lost
 * (CRM Phase 1 · Step 3, §4.2: the loss reason is mandatory and comes from a
 * list the organization can edit).
 *
 * A reason is NEVER deleted: an opportunity lost last year still points at it
 * (the foreign key is RESTRICT and this service has no delete). Retiring a
 * reason means `isActive = false`; it then disappears from the list a
 * salesperson picks from, and stays readable on the opportunities that used it.
 */
@Injectable()
export class LossReasonsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The active reasons, in the configured order. `includeInactive` is honoured
   * only for a caller who manages the organization's settings — a salesperson
   * asking for "all" simply gets the list they may choose from.
   */
  list(user: AuthUser, includeInactive = false) {
    const all = includeInactive && user.permissions.includes(PERMISSIONS.ORG_MANAGE);
    return this.prisma.lossReason.findMany({
      where: { organizationId: user.organizationId, ...(all ? {} : { isActive: true }) },
      orderBy: [{ sortOrder: 'asc' }, { nameAr: 'asc' }],
    });
  }

  async create(user: AuthUser, dto: CreateLossReasonDto) {
    const nameAr = dto.nameAr.trim();
    const nameEn = dto.nameEn.trim();
    return await this.prisma
      .$transaction(async (tx) => {
        const taken = await tx.lossReason.findFirst({
          where: { organizationId: user.organizationId, nameAr },
          select: { id: true },
        });
        if (taken) throw new ConflictException(DUPLICATE);
        const created = await tx.lossReason.create({
          data: { organizationId: user.organizationId, nameAr, nameEn, sortOrder: dto.sortOrder ?? 0, isActive: true },
        });
        await this.audit.record(
          {
            organizationId: user.organizationId,
            actorId: user.userId,
            entityType: 'LossReason',
            entityId: created.id,
            action: 'CREATE',
            after: created,
          },
          tx,
        );
        return created;
      })
      .catch((e) => {
        throw this.translateUnique(e);
      });
  }

  update(user: AuthUser, id: string, dto: UpdateLossReasonDto) {
    return this.prisma
      .$transaction(async (tx) => {
        const existing = await tx.lossReason.findFirst({ where: { id, organizationId: user.organizationId } });
        if (!existing) throw new NotFoundException('Loss reason not found');

        const data: { nameAr?: string; nameEn?: string; sortOrder?: number; isActive?: boolean } = {};
        if (dto.nameAr !== undefined) {
          data.nameAr = dto.nameAr.trim();
          if (data.nameAr !== existing.nameAr) {
            const taken = await tx.lossReason.findFirst({
              where: { organizationId: user.organizationId, nameAr: data.nameAr, id: { not: id } },
              select: { id: true },
            });
            if (taken) throw new ConflictException(DUPLICATE);
          }
        }
        if (dto.nameEn !== undefined) data.nameEn = dto.nameEn.trim();
        if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;
        if (dto.isActive !== undefined) data.isActive = dto.isActive;

        const updated = await tx.lossReason.update({ where: { id }, data });
        await this.audit.record(
          {
            organizationId: user.organizationId,
            actorId: user.userId,
            entityType: 'LossReason',
            entityId: id,
            action: 'UPDATE',
            before: existing,
            after: updated,
          },
          tx,
        );
        return updated;
      })
      .catch((e) => {
        throw this.translateUnique(e);
      });
  }

  /** The unique index (organizationId, nameAr) beat the pre-check: same answer. */
  private translateUnique(e: unknown) {
    if (typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002') {
      return new ConflictException(DUPLICATE);
    }
    return e;
  }
}
