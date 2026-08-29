import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ApprovalService } from '../../common/approval.service';
import { WorkflowEngine } from '../../common/workflow/workflow.engine';
import { APPROVAL_DOCUMENT_META, type ApprovalDocumentType } from '@npi/shared';
import type { AuthUser } from '../../common/auth-user';

export interface InboxTask {
  /** Where the task came from — the two are acted on through different routes. */
  source: 'APPROVAL' | 'WORKFLOW';
  id: string;
  documentType: string;
  documentId: string;
  documentCode: string;
  titleAr: string;
  titleEn: string;
  stateAr: string;
  stateEn: string;
  amount: number | null;
  waitingSince: Date;
  /** Hours the task has been waiting — what the dashboard's ageing reads. */
  ageHours: number;
  overdue: boolean;
  actionable: boolean;
  blockedReason?: string;
  linkPath: string | null;
}

/**
 * The unified task box — §8, phase 4 of the architecture, brought forward
 * because phase 1 already produces two kinds of task and a user with two
 * inboxes has none.
 *
 * It merges what the approval matrix is waiting on from this user's role with
 * what the workflow engine has parked on it. Both are role-scoped for the same
 * reason: a task box built on named people empties itself the first time
 * somebody leaves, and then nobody knows the document is stuck.
 */
@Injectable()
export class InboxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly approvals: ApprovalService,
    private readonly engine: WorkflowEngine,
  ) {}

  async tasks(user: AuthUser): Promise<InboxTask[]> {
    const [approvals, workflow] = await Promise.all([
      this.approvals.inbox(user),
      this.engine.tasksFor(user),
    ]);
    const now = Date.now();
    const hoursSince = (d: Date) => Math.round(((now - d.getTime()) / 3_600_000) * 10) / 10;

    const approvalTasks: InboxTask[] = approvals.map((r) => {
      const meta = APPROVAL_DOCUMENT_META[r.documentType as ApprovalDocumentType];
      return {
        source: 'APPROVAL',
        id: r.id,
        documentType: r.documentType,
        documentId: r.documentId,
        documentCode: r.documentCode,
        titleAr: `${meta.labelAr} ${r.documentCode} — بانتظار اعتمادك`,
        titleEn: `${meta.labelEn} ${r.documentCode} — awaiting your approval`,
        stateAr: `الخطوة ${r.currentStep} من ${r.steps.length}`,
        stateEn: `Step ${r.currentStep} of ${r.steps.length}`,
        amount: r.amount,
        waitingSince: r.currentStepAt,
        ageHours: hoursSince(r.currentStepAt),
        overdue: r.escalated === true,
        // A row the caller cannot sign stays visible rather than being hidden:
        // if they are the only holder of that role the chain is stuck, and the
        // organization needs to see that, not wonder where the document went.
        actionable: r.canDecide !== false,
        blockedReason: r.blockedReason,
        linkPath: '/approvals',
      };
    });

    // A document in a signature chain also has an open workflow instance
    // parked on the same role. Showing both would double-count it, and the
    // approval row is the one that carries the action.
    const claimed = new Set(approvals.map((r) => `${r.documentType}:${r.documentId}`));

    const workflowTasks: InboxTask[] = workflow
      .filter((t) => !claimed.has(`${t.documentType}:${t.documentId}`))
      .map((t) => ({
        source: 'WORKFLOW' as const,
        id: t.instanceId,
        documentType: t.documentType,
        documentId: t.documentId,
        documentCode: t.documentCode,
        titleAr: `${t.flowNameAr} ${t.documentCode}`,
        titleEn: `${t.flowNameEn} ${t.documentCode}`,
        stateAr: t.stateNameAr,
        stateEn: t.stateNameEn,
        amount: null,
        waitingSince: t.openedAt,
        ageHours: hoursSince(t.openedAt),
        overdue: false,
        actionable: true,
        linkPath: t.linkPath,
      }));

    // Oldest first: the point of a task box is that nothing rots at the bottom.
    return [...approvalTasks, ...workflowTasks].sort(
      (a, b) => a.waitingSince.getTime() - b.waitingSince.getTime(),
    );
  }

  /** What the sidebar badge counts — only what this user can actually do. */
  async count(user: AuthUser): Promise<{ total: number; actionable: number; overdue: number }> {
    const tasks = await this.tasks(user);
    return {
      total: tasks.length,
      actionable: tasks.filter((t) => t.actionable).length,
      overdue: tasks.filter((t) => t.overdue).length,
    };
  }

  /**
   * §8, phase 4: the executive view — every open document in the organization,
   * not just this user's. Two questions it must answer that a per-user inbox
   * cannot: what is stuck, and how long approvals actually take.
   */
  async monitor(user: AuthUser) {
    const [open, escalated, avgApproval, failedEvents] = await Promise.all([
      this.prisma.wfInstance.groupBy({
        by: ['documentType', 'currentState'],
        where: { organizationId: user.organizationId, closedAt: null },
        _count: { _all: true },
      }),
      this.prisma.approvalStep.count({
        where: {
          status: 'PENDING',
          escalatedAt: { not: null },
          request: { organizationId: user.organizationId, status: 'PENDING' },
        },
      }),
      this.prisma.approvalRequest.findMany({
        where: {
          organizationId: user.organizationId,
          status: { in: ['APPROVED', 'REJECTED'] },
          closedAt: { not: null },
        },
        select: { createdAt: true, closedAt: true },
        orderBy: { closedAt: 'desc' },
        take: 200,
      }),
      // A stuck consequence is an operational fact, not a log line: a failed
      // event means a commitment or a notification silently did not happen.
      this.prisma.domainEvent.count({
        where: { organizationId: user.organizationId, status: 'FAILED' },
      }),
    ]);

    const durations = avgApproval
      .filter((r) => r.closedAt)
      .map((r) => (r.closedAt!.getTime() - r.createdAt.getTime()) / 3_600_000);
    const avgHours = durations.length
      ? Math.round((durations.reduce((s, d) => s + d, 0) / durations.length) * 10) / 10
      : null;

    return {
      openByState: open.map((r) => ({
        documentType: r.documentType,
        state: r.currentState,
        count: r._count._all,
      })),
      escalatedSteps: escalated,
      /** Mean hours from chain opened to chain closed, last 200 decided. */
      averageApprovalHours: avgHours,
      sampleSize: durations.length,
      failedEvents,
    };
  }
}
