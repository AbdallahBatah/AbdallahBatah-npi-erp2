import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@npi/db';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../common/audit.service';
import type { AuthUser } from '../../common/auth-user';
import { CreateActivityDto, UpdateActivityDto } from './dto';
import { assertContactOf, resolveScope } from './crm-scope';
import { ACTIVITY_INCLUDE, withAttachmentCounts } from './crm-rows';
import { FollowUpTasksService } from './follow-up-tasks.service';

const BODY_MAX = 4000;
/** The first words of an entry become the title of the follow-up created with it. */
const TASK_TITLE_FROM_BODY = 120;
const DEFAULT_TAKE = 50;
const MAX_TAKE = 200;
/** A browser clock may run a little ahead of the server's. */
const FUTURE_SKEW_MS = 5 * 60_000;

export interface ActivityListFilters {
  customerId?: string;
  opportunityId?: string;
  take?: number;
  /** The id of the last entry of the previous page. */
  cursor?: string;
}

/**
 * The communication log (spec 4.4, «إدخال يدوي: ملاحظات، اجتماعات، مكالمات، مرفقات»).
 *
 * An entry says what happened (a note, a call, a meeting), when, and with whom; it hangs
 * on a customer and optionally on one of that customer's opportunities and contacts. It
 * is EDITED by its author alone and NEVER deleted — the log is historical evidence, like
 * the audit trail. Files are attachments on the entry (entityType ACTIVITY), not a kind
 * of entry. A follow-up task may be created in the same transaction as the entry.
 */
@Injectable()
export class ActivitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tasks: FollowUpTasksService,
  ) {}

  // ── reads ─────────────────────────────────────────────────────────────────

  /** A page of a customer's (or an opportunity's) timeline, newest occurrence first, with a keyset cursor. */
  async list(user: AuthUser, filters: ActivityListFilters) {
    if (!filters.customerId && !filters.opportunityId) {
      throw new BadRequestException('customerId or opportunityId is required');
    }
    const org = user.organizationId;
    const take = Math.min(Math.max(Math.trunc(filters.take ?? 0) || DEFAULT_TAKE, 1), MAX_TAKE);

    const where: Prisma.ActivityWhereInput = { organizationId: org };
    if (filters.customerId) where.customerId = filters.customerId;
    if (filters.opportunityId) where.opportunityId = filters.opportunityId;

    // One row more than asked for tells whether there is a next page. createdAt and id
    // break ties between entries of the same moment, so the cursor never skips or repeats.
    const rows = await this.prisma.activity.findMany({
      where,
      include: ACTIVITY_INCLUDE,
      orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, take);
    return {
      items: await withAttachmentCounts(this.prisma, org, items),
      nextCursor: rows.length > take ? items[items.length - 1].id : null,
    };
  }

  // ── writes ────────────────────────────────────────────────────────────────

  async create(user: AuthUser, dto: CreateActivityDto) {
    const org = user.organizationId;
    const body = this.cleanBody(dto.body);
    const occurredAt = this.parseOccurredAt(dto.occurredAt);
    const scope = await resolveScope(this.prisma, org, {
      customerId: dto.customerId,
      opportunityId: dto.opportunityId,
      projectId: dto.projectId,
      contactId: dto.contactId,
    });

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.activity.create({
        data: {
          organizationId: org,
          customerId: scope.customerId,
          opportunityId: scope.opportunityId,
          projectId: scope.projectId,
          contactId: scope.contactId,
          activityType: dto.activityType,
          occurredAt,
          body,
          createdById: user.userId,
        },
        include: ACTIVITY_INCLUDE,
      });
      await this.audit.record(
        { organizationId: org, actorId: user.userId, entityType: 'Activity', entityId: created.id, action: 'CREATE', after: created },
        tx,
      );

      const activity = { ...created, attachmentsCount: 0 };
      if (!dto.followUp) return { activity };

      // Same customer and opportunity as the entry; the title defaults to the entry's first words.
      const title = dto.followUp.title?.trim() || [...body].slice(0, TASK_TITLE_FROM_BODY).join('').trim();
      const task = await this.tasks.createInTx(tx, user, {
        scope,
        title,
        details: dto.followUp.details,
        dueAt: dto.followUp.dueAt,
        remindAt: dto.followUp.remindAt,
        assigneeId: dto.followUp.assigneeId,
      });
      return { activity, task };
    });
  }

  /** Author only (403 otherwise). The customer and the opportunity of an entry never change. */
  async update(user: AuthUser, id: string, dto: UpdateActivityDto) {
    const org = user.organizationId;
    const entry = await this.prisma.activity.findFirst({ where: { id, organizationId: org } });
    if (!entry) throw new NotFoundException('Activity not found');
    if (!entry.createdById || entry.createdById !== user.userId) {
      throw new ForbiddenException('Only the author can edit this entry');
    }

    const data: Prisma.ActivityUncheckedUpdateInput = {};
    if (dto.activityType !== undefined) data.activityType = dto.activityType;
    if (dto.occurredAt !== undefined) data.occurredAt = this.parseOccurredAt(dto.occurredAt);
    if (dto.body !== undefined) data.body = this.cleanBody(dto.body);
    if (dto.contactId !== undefined) {
      if (dto.contactId === null || dto.contactId === '') data.contactId = null;
      else {
        await assertContactOf(this.prisma, org, entry.customerId, dto.contactId);
        data.contactId = dto.contactId;
      }
    }
    if (Object.keys(data).length === 0) {
      const same = await this.prisma.activity.findFirstOrThrow({ where: { id, organizationId: org }, include: ACTIVITY_INCLUDE });
      return (await withAttachmentCounts(this.prisma, org, [same]))[0];
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.activity.update({ where: { id }, data, include: ACTIVITY_INCLUDE });
      await this.audit.record(
        { organizationId: org, actorId: user.userId, entityType: 'Activity', entityId: id, action: 'UPDATE', before: entry, after: row },
        tx,
      );
      return row;
    });
    return (await withAttachmentCounts(this.prisma, org, [updated]))[0];
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private cleanBody(value: string): string {
    const body = (value ?? '').trim();
    if (!body) throw new BadRequestException('Body is required');
    if (body.length > BODY_MAX) throw new BadRequestException(`Body must be at most ${BODY_MAX} characters`);
    return body;
  }

  /** Now when absent; a bad date is a 400; the future (beyond clock skew) is a 400. */
  private parseOccurredAt(value: string | undefined): Date {
    const now = new Date();
    if (value === undefined || value === null || value === '') return now;
    const at = new Date(value);
    if (Number.isNaN(at.getTime())) throw new BadRequestException('occurredAt must be a valid date');
    if (at.getTime() > now.getTime() + FUTURE_SKEW_MS) {
      throw new BadRequestException('Activity date cannot be in the future');
    }
    return at;
  }
}
