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
import { DelegationService, type ActiveDelegation } from './delegation.service';
import { EffectivePermissionsService } from './effective-permissions.service';
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

/**
 * The mirror of an applier, run when a chain is rejected.
 *
 * M4 made this necessary. Before the workflow engine, a rejected purchase
 * order simply stayed in DRAFT and the author could edit and resubmit it — the
 * chain closing was the whole story. Now the document sits in PENDING_APPROVAL
 * while it waits, so a rejection that only closes the chain would strand it
 * there forever: no transition out, and nobody able to touch it.
 */
export type ApprovalRejecter = (
  user: AuthUser,
  documentId: string,
  note: string,
) => Promise<unknown>;

export interface GateInput {
  documentType: ApprovalDocumentType;
  documentId: string;
  documentCode: string;
  /** Always the absolute value — a −900,000 change order is not a small one. */
  amount: number;
  /**
   * M4, the third dimension. Null falls back to the caller's own department,
   * and a caller with none is matched only by organization-wide rules.
   */
  departmentId?: string | null;
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
  currentStepAt: Date;
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
    escalatedAt: Date | null;
  }>;
  /**
   * Inbox rows only. A request can be at the caller's role and still be
   * unsignable *by them* — they raised it, they signed an earlier step, or
   * the document's approve key is not in their effective set (or, through a
   * delegation, not in the delegator's: ADR-02 §3-1).
   * Those rows stay visible rather than being filtered out: if the caller is
   * the only holder of that role, the chain is stuck and the organization
   * needs to see that, not wonder where the document went.
   */
  canDecide?: boolean;
  blockedReason?: 'RAISED_BY_YOU' | 'ALREADY_SIGNED' | 'NO_PERMISSION';
  /**
   * Inbox rows only. Set when the caller reaches this step through a temporary
   * delegation rather than their own role — the UI must say so before they
   * sign, not after.
   */
  viaDelegationFrom?: string;
  /** Inbox rows only: this step has been sitting past its escalation window. */
  escalated?: boolean;
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
  private readonly rejecters = new Map<ApprovalDocumentType, ApprovalRejecter>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly delegations: DelegationService,
    private readonly effective: EffectivePermissionsService,
  ) {}

  /**
   * Called from each owning module's onModuleInit. `rejecter` is optional only
   * for document types whose rejected state is the same as their pre-submission
   * one; anything that parks in a "pending approval" state must supply it, or a
   * rejection leaves the document stranded there.
   */
  register(
    documentType: ApprovalDocumentType,
    applier: ApprovalApplier,
    rejecter?: ApprovalRejecter,
  ): void {
    this.appliers.set(documentType, applier);
    if (rejecter) this.rejecters.set(documentType, rejecter);
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
    const departmentId =
      input.departmentId !== undefined
        ? input.departmentId
        : await this.departmentOf(user.userId);
    const rule = await this.resolveRule(
      user.organizationId,
      input.documentType,
      amount,
      departmentId,
    );
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
          departmentId,
          currentStepAt: new Date(),
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
            departmentId,
            escalationHours: rule.escalationHours,
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
  async resolveRule(
    organizationId: string,
    documentType: ApprovalDocumentType,
    amount: number,
    departmentId?: string | null,
  ) {
    const rules = await this.prisma.approvalRule.findMany({
      where: {
        organizationId,
        documentType,
        isActive: true,
        // Either scoped to this document's department, or scoped to nobody in
        // particular. A rule belonging to *another* department is not a
        // candidate at all — which is what lets two departments hold
        // overlapping bands without either being ambiguous.
        OR: [{ departmentId: null }, ...(departmentId ? [{ departmentId }] : [])],
      },
      include: { steps: { orderBy: { sequence: 'asc' } } },
      orderBy: { minAmount: 'asc' },
    });
    const covering = rules.filter((r) =>
      inBand(amount, Number(r.minAmount), r.maxAmount === null ? null : Number(r.maxAmount)),
    );
    // Specific beats general. Two rules can legitimately cover one amount now —
    // "POs over 100k need finance" for the whole company, and "…but in
    // Engineering they also need the technical director" — and the department
    // one has to win, or the exception is unexpressible.
    const match =
      covering.find((r) => r.departmentId !== null) ?? covering.find((r) => r.departmentId === null);
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
    // checked here, against the caller's live permission set: the effective
    // one (ADR-02), so a GRANT gives the key and a DENY takes it away. The key
    // alone is never a seat — the role check below still applies.
    const required = APPROVAL_DOCUMENT_META[request.documentType as ApprovalDocumentType].permission;
    if (!user.permissions.includes(required)) {
      throw new ForbiddenException('Insufficient permissions');
    }
    // The caller's own role, or a role lent to them by an active delegation
    // whose delegator still holds the key. Checked in that order so the common
    // case costs no extra query.
    let delegation: ActiveDelegation | null = null;
    if (!user.roleIds.includes(step.roleId)) {
      const lent = (await this.delegations.rolesFor(user.organizationId, user.userId)).filter(
        (d) => d.roleId === step.roleId,
      );
      const keys = await this.delegatorPermissions(lent);
      delegation = lent.find((d) => keys.get(d.fromUserId)?.has(required)) ?? null;
      if (!delegation) {
        throw new ForbiddenException('Your role is not the approver at this step');
      }
    }
    if (request.raisedById === user.userId) {
      throw new ForbiddenException('You cannot approve a document you submitted yourself');
    }
    // …nor may the person who raised it hand their approver's authority to
    // themselves through a delegation. Same control, one hop further out.
    if (delegation && delegation.fromUserId === request.raisedById) {
      throw new ForbiddenException(
        'This delegation comes from the person who submitted the document — it cannot be used to approve it',
      );
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
          delegationId: delegation?.id ?? null,
        },
      });
      const next = await tx.approvalRequest.update({
        where: { id: request.id },
        data: approved
          ? isLast
            ? { status: 'APPROVED', closedAt: new Date() }
            // currentStepAt restarts with the step: the next approver gets
            // their own full escalation window, not the remainder of someone
            // else's.
            : { currentStep: { increment: 1 }, currentStepAt: new Date() }
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
            viaDelegationId: delegation?.id ?? null,
          },
        },
        tx,
      );
      return next;
    });

    let applied = false;
    if (updated.status === 'REJECTED') {
      // Move the document too, not just the chain. Best-effort on purpose: the
      // rejection itself has already committed, and turning a recorded refusal
      // into a 500 would invite the approver to click again and produce a
      // second one.
      const rejecter = this.rejecters.get(request.documentType as ApprovalDocumentType);
      if (rejecter) {
        try {
          await rejecter(user, request.documentId, note?.trim() || 'Rejected');
        } catch (err) {
          this.logger.error(
            `Rejection applier failed for ${request.documentType} ${request.documentCode} — ` +
              'the chain is closed but the document did not move',
            err instanceof Error ? err.stack : String(err),
          );
        }
      }
    } else if (updated.status === 'APPROVED') {
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
    // Own role plus any lent to them right now. A delegate whose window has
    // closed simply stops seeing the rows — nothing has to be un-assigned.
    const delegated = await this.delegations.rolesFor(user.organizationId, user.userId);
    const delegatorKeys = await this.delegatorPermissions(delegated);
    const roleIds = [...new Set([...user.roleIds, ...delegated.map((d) => d.roleId)])];

    const rows = await this.prisma.approvalRequest.findMany({
      where: {
        organizationId: user.organizationId,
        status: 'PENDING',
        steps: { some: { roleId: { in: roleIds }, status: 'PENDING' } },
      },
      include: REQUEST_INCLUDE,
      orderBy: { createdAt: 'asc' },
    });
    // `steps.some` cannot express "…and it is the *current* step", so filter
    // the tail here rather than returning things this user cannot act on yet.
    return rows
      .filter((r) => {
        const current = r.steps.find((s) => s.sequence === r.currentStep);
        return !!current && roleIds.includes(current.roleId);
      })
      .map((r) => {
        const current = r.steps.find((s) => s.sequence === r.currentStep)!;
        const required = APPROVAL_DOCUMENT_META[r.documentType as ApprovalDocumentType].permission;
        const raisedByYou = r.raisedById === user.userId;
        const alreadySigned = r.steps.some((s) => s.decidedById === user.userId);
        // Through a delegation: the one whose delegator holds this document's
        // key, as decide() picks it, or else the first, to say whose it is.
        const lent = user.roleIds.includes(current.roleId)
          ? []
          : delegated.filter((d) => d.roleId === current.roleId);
        const via = lent.find((d) => delegatorKeys.get(d.fromUserId)?.has(required)) ?? lent[0];
        const lentByRaiser = !!via && via.fromUserId === r.raisedById;
        // decide() would answer 403: the key is not in the caller's effective
        // set, or the delegation lends nothing for this document.
        const noPermission =
          !user.permissions.includes(required) ||
          (!!via && !delegatorKeys.get(via.fromUserId)?.has(required));
        return {
          ...this.view(r),
          canDecide: !raisedByYou && !alreadySigned && !lentByRaiser && !noPermission,
          blockedReason: raisedByYou
            ? ('RAISED_BY_YOU' as const)
            : alreadySigned
              ? ('ALREADY_SIGNED' as const)
              : noPermission
                ? ('NO_PERMISSION' as const)
                : undefined,
          viaDelegationFrom: via?.fromUserName,
          escalated: current.escalatedAt !== null,
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

  /**
   * Each delegator's effective permission set, by user id. A delegation lends
   * the delegator's ROLE, and only for documents the delegator could approve
   * themselves: a DENY of the approve key on the delegator means the
   * delegation lends nothing for that document (ADR-02 §3-1). No delegations,
   * no query.
   */
  private async delegatorPermissions(
    delegations: readonly ActiveDelegation[],
  ): Promise<Map<string, Set<string>>> {
    const ids = [...new Set(delegations.map((d) => d.fromUserId))];
    const sets = await Promise.all(ids.map((id) => this.effective.forUser(id)));
    return new Map(ids.map((id, i) => [id, new Set(sets[i]?.permissions ?? [])]));
  }

  /**
   * The submitter's department, used when the caller does not state one. A
   * user with no department is not an error: they are simply covered by the
   * organization-wide rules only.
   */
  private async departmentOf(userId: string): Promise<string | null> {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { departmentId: true },
    });
    return row?.departmentId ?? null;
  }

  private view(row: {
    id: string;
    documentType: string;
    documentId: string;
    documentCode: string;
    amount: Prisma.Decimal;
    status: string;
    currentStep: number;
    currentStepAt: Date;
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
      escalatedAt: Date | null;
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
      currentStepAt: row.currentStepAt,
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
        escalatedAt: s.escalatedAt,
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
