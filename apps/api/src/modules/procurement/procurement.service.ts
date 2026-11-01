import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ForbiddenException,
  type OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NumberingService } from '../../common/numbering.service';
import { AuditService } from '../../common/audit.service';
import { PostingService } from '../../common/posting.service';
import { TaxService } from '../../common/tax.service';
import { ApprovalService } from '../../common/approval.service';
import { NotificationService } from '../../common/notification.service';
import { WorkflowEngine } from '../../common/workflow/workflow.engine';
import { EventDispatcher } from '../../common/workflow/event-dispatcher.service';
import {
  evaluateThreeWayMatch,
  PERMISSIONS,
  THREE_WAY_MATCH_TOLERANCE_PCT,
  WF_ACTIONS,
  WF_EVENTS,
  WF_FLOWS,
} from '@npi/shared';
import type { AuthUser } from '../../common/auth-user';
import type { Prisma } from '@npi/db';
import type {
  CreateBillDto,
  CreateClaimDto,
  CreatePoDto,
  CreateSubcontractDto,
  CreateVendorDto,
  ReceiveDto,
  TransferDto,
} from './dto';

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

@Injectable()
export class ProcurementService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly posting: PostingService,
    private readonly tax: TaxService,
    private readonly approvals: ApprovalService,
    private readonly notifications: NotificationService,
    private readonly engine: WorkflowEngine,
    private readonly events: EventDispatcher,
  ) {}

  /**
   * Hand the matrix the two state changes it may complete on our behalf, and
   * subscribe to the outbox events this module owns the consequences of.
   *
   * The registration direction matters in both cases: the kernel never imports
   * this module, so approvals and the engine stay dependencies *of* procurement
   * and not the other way round. That is what keeps the boundary liftable.
   */
  onModuleInit(): void {
    // The PO now parks in PENDING_APPROVAL while it waits, so its rejection
    // needs a mover as well as a closer — otherwise a refused order sits in a
    // state no transition leaves.
    this.approvals.register(
      'PURCHASE_ORDER',
      (user, id) => this.applyPoApproval(user, id),
      (user, id, note) => this.applyPoRejection(user, id, note),
    );
    // The claim never parks: a rejected claim stays SUBMITTED and can be
    // revised and re-approved, exactly as before. No rejecter needed.
    this.approvals.register('PROGRESS_CLAIM', (user, id) => this.applyClaimApproval(user, id));

    // §6: po.approved ← إنشاء التزام محاسبي.
    this.events.on(WF_EVENTS.PO_APPROVED, 'book-po-commitment', async (event) => {
      await this.bookCommitment(event.organizationId, event.payload.documentId);
    });
    // §6: goods.received ← فتح بند الفاتورة (المطابقة الثلاثية).
    this.events.on(WF_EVENTS.GOODS_RECEIVED, 'invite-vendor-bill', async (event) => {
      await this.inviteVendorBill(event.organizationId, event.payload.documentId);
    });
    // The commitment is released when the liability becomes real — otherwise a
    // project reads as double-spent between receipt and invoice.
    this.events.on(WF_EVENTS.INVOICE_APPROVED, 'release-po-commitment', async (event) => {
      await this.releaseCommitment(event.organizationId, event.payload.documentId);
    });
  }

  // ── Vendors (SCM master data) ─────────────────────────────────────────────

  listVendors(user: AuthUser) {
    return this.prisma.vendor.findMany({
      where: { organizationId: user.organizationId },
      include: { _count: { select: { purchaseOrders: true } } },
      orderBy: { code: 'asc' },
    });
  }

  createVendor(user: AuthUser, dto: CreateVendorDto) {
    return this.prisma.$transaction(async (tx) => {
      const code = await this.numbering.next(user.organizationId, 'VENDOR', tx);
      const vendor = await tx.vendor.create({
        data: {
          organizationId: user.organizationId,
          code,
          nameAr: dto.nameAr,
          nameEn: dto.nameEn,
          vendorType: dto.vendorType ?? 'SUPPLIER',
          vatNumber: dto.vatNumber,
          crNumber: dto.crNumber,
          phone: dto.phone,
          email: dto.email,
          isManufacturer: dto.isManufacturer ?? false,
        },
      });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'Vendor',
          entityId: vendor.id,
          action: 'CREATE',
          after: { code, nameEn: dto.nameEn },
        },
        tx,
      );
      return vendor;
    });
  }

  // ── Purchase orders (SCM-01/02) ───────────────────────────────────────────

  listPos(user: AuthUser) {
    return this.prisma.purchaseOrder.findMany({
      where: { organizationId: user.organizationId },
      include: {
        vendor: { select: { code: true, nameAr: true, nameEn: true } },
        project: { select: { id: true, code: true } },
        _count: { select: { goodsReceipts: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getPo(user: AuthUser, id: string) {
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id, organizationId: user.organizationId },
      include: {
        vendor: true,
        project: { select: { id: true, code: true, nameAr: true, nameEn: true } },
        // P4-4: where the vendor delivers (from the requisition's sourcing).
        deliveryLocation: { select: { id: true, code: true, nameAr: true, nameEn: true } },
        lines: {
          include: {
            item: { select: { sku: true, nameAr: true, nameEn: true, isSerialised: true, uom: true } },
            wbsElement: { select: { code: true, nameAr: true, nameEn: true } },
          },
        },
        goodsReceipts: {
          include: { lines: true, serialUnits: { select: { id: true } }, vendorBills: { select: { id: true, code: true, status: true } } },
          orderBy: { receivedAt: 'desc' },
        },
        vendorBills: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!po) throw new NotFoundException('Purchase order not found');
    // A PO stuck in DRAFT because it is mid-chain must say so on its own page —
    // otherwise "I clicked approve and nothing happened" is the whole story.
    const pendingApproval = await this.approvals.forDocument(user, 'PURCHASE_ORDER', po.id);
    return { ...po, pendingApproval: pendingApproval?.status === 'PENDING' ? pendingApproval : null };
  }

  /** Create a draft PO. Committed cost appears once it is approved. */
  async createPo(user: AuthUser, dto: CreatePoDto) {
    if (!dto.lines.length) throw new BadRequestException('PO needs at least one line');

    const vendor = await this.prisma.vendor.findFirst({
      where: { id: dto.vendorId, organizationId: user.organizationId },
    });
    if (!vendor) throw new NotFoundException('Vendor not found');

    if (dto.projectId) {
      const project = await this.prisma.project.findFirst({
        where: { id: dto.projectId, organizationId: user.organizationId },
      });
      if (!project) throw new NotFoundException('Project not found');
    }

    const items = await this.prisma.item.findMany({
      where: { organizationId: user.organizationId, id: { in: dto.lines.map((l) => l.itemId) } },
      select: { id: true },
    });
    if (items.length !== new Set(dto.lines.map((l) => l.itemId)).size) {
      throw new BadRequestException('One or more items not found');
    }

    const lines = dto.lines.map((l) => ({
      itemId: l.itemId,
      wbsElementId: l.wbsElementId,
      qty: l.qty,
      unitPrice: l.unitPrice,
      lineTotal: round2(l.qty * l.unitPrice),
    }));
    const subtotal = round2(lines.reduce((s, l) => s + l.lineTotal, 0));
    const { rate: vatRate } = await this.tax.standardVat(user.organizationId);
    const vatAmount = round2(subtotal * (vatRate / 100));

    return this.prisma.$transaction(async (tx) => {
      const code = await this.numbering.next(user.organizationId, 'PURCHASE_ORDER', tx);
      const po = await tx.purchaseOrder.create({
        data: {
          organizationId: user.organizationId,
          code,
          vendorId: dto.vendorId,
          projectId: dto.projectId,
          currency: dto.currency ?? 'SAR',
          subtotal,
          vatAmount,
          total: round2(subtotal + vatAmount),
          lines: { create: lines },
        },
        include: { lines: true },
      });
      // Opened with the document, never after it: a PO whose flow instance is
      // missing has an unknowable state, and every read path would then need a
      // fallback for a case that should be impossible.
      await this.engine.open(tx, {
        organizationId: user.organizationId,
        flowCode: WF_FLOWS.PURCHASE_ORDER,
        documentId: po.id,
        documentCode: po.code,
        assigneeRoleId: user.roleId,
      });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'PurchaseOrder',
          entityId: po.id,
          action: 'CREATE',
          after: { code, subtotal, vatAmount, projectId: dto.projectId },
        },
        tx,
      );
      return po;
    });
  }

  /**
   * The single entry point users hit. Order of operations is deliberate:
   *
   *   1. ask the engine whether SUBMIT is legal here at all,
   *   2. ask the matrix whether this amount needs signatures,
   *   3. move the document.
   *
   * Reversed, a signature chain could be opened for a move the engine would
   * refuse, and people would sign something that can never be applied.
   *
   * With no band configured, submitting still approves outright — exactly the
   * pre-matrix behaviour — but the PO now passes visibly through
   * PENDING_APPROVAL, which is the state §7 says the map was missing.
   */
  async approvePo(user: AuthUser, id: string) {
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id, organizationId: user.organizationId },
      include: { project: { select: { id: true } } },
    });
    if (!po) throw new NotFoundException('Purchase order not found');

    await this.engine.assertCan(user, {
      documentType: 'PurchaseOrder',
      documentId: po.id,
      actionCode: WF_ACTIONS.SUBMIT,
      context: this.poContext(po),
    });

    const verdict = await this.approvals.gate(user, {
      documentType: 'PURCHASE_ORDER',
      documentId: po.id,
      documentCode: po.code,
      amount: Number(po.total),
    });
    if (verdict.cleared && !user.permissions.includes(PERMISSIONS.PROCUREMENT_APPROVE)) {
      // Separated rights (Step 1): a role that may write/submit but not approve must
      // not self-approve when no matrix band applies. Fail before any state change.
      throw new ForbiddenException('Approving this document requires the approve permission; no approval rule routes it to someone else');
    }

    const nextRole = verdict.cleared
      ? user.roleId
      : (verdict.request.steps.find((st) => st.sequence === verdict.request.currentStep)?.role.id ??
        null);

    await this.engine.transition(user, {
      documentType: 'PurchaseOrder',
      documentId: po.id,
      actionCode: WF_ACTIONS.SUBMIT,
      context: this.poContext(po),
      assigneeRoleId: nextRole,
      apply: async (tx) => {
        await tx.purchaseOrder.update({
          where: { id: po.id },
          data: { status: 'PENDING_APPROVAL' },
        });
      },
    });

    if (!verdict.cleared) {
      const parked = await this.prisma.purchaseOrder.findUnique({ where: { id: po.id } });
      return { ...parked, pendingApproval: verdict.request };
    }
    return this.applyPoApproval(user, id);
  }

  /**
   * The state change itself, and the applier the matrix calls on final
   * sign-off — which is why it re-reads and re-checks rather than trusting the
   * caller: between submission and the last signature, anything could have
   * happened to the PO.
   *
   * `po.approved` is emitted inside the engine's transaction. The commitment
   * it books is therefore guaranteed to happen, but not guaranteed to have
   * happened *yet* — which is the honest trade the outbox makes.
   */
  private async applyPoApproval(user: AuthUser, id: string) {
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id, organizationId: user.organizationId },
      include: { lines: { select: { wbsElementId: true, lineTotal: true } } },
    });
    if (!po) throw new NotFoundException('Purchase order not found');

    await this.engine.transition(user, {
      documentType: 'PurchaseOrder',
      documentId: po.id,
      actionCode: WF_ACTIONS.APPROVE,
      context: this.poContext(po),
      assigneeRoleId: user.roleId,
      eventPayload: { total: Number(po.total), projectId: po.projectId },
      apply: async (tx) => {
        await tx.purchaseOrder.update({
          where: { id: po.id },
          data: { status: 'APPROVED', approvedAt: new Date(), approvedById: user.userId },
        });
      },
    });
    return this.prisma.purchaseOrder.findUnique({ where: { id: po.id } });
  }

  /**
   * The chain refused it. The PO returns to DRAFT so its author can fix and
   * resubmit — which is what "مرفوض" meant before the PO had a waiting state,
   * and what people already expect.
   */
  private async applyPoRejection(user: AuthUser, id: string, note: string) {
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id, organizationId: user.organizationId },
    });
    if (!po || po.status !== 'PENDING_APPROVAL') return null;

    return this.engine.transition(user, {
      documentType: 'PurchaseOrder',
      documentId: po.id,
      actionCode: WF_ACTIONS.REJECT,
      comment: note,
      context: this.poContext(po),
      apply: async (tx) => {
        await tx.purchaseOrder.update({ where: { id: po.id }, data: { status: 'CANCELLED' } });
      },
    });
  }

  /**
   * §7: معتمد ← مرسَل للمورّد. Approving internally and placing the order with
   * the vendor were the same act before M4, so "we approved it but nobody sent
   * it" was a state the system could not represent — and therefore could not
   * report on.
   */
  async sendPo(user: AuthUser, id: string) {
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id, organizationId: user.organizationId },
    });
    if (!po) throw new NotFoundException('Purchase order not found');

    await this.engine.transition(user, {
      documentType: 'PurchaseOrder',
      documentId: po.id,
      actionCode: WF_ACTIONS.SEND,
      context: this.poContext(po),
      assigneeRoleId: user.roleId,
      eventPayload: { vendorId: po.vendorId, total: Number(po.total) },
      apply: async (tx) => {
        await tx.purchaseOrder.update({ where: { id: po.id }, data: { status: 'SENT' } });
      },
    });
    return this.prisma.purchaseOrder.findUnique({ where: { id: po.id } });
  }

  /** The facts a PO transition's condition may compare against. */
  private poContext(po: { total: unknown; projectId: string | null; status: string }) {
    return {
      total: Number(po.total),
      projectId: po.projectId ?? null,
      status: po.status,
    };
  }

  // ── Goods receipt (SCM-01) + serial registration (SCM-05) + actuals (PRJ-03)
  //
  // §7 splits what used to be one instant into three states: مسودة ← مفحوص ←
  // مقبول. Recording an arrival and accepting it were the same act before M4,
  // which is why a rejected delivery had nowhere to live and why stock could
  // not be trusted before anyone had looked in the boxes.

  /**
   * Record what arrived. Nothing moves in stock, nothing is costed, and no
   * journal is written — this is a delivery note, not an acceptance.
   */
  async receive(user: AuthUser, poId: string, dto: ReceiveDto) {
    if (!dto.lines.length) throw new BadRequestException('Receipt needs at least one line');

    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id: poId, organizationId: user.organizationId },
      include: { lines: { include: { item: true } }, vendor: true },
    });
    if (!po) throw new NotFoundException('Purchase order not found');
    // SENT, not merely APPROVED: goods arriving against an order the vendor was
    // never sent is a receiving error worth catching, not a state to record.
    // PARTIALLY_RECEIVED keeps split deliveries working.
    if (!['SENT', 'PARTIALLY_RECEIVED'].includes(po.status)) {
      throw new BadRequestException(
        'PO must be approved and sent to the vendor before goods can be received against it',
      );
    }

    // Validate every receipt line against its PO line.
    const byId = new Map(po.lines.map((l) => [l.id, l]));
    for (const rl of dto.lines) {
      const pol = byId.get(rl.poLineId);
      if (!pol) throw new BadRequestException(`PO line ${rl.poLineId} not found on this PO`);
      const remaining = Number(pol.qty) - Number(pol.receivedQty);
      if (rl.qty > remaining + 1e-9) {
        throw new BadRequestException(
          `Line ${pol.item.sku}: receiving ${rl.qty} exceeds remaining ${remaining}`,
        );
      }
      if (pol.item.isSerialised) {
        const serials = rl.serials ?? [];
        if (serials.length !== rl.qty) {
          throw new BadRequestException(
            `Line ${pol.item.sku} is serialised: ${rl.qty} serial numbers required, got ${serials.length}`,
          );
        }
        if (new Set(serials).size !== serials.length) {
          throw new BadRequestException(`Line ${pol.item.sku}: duplicate serial numbers in receipt`);
        }
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const code = await this.numbering.next(user.organizationId, 'GOODS_RECEIPT', tx);
      const grn = await tx.goodsReceipt.create({
        data: {
          organizationId: user.organizationId,
          code,
          purchaseOrderId: po.id,
          receivedById: user.userId,
          notes: dto.notes,
          lines: {
            // Serials are read off the cartons now, while the delivery is in
            // front of the receiver, and stored on the row until acceptance
            // turns them into stock. On the row, not in memory: a receipt left
            // overnight must survive a restart.
            create: dto.lines.map((rl) => ({
              purchaseOrderLineId: rl.poLineId,
              qty: rl.qty,
              serials: rl.serials ?? [],
              batchNo: rl.batchNo ?? null,
            })),
          },
        },
      });

      await this.engine.open(tx, {
        organizationId: user.organizationId,
        flowCode: WF_FLOWS.GOODS_RECEIPT,
        documentId: grn.id,
        documentCode: grn.code,
        assigneeRoleId: user.roleId,
      });

      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'GoodsReceipt',
          entityId: grn.id,
          action: 'RECORD',
          after: { code, poCode: po.code, lines: dto.lines.length },
        },
        tx,
      );

      return tx.goodsReceipt.findUnique({ where: { id: grn.id }, include: { lines: true } });
    });
  }

  /** §7: مسودة ← مفحوص. A separate act, so it can be a separate pair of eyes. */
  async inspectGrn(user: AuthUser, grnId: string, comment?: string) {
    const grn = await this.ownedGrn(user, grnId);
    await this.engine.transition(user, {
      documentType: 'GoodsReceipt',
      documentId: grn.id,
      actionCode: WF_ACTIONS.INSPECT,
      comment,
      assigneeRoleId: user.roleId,
      apply: async (tx) => {
        await tx.goodsReceipt.update({
          where: { id: grn.id },
          data: { status: 'INSPECTED', inspectedAt: new Date(), inspectedById: user.userId },
        });
      },
    });
    return this.prisma.goodsReceipt.findUnique({ where: { id: grn.id } });
  }

  /**
   * §7: مفحوص ← مرفوض جزئياً. The engine requires the comment (REJECT_PARTIAL
   * is in WF_ACTIONS_REQUIRING_COMMENT); this is a dispute with a vendor, and
   * one nobody can reconstruct later is one the company loses.
   */
  async rejectGrn(user: AuthUser, grnId: string, comment: string) {
    const grn = await this.ownedGrn(user, grnId);
    await this.engine.transition(user, {
      documentType: 'GoodsReceipt',
      documentId: grn.id,
      actionCode: WF_ACTIONS.REJECT_PARTIAL,
      comment,
      apply: async (tx) => {
        await tx.goodsReceipt.update({
          where: { id: grn.id },
          data: { status: 'PARTIALLY_REJECTED', rejectionNote: comment.trim() },
        });
      },
    });
    return this.prisma.goodsReceipt.findUnique({ where: { id: grn.id } });
  }

  /**
   * §7: مفحوص ← مقبول — and the moment stock actually exists.
   *
   * Everything acceptance causes (stock levels, serial units, movement rows,
   * project actuals, the PO's own received state) happens inside the engine's
   * transaction rather than in the `goods.received` handler. That is a
   * deliberate reading of §6: the outbox exists so a consequence cannot be
   * *lost*, and same-transaction is a strictly stronger guarantee than
   * at-least-once delivery. The event carries the genuinely cross-module part
   * — payables may now raise a bill — which belongs to another module and can
   * safely be a moment late.
   */
  async acceptGrn(user: AuthUser, grnId: string, comment?: string) {
    const grn = await this.prisma.goodsReceipt.findFirst({
      where: { id: grnId, organizationId: user.organizationId },
      include: {
        purchaseOrder: { include: { vendor: true } },
        lines: { include: { purchaseOrderLine: { include: { item: true } } } },
      },
    });
    if (!grn) throw new NotFoundException('Goods receipt not found');

    // SCM-04: goods land in a location (default: first warehouse).
    const location = await this.prisma.location.findFirst({
      where: { organizationId: user.organizationId, locationType: 'WAREHOUSE' },
      orderBy: { code: 'asc' },
    });
    if (!location) throw new BadRequestException('No stock location found — re-run the seed');

    const po = grn.purchaseOrder;
    let materialCost = 0;

    await this.engine.transition(user, {
      documentType: 'GoodsReceipt',
      documentId: grn.id,
      actionCode: WF_ACTIONS.ACCEPT,
      comment,
      assigneeRoleId: null,
      eventPayload: { purchaseOrderId: po.id, purchaseOrderCode: po.code },
      apply: async (tx) => {
        for (const gl of grn.lines) {
          const pol = gl.purchaseOrderLine;
          const qty = Number(gl.qty);

          await tx.purchaseOrderLine.update({
            where: { id: pol.id },
            data: { receivedQty: { increment: qty } },
          });

          // SCM-05: serialised stock is born here, as entities not fields.
          if (pol.item.isSerialised) {
            await tx.serialUnit.createMany({
              data: gl.serials.map((serialNo) => ({
                organizationId: user.organizationId,
                itemId: pol.itemId,
                serialNo,
                batchNo: gl.batchNo,
                manufacturerVendorId: po.vendor.isManufacturer ? po.vendorId : null,
                goodsReceiptId: grn.id,
                projectId: po.projectId,
                currentState: 'IN_STOCK' as const,
                locationId: location.id,
              })),
            });
          } else {
            // Bulk stock: level up at the receiving location.
            await tx.stockLevel.upsert({
              where: {
                organizationId_itemId_locationId: {
                  organizationId: user.organizationId,
                  itemId: pol.itemId,
                  locationId: location.id,
                },
              },
              update: { qty: { increment: qty } },
              create: {
                organizationId: user.organizationId,
                itemId: pol.itemId,
                locationId: location.id,
                qty,
              },
            });
          }

          // Append-only movement trail (one row per receipt line).
          await tx.stockMovement.create({
            data: {
              organizationId: user.organizationId,
              itemId: pol.itemId,
              toLocationId: location.id,
              qty,
              movementType: 'RECEIPT',
              sourceType: 'GoodsReceipt',
              sourceId: grn.id,
            },
          });

          // PRJ-03: append-only actual cost, per WBS bucket of the PO line.
          const amount = round2(qty * Number(pol.unitPrice));
          materialCost += amount;
          if (po.projectId) {
            await tx.projectCostEntry.create({
              data: {
                organizationId: user.organizationId,
                projectId: po.projectId,
                wbsElementId: pol.wbsElementId,
                costType: 'MATERIAL',
                sourceType: 'GoodsReceipt',
                sourceId: grn.id,
                amount,
                memo: `${grn.code} · ${pol.item.sku} × ${qty} @ ${Number(pol.unitPrice)}`,
              },
            });
          }
        }

        await tx.goodsReceipt.update({ where: { id: grn.id }, data: { status: 'ACCEPTED' } });

        // Fully received when every line's receivedQty reaches its qty.
        const fresh = await tx.purchaseOrderLine.findMany({ where: { purchaseOrderId: po.id } });
        const fullyReceived = fresh.every((l) => Number(l.receivedQty) >= Number(l.qty) - 1e-9);
        await tx.purchaseOrder.update({
          where: { id: po.id },
          data: { status: fullyReceived ? 'RECEIVED' : 'PARTIALLY_RECEIVED' },
        });

        await this.audit.record(
          {
            organizationId: user.organizationId,
            actorId: user.userId,
            entityType: 'GoodsReceipt',
            entityId: grn.id,
            action: 'ACCEPT',
            after: {
              code: grn.code,
              poCode: po.code,
              materialCost: round2(materialCost),
              fullyReceived,
            },
          },
          tx,
        );
      },
    });

    return this.prisma.goodsReceipt.findUnique({
      where: { id: grn.id },
      include: { lines: true, serialUnits: true },
    });
  }

  private async ownedGrn(user: AuthUser, id: string) {
    const grn = await this.prisma.goodsReceipt.findFirst({
      where: { id, organizationId: user.organizationId },
    });
    if (!grn) throw new NotFoundException('Goods receipt not found');
    return grn;
  }

  // ── Vendor bill (SCM↔FIN) ────────────────────────────────────────────────
  //
  // §7: مسجَّلة ← مطابقة ثلاثياً ← معتمدة ← مجدولة للدفع ← مدفوعة.
  //
  // The journal moved with the states, and that is the substantive change in
  // this file. A bill used to be created already POSTED: recording what a
  // supplier sent and accepting the liability for it were one irreversible
  // act, so a disputed invoice was already in the ledger before anyone read
  // it. Dr WIP + Dr VAT Input / Cr AP now waits for APPROVED — which is what
  // makes "مطابقة" and "معتمدة" mean anything rather than decorate a screen.

  /**
   * Record what the vendor sent. No journal — this is their paperwork, not yet
   * our liability.
   */
  async createBill(user: AuthUser, dto: CreateBillDto) {
    const grn = await this.prisma.goodsReceipt.findFirst({
      where: { id: dto.goodsReceiptId, organizationId: user.organizationId },
      include: {
        purchaseOrder: { include: { vendor: true } },
        lines: { include: { purchaseOrderLine: true } },
        vendorBills: { select: { id: true } },
      },
    });
    if (!grn) throw new NotFoundException('Goods receipt not found');
    if (grn.vendorBills.length > 0) {
      throw new BadRequestException('Goods receipt is already billed');
    }
    // Billing goods nobody accepted is how a disputed delivery gets paid for.
    if (grn.status !== 'ACCEPTED') {
      throw new BadRequestException(
        `${grn.code} has not been accepted yet — inspect and accept the delivery before billing it`,
      );
    }

    const subtotal = round2(
      grn.lines.reduce((s, l) => s + Number(l.qty) * Number(l.purchaseOrderLine.unitPrice), 0),
    );
    const { rate: vatRate } = await this.tax.standardVat(user.organizationId);
    const vatAmount = round2(subtotal * (vatRate / 100));
    const total = round2(subtotal + vatAmount);

    return this.prisma.$transaction(async (tx) => {
      const code = await this.numbering.next(user.organizationId, 'VENDOR_BILL', tx);
      const bill = await tx.vendorBill.create({
        data: {
          organizationId: user.organizationId,
          code,
          vendorId: grn.purchaseOrder.vendorId,
          purchaseOrderId: grn.purchaseOrderId,
          goodsReceiptId: grn.id,
          subtotal,
          vatAmount,
          total,
          status: 'DRAFT',
          vendorRef: dto.vendorRef,
        },
      });

      await this.engine.open(tx, {
        organizationId: user.organizationId,
        flowCode: WF_FLOWS.VENDOR_BILL,
        documentId: bill.id,
        documentCode: bill.code,
        assigneeRoleId: user.roleId,
      });

      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'VendorBill',
          entityId: bill.id,
          action: 'RECORD',
          after: { code, subtotal, vatAmount, total },
        },
        tx,
      );
      return bill;
    });
  }

  /**
   * §7: مسجَّلة ← مطابقة ثلاثياً — the PO, the receipt and the invoice compared.
   *
   * The comparison is recorded, not just decided: an auditor needs the three
   * quantities and the two values that were weighed, and the tolerance that was
   * in force when they were. A variance does not fail the call — it produces a
   * match row saying which way it went, and the engine's condition on the
   * APPROVE transition is what refuses to let a mismatched bill be approved.
   */
  async matchBill(user: AuthUser, billId: string, comment?: string) {
    const bill = await this.prisma.vendorBill.findFirst({
      where: { id: billId, organizationId: user.organizationId },
      include: {
        purchaseOrder: { include: { lines: true } },
        goodsReceipt: { include: { lines: { include: { purchaseOrderLine: true } } } },
      },
    });
    if (!bill) throw new NotFoundException('Vendor bill not found');
    if (!bill.purchaseOrder || !bill.goodsReceipt) {
      throw new BadRequestException(
        'This bill is not linked to a purchase order and receipt — there is nothing to match against',
      );
    }

    const orderedQty = bill.purchaseOrder.lines.reduce((s, l) => s + Number(l.qty), 0);
    const receivedQty = bill.goodsReceipt.lines.reduce((s, l) => s + Number(l.qty), 0);
    const receivedValue = round2(
      bill.goodsReceipt.lines.reduce(
        (s, l) => s + Number(l.qty) * Number(l.purchaseOrderLine.unitPrice),
        0,
      ),
    );
    // The invoice is compared on its net of VAT: tax is not a purchasing
    // variance, and including it would flag every bill the moment a rate moves.
    const billedValue = Number(bill.subtotal);
    // Absent an itemised vendor invoice, the billed quantity is what the
    // receipt says was billed for. Stated plainly here rather than implied, so
    // a future itemised-invoice feature knows exactly what it is replacing.
    const billedQty = receivedQty;

    const inputs = { orderedQty, receivedQty, billedQty, receivedValue, billedValue };
    const result = evaluateThreeWayMatch(inputs, THREE_WAY_MATCH_TOLERANCE_PCT);

    await this.engine.transition(user, {
      documentType: 'VendorBill',
      documentId: bill.id,
      actionCode: WF_ACTIONS.MATCH,
      comment,
      context: { matchResult: result, total: Number(bill.total) },
      assigneeRoleId: user.roleId,
      eventPayload: { result, ...inputs },
      apply: async (tx) => {
        await tx.threeWayMatch.upsert({
          where: { vendorBillId: bill.id },
          update: {
            result,
            orderedQty,
            receivedQty,
            billedQty,
            receivedValue,
            billedValue,
            tolerancePct: THREE_WAY_MATCH_TOLERANCE_PCT,
            detailJson: inputs as unknown as Prisma.InputJsonValue,
            matchedAt: new Date(),
            matchedById: user.userId,
          },
          create: {
            organizationId: user.organizationId,
            vendorBillId: bill.id,
            purchaseOrderId: bill.purchaseOrderId!,
            goodsReceiptId: bill.goodsReceiptId!,
            result,
            orderedQty,
            receivedQty,
            billedQty,
            receivedValue,
            billedValue,
            tolerancePct: THREE_WAY_MATCH_TOLERANCE_PCT,
            detailJson: inputs as unknown as Prisma.InputJsonValue,
            matchedById: user.userId,
          },
        });
        await tx.vendorBill.update({ where: { id: bill.id }, data: { status: 'MATCHED' } });
      },
    });

    return this.prisma.vendorBill.findUnique({
      where: { id: bill.id },
      include: { threeWayMatch: true },
    });
  }

  /**
   * §7: مطابقة ← معتمدة, and the only place a vendor bill reaches the ledger.
   *
   * The engine refuses this transition unless the match came back MATCHED (the
   * condition lives on the transition row, so a company that wants to allow
   * approving a price variance can change it without a deploy). Approving is
   * what accepts the liability, so it is also what posts the journal.
   */
  async approveBill(user: AuthUser, billId: string, comment?: string) {
    const bill = await this.prisma.vendorBill.findFirst({
      where: { id: billId, organizationId: user.organizationId },
      include: {
        purchaseOrder: { include: { vendor: true } },
        goodsReceipt: { select: { code: true } },
        threeWayMatch: { select: { result: true } },
      },
    });
    if (!bill) throw new NotFoundException('Vendor bill not found');

    const subtotal = Number(bill.subtotal);
    const vatAmount = Number(bill.vatAmount);
    const total = Number(bill.total);
    const currency = bill.purchaseOrder?.currency ?? 'SAR';

    const acc = await this.posting.accounts(user.organizationId, [
      'WIP',
      'VAT_INPUT',
      'AP',
    ] as const);

    await this.engine.transition(user, {
      documentType: 'VendorBill',
      documentId: bill.id,
      actionCode: WF_ACTIONS.APPROVE,
      comment,
      context: { matchResult: bill.threeWayMatch?.result ?? null, total },
      assigneeRoleId: user.roleId,
      eventPayload: { total, purchaseOrderId: bill.purchaseOrderId },
      apply: async (tx) => {
        await tx.vendorBill.update({ where: { id: bill.id }, data: { status: 'APPROVED' } });

        await this.posting.journal(tx, {
          organizationId: user.organizationId,
          sourceType: 'VendorBill',
          sourceId: bill.id,
          // Project dimension: this is what makes the WIP balance readable per
          // project when cost of revenue is recognised.
          projectId: bill.purchaseOrder?.projectId ?? null,
          memo: `Vendor bill ${bill.code} — ${bill.purchaseOrder?.vendor.nameEn ?? ''} (${bill.goodsReceipt?.code ?? ''})`,
          lines: [
            { accountId: acc.WIP, debit: subtotal, credit: 0, currency },
            { accountId: acc.VAT_INPUT, debit: vatAmount, credit: 0, currency },
            { accountId: acc.AP, debit: 0, credit: total, currency },
          ],
        });

        await this.audit.record(
          {
            organizationId: user.organizationId,
            actorId: user.userId,
            entityType: 'VendorBill',
            entityId: bill.id,
            action: 'POST',
            after: { code: bill.code, subtotal, vatAmount, total },
          },
          tx,
        );
      },
    });

    return this.prisma.vendorBill.findUnique({ where: { id: bill.id } });
  }

  /** §7: معتمدة ← مجدولة للدفع. The queue the payment run draws from. */
  async scheduleBill(user: AuthUser, billId: string, comment?: string) {
    const bill = await this.prisma.vendorBill.findFirst({
      where: { id: billId, organizationId: user.organizationId },
    });
    if (!bill) throw new NotFoundException('Vendor bill not found');

    await this.engine.transition(user, {
      documentType: 'VendorBill',
      documentId: bill.id,
      actionCode: WF_ACTIONS.SCHEDULE,
      comment,
      context: { total: Number(bill.total) },
      assigneeRoleId: user.roleId,
      apply: async (tx) => {
        await tx.vendorBill.update({ where: { id: bill.id }, data: { status: 'SCHEDULED' } });
      },
    });
    return this.prisma.vendorBill.findUnique({ where: { id: bill.id } });
  }

  // ── the outbox subscribers this module owns ───────────────────────────────

  /**
   * §6: `po.approved ← إنشاء التزام محاسبي`.
   *
   * Committed cost is not actual cost and does not belong in the ledger: no
   * money has moved and no liability exists yet. It belongs in the project's
   * own commitment ledger, which is what stops a project reading as
   * under-spent while half a million riyals of approved POs are in flight
   * against it.
   *
   * Idempotent: a second delivery of the same event finds the commitment row
   * already there and does nothing.
   */
  private async bookCommitment(organizationId: string, purchaseOrderId: string): Promise<void> {
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id: purchaseOrderId, organizationId },
      include: { lines: { select: { wbsElementId: true, lineTotal: true } } },
    });
    if (!po?.projectId) return; // No project dimension: nothing to commit against.

    const existing = await this.prisma.projectCommitment.count({
      where: { sourceType: 'PurchaseOrder', sourceId: po.id },
    });
    if (existing > 0) return;

    await this.prisma.projectCommitment.createMany({
      data: po.lines.map((l) => ({
        organizationId,
        projectId: po.projectId!,
        wbsElementId: l.wbsElementId,
        sourceType: 'PurchaseOrder',
        sourceId: po.id,
        amount: l.lineTotal,
        memo: `Committed by ${po.code}`,
      })),
    });
  }

  /**
   * The mirror of bookCommitment: once a bill is approved the cost is actual,
   * and leaving the commitment standing would count it twice.
   */
  private async releaseCommitment(organizationId: string, vendorBillId: string): Promise<void> {
    const bill = await this.prisma.vendorBill.findFirst({
      where: { id: vendorBillId, organizationId },
      select: { id: true, code: true, purchaseOrderId: true, subtotal: true },
    });
    if (!bill?.purchaseOrderId) return;

    const already = await this.prisma.projectCommitment.count({
      where: { sourceType: 'Release', sourceId: bill.id },
    });
    if (already > 0) return;

    const committed = await this.prisma.projectCommitment.findMany({
      where: { sourceType: 'PurchaseOrder', sourceId: bill.purchaseOrderId },
    });
    if (committed.length === 0) return;

    // A releasing row per committed row, so the release lands in the same WBS
    // buckets the commitment did. Capped at what was committed: an invoice
    // above the PO must not release more than was ever set aside.
    const totalCommitted = committed.reduce((s, c) => s + Number(c.amount), 0);
    if (totalCommitted <= 0) return;
    const releasable = Math.min(Number(bill.subtotal), totalCommitted);

    await this.prisma.projectCommitment.createMany({
      data: committed.map((c) => ({
        organizationId,
        projectId: c.projectId,
        wbsElementId: c.wbsElementId,
        sourceType: 'Release',
        sourceId: bill.id,
        amount: -round2((Number(c.amount) / totalCommitted) * releasable),
        memo: `Released by ${bill.code}`,
      })),
    });
  }

  /**
   * §6: `goods.received ← ... مطابقة ثلاثية`. Payables cannot know a delivery
   * was accepted without being told, and a receipt nobody bills is working
   * capital sitting still.
   *
   * Not best-effort: a handler that swallows its own failure would be marked
   * PROCESSED having done nothing. Throwing is what earns the retry.
   */
  private async inviteVendorBill(organizationId: string, goodsReceiptId: string): Promise<void> {
    const grn = await this.prisma.goodsReceipt.findFirst({
      where: { id: goodsReceiptId, organizationId },
      include: {
        purchaseOrder: { select: { code: true, vendor: { select: { nameAr: true, nameEn: true } } } },
        vendorBills: { select: { id: true } },
      },
    });
    if (!grn || grn.vendorBills.length > 0 || grn.status !== 'ACCEPTED') return;

    await this.notifications.notify({
      organizationId,
      permission: PERMISSIONS.PAYMENT_WRITE,
      type: 'GOODS_ACCEPTED',
      titleAr: `استلام مقبول بانتظار الفاتورة: ${grn.code}`,
      titleEn: `Accepted receipt awaiting invoice: ${grn.code}`,
      bodyAr: `قُبل الاستلام ${grn.code} على أمر الشراء ${grn.purchaseOrder.code} من ${grn.purchaseOrder.vendor.nameAr} — سجّل فاتورة المورّد وطابقها ثلاثياً.`,
      bodyEn: `${grn.code} on ${grn.purchaseOrder.code} from ${grn.purchaseOrder.vendor.nameEn} was accepted — record the vendor bill and run the three-way match.`,
      linkPath: '/payables',
    });
  }

  // ── Serial units (AST-01 minimal registry) ────────────────────────────────

  async listSerialUnits(
    user: AuthUser,
    q?: { search?: string; state?: string; take?: number; skip?: number },
  ) {
    const where = {
      organizationId: user.organizationId,
      ...(q?.state ? { currentState: q.state as any } : {}),
      ...(q?.search
        ? {
            OR: [
              { serialNo: { contains: q.search, mode: 'insensitive' as const } },
              { item: { sku: { contains: q.search, mode: 'insensitive' as const } } },
              { item: { nameAr: { contains: q.search, mode: 'insensitive' as const } } },
              { item: { nameEn: { contains: q.search, mode: 'insensitive' as const } } },
            ],
          }
        : {}),
    };
    const query = {
      where,
      include: {
        item: { select: { sku: true, nameAr: true, nameEn: true } },
        project: { select: { code: true } },
        goodsReceipt: { select: { code: true } },
        manufacturerVendor: { select: { nameAr: true, nameEn: true } },
        location: { select: { id: true, code: true, nameAr: true, nameEn: true } },
      },
      orderBy: { createdAt: 'desc' as const },
    };
    // With `take`, return a paginated envelope; otherwise the legacy array.
    if (q?.take !== undefined) {
      const [rows, total] = await Promise.all([
        this.prisma.serialUnit.findMany({ ...query, take: q.take, skip: q.skip ?? 0 }),
        this.prisma.serialUnit.count({ where }),
      ]);
      return { rows, total };
    }
    return this.prisma.serialUnit.findMany(query);
  }

  // ── Subcontracts & progress claims (PRJ-07) ───────────────────────────────

  listSubcontracts(user: AuthUser) {
    return this.prisma.subcontractAgreement.findMany({
      where: { organizationId: user.organizationId },
      include: {
        vendor: { select: { code: true, nameAr: true, nameEn: true } },
        project: { select: { id: true, code: true } },
        claims: { orderBy: { sequence: 'asc' } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createSubcontract(user: AuthUser, dto: CreateSubcontractDto) {
    const vendor = await this.prisma.vendor.findFirst({
      where: { id: dto.vendorId, organizationId: user.organizationId },
    });
    if (!vendor) throw new NotFoundException('Vendor not found');
    const project = await this.prisma.project.findFirst({
      where: { id: dto.projectId, organizationId: user.organizationId },
    });
    if (!project) throw new NotFoundException('Project not found');
    if (dto.wbsElementId) {
      const wbs = await this.prisma.wbsElement.findFirst({
        where: { id: dto.wbsElementId, projectId: dto.projectId },
      });
      if (!wbs) throw new BadRequestException('WBS element does not belong to this project');
    }

    return this.prisma.$transaction(async (tx) => {
      const code = await this.numbering.next(user.organizationId, 'SUBCONTRACT', tx);
      const sub = await tx.subcontractAgreement.create({
        data: {
          organizationId: user.organizationId,
          code,
          vendorId: dto.vendorId,
          projectId: dto.projectId,
          wbsElementId: dto.wbsElementId,
          scopeAr: dto.scopeAr,
          scopeEn: dto.scopeEn,
          amount: dto.amount,
          retentionPct: dto.retentionPct ?? 0,
          status: 'ACTIVE',
        },
      });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'SubcontractAgreement',
          entityId: sub.id,
          action: 'CREATE',
          after: { code, amount: dto.amount, vendorId: dto.vendorId },
        },
        tx,
      );
      return sub;
    });
  }

  /** المستخلص: submit a progress claim against the agreement's remaining value. */
  async createClaim(user: AuthUser, agreementId: string, dto: CreateClaimDto) {
    const agreement = await this.prisma.subcontractAgreement.findFirst({
      where: { id: agreementId, organizationId: user.organizationId },
      include: { claims: { where: { status: { in: ['SUBMITTED', 'APPROVED', 'PAID'] } } } },
    });
    if (!agreement) throw new NotFoundException('Subcontract not found');
    if (agreement.status !== 'ACTIVE') {
      throw new BadRequestException('Subcontract must be ACTIVE to claim against');
    }
    const claimedSoFar = agreement.claims.reduce((s, c) => s + Number(c.claimedAmount), 0);
    if (claimedSoFar + dto.claimedAmount > Number(agreement.amount) + 1e-9) {
      throw new BadRequestException(
        `Claim exceeds agreement: claimed ${claimedSoFar} + ${dto.claimedAmount} > ${Number(agreement.amount)}`,
      );
    }

    const { rate: vatRate } = await this.tax.standardVat(user.organizationId);
    const vatAmount = round2(dto.claimedAmount * (vatRate / 100));
    const retention = round2(dto.claimedAmount * (Number(agreement.retentionPct) / 100));
    const netPayable = round2(dto.claimedAmount + vatAmount - retention);
    const sequence = agreement.claims.length + 1;

    return this.prisma.$transaction(async (tx) => {
      const code = await this.numbering.next(user.organizationId, 'CLAIM', tx);
      const claim = await tx.progressClaim.create({
        data: {
          organizationId: user.organizationId,
          code,
          agreementId,
          sequence,
          descriptionAr: dto.descriptionAr,
          descriptionEn: dto.descriptionEn,
          claimedAmount: dto.claimedAmount,
          vatAmount,
          retentionWithheld: retention,
          netPayable,
        },
      });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'ProgressClaim',
          entityId: claim.id,
          action: 'CREATE',
          after: { code, claimedAmount: dto.claimedAmount, retention },
        },
        tx,
      );
      return claim;
    });
  }

  /**
   * Claims run through the approval matrix on the claimed amount before any
   * accounting happens — the point of the gate is that a large claim does not
   * hit the ledger on one person's say-so.
   */
  async approveClaim(user: AuthUser, claimId: string) {
    const claim = await this.prisma.progressClaim.findFirst({
      where: { id: claimId, organizationId: user.organizationId },
    });
    if (!claim) throw new NotFoundException('Claim not found');
    if (claim.status !== 'SUBMITTED') {
      throw new BadRequestException('Only submitted claims can be approved');
    }

    const verdict = await this.approvals.gate(user, {
      documentType: 'PROGRESS_CLAIM',
      documentId: claim.id,
      documentCode: claim.code,
      amount: Number(claim.claimedAmount),
    });
    if (verdict.cleared && !user.permissions.includes(PERMISSIONS.PROCUREMENT_APPROVE)) {
      // Separated rights (Step 1): a role that may write/submit but not approve must
      // not self-approve when no matrix band applies. Fail before any state change.
      throw new ForbiddenException('Approving this document requires the approve permission; no approval rule routes it to someone else');
    }
    if (!verdict.cleared) return { ...claim, pendingApproval: verdict.request };

    return this.applyClaimApproval(user, claimId);
  }

  /**
   * Approval posts the back-to-back accounting: SUBCONTRACT actual cost on the
   * project, and the AP journal — Dr WIP + Dr VAT input / Cr AP (net) + Cr
   * subcontractor retention payable (2050).
   */
  private async applyClaimApproval(user: AuthUser, claimId: string) {
    const claim = await this.prisma.progressClaim.findFirst({
      where: { id: claimId, organizationId: user.organizationId },
      include: { agreement: { include: { vendor: true } } },
    });
    if (!claim) throw new NotFoundException('Claim not found');
    if (claim.status !== 'SUBMITTED') {
      throw new BadRequestException('Only submitted claims can be approved');
    }

    const claimed = Number(claim.claimedAmount);
    const vat = Number(claim.vatAmount);
    const retention = Number(claim.retentionWithheld);
    const net = Number(claim.netPayable);

    const acc = await this.posting.accounts(user.organizationId, [
      'WIP',
      'VAT_INPUT',
      'AP',
      'RETENTION_PAYABLE',
    ] as const);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.progressClaim.update({
        where: { id: claim.id },
        data: { status: 'APPROVED', approvedAt: new Date(), approvedById: user.userId },
      });

      await tx.projectCostEntry.create({
        data: {
          organizationId: user.organizationId,
          projectId: claim.agreement.projectId,
          wbsElementId: claim.agreement.wbsElementId,
          costType: 'SUBCONTRACT',
          sourceType: 'ProgressClaim',
          sourceId: claim.id,
          amount: claimed,
          memo: `${claim.code} · ${claim.agreement.code} (${claim.agreement.vendor.nameEn})`,
        },
      });

      const lines = [
        { accountId: acc.WIP, debit: claimed, credit: 0 },
        { accountId: acc.VAT_INPUT, debit: vat, credit: 0 },
        { accountId: acc.AP, debit: 0, credit: net },
      ];
      if (retention > 0) lines.push({ accountId: acc.RETENTION_PAYABLE, debit: 0, credit: retention });
      await this.posting.journal(tx, {
        organizationId: user.organizationId,
        sourceType: 'ProgressClaim',
        sourceId: claim.id,
        projectId: claim.agreement.projectId,
        memo: `Progress claim ${claim.code} — ${claim.agreement.vendor.nameEn}`,
        lines,
      });

      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'ProgressClaim',
          entityId: claim.id,
          action: 'APPROVE',
          after: { claimed, vat, retention, net },
        },
        tx,
      );
      return updated;
    });
  }

  // ── Locations, stock levels & transfers (SCM-04) ──────────────────────────

  listLocations(user: AuthUser) {
    return this.prisma.location.findMany({
      where: { organizationId: user.organizationId },
      include: {
        project: { select: { code: true } },
        _count: { select: { serialUnits: true } },
      },
      orderBy: { code: 'asc' },
    });
  }

  listStock(user: AuthUser) {
    return this.prisma.stockLevel.findMany({
      where: { organizationId: user.organizationId, qty: { gt: 0 } },
      include: {
        item: { select: { sku: true, nameAr: true, nameEn: true, uom: true } },
        location: { select: { code: true, nameAr: true, nameEn: true, locationType: true } },
      },
      orderBy: [{ location: { code: 'asc' } }, { item: { sku: 'asc' } }],
    });
  }

  /** Move a serial unit or a bulk quantity between locations. */
  async transfer(user: AuthUser, dto: TransferDto) {
    const to = await this.prisma.location.findFirst({
      where: { id: dto.toLocationId, organizationId: user.organizationId },
    });
    if (!to) throw new NotFoundException('Destination location not found');

    if (dto.serialUnitId) {
      const unit = await this.prisma.serialUnit.findFirst({
        where: { id: dto.serialUnitId, organizationId: user.organizationId },
      });
      if (!unit) throw new NotFoundException('Serial unit not found');
      if (unit.currentState !== 'IN_STOCK') {
        throw new BadRequestException(`Serial is ${unit.currentState} — only IN_STOCK stock moves`);
      }
      if (unit.locationId === to.id) throw new BadRequestException('Serial is already at that location');

      return this.prisma.$transaction(async (tx) => {
        const moved = await tx.serialUnit.update({
          where: { id: unit.id },
          data: { locationId: to.id },
        });
        await tx.stockMovement.create({
          data: {
            organizationId: user.organizationId,
            itemId: unit.itemId,
            serialUnitId: unit.id,
            fromLocationId: unit.locationId,
            toLocationId: to.id,
            qty: 1,
            movementType: 'TRANSFER',
          },
        });
        return moved;
      });
    }

    // Bulk transfer.
    if (!dto.itemId || !dto.qty || !dto.fromLocationId) {
      throw new BadRequestException('Bulk transfer needs itemId, qty and fromLocationId');
    }
    if (dto.fromLocationId === to.id) throw new BadRequestException('Source equals destination');
    const level = await this.prisma.stockLevel.findFirst({
      where: {
        organizationId: user.organizationId,
        itemId: dto.itemId,
        locationId: dto.fromLocationId,
      },
    });
    if (!level || Number(level.qty) < dto.qty - 1e-9) {
      throw new BadRequestException(
        `Insufficient stock at source: have ${Number(level?.qty ?? 0)}, moving ${dto.qty}`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.stockLevel.update({
        where: { id: level.id },
        data: { qty: { decrement: dto.qty } },
      });
      await tx.stockLevel.upsert({
        where: {
          organizationId_itemId_locationId: {
            organizationId: user.organizationId,
            itemId: dto.itemId!,
            locationId: to.id,
          },
        },
        update: { qty: { increment: dto.qty } },
        create: {
          organizationId: user.organizationId,
          itemId: dto.itemId!,
          locationId: to.id,
          qty: dto.qty!,
        },
      });
      return tx.stockMovement.create({
        data: {
          organizationId: user.organizationId,
          itemId: dto.itemId!,
          fromLocationId: dto.fromLocationId,
          toLocationId: to.id,
          qty: dto.qty!,
          movementType: 'TRANSFER',
        },
      });
    });
  }

  /**
   * AST-01: installation flips the serial from stock into an operating asset.
   * The asset register row is created here — under the project's PLANT root
   * (created on first install) — so work orders and warranties can hang off it.
   */
  async installSerialUnit(user: AuthUser, id: string) {
    const unit = await this.prisma.serialUnit.findFirst({
      where: { id, organizationId: user.organizationId },
      include: { item: true, asset: { select: { id: true } } },
    });
    if (!unit) throw new NotFoundException('Serial unit not found');
    if (unit.currentState !== 'IN_STOCK') {
      throw new BadRequestException(`Serial is ${unit.currentState}, only IN_STOCK can be installed`);
    }

    const assetTypeByCategory: Record<string, 'MODULE' | 'INVERTER' | 'EQUIPMENT'> = {
      MODULE: 'MODULE',
      INVERTER: 'INVERTER',
    };

    const updated = await this.prisma.$transaction(async (tx) => {
      const installed = await tx.serialUnit.update({
        where: { id },
        data: { currentState: 'INSTALLED', installedAt: new Date() },
      });

      if (!unit.asset) {
        // PLANT root per project (or org-level for stockless installs).
        let plant = await tx.asset.findFirst({
          where: {
            organizationId: user.organizationId,
            assetType: 'PLANT',
            projectId: unit.projectId ?? null,
          },
        });
        if (!plant) {
          const plantCode = await this.numbering.next(user.organizationId, 'ASSET', tx);
          const project = unit.projectId
            ? await tx.project.findUnique({ where: { id: unit.projectId }, select: { nameAr: true, nameEn: true } })
            : null;
          plant = await tx.asset.create({
            data: {
              organizationId: user.organizationId,
              code: plantCode,
              assetType: 'PLANT',
              projectId: unit.projectId,
              nameAr: project ? `محطة — ${project.nameAr}` : 'محطة عامة',
              nameEn: project ? `Plant — ${project.nameEn}` : 'General plant',
            },
          });
        }

        const code = await this.numbering.next(user.organizationId, 'ASSET', tx);
        await tx.asset.create({
          data: {
            organizationId: user.organizationId,
            code,
            parentAssetId: plant.id,
            projectId: unit.projectId,
            assetType: assetTypeByCategory[unit.item.itemCategory] ?? 'EQUIPMENT',
            nameAr: `${unit.item.nameAr} — ${unit.serialNo}`,
            nameEn: `${unit.item.nameEn} — ${unit.serialNo}`,
            serialUnitId: unit.id,
            installDate: new Date(),
          },
        });
      }

      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'SerialUnit',
          entityId: id,
          action: 'INSTALL',
          before: { currentState: 'IN_STOCK' },
          after: { currentState: 'INSTALLED', assetCreated: !unit.asset },
        },
        tx,
      );
      return installed;
    });
    return updated;
  }
}
