import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationService } from './notification.service';
import { APPROVAL_DOCUMENT_META, type ApprovalDocumentType } from '@npi/shared';

/**
 * Automatic escalation — the second half of §5's "التصعيد الآلي عند تجاوز مدة
 * الانتظار المحددة".
 *
 * What escalation does here: it notifies. Loudly, once, to the people who can
 * unstick the chain — the next approver in line and the organization's
 * approval administrators — and it marks the step so every screen can show it
 * as overdue.
 *
 * What it deliberately does *not* do: sign, skip the step, or advance the
 * chain. An escalation that approves things by itself when nobody is looking
 * is not a control, it is a delay before an automatic yes — and it would make
 * "the CEO approved this" a statement the audit trail could not support.
 * Unblocking a stuck chain stays a human act: sign it, reject it, or delegate.
 */
@Injectable()
export class ApprovalEscalationScheduler {
  private readonly logger = new Logger(ApprovalEscalationScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'escalate-stale-approvals', timeZone: 'Asia/Riyadh' })
  async scheduledSweep(): Promise<void> {
    try {
      const escalated = await this.sweep();
      if (escalated > 0) this.logger.warn(`Escalated ${escalated} overdue approval step(s)`);
    } catch (err) {
      // Never let a cron rejection become an unhandledRejection and take the
      // API down; next hour's run sees the same overdue steps.
      this.logger.error(
        'Approval escalation sweep failed',
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /** Returns how many steps were escalated. Callable directly from a test. */
  async sweep(now: Date = new Date()): Promise<number> {
    const pending = await this.prisma.approvalRequest.findMany({
      where: {
        status: 'PENDING',
        // Only chains whose rule actually asked for escalation. A null
        // escalationHours means "no deadline", and a rule deleted since
        // submission (ruleId → null) leaves the chain alone rather than
        // inventing a deadline for it.
        rule: { escalationHours: { not: null } },
      },
      include: {
        rule: { select: { escalationHours: true } },
        steps: { orderBy: { sequence: 'asc' } },
      },
    });

    let count = 0;
    for (const request of pending) {
      const hours = request.rule?.escalationHours;
      if (!hours || hours <= 0) continue;

      const step = request.steps.find((s) => s.sequence === request.currentStep);
      // Escalate once. A step that already carries a stamp has been reported;
      // repeating it every hour is how a real escalation becomes background noise.
      if (!step || step.status !== 'PENDING' || step.escalatedAt) continue;

      const dueAt = new Date(request.currentStepAt.getTime() + hours * 3_600_000);
      if (now < dueAt) continue;

      await this.escalate(request, step, hours);
      count += 1;
    }
    return count;
  }

  private async escalate(
    request: {
      id: string;
      organizationId: string;
      documentType: string;
      documentCode: string;
      currentStep: number;
      currentStepAt: Date;
      raisedById: string | null;
    },
    step: { id: string; roleId: string },
    hours: number,
  ): Promise<void> {
    const meta = APPROVAL_DOCUMENT_META[request.documentType as ApprovalDocumentType];

    // Stamp first. If the notifications below fail, the step is still marked —
    // an escalation that re-fires every hour because its bell broke is worse
    // than one that was recorded but quiet, and the marker is what the screens
    // read.
    await this.prisma.approvalStep.update({
      where: { id: step.id },
      data: { escalatedAt: new Date() },
    });

    const waited = `${hours}`;
    const bodyAr = `مضى أكثر من ${waited} ساعة على انتظار الخطوة ${request.currentStep} دون بتّ.`;
    const bodyEn = `Step ${request.currentStep} has been waiting more than ${waited} hour(s) with no decision.`;

    // The approver's own role: the reminder they were always owed.
    await this.notifications.notifyBestEffort({
      organizationId: request.organizationId,
      permission: meta.permission,
      roleId: step.roleId,
      excludeUserId: request.raisedById,
      type: 'APPROVAL_ESCALATED',
      titleAr: `متأخر عن الاعتماد: ${request.documentCode}`,
      titleEn: `Overdue approval: ${request.documentCode}`,
      bodyAr,
      bodyEn,
      linkPath: '/approvals',
    });

    // And the people who can actually do something about a role that has gone
    // quiet — reassign, delegate, or reconfigure the matrix.
    await this.notifications.notifyBestEffort({
      organizationId: request.organizationId,
      permission: 'admin.approval.manage',
      type: 'APPROVAL_ESCALATED',
      titleAr: `تصعيد اعتماد: ${request.documentCode}`,
      titleEn: `Approval escalated: ${request.documentCode}`,
      bodyAr: `${bodyAr} الرجاء المتابعة أو التفويض المؤقت.`,
      bodyEn: `${bodyEn} Follow up, or set a temporary delegation.`,
      linkPath: '/approvals',
    });

    this.logger.warn(
      `Approval ${request.id} (${request.documentCode}) escalated at step ${request.currentStep} after ${hours}h`,
    );
  }
}
