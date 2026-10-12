import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@npi/db';
import {
  PERMISSIONS,
  defaultRemindAt,
  isBeforeToday,
  normalizeValidUntil,
  riyadhDayStart,
} from '@npi/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { NumberingService } from '../../common/numbering.service';
import { AuditService } from '../../common/audit.service';
import { NotificationService } from '../../common/notification.service';
import {
  ORG_SETTING_DEFAULTS,
  ORG_SETTING_KEYS,
  OrgSettingsService,
} from '../../common/org-settings.service';
import type { AuthUser } from '../../common/auth-user';
import { holdsEffectively } from '../../common/permission-predicates';
import { CreateTaskDto, UpdateTaskDto } from './dto';
import { resolveScope, type CustomerScope } from './crm-scope';
import { TASK_INCLUDE, withDueState } from './crm-rows';
import { taskAssigned, taskReminder, type TaskNoticeSource } from './follow-up-notifications';

type Tx = Prisma.TransactionClient;

const DAY_MS = 86_400_000;
const TITLE_MAX = 200;
const DEFAULT_TAKE = 200;
const MAX_TAKE = 500;

const STATUSES = ['OPEN', 'DONE', 'CANCELLED'] as const;
const DUE_FILTERS = ['all', 'overdue', 'today', 'week'] as const;

export interface TaskListFilters {
  /** Only the caller's own tasks (`mine=1`). Wins over `assigneeId`. */
  mine?: boolean;
  assigneeId?: string;
  customerId?: string;
  opportunityId?: string;
  /** OPEN (default) | DONE | CANCELLED | ALL. */
  status?: string;
  /** all (default) | overdue | today | week — cut on Riyadh days. */
  due?: string;
  take?: number;
}

/** What a task is created from. The scope has already been checked by `resolveScope`. */
export interface TaskCreateInput {
  scope: CustomerScope;
  title?: string | null;
  details?: string | null;
  /** yyyy-mm-dd or any ISO instant; the Riyadh DAY it falls on is what is stored. */
  dueAt: string | Date;
  remindAt?: string | Date | null;
  assigneeId?: string | null;
}

const text = (v: string | null | undefined): string | null | undefined =>
  v === undefined ? undefined : v === null || v.trim() === '' ? null : v.trim();

/**
 * Follow-up tasks (spec 4.4, «مهام متابعة بتاريخ استحقاق وتذكير») — what must happen
 * next with a customer.
 *
 * Shared by the team: anyone who may write customers completes, cancels, edits or
 * re-assigns any task of the organization (the audit trail names who did). A closed
 * task (done or cancelled) is final — no re-opening; a new task is created instead.
 * Date arithmetic lives in @npi/shared (follow-up-dates.ts); the notifications' text in
 * follow-up-notifications.ts.
 */
@Injectable()
export class FollowUpTasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly settings: OrgSettingsService,
  ) {}

  // ── reads ─────────────────────────────────────────────────────────────────

  async list(user: AuthUser, filters: TaskListFilters = {}) {
    const status = (filters.status ?? 'OPEN').toUpperCase();
    if (status !== 'ALL' && !(STATUSES as readonly string[]).includes(status)) {
      throw new BadRequestException('Unknown task status');
    }
    const due = filters.due ?? 'all';
    if (!(DUE_FILTERS as readonly string[]).includes(due)) {
      throw new BadRequestException('Unknown due filter');
    }
    const now = new Date();
    const today = normalizeValidUntil(now) as Date; // the stored form of today's Riyadh date
    const day = (n: number) => new Date(today.getTime() + n * DAY_MS);

    const where: Prisma.FollowUpTaskWhereInput = { organizationId: user.organizationId };
    if (status !== 'ALL') where.status = status as 'OPEN' | 'DONE' | 'CANCELLED';
    if (filters.mine) where.assigneeId = user.userId;
    else if (filters.assigneeId) where.assigneeId = filters.assigneeId;
    if (filters.customerId) where.customerId = filters.customerId;
    if (filters.opportunityId) where.opportunityId = filters.opportunityId;
    if (due === 'overdue') where.dueAt = { lt: today };
    else if (due === 'today') where.dueAt = { gte: today, lt: day(1) };
    else if (due === 'week') where.dueAt = { gte: today, lt: day(7) };

    const take = Math.min(Math.max(Math.trunc(filters.take ?? DEFAULT_TAKE) || DEFAULT_TAKE, 1), MAX_TAKE);
    const closedOnly = status === 'DONE' || status === 'CANCELLED';
    const rows = await this.prisma.followUpTask.findMany({
      where,
      include: TASK_INCLUDE,
      orderBy: closedOnly
        ? [{ completedAt: 'desc' }, { updatedAt: 'desc' }]
        : [{ dueAt: 'asc' }, { createdAt: 'asc' }],
      take,
    });

    const decorated = rows.map((r) => withDueState(r, now));
    if (status !== 'ALL') return decorated;
    // ALL: the open ones first (by due day, as read), then the closed, newest first.
    const open = decorated.filter((r) => r.status === 'OPEN');
    const closed = decorated
      .filter((r) => r.status !== 'OPEN')
      .sort((a, b) => (b.completedAt ?? b.updatedAt).getTime() - (a.completedAt ?? a.updatedAt).getTime());
    return [...open, ...closed];
  }

  /**
   * The people a task may be given to: the ACTIVE users of the caller's organization who
   * may open the tasks screen (`crm.task.read` held effectively — through their primary
   * role, an extra one or a GRANT, and not DENIED; ADR-02 §5), by Arabic name, with
   * nothing but the three fields a picker needs (no e-mail, role or status). The caller is
   * included when they hold the key — the screen drops "me" itself, because "me" is the
   * default when nobody is picked. Read behind the write key: only someone who may create
   * a task has a reason to ask.
   */
  assignees(user: AuthUser) {
    return this.prisma.user.findMany({
      where: {
        organizationId: user.organizationId,
        isActive: true,
        AND: [holdsEffectively(PERMISSIONS.TASK_READ)],
      },
      select: { id: true, nameAr: true, nameEn: true },
      orderBy: { nameAr: 'asc' },
    });
  }

  /**
   * The dashboard card: the caller's OWN open tasks due today and already late. Riyadh
   * days — a due day is stored as UTC midnight of its Riyadh date, and `normalizeValidUntil`
   * gives today's stored form.
   */
  async mySummary(user: AuthUser): Promise<{ dueToday: number; overdue: number }> {
    const today = normalizeValidUntil(new Date()) as Date;
    const mine = { organizationId: user.organizationId, assigneeId: user.userId, status: 'OPEN' as const };
    const [dueToday, overdue] = await Promise.all([
      this.prisma.followUpTask.count({ where: { ...mine, dueAt: today } }),
      this.prisma.followUpTask.count({ where: { ...mine, dueAt: { lt: today } } }),
    ]);
    return { dueToday, overdue };
  }

  async get(user: AuthUser, id: string) {
    const row = await this.prisma.followUpTask.findFirst({
      where: { id, organizationId: user.organizationId },
      include: TASK_INCLUDE,
    });
    if (!row) throw new NotFoundException('Task not found');
    return withDueState(row);
  }

  // ── create ────────────────────────────────────────────────────────────────

  /** POST /tasks. Links are checked first (no transaction for a request that cannot succeed). */
  async create(user: AuthUser, dto: CreateTaskDto) {
    const scope = await resolveScope(this.prisma, user.organizationId, {
      customerId: dto.customerId,
      opportunityId: dto.opportunityId,
      projectId: dto.projectId,
    });
    return this.prisma.$transaction((tx) =>
      this.createInTx(tx, user, {
        scope,
        title: dto.title,
        details: dto.details,
        dueAt: dto.dueAt,
        remindAt: dto.remindAt,
        assigneeId: dto.assigneeId,
      }),
    );
  }

  /**
   * Creates a task inside the caller's transaction (also used when a log entry is saved
   * together with a follow-up). PRECONDITION: `input.scope` came from `resolveScope`.
   *
   *  · the due DAY may be today but not earlier;
   *  · the assignee defaults to the actor and must be an active user of the organization;
   *  · the reminder is the one given, or `daysBefore` days before the due day at the
   *    configured hour (Riyadh) — and if that moment has already passed (a task for today),
   *    the reminder is sent AT ONCE, in this transaction (and counts as sent);
   *  · somebody else's task is announced to them (TASK_ASSIGNED) — and that notice
   *    replaces the immediate reminder, so one task never rings twice at creation.
   */
  async createInTx(tx: Tx, user: AuthUser, input: TaskCreateInput) {
    const org = user.organizationId;
    const now = new Date();

    const title = (input.title ?? '').trim();
    if (!title) throw new BadRequestException('Title is required');
    if (title.length > TITLE_MAX) throw new BadRequestException(`Title must be at most ${TITLE_MAX} characters`);
    const dueAt = this.parseDueDay(input.dueAt, now);

    const assigneeId = input.assigneeId || user.userId;
    await this.assertAssignee(tx, org, assigneeId);

    const remindAt = await this.reminderFor(tx, org, dueAt, input.remindAt);
    const remindNow = remindAt.getTime() <= now.getTime();

    const code = await this.numbering.next(org, 'FOLLOWUP_TASK', tx);
    const created = await tx.followUpTask.create({
      data: {
        organizationId: org,
        code,
        customerId: input.scope.customerId,
        opportunityId: input.scope.opportunityId,
        projectId: input.scope.projectId,
        title,
        details: text(input.details) ?? null,
        dueAt,
        remindAt,
        assigneeId,
        status: 'OPEN',
        reminderSentAt: remindNow ? now : null,
        createdById: user.userId,
      },
    });
    await this.audit.record(
      { organizationId: org, actorId: user.userId, entityType: 'FollowUpTask', entityId: created.id, action: 'CREATE', after: created },
      tx,
    );

    const customer = { nameAr: input.scope.customerNameAr, nameEn: input.scope.customerNameEn };
    const source: TaskNoticeSource = { id: created.id, organizationId: org, code: created.code, title: created.title, dueAt: created.dueAt };
    if (assigneeId !== user.userId) {
      await this.notifications.notifyUser({ organizationId: org, userId: assigneeId, ...taskAssigned(source, customer) }, tx);
    }
    // A reminder that is already due at creation is sent at once — unless the
    // assignment notice above just went to the same person, in which case a
    // second bell for the same task a millisecond later says nothing new.
    if (remindNow && assigneeId === user.userId) {
      await this.notifications.notifyUser({ organizationId: org, userId: assigneeId, ...taskReminder(source, customer) }, tx);
    }
    return created;
  }

  // ── update ────────────────────────────────────────────────────────────────

  /**
   * Edits an OPEN task. Moving the due day LATER than before re-opens the reminder (a new
   * one is due) and the overdue notice (the task may lapse again); moving it earlier keeps
   * what was already sent. A reminder not yet sent is recomputed for the new day.
   */
  update(user: AuthUser, id: string, dto: UpdateTaskDto) {
    const org = user.organizationId;
    return this.prisma.$transaction(async (tx) => {
      const found = await tx.followUpTask.findFirst({
        where: { id, organizationId: org },
        include: { customer: { select: { id: true, code: true, nameAr: true, nameEn: true } } },
      });
      if (!found) throw new NotFoundException('Task not found');
      const { customer, ...task } = found;
      if (task.status !== 'OPEN') throw new ConflictException('Task is not open');

      const now = new Date();
      const data: Prisma.FollowUpTaskUncheckedUpdateManyInput = {};

      if (dto.title !== undefined) {
        const title = dto.title.trim();
        if (!title) throw new BadRequestException('Title is required');
        if (title.length > TITLE_MAX) throw new BadRequestException(`Title must be at most ${TITLE_MAX} characters`);
        if (title !== task.title) data.title = title;
      }
      if (dto.details !== undefined) {
        const details = text(dto.details) ?? null;
        if (details !== task.details) data.details = details;
      }

      // The due day and, with it, the reminder.
      let dueAt = task.dueAt;
      let remindNow = false;
      if (dto.dueAt !== undefined) {
        // Naming the day the task already has is not a change — even when that day is now
        // past (an overdue task may be edited without being re-dated).
        const next = this.parseDueDay(dto.dueAt, now, task.dueAt);
        if (next.getTime() !== task.dueAt.getTime()) {
          dueAt = next;
          data.dueAt = next;
          const later = next.getTime() > task.dueAt.getTime();
          if (later && task.overdueNotifiedAt) data.overdueNotifiedAt = null;
          if (dto.remindAt === undefined && (later || !task.reminderSentAt)) {
            // A new reminder is due (the day moved on) or none was sent yet: recompute it.
            const remindAt = await this.reminderFor(tx, org, next, undefined);
            data.remindAt = remindAt;
            if (later && task.reminderSentAt) data.reminderSentAt = null;
            if (remindAt.getTime() <= now.getTime()) {
              data.reminderSentAt = now;
              remindNow = true;
            }
          }
        }
      }
      if (dto.remindAt !== undefined) {
        const remindAt = await this.reminderFor(tx, org, dueAt, dto.remindAt);
        data.remindAt = remindAt;
        if (remindAt.getTime() <= now.getTime()) {
          if (!task.reminderSentAt || data.reminderSentAt === null) {
            data.reminderSentAt = now;
            remindNow = true;
          }
        } else if (task.reminderSentAt) {
          data.reminderSentAt = null; // it moved into the future: it is due again then
        }
      }

      // The assignee.
      let reassigned = false;
      if (dto.assigneeId !== undefined && dto.assigneeId !== task.assigneeId) {
        await this.assertAssignee(tx, org, dto.assigneeId);
        data.assigneeId = dto.assigneeId;
        reassigned = true;
      }

      if (Object.keys(data).length === 0) {
        return withDueState(
          await tx.followUpTask.findUniqueOrThrow({ where: { id }, include: TASK_INCLUDE }),
          now,
        );
      }

      const { count } = await tx.followUpTask.updateMany({
        where: { id, organizationId: org, status: 'OPEN' },
        data,
      });
      if (count === 0) throw new ConflictException('Task is not open');
      const after = await tx.followUpTask.findUniqueOrThrow({ where: { id }, include: TASK_INCLUDE });

      const audited = (action: 'UPDATE' | 'REASSIGN') =>
        this.audit.record(
          { organizationId: org, actorId: user.userId, entityType: 'FollowUpTask', entityId: id, action, before: task, after },
          tx,
        );
      if (Object.keys(data).some((k) => k !== 'assigneeId')) await audited('UPDATE');
      if (reassigned) await audited('REASSIGN');

      const names = { nameAr: customer.nameAr, nameEn: customer.nameEn };
      const source: TaskNoticeSource = { id, organizationId: org, code: task.code, title: after.title, dueAt: after.dueAt };
      const recipient = after.assigneeId;
      if (reassigned && recipient !== user.userId) {
        await this.notifications.notifyUser({ organizationId: org, userId: recipient, ...taskAssigned(source, names) }, tx);
      }
      if (remindNow) {
        await this.notifications.notifyUser({ organizationId: org, userId: recipient, ...taskReminder(source, names) }, tx);
      }
      return withDueState(after, now);
    });
  }

  // ── close ─────────────────────────────────────────────────────────────────

  complete(user: AuthUser, id: string) {
    return this.close(user, id, 'COMPLETE', (now) => ({
      status: 'DONE' as const,
      completedAt: now,
      completedById: user.userId,
    }));
  }

  /** Cancelling is final and needs a reason (kept on the task). */
  async cancel(user: AuthUser, id: string, reason: string | null | undefined) {
    const why = (reason ?? '').trim();
    if (!why) throw new BadRequestException('Cancellation reason is required');
    return await this.close(user, id, 'CANCEL', () => ({ status: 'CANCELLED' as const, cancelReason: why }));
  }

  private close(
    user: AuthUser,
    id: string,
    action: 'COMPLETE' | 'CANCEL',
    build: (now: Date) => Prisma.FollowUpTaskUncheckedUpdateManyInput,
  ) {
    const org = user.organizationId;
    return this.prisma.$transaction(async (tx) => {
      const task = await tx.followUpTask.findFirst({ where: { id, organizationId: org } });
      if (!task) throw new NotFoundException('Task not found');
      if (task.status !== 'OPEN') throw new ConflictException('Task is not open');
      const now = new Date();
      // The guard in the WHERE is what makes two simultaneous closes a 409 for the loser.
      const { count } = await tx.followUpTask.updateMany({
        where: { id, organizationId: org, status: 'OPEN' },
        data: build(now),
      });
      if (count === 0) throw new ConflictException('Task is not open');
      const after = await tx.followUpTask.findUniqueOrThrow({ where: { id }, include: TASK_INCLUDE });
      await this.audit.record(
        { organizationId: org, actorId: user.userId, entityType: 'FollowUpTask', entityId: id, action, before: task, after },
        tx,
      );
      return withDueState(after, now);
    });
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /**
   * The Riyadh DAY the input falls on, stored as UTC midnight; never before today —
   * unless it is the very day the task already has (`unchanged`).
   */
  private parseDueDay(value: string | Date, now: Date, unchanged?: Date): Date {
    const day = normalizeValidUntil(value);
    if (!day) throw new BadRequestException('dueAt must be a valid date');
    if (unchanged && day.getTime() === unchanged.getTime()) return day;
    if (isBeforeToday(day, now)) throw new BadRequestException('Due date cannot be in the past');
    return day;
  }

  /** 400 unless `userId` is an active user of the organization. */
  private async assertAssignee(tx: Tx, organizationId: string, userId: string): Promise<void> {
    const assignee = await tx.user.findFirst({
      where: { id: userId, organizationId, isActive: true },
      select: { id: true },
    });
    if (!assignee) throw new BadRequestException('Assignee not found');
  }

  /**
   * The reminder instant: the one given (it may not fall after the due day), or the
   * organization's rule — `crm.task.reminderDaysBefore` days before, at `crm.task.reminderHour`.
   */
  private async reminderFor(
    tx: Tx,
    organizationId: string,
    dueDay: Date,
    given: string | Date | null | undefined,
  ): Promise<Date> {
    if (given !== undefined && given !== null && given !== '') {
      const at = given instanceof Date ? given : new Date(given);
      if (Number.isNaN(at.getTime())) throw new BadRequestException('remindAt must be a valid date');
      if (at.getTime() >= riyadhDayStart(dueDay).getTime() + DAY_MS) {
        throw new BadRequestException('Reminder cannot be after the due date');
      }
      return at;
    }
    const [daysBefore, hour] = await Promise.all([
      this.settings.get<number>(organizationId, ORG_SETTING_KEYS.TASK_REMINDER_DAYS_BEFORE, ORG_SETTING_DEFAULTS[ORG_SETTING_KEYS.TASK_REMINDER_DAYS_BEFORE], tx),
      this.settings.get<number>(organizationId, ORG_SETTING_KEYS.TASK_REMINDER_HOUR, ORG_SETTING_DEFAULTS[ORG_SETTING_KEYS.TASK_REMINDER_HOUR], tx),
    ]);
    return defaultRemindAt(dueDay, daysBefore, hour);
  }
}
