import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { riyadhDayStart } from '@npi/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationService } from '../../common/notification.service';
import { taskOverdue, taskReminder } from './follow-up-notifications';

const NOTICE_SELECT = {
  id: true,
  organizationId: true,
  code: true,
  title: true,
  dueAt: true,
  assigneeId: true,
  createdById: true,
  customer: { select: { nameAr: true, nameEn: true } },
} as const;

/**
 * CRM Phase 1 · Step 5 (spec 4.4 «تذكير» and §11 «التنبيهات داخل النظام: مهام متابعة
 * مستحقة»). Every hour, on the hour, Riyadh time, two things are said about the open
 * follow-up tasks — each ONCE, and only in the system (the bell and the inbox; there is
 * no mail in this release):
 *
 *   1. the REMINDER: a task whose reminder instant has come and that has not been
 *      reminded yet → TASK_REMINDER to the assignee;
 *   2. the OVERDUE notice: a task whose whole due DAY is over (a later Riyadh day has
 *      begun) and that is still open → TASK_OVERDUE to the assignee and, if somebody
 *      else created it, to the creator. The due day itself is not late.
 *
 * "Once" is a claim: the row is stamped (`reminderSentAt`, `overdueNotifiedAt`) by an
 * UPDATE that only succeeds while the stamp is still empty and the task still open, in
 * the same transaction as the notification — so two sweeps (or a sweep and a person
 * completing the task) can never say it twice or say it about a closed task.
 *
 * A DONE or CANCELLED task is never selected. One task that cannot be processed does not
 * keep the others from being told (the convention of proposal-expiry.scheduler.ts).
 */
@Injectable()
export class FollowUpReminderScheduler {
  private readonly logger = new Logger(FollowUpReminderScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'remind-follow-up-tasks', timeZone: 'Asia/Riyadh' })
  async scheduledSweep(): Promise<void> {
    try {
      const { reminded, overdue } = await this.sweep();
      if (reminded > 0 || overdue > 0) {
        this.logger.log(`Follow-up tasks: ${reminded} reminder(s) and ${overdue} overdue notice(s) sent`);
      }
    } catch (err) {
      // Never let a cron rejection become an unhandledRejection and take the API down;
      // next hour's run sees the same tasks.
      this.logger.error('Follow-up reminder sweep failed', err instanceof Error ? err.stack : String(err));
    }
  }

  /** How many tasks were reminded and how many flagged overdue. Callable directly from a test. */
  async sweep(now: Date = new Date()): Promise<{ reminded: number; overdue: number }> {
    const reminded = await this.sendReminders(now);
    const overdue = await this.sendOverdueNotices(now);
    return { reminded, overdue };
  }

  private async sendReminders(now: Date): Promise<number> {
    const due = await this.prisma.followUpTask.findMany({
      where: { status: 'OPEN', reminderSentAt: null, remindAt: { lte: now } },
      select: NOTICE_SELECT,
    });

    let count = 0;
    for (const task of due) {
      try {
        const sent = await this.prisma.$transaction(async (tx) => {
          const claimed = await tx.followUpTask.updateMany({
            where: { id: task.id, status: 'OPEN', reminderSentAt: null },
            data: { reminderSentAt: now },
          });
          if (claimed.count === 0) return false;
          await this.notifications.notifyUser(
            { organizationId: task.organizationId, userId: task.assigneeId, ...taskReminder(task, task.customer) },
            tx,
          );
          return true;
        });
        if (sent) count += 1;
      } catch (err) {
        this.logger.error(`Could not remind about task ${task.id}`, err instanceof Error ? err.stack : String(err));
      }
    }
    return count;
  }

  private async sendOverdueNotices(now: Date): Promise<number> {
    const late = await this.prisma.followUpTask.findMany({
      where: {
        status: 'OPEN',
        overdueNotifiedAt: null,
        // The due DAY is stored as UTC midnight of its Riyadh date; it is over once
        // today (Riyadh) has begun after it. The due day itself is not late.
        dueAt: { lt: riyadhDayStart(now) },
      },
      select: NOTICE_SELECT,
    });

    let count = 0;
    for (const task of late) {
      try {
        const sent = await this.prisma.$transaction(async (tx) => {
          const claimed = await tx.followUpTask.updateMany({
            where: { id: task.id, status: 'OPEN', overdueNotifiedAt: null },
            data: { overdueNotifiedAt: now },
          });
          if (claimed.count === 0) return false;
          const notice = taskOverdue(task, task.customer, now);
          await this.notifications.notifyUser({ organizationId: task.organizationId, userId: task.assigneeId, ...notice }, tx);
          if (task.createdById && task.createdById !== task.assigneeId) {
            await this.notifications.notifyUser({ organizationId: task.organizationId, userId: task.createdById, ...notice }, tx);
          }
          return true;
        });
        if (sent) count += 1;
      } catch (err) {
        this.logger.error(`Could not flag task ${task.id} overdue`, err instanceof Error ? err.stack : String(err));
      }
    }
    return count;
  }
}
