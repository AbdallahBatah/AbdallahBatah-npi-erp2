import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from './audit.service';
import { NotificationService } from './notification.service';
import {
  APPROVAL_DOCUMENTS,
  APPROVAL_DOCUMENT_META,
  inBand,
  type ApprovalDocumentType,
} from '@npi/shared';
import type { AuthUser } from './auth-user';
import type { Prisma } from '@npi/db';

/**
 * Performs the real state change once the last signature lands. Owning modules
 * register one of these at boot; the matrix never reaches into their tables
 * itself, and this is also what keeps the dependency one-way (procurement
 * depends on the kernel, not the kernel on procurement).
 */
export type ApprovalApplier = (user: AuthUser, documentId: string) => Promise<unknown>;

export interface GateInput {
  documentType: ApprovalDocumentType;
  documentId: string;
  documentCode: string;
  /** Always the absolute value — a −900,000 change order is not a small one. */
  amount: number;
}

export type GateVerdict =
  /** No rule covers this amount: the caller's own permission decides, as before. */
  | { cleared: true; request: null }
  /** A chain was opened (or is already open) — the document must not change yet. */
  | { cleared: false; request: ApprovalRequestView };

export interface ApprovalRequestView {
  id: string;
  documentType: ApprovalDocumentType;
  documentId: string;
  documentCode: string;
  amount: number;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  currentStep: number;
  createdAt: Date;
  closedAt: Date | null;
  raisedBy: { id: string; nameAr: string; nameEn: string } | null;
  steps: Array<{
    sequence: number;
    status: 'PENDING' | 'APPROVED' | 'REJECTED';
    role: { id: string; nameAr: string; nameEn: string };
    decidedBy: { id: string; nameAr: string; nameEn: string } | null;
    decidedAt: Date | null;
    note: string | null;
  }>;
  /**
   * Inbox rows only. A request can be at the caller's role and still be
   * unsignable *by them* — they raised it, or they signed an earlier step.
   * Those rows stay visible rather than being filtered out: if the caller is
   * the only holder of that role, the chain is stuck and the organization
   * needs to see that, not wonder where the document went.
   */
  canDecide?: boolean;
  blockedReason?: 'RAISED_BY_YOU' | 'ALREADY_SIGNED';
}

const REQUEST_INCLUDE = {
  raisedBy: { select: { id: true, nameAr: true, nameEn: true } },
  steps: {
    orderBy: { sequence: 'asc' },
    include: {
      role: { select: { id: true, nameAr: true, nameEn: true } },
      decidedBy: { select: { id: true, nameAr: true, nameEn: true } },
    },
  },
} as const;

/**
 * The approval matrix — package و.
 *
 * The gap it closes: before this, a 500 SAR purchase order and a 5,000,000 SAR
 * one needed the same single permission, and whoever held it approved either
 * one alone. Now an organization can say "above 100,000 the project manager
 * signs, then finance" without anyone editing code — while the *lifecycle*
 * (which states exist, which transitions are legal) stays in code and tested.
 *
 * Two controls are not configurable, deliberately:
 *  · whoever submits a document cannot sign it, and
 *  · no one person can sign two steps of the same chain.
 * A matrix that lets you switch those off is not a control.
 */
@Injectable()
export class ApprovalService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ApprovalService.name);
  private readonly appliers = new Map<ApprovalDocumentType, ApprovalApplier>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  /** Called from each owning module's onModuleInit. */
  register(documentType: ApprovalDocumentType, applier: ApprovalApplier): void {
    this.appliers.set(documentType, applier);
  }

  /**
   * Every document type the matrix advertises must have an owner by the time
   * requests can arrive. Without this, forgetting a register() call would
   * present as a chain that collects every signature and then refuses to apply
   * — the worst possible moment to discover it. Fail at boot instead.
   */
  onApplicationBootstrap(): void {
    const missing = APPROVAL_DOCUMENTS.map((d) => d.value).filter((v) => !this.appliers.has(v));
    if (missing.length) {
      throw new Error(
        `Approval matrix has no applier registered for: ${missing.join(', ')}. ` +
          'Either register one in the owning module, or remove the type from APPROVAL_DOCUMENTS.',
      );
    }
  }

  // ── the gate business services call ───────────────────────────────────────

  /**
   * Ask the matrix whether `user` may just do it. Either it clears (no rule
   * covers this amount) or a signature chain opens and the caller returns
   * without touching the document.
   */
  async gate(user: AuthUser, input: GateInput): Promise<GateVerdict> {
    const amount = Math.abs(input.amount);
    const rule = await this.resolveRule(user.organizationId, input.documentType, amount);
    if (!rule) return { cleared: true, request: null };

    const open = await this.prisma.approvalRequest.findFirst({
      where: {
        organizationId: user.organizationId,
        documentType: input.documentType,
        documentId: input.documentId,
        status: 'PENDING',
      },
      include: REQUEST_INCLUDE,
    });
    if (open) {
      throw new BadRequestException(
        `${input.documentCode} is already awaiting approval at step ${open.currentStep}`,
      );
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const request = await tx.approvalRequest.create({
        data: {
          organizationId: user.organizationId,
          documentType: input.documentType,
          documentId: input.documentId,
          documentCode: input.documentCode,
          amount,
          ruleId: rule.id,
          raisedById: user.userId,
          steps: {
            create: rule.steps.map((s) => ({ sequence: s.sequence, roleId: s.roleId })),
          },
        },
        include: REQUEST_INCLUDE,
      });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'ApprovalRequest',
          entityId: request.id,
          action: 'SUBMIT',
          after: {
            documentType: input.documentType,
            documentCode: input.documentCode,
            amount,
            steps: rule.steps.map((s) => s.sequence),
          },
        },
        tx,
      );
      return request;
    });

    await this.notifyStep(created.id);
    return { cleared: false, request: this.view(created) };
  }

  /**
   * The band covering `amount` for this document type, with its steps in order.
   * Null means the matrix has nothing to say — which is the state every
   * organization starts in, so nothing changes until someone configures a rule.
   */
  async resolveRule(organizationId: string, documentType: ApprovalDocumentType, amount: number) {
    const rules = await this.prisma.approvalRule.findMany({
      where: { organizationId, documentType, isActive: true },
      include: { steps: { orderBy: { sequence: 'asc' } } },
      orderBy: { minAmount: 'asc' },
    });
    const match = rules.find((r) =>
      inBand(amount, Number(r.minAmount), r.maxAmount === null ? null : Number(r.maxAmount)),
    );
    // A band with no steps would open a chain nobody could ever close. Saving
    // one is already refused; ignoring it here too means a row hand-inserted
    // into the database degrades to the old behaviour instead of deadlocking.
    if (match && match.steps.length === 0) {
      this.logger.warn(
        `Approval rule ${match.id} (${documentType}) has no steps — treating as no rule`,
      );
      return null;
    }
    return match ?? null;
  }

  // ── deciding ──────────────────────────────────────────────────────────────

  async decide(
    user: AuthUser,
    requestId: string,
    decision: 'APPROVE' | 'REJECT',
    note?: string,
  ): Promise<{ request: ApprovalRequestView; applied: boolean }> {
    const request = await this.prisma.approvalRequest.findFirst({
      where: { id: requestId, organizationId: user.organizationId },
      include: REQUEST_INCLUDE,
    });
    if (!request) throw new NotFoundException('Approval request not found');
    if (request.status !== 'PENDING') {
      throw new BadRequestException('This request has already been decided');
    }

    const step = request.steps.find((s) => s.sequence === request.currentStep);
    if (!step) throw new BadRequestException('Approval chain is corrupt — no current step');

    // Deciding is the same authority as doing. The route cannot declare this
    // statically (it depends on the request's document type), and the role's
    // permissions may have been edited since the rule was saved — so it is
    // checked here, against the caller's live permission set.
    const required = APPROVAL_DOCUMENT_META[request.documentType as ApprovalDocumentType].permission;
    if (!user.permissions.includes(required)) {
      throw new ForbiddenException('Insufficient permissions');
    }
    if (step.roleId !== user.roleId) {
      throw new ForbiddenException('Your role is not the approver at this step');
    }
    if (request.raisedById === user.userId) {
      throw new ForbiddenException('You cannot approve a document you submitted yourself');
    }
    if (request.steps.some((s) => s.decidedById === user.userId)) {
      throw new ForbiddenException('You have already signed an earlier step of this request');
    }

    const isLast = request.currentStep >= request.steps.length;
    const approved = decision === 'APPROVE';

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.approvalStep.update({
        where: { id: step.id },
        data: {
          status: approved ? 'APPROVED' : 'REJECTED',
          decidedById: user.userId,
          decidedAt: new Date(),
          note: note?.trim() || null,
        },
      });
      const next = await tx.approvalRequest.update({
        where: { id: request.id },
        data: approved
          ? isLast
            ? { status: 'APPROVED', closedAt: new Date() }
            : { currentStep: { increment: 1 } }
          : { status: 'REJECTED', closedAt: new Date() },
        include: REQUEST_INCLUDE,
      });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'ApprovalRequest',
          entityId: request.id,
          action: approved ? 'APPROVE_STEP' : 'REJECT',
          before: { currentStep: request.currentStep, status: request.status },
          after: {
            currentStep: next.currentStep,
            status: next.status,
            documentType: request.documentType,
            documentCode: request.documentCode,
            note: note?.trim() || null,
          },
        },
        tx,
      );
      return next;
    });

    let applied = false;
    if (updated.status === 'APPROVED') {
      // The chain is complete: now — and only now — the document changes.
      const applier = this.appliers.get(request.documentType as ApprovalDocumentType);
      if (!applier) {
        throw new BadRequestException(
          `No handler registered for ${request.documentType} — the document was not applied`,
        );
      }
      await applier(user, request.documentId);
      applied = true;
    } else if (updated.status === 'PENDING') {
      await this.notifyStep(updated.id);
    }

    if (updated.status !== 'PENDING') await this.notifyOutcome(updated.id);
    return { request: this.view(updated), applied };
  }

  // ── reading ───────────────────────────────────────────────────────────────

  /** Everything waiting on *this user's* role right now. */
  async inbox(user: AuthUser): Promise<ApprovalRequestView[]> {
    const rows = await this.prisma.approvalRequest.findMany({
      where: {
        organizationId: user.organizationId,
        status: 'PENDING',
        steps: { some: { roleId: user.roleId, status: 'PENDING' } },
      },
      include: REQUEST_INCLUDE,
      orderBy: { createdAt: 'asc' },
    });
    // `steps.some` cannot express "…and it is the *current* step", so filter
    // the tail here rather than returning things this user cannot act on yet.
    return rows
      .filter((r) => r.steps.find((s) => s.sequence === r.currentStep)?.roleId === user.roleId)
      .map((r) => {
        const raisedByYou = r.raisedById === user.userId;
        const alreadySigned = r.steps.some((s) => s.decidedById === user.userId);
        return {
          ...this.view(r),
          canDecide: !raisedByYou && !alreadySigned,
          blockedReason: raisedByYou
            ? ('RAISED_BY_YOU' as const)
            : alreadySigned
              ? ('ALREADY_SIGNED' as const)
              : undefined,
        };
      });
  }

  /** How many the caller can actually act on — what the badge should count. */
  async inboxCount(user: AuthUser): Promise<number> {
    return (await this.inbox(user)).filter((r) => r.canDecide).length;
  }

  async history(
    user: AuthUser,
    filter: { documentType?: string; status?: string; take: number; skip: number },
  ) {
    const where: Prisma.ApprovalRequestWhereInput = {
      organizationId: user.organizationId,
      documentType: (filter.documentType as ApprovalDocumentType) || undefined,
      status: (filter.status as 'PENDING' | 'APPROVED' | 'REJECTED') || undefined,
    };
    const [total, rows] = await Promise.all([
      this.prisma.approvalRequest.count({ where }),
      this.prisma.approvalRequest.findMany({
        where,
        include: REQUEST_INCLUDE,
        orderBy: { createdAt: 'desc' },
        take: filter.take,
        skip: filter.skip,
      }),
    ]);
    return { total, rows: rows.map((r) => this.view(r)) };
  }

  /** The open chain for one document, if any — drives the badge on its page. */
  async forDocument(
    user: AuthUser,
    documentType: ApprovalDocumentType,
    documentId: string,
  ): Promise<ApprovalRequestView | null> {
    const row = await this.prisma.approvalRequest.findFirst({
      where: {
        organizationId: user.organizationId,
        documentType,
        documentId,
      },
      include: REQUEST_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
    return row ? this.view(row) : null;
  }

  /**
   * Open chains for a batch of documents, keyed by document id. List screens
   * use this to show "awaiting approval" on the rows that are — one query for
   * the whole page rather than one per row.
   */
  async pendingFor(
    organizationId: string,
    documentType: ApprovalDocumentType,
    documentIds: string[],
  ): Promise<Map<string, ApprovalRequestView>> {
    if (documentIds.length === 0) return new Map();
    const rows = await this.prisma.approvalRequest.findMany({
      where: {
        organizationId,
        documentType,
        documentId: { in: documentIds },
        status: 'PENDING',
      },
      include: REQUEST_INCLUDE,
    });
    return new Map(rows.map((r) => [r.documentId, this.view(r)]));
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private view(row: {
    id: string;
    documentType: string;
    documentId: string;
    documentCode: string;
    amount: Prisma.Decimal;
    status: string;
    currentStep: number;
    createdAt: Date;
    closedAt: Date | null;
    raisedBy: { id: string; nameAr: string; nameEn: string } | null;
    steps: Array<{
      sequence: number;
      status: string;
      role: { id: string; nameAr: string; nameEn: string };
      decidedBy: { id: string; nameAr: string; nameEn: string } | null;
      decidedAt: Date | null;
      note: string | null;
    }>;
  }): ApprovalRequestView {
    return {
      id: row.id,
      documentType: row.documentType as ApprovalDocumentType,
      documentId: row.documentId,
      documentCode: row.documentCode,
      amount: Number(row.amount),
      status: row.status as ApprovalRequestView['status'],
      currentStep: row.currentStep,
      createdAt: row.createdAt,
      closedAt: row.closedAt,
      raisedBy: row.raisedBy,
      steps: row.steps.map((s) => ({
        sequence: s.sequence,
        status: s.status as ApprovalRequestView['status'],
        role: s.role,
        decidedBy: s.decidedBy,
        decidedAt: s.decidedAt,
        note: s.note,
      })),
    };
  }

  /** Tell exactly the role that owes a signature — nobody else. */
  private async notifyStep(requestId: string): Promise<void> {
    const request = await this.prisma.approvalRequest.findUnique({
      where: { id: requestId },
      include: { steps: { orderBy: { sequence: 'asc' } } },
    });
    if (!request || request.status !== 'PENDING') return;
    const step = request.steps.find((s) => s.sequence === request.currentStep);
    if (!step) return;

    const meta = APPROVAL_DOCUMENT_META[request.documentType as ApprovalDocumentType];
    await this.notifications.notifyBestEffort({
      organizationId: request.organizationId,
      permission: meta.permission,
      roleId: step.roleId,
      excludeUserId: request.raisedById,
      type: 'APPROVAL_PENDING',
      titleAr: `بانتظار اعتمادك: ${request.documentCode}`,
      titleEn: `Awaiting your approval: ${request.documentCode}`,
      bodyAr: `${meta.labelAr} بمبلغ ${Number(request.amount).toLocaleString('en-US')} ريال — الخطوة ${request.currentStep} من ${request.steps.length}.`,
      bodyEn: `${meta.labelEn} for SAR ${Number(request.amount).toLocaleString('en-US')} — step ${request.currentStep} of ${request.steps.length}.`,
      linkPath: '/approvals',
    });
  }

  /** Tell the person who submitted it how it ended. */
  private async notifyOutcome(requestId: string): Promise<void> {
    const request = await this.prisma.approvalRequest.findUnique({ where: { id: requestId } });
    if (!request?.raisedById || request.status === 'PENDING') return;
    const meta = APPROVAL_DOCUMENT_META[request.documentType as ApprovalDocumentType];
    const ok = request.status === 'APPROVED';
    try {
      await this.prisma.notification.create({
        data: {
          organizationId: request.organizationId,
          userId: request.raisedById,
          type: ok ? 'APPROVAL_GRANTED' : 'APPROVAL_REJECTED',
          titleAr: `${ok ? 'اعتُمد' : 'رُفض'}: ${request.documentCode}`,
          titleEn: `${ok ? 'Approved' : 'Rejected'}: ${request.documentCode}`,
          bodyAr: `${meta.labelAr} الذي رفعته للاعتماد ${ok ? 'اكتملت موافقاته' : 'رُفض ولم يُطبَّق'}.`,
          bodyEn: `The ${meta.labelEn.toLowerCase()} you submitted was ${ok ? 'fully approved' : 'rejected and not applied'}.`,
          linkPath: '/approvals',
        },
      });
    } catch (err) {
      // The decision itself already committed — never turn a bell into a 500.
      this.logger.error(
        `Outcome notification failed for approval ${requestId}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
