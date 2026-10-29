import {
  BadRequestException,
  ForbiddenException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NumberingService } from '../../common/numbering.service';
import { AuditService } from '../../common/audit.service';
import { ApprovalService } from '../../common/approval.service';
import { TaxService } from '../../common/tax.service';
import { NotificationService } from '../../common/notification.service';
import { WorkflowEngine } from '../../common/workflow/workflow.engine';
import { EventDispatcher } from '../../common/workflow/event-dispatcher.service';
import { OutboxService } from '../../common/workflow/outbox.service';
import { PERMISSIONS, WF_ACTIONS, WF_EVENTS, WF_FLOWS } from '@npi/shared';
import type { AuthUser } from '../../common/auth-user';
import type { Prisma } from '@npi/db';
import type {
  ConvertToPoDto,
  CreateRequisitionDto,
  SourceRequisitionDto,
  UpdateRequisitionDto,
} from './requisitions.dto';

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * The purchase requisition — the step §7 of the architecture starts the cycle
 * with, and the one the system never had. Before this, the first record of a
 * spend was the purchase order: the request and the commitment were the same
 * document, so "who asked for this, and did anyone say yes before we told a
 * vendor to ship it" had no answer.
 *
 * Every state change here goes through `WorkflowEngine.transition()`. Nothing
 * in this file writes `status` directly — that is the golden rule of §4, and
 * the reason the requisition's audit trail is complete by construction rather
 * than by remembering to log.
 */
@Injectable()
export class RequisitionsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalService,
    private readonly tax: TaxService,
    private readonly notifications: NotificationService,
    private readonly engine: WorkflowEngine,
    private readonly events: EventDispatcher,
    private readonly outbox: OutboxService,
  ) {}

  private readonly logger = new Logger(RequisitionsService.name);

  /**
   * `pr.approved ← فتح أمر شراء` (§6).
   *
   * What the handler does *not* do is invent a vendor. A requisition says what
   * is needed and who authorised the spend; choosing who to buy it from is a
   * commercial judgement with its own consequences, and a PO auto-raised
   * against a guessed vendor would be a commitment nobody made. So the event
   * puts the approved requisition in front of the people who can convert it,
   * and `convertToPo` is where the vendor and the real prices are decided.
   *
   * Idempotent, as every handler must be: notifying twice is survivable, and
   * the dispatcher's contract is at-least-once, not exactly-once.
   */
  onModuleInit(): void {
    // The requisition's own band in the matrix. Both halves are registered:
    // the approval that applies it, and the rejection that moves it out of
    // PENDING_APPROVAL — without the second, a refused requisition would be
    // stranded in a state no transition leaves.
    this.approvals.register(
      'PURCHASE_REQUISITION',
      (user, id) => this.applyApproval(user, id),
      (user, id, note) => this.applyRejection(user, id, note),
    );

    this.events.on(WF_EVENTS.PR_APPROVED, 'notify-buyers-to-convert', async (event) => {
      await this.announceApproved(event.organizationId, event.payload.documentId);
    });
  }

  // ── reading ───────────────────────────────────────────────────────────────

  list(user: AuthUser, filter: { status?: string; take: number; skip: number }) {
    const where: Prisma.PurchaseRequisitionWhereInput = {
      organizationId: user.organizationId,
      status: (filter.status as never) || undefined,
    };
    return this.prisma.$transaction(async (tx) => {
      const [total, rows] = await Promise.all([
        tx.purchaseRequisition.count({ where }),
        tx.purchaseRequisition.findMany({
          where,
          include: {
            department: { select: { id: true, code: true, nameAr: true, nameEn: true } },
            project: { select: { id: true, code: true } },
            requestedBy: { select: { id: true, nameAr: true, nameEn: true } },
            purchaseOrder: { select: { id: true, code: true, status: true } },
            _count: { select: { lines: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: filter.take,
          skip: filter.skip,
        }),
      ]);
      return { total, rows };
    });
  }

  async get(user: AuthUser, id: string) {
    const pr = await this.prisma.purchaseRequisition.findFirst({
      where: { id, organizationId: user.organizationId },
      include: {
        department: { select: { id: true, code: true, nameAr: true, nameEn: true } },
        project: { select: { id: true, code: true, nameAr: true, nameEn: true } },
        requestedBy: { select: { id: true, nameAr: true, nameEn: true } },
        purchaseOrder: { select: { id: true, code: true, status: true } },
        vendor: { select: { id: true, code: true, nameAr: true, nameEn: true } },
        deliveryLocation: { select: { id: true, code: true, nameAr: true, nameEn: true } },
        lines: {
          include: {
            item: { select: { sku: true, nameAr: true, nameEn: true, uom: true } },
            wbsElement: { select: { code: true, nameAr: true, nameEn: true } },
          },
        },
      },
    });
    if (!pr) throw new NotFoundException('Purchase requisition not found');

    const [instance, history, actions, pendingApproval] = await Promise.all([
      this.engine.instanceFor(user.organizationId, 'PurchaseRequisition', pr.id),
      this.engine.history(user.organizationId, 'PurchaseRequisition', pr.id),
      this.engine.available(user, 'PurchaseRequisition', pr.id, this.contextOf(pr)),
      this.approvals.forDocument(user, 'PURCHASE_REQUISITION', pr.id),
    ]);

    return {
      ...pr,
      workflow: { instance, history, actions },
      // A requisition in a chain must say so on its own page — "I clicked
      // submit and nothing happened" is otherwise the whole story.
      pendingApproval: pendingApproval?.status === 'PENDING' ? pendingApproval : null,
    };
  }

  // ── writing ───────────────────────────────────────────────────────────────

  async create(user: AuthUser, dto: CreateRequisitionDto) {
    const lines = await this.priceLines(user, dto.lines);
    const estimatedTotal = round2(lines.reduce((s, l) => s + l.lineTotal, 0));
    const departmentId = dto.departmentId ?? (await this.departmentOf(user.userId));

    if (dto.departmentId) await this.assertDepartment(user, dto.departmentId);
    if (dto.projectId) await this.assertProject(user, dto.projectId);

    return this.prisma.$transaction(async (tx) => {
      const code = await this.numbering.next(user.organizationId, 'PURCHASE_REQUISITION', tx);
      const pr = await tx.purchaseRequisition.create({
        data: {
          organizationId: user.organizationId,
          code,
          justification: dto.justification.trim(),
          departmentId,
          projectId: dto.projectId,
          requestedById: user.userId,
          neededBy: dto.neededBy ? new Date(dto.neededBy) : null,
          currency: dto.currency ?? 'SAR',
          estimatedTotal,
          lines: { create: lines },
        },
        include: { lines: true },
      });

      // Opened in the same transaction as the document. A requisition without
      // a workflow instance would have an unknowable state.
      await this.engine.open(tx, {
        organizationId: user.organizationId,
        flowCode: WF_FLOWS.PURCHASE_REQUISITION,
        documentId: pr.id,
        documentCode: pr.code,
        assigneeRoleId: user.roleId,
      });

      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'PurchaseRequisition',
          entityId: pr.id,
          action: 'CREATE',
          after: { code, estimatedTotal, departmentId, projectId: dto.projectId },
        },
        tx,
      );
      return pr;
    });
  }

  /** Editable only while it is still the author's — see the state check. */
  async update(user: AuthUser, id: string, dto: UpdateRequisitionDto) {
    const pr = await this.owned(user, id);
    if (pr.status !== 'DRAFT' && pr.status !== 'RETURNED') {
      throw new BadRequestException(
        'Only a draft or returned requisition can be edited — submit a new one instead',
      );
    }

    const lines = dto.lines ? await this.priceLines(user, dto.lines) : null;
    if (dto.departmentId) await this.assertDepartment(user, dto.departmentId);
    if (dto.projectId) await this.assertProject(user, dto.projectId);

    return this.prisma.$transaction(async (tx) => {
      if (lines) {
        await tx.purchaseRequisitionLine.deleteMany({ where: { requisitionId: pr.id } });
        await tx.purchaseRequisitionLine.createMany({
          data: lines.map((l) => ({ ...l, requisitionId: pr.id })),
        });
      }
      const updated = await tx.purchaseRequisition.update({
        where: { id: pr.id },
        data: {
          justification: dto.justification?.trim() ?? undefined,
          departmentId: dto.departmentId === undefined ? undefined : dto.departmentId,
          projectId: dto.projectId === undefined ? undefined : dto.projectId,
          neededBy:
            dto.neededBy === undefined ? undefined : dto.neededBy ? new Date(dto.neededBy) : null,
          estimatedTotal: lines
            ? round2(lines.reduce((s, l) => s + l.lineTotal, 0))
            : undefined,
        },
        include: { lines: true },
      });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'PurchaseRequisition',
          entityId: pr.id,
          action: 'UPDATE',
          before: { estimatedTotal: Number(pr.estimatedTotal) },
          after: { estimatedTotal: Number(updated.estimatedTotal) },
        },
        tx,
      );
      return updated;
    });
  }

  // ── the workflow actions ──────────────────────────────────────────────────

  /**
   * One entry point for every user-driven move. SUBMIT and APPROVE are the
   * two that consult the approval matrix — SUBMIT to open a chain, APPROVE to
   * sign one — and both do it in the same order:
   *
   *   1. ask the engine whether the move would be legal at all,
   *   2. only then touch a signature chain.
   *
   * Reversed, a chain could be raised (or signed) for a move the engine would
   * refuse — people would sign something that can never be applied, which is
   * worse than a plain error because it wastes the one thing approval spends:
   * attention. Every other action (REJECT, RETURN, CANCEL, …) still goes
   * straight to the engine on a bare permission check, unchanged.
   */
  async act(user: AuthUser, id: string, action: string, comment?: string) {
    const pr = await this.owned(user, id);

    if (action === WF_ACTIONS.SUBMIT) return this.submit(user, pr, comment);
    if (action === WF_ACTIONS.APPROVE) return this.approve(user, pr, comment);

    const result = await this.engine.transition(user, {
      documentType: 'PurchaseRequisition',
      documentId: pr.id,
      actionCode: action,
      comment,
      context: this.contextOf(pr),
      assigneeRoleId: this.assigneeAfter(action, user.roleId),
      apply: async (tx, ctx) => {
        await tx.purchaseRequisition.update({
          where: { id: pr.id },
          data: { status: ctx.toState as never },
        });
      },
    });
    return { ...result, status: result.toState };
  }

  /**
   * APPROVE, specifically. Before the matrix could be bypassed here: this is
   * the only action besides SUBMIT that a bare `engine.transition()` call is
   * not enough for, because "may sign" is not the same question as "holds the
   * transition's static permission" — the whole reason a signature chain
   * exists is to name *who*, not just *which permission*.
   */
  private async approve(
    user: AuthUser,
    pr: {
      id: string;
      code: string;
      estimatedTotal: Prisma.Decimal;
      departmentId: string | null;
      requestedById: string | null;
    },
    comment?: string,
  ) {
    // The requester cannot sign their own request — true whether or not a
    // chain is even open. (The no-band path in `submit()` is the *system*
    // approving because nothing crossed the threshold; a person clicking
    // APPROVE on their own document is never that.)
    if (pr.requestedById === user.userId) {
      throw new ForbiddenException('You cannot approve a requisition you raised yourself');
    }

    // (1) Would the engine allow this move at all?
    await this.engine.assertCan(user, {
      documentType: 'PurchaseRequisition',
      documentId: pr.id,
      actionCode: WF_ACTIONS.APPROVE,
      context: this.contextOf(pr),
    });

    // (2) Is a signature chain still open for this document? If so, that
    // chain — not a bare permission check — is the only way forward: `decide`
    // enforces who may sign it (the current step's role or an active
    // delegation, never the raiser, never someone who already signed an
    // earlier step), advances a multi-step chain, and applies the document on
    // the last signature.
    const chain = await this.approvals.forDocument(user, 'PURCHASE_REQUISITION', pr.id);
    if (chain?.status === 'PENDING') {
      const { request, applied } = await this.approvals.decide(user, chain.id, 'APPROVE', comment);
      return {
        status: applied ? 'APPROVED' : 'PENDING_APPROVAL',
        applied,
        pendingApproval: applied ? null : request,
      };
    }

    // No band covers this amount, or this is legacy data with no chain at
    // all: keep today's behaviour — a straight, permission-gated transition.
    const result = await this.engine.transition(user, {
      documentType: 'PurchaseRequisition',
      documentId: pr.id,
      actionCode: WF_ACTIONS.APPROVE,
      comment,
      context: this.contextOf(pr),
      assigneeRoleId: this.assigneeAfter(WF_ACTIONS.APPROVE, user.roleId),
      apply: async (tx, ctx) => {
        await tx.purchaseRequisition.update({
          where: { id: pr.id },
          data: { status: ctx.toState as never },
        });
      },
    });
    return { ...result, status: result.toState };
  }

  private async submit(
    user: AuthUser,
    pr: { id: string; code: string; estimatedTotal: Prisma.Decimal; departmentId: string | null },
    comment?: string,
  ) {
    // (1) Would the engine allow this move at all?
    await this.engine.assertCan(user, {
      documentType: 'PurchaseRequisition',
      documentId: pr.id,
      actionCode: WF_ACTIONS.SUBMIT,
      context: this.contextOf(pr),
    });

    // (2) Does the matrix want signatures for this amount and department?
    const verdict = await this.approvals.gate(user, {
      documentType: 'PURCHASE_REQUISITION',
      documentId: pr.id,
      documentCode: pr.code,
      amount: Number(pr.estimatedTotal),
      departmentId: pr.departmentId,
    });

    if (!verdict.cleared) {
      // Parked with the role that owes the first signature, so it lands in
      // exactly one task box rather than everybody's.
      const nextRole = verdict.request.steps.find(
        (s) => s.sequence === verdict.request.currentStep,
      )?.role.id;
      const result = await this.engine.transition(user, {
        documentType: 'PurchaseRequisition',
        documentId: pr.id,
        actionCode: WF_ACTIONS.SUBMIT,
        comment,
        context: this.contextOf(pr),
        assigneeRoleId: nextRole ?? null,
        apply: async (tx) => {
          await tx.purchaseRequisition.update({
            where: { id: pr.id },
            data: { status: 'PENDING_APPROVAL' },
          });
        },
      });
      return { ...result, status: 'PENDING_APPROVAL', pendingApproval: verdict.request };
    }

    // No band covers it: submitting *is* approving, exactly as before the
    // matrix existed for anything else.
    await this.engine.transition(user, {
      documentType: 'PurchaseRequisition',
      documentId: pr.id,
      actionCode: WF_ACTIONS.SUBMIT,
      comment,
      context: this.contextOf(pr),
      assigneeRoleId: user.roleId,
      apply: async (tx) => {
        await tx.purchaseRequisition.update({
          where: { id: pr.id },
          data: { status: 'PENDING_APPROVAL' },
        });
      },
    });
    return this.applyApproval(user, pr.id);
  }

  /**
   * The state change itself, and the applier the matrix calls on final
   * sign-off. It re-reads rather than trusting the caller: between submission
   * and the last signature, anything could have happened to the requisition.
   */
  async applyApproval(user: AuthUser, id: string) {
    const pr = await this.prisma.purchaseRequisition.findFirst({
      where: { id, organizationId: user.organizationId },
    });
    if (!pr) throw new NotFoundException('Purchase requisition not found');
    if (pr.status !== 'PENDING_APPROVAL') {
      throw new BadRequestException('Only a requisition awaiting approval can be approved');
    }

    const result = await this.engine.transition(user, {
      documentType: 'PurchaseRequisition',
      documentId: pr.id,
      actionCode: WF_ACTIONS.APPROVE,
      context: this.contextOf(pr),
      assigneeRoleId: null,
      eventPayload: {
        estimatedTotal: Number(pr.estimatedTotal),
        projectId: pr.projectId,
        departmentId: pr.departmentId,
      },
      apply: async (tx) => {
        await tx.purchaseRequisition.update({
          where: { id: pr.id },
          data: { status: 'APPROVED' },
        });
      },
    });

    // P4-4 (ADR-04 §3-6): sourced during the chain → the last signature raises
    // the PO already approved; the general manager signed it in the chain.
    // Unsourced, it stays APPROVED for manual conversion, as before.
    if (pr.vendorId && !pr.purchaseOrderId) {
      try {
        const po = await this.raiseApprovedPo(user, pr.id);
        return { ...result, status: 'CONVERTED', purchaseOrder: { id: po.id, code: po.code } };
      } catch (err) {
        // The approval has committed; a PO that failed to raise leaves the
        // requisition APPROVED, and the pr.approved handler tells procurement
        // to convert it by hand. Never undo a signature over a side effect.
        this.logger.warn(`Auto PO for ${pr.code} failed: ${(err as Error).message}`);
      }
    }
    return { ...result, status: 'APPROVED' };
  }

  // ── sourcing during approval (P4-4) ───────────────────────────────────────

  /**
   * The projects GM's step in the new chain (owner work cycle step 13): what,
   * at what price, from whom, by when, delivered where. Allowed only while the
   * chain is open. Prices may fall freely but the total may not exceed the
   * amount the chain was opened for — the later signers would otherwise be
   * signing for less than the company commits.
   */
  async source(user: AuthUser, id: string, dto: SourceRequisitionDto) {
    const pr = await this.prisma.purchaseRequisition.findFirst({
      where: { id, organizationId: user.organizationId },
      include: { lines: true },
    });
    if (!pr) throw new NotFoundException('Purchase requisition not found');
    if (pr.status !== 'PENDING_APPROVAL') {
      throw new ConflictException('Sourcing is set while the requisition awaits approval');
    }
    if (pr.requestedById === user.userId) {
      throw new ForbiddenException('You cannot source a requisition you raised yourself');
    }
    const vendor = await this.prisma.vendor.findFirst({
      where: { id: dto.vendorId, organizationId: user.organizationId },
      select: { id: true },
    });
    if (!vendor) throw new NotFoundException('Vendor not found');
    if (dto.deliveryLocationId) {
      const loc = await this.prisma.location.findFirst({
        where: { id: dto.deliveryLocationId, organizationId: user.organizationId },
        select: { id: true },
      });
      if (!loc) throw new NotFoundException('Delivery location not found');
    }
    const prices = new Map((dto.prices ?? []).map((p) => [p.requisitionLineId, p.unitPrice]));
    const unknown = [...prices.keys()].find((lid) => !pr.lines.some((l) => l.id === lid));
    if (unknown) throw new BadRequestException(`Line ${unknown} is not on this requisition`);

    const lines = pr.lines.map((l) => {
      const unit = prices.get(l.id) ?? Number(l.estimatedUnitPrice);
      return { id: l.id, unit, lineTotal: round2(Number(l.qty) * unit) };
    });
    const total = round2(lines.reduce((s, l) => s + l.lineTotal, 0));
    const chain = await this.approvals.forDocument(user, 'PURCHASE_REQUISITION', pr.id);
    const ceiling = chain?.status === 'PENDING' ? Number(chain.amount) : Number(pr.estimatedTotal);
    if (total > ceiling + 0.005) {
      throw new ConflictException(
        `Sourced total ${total} exceeds the ${ceiling} the approval was opened for — return the requisition to be resubmitted`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      for (const l of lines) {
        await tx.purchaseRequisitionLine.update({
          where: { id: l.id },
          data: { estimatedUnitPrice: l.unit, lineTotal: l.lineTotal },
        });
      }
      const updated = await tx.purchaseRequisition.update({
        where: { id: pr.id },
        data: {
          vendorId: vendor.id,
          deliveryLocationId: dto.deliveryLocationId ?? pr.deliveryLocationId,
          neededBy: dto.neededBy ? new Date(dto.neededBy) : pr.neededBy,
          estimatedTotal: total,
          sourcedById: user.userId,
          sourcedAt: new Date(),
        },
      });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'PurchaseRequisition',
          entityId: pr.id,
          action: 'SOURCE',
          before: { vendorId: pr.vendorId, estimatedTotal: Number(pr.estimatedTotal) },
          after: { vendorId: vendor.id, estimatedTotal: total, deliveryLocationId: updated.deliveryLocationId },
        },
        tx,
      );
      return updated;
    });
  }

  /** The sourced requisition's PO, born APPROVED, its commitment booked by po.approved. */
  private async raiseApprovedPo(user: AuthUser, id: string) {
    const pr = await this.prisma.purchaseRequisition.findFirst({
      where: { id, organizationId: user.organizationId },
      include: { lines: true },
    });
    if (!pr?.vendorId) throw new BadRequestException('Requisition has no sourced vendor');
    const po = await this.prisma.$transaction((tx) =>
      this.buildPoFromRequisition(tx, user.organizationId, pr, pr.vendorId!, new Map(), {
        actorId: user.userId,
        approvedById: user.userId,
        deliveryLocationId: pr.deliveryLocationId,
        expectedDelivery: pr.neededBy,
      }),
    );
    await this.notifications.notifyBestEffort({
      organizationId: user.organizationId,
      permission: PERMISSIONS.PROCUREMENT_WRITE,
      type: 'PURCHASE_ORDER_APPROVED',
      titleAr: `أمر شراء معتمد جاهز للإرسال للمورّد: ${po.code} (من ${pr.code})`,
      titleEn: `Approved purchase order ready to send to the vendor: ${po.code} (from ${pr.code})`,
      linkPath: `/procurement/${po.id}`,
    });
    return po;
  }

  /** The matrix's rejection path: the document must move too, not just the chain. */
  async applyRejection(user: AuthUser, id: string, comment: string) {
    const pr = await this.prisma.purchaseRequisition.findFirst({
      where: { id, organizationId: user.organizationId },
    });
    // Already moved on, or never parked: nothing to undo, and saying so is not
    // an error — the rejecter runs after the chain has already committed.
    if (!pr || pr.status !== 'PENDING_APPROVAL') return null;
    return this.engine.transition(user, {
      documentType: 'PurchaseRequisition',
      documentId: pr.id,
      actionCode: WF_ACTIONS.REJECT,
      comment,
      context: this.contextOf(pr),
      apply: async (tx) => {
        await tx.purchaseRequisition.update({
          where: { id: pr.id },
          data: { status: 'REJECTED' },
        });
      },
    });
  }

  // ── conversion to a purchase order ────────────────────────────────────────

  /**
   * Turn an approved requisition into a draft PO. Idempotent by construction:
   * `purchaseOrderId` is unique, so a second conversion is refused by the
   * database rather than by a read-then-write anyone could race.
   */
  async convertToPo(user: AuthUser, id: string, dto: ConvertToPoDto) {
    const pr = await this.prisma.purchaseRequisition.findFirst({
      where: { id, organizationId: user.organizationId },
      include: { lines: true },
    });
    if (!pr) throw new NotFoundException('Purchase requisition not found');
    if (pr.status !== 'APPROVED') {
      throw new BadRequestException('Only an approved requisition can become a purchase order');
    }
    if (pr.purchaseOrderId) {
      throw new BadRequestException(`Already converted to ${pr.purchaseOrderId}`);
    }
    const vendor = await this.prisma.vendor.findFirst({
      where: { id: dto.vendorId, organizationId: user.organizationId },
    });
    if (!vendor) throw new NotFoundException('Vendor not found');

    const overrides = new Map((dto.prices ?? []).map((p) => [p.requisitionLineId, p.unitPrice]));
    return this.prisma.$transaction((tx) =>
      this.buildPoFromRequisition(tx, user.organizationId, pr, dto.vendorId, overrides, {
        actorId: user.userId,
        currency: dto.currency,
      }),
    );
  }

  private async announceApproved(organizationId: string, requisitionId: string): Promise<void> {
    const pr = await this.prisma.purchaseRequisition.findFirst({
      where: { id: requisitionId, organizationId },
      select: { id: true, code: true, status: true, purchaseOrderId: true, estimatedTotal: true },
    });
    // Already converted, or gone, or moved on: nothing to announce. Returning
    // quietly is what makes a repeated delivery harmless.
    if (!pr || pr.purchaseOrderId || pr.status !== 'APPROVED') return;

    // Not best-effort: a handler that swallows its own failure would be marked
    // PROCESSED having done nothing. Throwing is what earns the retry.
    await this.notifications.notify({
      organizationId,
      permission: PERMISSIONS.PROCUREMENT_WRITE,
      type: 'REQUISITION_APPROVED',
      titleAr: `طلب شراء معتمد بانتظار التحويل: ${pr.code}`,
      titleEn: `Approved requisition awaiting conversion: ${pr.code}`,
      bodyAr: `اعتُمد الطلب بقيمة تقديرية ${Number(pr.estimatedTotal).toLocaleString('en-US')} ريال — اختر المورّد وحوّله إلى أمر شراء.`,
      bodyEn: `Approved at an estimated SAR ${Number(pr.estimatedTotal).toLocaleString('en-US')} — pick a vendor and convert it to a purchase order.`,
      linkPath: `/requisitions/${pr.id}`,
    });
  }

  private async buildPoFromRequisition(
    tx: Prisma.TransactionClient,
    organizationId: string,
    pr: {
      id: string;
      code: string;
      projectId: string | null;
      currency: string;
      lines: Array<{
        id: string;
        itemId: string;
        wbsElementId: string | null;
        qty: Prisma.Decimal;
        estimatedUnitPrice: Prisma.Decimal;
      }>;
    },
    vendorId: string,
    overrides: Map<string, number>,
    opts: {
      actorId: string;
      currency?: string;
      /** P4-4: set when the chain already carried the final signature. */
      approvedById?: string;
      deliveryLocationId?: string | null;
      expectedDelivery?: Date | null;
    },
  ) {
    const poLines = pr.lines.map((l) => {
      const unitPrice = overrides.get(l.id) ?? Number(l.estimatedUnitPrice);
      return {
        itemId: l.itemId,
        wbsElementId: l.wbsElementId,
        qty: Number(l.qty),
        unitPrice,
        lineTotal: round2(Number(l.qty) * unitPrice),
      };
    });
    const subtotal = round2(poLines.reduce((s, l) => s + l.lineTotal, 0));
    // Same source of truth as every other VAT figure in the system — never a
    // literal 15, which is how three modules drifted apart before M1.
    const { rate: vatRate } = await this.tax.standardVat(organizationId, tx);
    const vatAmount = round2(subtotal * (vatRate / 100));

    const code = await this.numbering.next(organizationId, 'PURCHASE_ORDER', tx);
    const po = await tx.purchaseOrder.create({
      data: {
        organizationId,
        code,
        vendorId,
        projectId: pr.projectId,
        currency: opts.currency ?? pr.currency,
        subtotal,
        vatAmount,
        total: round2(subtotal + vatAmount),
        deliveryLocationId: opts.deliveryLocationId ?? null,
        expectedDelivery: opts.expectedDelivery ?? null,
        ...(opts.approvedById
          ? { status: 'APPROVED' as const, approvedAt: new Date(), approvedById: opts.approvedById }
          : {}),
        lines: { create: poLines },
      },
      include: { lines: true },
    });

    if (opts.approvedById) {
      // Adopted straight into APPROVED (no DRAFT → SUBMIT → APPROVE replay),
      // and po.approved emitted in the same transaction so the project
      // commitment is booked exactly as for a PO approved on its own page.
      await this.engine.adopt(tx, {
        organizationId,
        flowCode: WF_FLOWS.PURCHASE_ORDER,
        documentId: po.id,
        documentCode: po.code,
        stateCode: 'APPROVED',
      });
      await this.outbox.emit(tx, {
        organizationId,
        eventCode: WF_EVENTS.PO_APPROVED,
        payload: {
          documentType: 'PurchaseOrder',
          documentId: po.id,
          documentCode: po.code,
          fromState: 'DRAFT',
          toState: 'APPROVED',
          actorId: opts.approvedById,
          requisitionId: pr.id,
        },
      });
    } else {
      await this.engine.open(tx, {
        organizationId,
        flowCode: WF_FLOWS.PURCHASE_ORDER,
        documentId: po.id,
        documentCode: po.code,
        assigneeRoleId: null,
      });
    }

    await tx.purchaseRequisition.update({
      where: { id: pr.id },
      data: { status: 'CONVERTED', purchaseOrderId: po.id },
    });

    await this.audit.record(
      {
        organizationId,
        actorId: opts.actorId,
        entityType: 'PurchaseRequisition',
        entityId: pr.id,
        action: 'CONVERT',
        after: { purchaseOrderId: po.id, purchaseOrderCode: po.code, subtotal },
      },
      tx,
    );
    return po;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** The facts a transition's `conditionExpr` may compare against. */
  private contextOf(pr: {
    estimatedTotal: Prisma.Decimal;
    projectId?: string | null;
    departmentId?: string | null;
  }) {
    return {
      estimatedTotal: Number(pr.estimatedTotal),
      projectId: pr.projectId ?? null,
      departmentId: pr.departmentId ?? null,
    };
  }

  /**
   * Who owes the next action. Returning it to its author on RETURN is the
   * whole point of that action: a document sent back with nobody holding it
   * is a document nobody fixes.
   */
  private assigneeAfter(action: string, actorRoleId: string): string | null {
    return action === WF_ACTIONS.RETURN ? actorRoleId : null;
  }

  private async owned(user: AuthUser, id: string) {
    const pr = await this.prisma.purchaseRequisition.findFirst({
      where: { id, organizationId: user.organizationId },
    });
    if (!pr) throw new NotFoundException('Purchase requisition not found');
    return pr;
  }

  private async priceLines(
    user: AuthUser,
    lines: Array<{
      itemId: string;
      qty: number;
      estimatedUnitPrice?: number;
      wbsElementId?: string;
      notes?: string;
    }>,
  ) {
    const items = await this.prisma.item.findMany({
      where: { organizationId: user.organizationId, id: { in: lines.map((l) => l.itemId) } },
      select: { id: true, unitCost: true },
    });
    const byId = new Map(items.map((i) => [i.id, i]));
    const missing = lines.find((l) => !byId.has(l.itemId));
    if (missing) throw new NotFoundException(`Item ${missing.itemId} not found`);

    return lines.map((l) => {
      // The catalogue price is the default estimate. A requisition raised
      // without a number is not a request anyone can approve against a band.
      const unit = l.estimatedUnitPrice ?? Number(byId.get(l.itemId)!.unitCost);
      return {
        itemId: l.itemId,
        wbsElementId: l.wbsElementId ?? null,
        qty: l.qty,
        estimatedUnitPrice: unit,
        lineTotal: round2(l.qty * unit),
        notes: l.notes ?? null,
      };
    });
  }

  private async departmentOf(userId: string): Promise<string | null> {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { departmentId: true },
    });
    return row?.departmentId ?? null;
  }

  private async assertDepartment(user: AuthUser, departmentId: string) {
    const dept = await this.prisma.department.findFirst({
      where: { id: departmentId, organizationId: user.organizationId },
    });
    if (!dept) throw new NotFoundException('Department not found');
  }

  private async assertProject(user: AuthUser, projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, organizationId: user.organizationId },
    });
    if (!project) throw new NotFoundException('Project not found');
  }
}
