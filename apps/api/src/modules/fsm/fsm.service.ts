import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NumberingService } from '../../common/numbering.service';
import { AuditService } from '../../common/audit.service';
import type { AuthUser } from '../../common/auth-user';
import type {
  AddPartDto,
  AddTimeDto,
  AssignDto,
  CompleteDto,
  CreatePlanDto,
  CreateWarrantyClaimDto,
  CreateWorkOrderDto,
  ReplaceSerialDto,
} from './dto';

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

@Injectable()
export class FsmService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
  ) {}

  // ── Asset register (AST-01) ───────────────────────────────────────────────

  listAssets(user: AuthUser) {
    return this.prisma.asset.findMany({
      where: { organizationId: user.organizationId },
      include: {
        parent: { select: { code: true } },
        project: { select: { code: true } },
        serialUnit: { select: { serialNo: true } },
        _count: { select: { workOrders: true, children: true } },
      },
      orderBy: [{ assetType: 'asc' }, { code: 'asc' }],
    });
  }

  /** Field crew for dispatch dropdowns (FSM-05 light). */
  listTechnicians(user: AuthUser) {
    return this.prisma.user.findMany({
      where: { organizationId: user.organizationId, isActive: true },
      select: { id: true, nameAr: true, nameEn: true, email: true },
      orderBy: { nameEn: 'asc' },
    });
  }

  // ── Work orders (FSM-01) ──────────────────────────────────────────────────

  async summary(user: AuthUser) {
    const org = user.organizationId;
    const now = new Date();
    const [open, inProgress, overdue, closedThisMonth] = await Promise.all([
      this.prisma.workOrder.count({
        where: { organizationId: org, status: { in: ['OPEN', 'ASSIGNED'] } },
      }),
      this.prisma.workOrder.count({ where: { organizationId: org, status: 'IN_PROGRESS' } }),
      this.prisma.workOrder.count({
        where: {
          organizationId: org,
          status: { in: ['OPEN', 'ASSIGNED', 'IN_PROGRESS'] },
          slaDueAt: { lt: now },
        },
      }),
      this.prisma.workOrder.count({
        where: {
          organizationId: org,
          status: 'CLOSED',
          closedAt: { gte: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)) },
        },
      }),
    ]);
    return { open, inProgress, overdue, closedThisMonth };
  }

  list(user: AuthUser) {
    return this.prisma.workOrder.findMany({
      where: { organizationId: user.organizationId },
      include: {
        asset: { select: { code: true, nameAr: true, nameEn: true } },
        project: { select: { code: true } },
        assignedTo: { select: { nameAr: true, nameEn: true } },
        _count: { select: { parts: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(user: AuthUser, id: string) {
    const wo = await this.prisma.workOrder.findFirst({
      where: { id, organizationId: user.organizationId },
      include: {
        asset: { select: { id: true, code: true, nameAr: true, nameEn: true, assetType: true } },
        project: { select: { id: true, code: true } },
        assignedTo: { select: { id: true, nameAr: true, nameEn: true } },
        maintenancePlan: { select: { code: true, nameAr: true, nameEn: true } },
        parts: { include: { item: { select: { sku: true, nameAr: true, nameEn: true, uom: true } } } },
        timesheets: {
          include: { user: { select: { nameAr: true, nameEn: true } } },
          orderBy: { workDate: 'desc' },
        },
      },
    });
    if (!wo) throw new NotFoundException('Work order not found');
    const partsCost = round2(wo.parts.reduce((s, p) => s + Number(p.totalCost), 0));
    const labourCost = round2(wo.timesheets.reduce((s, ts) => s + Number(ts.amount), 0));
    return { ...wo, partsCost, labourCost };
  }

  async create(user: AuthUser, dto: CreateWorkOrderDto) {
    let projectId = dto.projectId;
    if (dto.assetId) {
      const asset = await this.prisma.asset.findFirst({
        where: { id: dto.assetId, organizationId: user.organizationId },
      });
      if (!asset) throw new NotFoundException('Asset not found');
      projectId = projectId ?? asset.projectId ?? undefined;
    }

    return this.prisma.$transaction(async (tx) => {
      const code = await this.numbering.next(user.organizationId, 'WORK_ORDER', tx);
      const wo = await tx.workOrder.create({
        data: {
          organizationId: user.organizationId,
          code,
          titleAr: dto.titleAr,
          titleEn: dto.titleEn,
          description: dto.description,
          woType: dto.woType ?? 'CORRECTIVE',
          priority: dto.priority ?? 'MEDIUM',
          assetId: dto.assetId,
          projectId,
          scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : undefined,
          slaDueAt: dto.slaDueAt ? new Date(dto.slaDueAt) : undefined,
          assignedToId: dto.assignedToId,
          status: dto.assignedToId ? 'ASSIGNED' : 'OPEN',
        },
      });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'WorkOrder',
          entityId: wo.id,
          action: 'CREATE',
          after: { code, woType: wo.woType, priority: wo.priority },
        },
        tx,
      );
      return wo;
    });
  }

  private async mustGet(user: AuthUser, id: string) {
    const wo = await this.prisma.workOrder.findFirst({
      where: { id, organizationId: user.organizationId },
    });
    if (!wo) throw new NotFoundException('Work order not found');
    return wo;
  }

  async assign(user: AuthUser, id: string, dto: AssignDto) {
    const wo = await this.mustGet(user, id);
    if (!['OPEN', 'ASSIGNED'].includes(wo.status)) {
      throw new BadRequestException(`Cannot assign a ${wo.status} work order`);
    }
    const tech = await this.prisma.user.findFirst({
      where: { id: dto.assignedToId, organizationId: user.organizationId, isActive: true },
    });
    if (!tech) throw new NotFoundException('Technician not found');

    const updated = await this.prisma.workOrder.update({
      where: { id },
      data: {
        assignedToId: dto.assignedToId,
        scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : wo.scheduledAt,
        status: 'ASSIGNED',
      },
    });
    await this.audit.record({
      organizationId: user.organizationId,
      actorId: user.userId,
      entityType: 'WorkOrder',
      entityId: id,
      action: 'ASSIGN',
      after: { assignedToId: dto.assignedToId },
    });
    return updated;
  }

  async start(user: AuthUser, id: string) {
    const wo = await this.mustGet(user, id);
    if (!['OPEN', 'ASSIGNED'].includes(wo.status)) {
      throw new BadRequestException(`Cannot start a ${wo.status} work order`);
    }
    // Starting field work flags the asset as under maintenance.
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.workOrder.update({
        where: { id },
        data: { status: 'IN_PROGRESS', startedAt: new Date() },
      });
      if (wo.assetId) {
        await tx.asset.updateMany({
          where: { id: wo.assetId, status: 'OPERATING' },
          data: { status: 'UNDER_MAINTENANCE' },
        });
      }
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'WorkOrder',
          entityId: id,
          action: 'START',
          after: { status: 'IN_PROGRESS' },
        },
        tx,
      );
      return updated;
    });
  }

  /**
   * Spare-part consumption (SCM-07 seed): draws the qty from a stock location
   * (level −, ISSUE movement) and posts O&M MATERIAL cost on the project.
   */
  async addPart(user: AuthUser, id: string, dto: AddPartDto) {
    const wo = await this.mustGet(user, id);
    if (wo.status !== 'IN_PROGRESS') {
      throw new BadRequestException('Parts can only be added while the work order is in progress');
    }
    const item = await this.prisma.item.findFirst({
      where: { id: dto.itemId, organizationId: user.organizationId },
    });
    if (!item) throw new NotFoundException('Item not found');
    if (item.isSerialised) {
      throw new BadRequestException('Serialised items are replaced via the RMA flow (W7), not bulk parts');
    }
    const level = await this.prisma.stockLevel.findFirst({
      where: {
        organizationId: user.organizationId,
        itemId: dto.itemId,
        locationId: dto.fromLocationId,
      },
    });
    if (!level || Number(level.qty) < dto.qty - 1e-9) {
      throw new BadRequestException(
        `Insufficient stock at location: have ${Number(level?.qty ?? 0)}, need ${dto.qty}`,
      );
    }

    const unitCost = Number(item.unitCost);
    const totalCost = round2(dto.qty * unitCost);

    return this.prisma.$transaction(async (tx) => {
      const part = await tx.workOrderPart.create({
        data: {
          workOrderId: wo.id,
          itemId: dto.itemId,
          qty: dto.qty,
          fromLocationId: dto.fromLocationId,
          unitCost,
          totalCost,
        },
      });
      await tx.stockLevel.update({
        where: { id: level.id },
        data: { qty: { decrement: dto.qty } },
      });
      await tx.stockMovement.create({
        data: {
          organizationId: user.organizationId,
          itemId: dto.itemId,
          fromLocationId: dto.fromLocationId,
          qty: dto.qty,
          movementType: 'ISSUE',
          sourceType: 'WorkOrder',
          sourceId: wo.id,
        },
      });
      if (wo.projectId) {
        await tx.projectCostEntry.create({
          data: {
            organizationId: user.organizationId,
            projectId: wo.projectId,
            costType: 'MATERIAL',
            sourceType: 'WorkOrder',
            sourceId: wo.id,
            amount: totalCost,
            memo: `${wo.code} · ${item.sku} × ${dto.qty} @ ${unitCost}`,
          },
        });
      }
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'WorkOrder',
          entityId: wo.id,
          action: 'CONSUME_PART',
          after: { itemId: dto.itemId, qty: dto.qty, totalCost },
        },
        tx,
      );
      return part;
    });
  }

  async complete(user: AuthUser, id: string, dto: CompleteDto) {
    const wo = await this.mustGet(user, id);
    if (wo.status !== 'IN_PROGRESS') {
      throw new BadRequestException('Only in-progress work orders can be completed');
    }
    // FSM-04: mandatory checklist items must be ticked before completion.
    if (wo.maintenancePlanId) {
      const plan = await this.prisma.maintenancePlan.findUnique({
        where: { id: wo.maintenancePlanId },
        select: { checklistTemplateJson: true },
      });
      const template =
        (plan?.checklistTemplateJson as Array<{ labelAr?: string; labelEn: string; mandatory?: boolean }> | null) ?? [];
      const mandatory = template.filter((i) => i.mandatory);
      for (const m of mandatory) {
        // Match by either language so Arabic-only checklists remain closable.
        const result = dto.checklist?.find(
          (c: any) =>
            c.labelEn === m.labelEn ||
            c.label === m.labelEn ||
            (m.labelAr && (c.labelAr === m.labelAr || c.label === m.labelAr)),
        );
        if (!result?.done) {
          throw new BadRequestException(
            `Mandatory checklist item not done: ${m.labelAr ?? m.labelEn}`,
          );
        }
      }
    }

    const updated = await this.prisma.workOrder.update({
      where: { id },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        checklistJson: dto.checklist ? JSON.parse(JSON.stringify(dto.checklist)) : undefined,
      },
    });
    await this.audit.record({
      organizationId: user.organizationId,
      actorId: user.userId,
      entityType: 'WorkOrder',
      entityId: id,
      action: 'COMPLETE',
      after: { checklistItems: dto.checklist?.length ?? 0 },
    });
    return updated;
  }

  async close(user: AuthUser, id: string) {
    const wo = await this.mustGet(user, id);
    if (wo.status !== 'COMPLETED') {
      throw new BadRequestException('Only completed work orders can be closed');
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.workOrder.update({
        where: { id },
        data: { status: 'CLOSED', closedAt: new Date() },
      });
      // The asset returns to service when its work closes.
      if (wo.assetId) {
        await tx.asset.updateMany({
          where: { id: wo.assetId, status: 'UNDER_MAINTENANCE' },
          data: { status: 'OPERATING' },
        });
      }
      // FSM-11 loop closure: the alert that raised this work order is resolved.
      await tx.performanceAlert.updateMany({
        where: { workOrderId: wo.id, status: { not: 'RESOLVED' } },
        data: { status: 'RESOLVED', resolvedAt: new Date() },
      });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'WorkOrder',
          entityId: id,
          action: 'CLOSE',
          after: { status: 'CLOSED' },
        },
        tx,
      );
      return updated;
    });
  }

  async cancel(user: AuthUser, id: string) {
    const wo = await this.mustGet(user, id);
    if (['CLOSED', 'CANCELLED'].includes(wo.status)) {
      throw new BadRequestException(`Work order is already ${wo.status}`);
    }
    if (wo.status === 'IN_PROGRESS') {
      const parts = await this.prisma.workOrderPart.count({ where: { workOrderId: id } });
      if (parts > 0) {
        throw new BadRequestException('Cannot cancel: parts already consumed — complete and close instead');
      }
    }
    const updated = await this.prisma.workOrder.update({
      where: { id },
      data: { status: 'CANCELLED' },
    });
    await this.audit.record({
      organizationId: user.organizationId,
      actorId: user.userId,
      entityType: 'WorkOrder',
      entityId: id,
      action: 'CANCEL',
      before: { status: wo.status },
      after: { status: 'CANCELLED' },
    });
    return updated;
  }

  // ── Labour time (FSM-07) ──────────────────────────────────────────────────

  /** Field hours on a work order → Timesheet + LABOUR cost on the project. */
  async addTime(user: AuthUser, workOrderId: string, dto: AddTimeDto) {
    const wo = await this.mustGet(user, workOrderId);
    if (!['IN_PROGRESS', 'COMPLETED'].includes(wo.status)) {
      throw new BadRequestException('Hours are recorded on in-progress or completed work orders');
    }
    const techId = dto.userId ?? wo.assignedToId ?? user.userId;
    const tech = await this.prisma.user.findFirst({
      where: { id: techId, organizationId: user.organizationId },
    });
    if (!tech) throw new NotFoundException('Technician not found');

    const amount = round2(dto.hours * dto.hourlyRate);
    return this.prisma.$transaction(async (tx) => {
      const ts = await tx.timesheet.create({
        data: {
          organizationId: user.organizationId,
          workOrderId: wo.id,
          userId: techId,
          workDate: dto.workDate ? new Date(dto.workDate) : new Date(),
          hours: dto.hours,
          hourlyRate: dto.hourlyRate,
          amount,
          memo: dto.memo,
        },
      });
      if (wo.projectId) {
        await tx.projectCostEntry.create({
          data: {
            organizationId: user.organizationId,
            projectId: wo.projectId,
            costType: 'LABOUR',
            sourceType: 'Timesheet',
            sourceId: ts.id,
            amount,
            memo: `${wo.code} · ${tech.nameEn} × ${dto.hours}h @ ${dto.hourlyRate}`,
          },
        });
      }
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'Timesheet',
          entityId: ts.id,
          action: 'CREATE',
          after: { workOrderCode: wo.code, hours: dto.hours, amount },
        },
        tx,
      );
      return ts;
    });
  }

  // ── Warranty claims / RMA (FSM-09) ────────────────────────────────────────

  listClaims(user: AuthUser) {
    return this.prisma.warrantyClaim.findMany({
      where: { organizationId: user.organizationId },
      include: {
        serialUnit: { include: { item: { select: { id: true, sku: true, nameAr: true, nameEn: true } } } },
        replacementSerialUnit: { select: { serialNo: true } },
        manufacturerVendor: { select: { nameAr: true, nameEn: true } },
        workOrder: { select: { id: true, code: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** The serial goes FAULTY (and its asset with it); the claim targets its manufacturer. */
  async createClaim(user: AuthUser, dto: CreateWarrantyClaimDto) {
    const unit = await this.prisma.serialUnit.findFirst({
      where: { id: dto.serialUnitId, organizationId: user.organizationId },
      include: { asset: { select: { id: true } } },
    });
    if (!unit) throw new NotFoundException('Serial unit not found');
    if (!['INSTALLED', 'FAULTY'].includes(unit.currentState)) {
      throw new BadRequestException(`Serial is ${unit.currentState} — claims target installed units`);
    }
    const existing = await this.prisma.warrantyClaim.findFirst({
      where: {
        serialUnitId: unit.id,
        status: { in: ['DRAFT', 'SUBMITTED', 'APPROVED'] },
      },
    });
    if (existing) throw new BadRequestException(`Serial already has live claim ${existing.code}`);

    return this.prisma.$transaction(async (tx) => {
      const code = await this.numbering.next(user.organizationId, 'RMA', tx);
      const claim = await tx.warrantyClaim.create({
        data: {
          organizationId: user.organizationId,
          code,
          serialUnitId: unit.id,
          manufacturerVendorId: unit.manufacturerVendorId,
          workOrderId: dto.workOrderId,
          defectAr: dto.defectAr,
          defectEn: dto.defectEn,
        },
      });
      await tx.serialUnit.update({
        where: { id: unit.id },
        data: { currentState: 'FAULTY' },
      });
      if (unit.asset) {
        await tx.asset.update({ where: { id: unit.asset.id }, data: { status: 'FAULTY' } });
      }
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'WarrantyClaim',
          entityId: claim.id,
          action: 'CREATE',
          after: { code, serialUnitId: unit.id },
        },
        tx,
      );
      return claim;
    });
  }

  private async mustGetClaim(user: AuthUser, id: string) {
    const claim = await this.prisma.warrantyClaim.findFirst({
      where: { id, organizationId: user.organizationId },
      include: { serialUnit: { include: { asset: { select: { id: true } } } } },
    });
    if (!claim) throw new NotFoundException('Warranty claim not found');
    return claim;
  }

  async submitClaim(user: AuthUser, id: string) {
    const claim = await this.mustGetClaim(user, id);
    if (claim.status !== 'DRAFT') throw new BadRequestException(`Claim is ${claim.status}`);
    return this.prisma.warrantyClaim.update({
      where: { id },
      data: { status: 'SUBMITTED', submittedAt: new Date() },
    });
  }

  async approveClaim(user: AuthUser, id: string) {
    const claim = await this.mustGetClaim(user, id);
    if (claim.status !== 'SUBMITTED') throw new BadRequestException(`Claim is ${claim.status}`);
    return this.prisma.warrantyClaim.update({ where: { id }, data: { status: 'APPROVED' } });
  }

  async rejectClaim(user: AuthUser, id: string) {
    const claim = await this.mustGetClaim(user, id);
    if (!['DRAFT', 'SUBMITTED'].includes(claim.status)) {
      throw new BadRequestException(`Claim is ${claim.status}`);
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.warrantyClaim.update({
        where: { id },
        data: { status: 'REJECTED', resolvedAt: new Date() },
      });
      // Rejected: the unit stays faulty hardware-wise but returns to service state.
      await tx.serialUnit.update({
        where: { id: claim.serialUnitId },
        data: { currentState: 'INSTALLED' },
      });
      if (claim.serialUnit.asset) {
        await tx.asset.update({
          where: { id: claim.serialUnit.asset.id },
          data: { status: 'OPERATING' },
        });
      }
      return updated;
    });
  }

  /**
   * The point of the whole RMA design: replacement swaps the serial UNDER the
   * same asset, so the asset's operating history (readings, alerts, work
   * orders) survives the hardware change.
   */
  async replaceSerial(user: AuthUser, id: string, dto: ReplaceSerialDto) {
    const claim = await this.mustGetClaim(user, id);
    if (claim.status !== 'APPROVED') {
      throw new BadRequestException('Claim must be APPROVED before replacement');
    }
    const replacement = await this.prisma.serialUnit.findFirst({
      where: { id: dto.replacementSerialUnitId, organizationId: user.organizationId },
    });
    if (!replacement) throw new NotFoundException('Replacement serial not found');
    if (replacement.currentState !== 'IN_STOCK') {
      throw new BadRequestException(`Replacement is ${replacement.currentState} — must be IN_STOCK`);
    }
    if (replacement.itemId !== claim.serialUnit.itemId) {
      throw new BadRequestException('Replacement must be the same item as the faulty unit');
    }

    return this.prisma.$transaction(async (tx) => {
      // Old unit leaves the field.
      await tx.serialUnit.update({
        where: { id: claim.serialUnitId },
        data: { currentState: 'RETURNED' },
      });
      // New unit takes its place — and its asset.
      await tx.serialUnit.update({
        where: { id: replacement.id },
        data: {
          currentState: 'INSTALLED',
          installedAt: new Date(),
          projectId: claim.serialUnit.projectId,
        },
      });
      if (claim.serialUnit.asset) {
        await tx.asset.update({
          where: { id: claim.serialUnit.asset.id },
          data: { serialUnitId: replacement.id, status: 'OPERATING', installDate: new Date() },
        });
      }
      await tx.stockMovement.create({
        data: {
          organizationId: user.organizationId,
          itemId: replacement.itemId,
          serialUnitId: replacement.id,
          fromLocationId: replacement.locationId,
          qty: 1,
          movementType: 'ISSUE',
          sourceType: 'WarrantyClaim',
          sourceId: claim.id,
        },
      });
      const updated = await tx.warrantyClaim.update({
        where: { id: claim.id },
        data: {
          status: 'REPLACED',
          resolvedAt: new Date(),
          replacementSerialUnitId: replacement.id,
        },
      });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'WarrantyClaim',
          entityId: claim.id,
          action: 'REPLACE',
          before: { serialUnitId: claim.serialUnitId },
          after: { replacementSerialUnitId: replacement.id },
        },
        tx,
      );
      return updated;
    });
  }

  // ── Maintenance plans (FSM-02) ────────────────────────────────────────────

  listPlans(user: AuthUser) {
    return this.prisma.maintenancePlan.findMany({
      where: { organizationId: user.organizationId },
      include: {
        asset: { select: { code: true, nameAr: true, nameEn: true } },
        project: { select: { code: true } },
        _count: { select: { workOrders: true } },
      },
      orderBy: { nextDueAt: 'asc' },
    });
  }

  async createPlan(user: AuthUser, dto: CreatePlanDto) {
    if (dto.assetId) {
      const asset = await this.prisma.asset.findFirst({
        where: { id: dto.assetId, organizationId: user.organizationId },
      });
      if (!asset) throw new NotFoundException('Asset not found');
    }
    const firstDue = dto.firstDueAt ? new Date(dto.firstDueAt) : new Date();

    return this.prisma.$transaction(async (tx) => {
      const code = await this.numbering.next(user.organizationId, 'MAINTENANCE_PLAN', tx);
      const plan = await tx.maintenancePlan.create({
        data: {
          organizationId: user.organizationId,
          code,
          nameAr: dto.nameAr,
          nameEn: dto.nameEn,
          assetId: dto.assetId,
          projectId: dto.projectId,
          intervalDays: dto.intervalDays,
          nextDueAt: firstDue,
          checklistTemplateJson: dto.checklist
            ? JSON.parse(JSON.stringify(dto.checklist))
            : undefined,
        },
      });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'MaintenancePlan',
          entityId: plan.id,
          action: 'CREATE',
          after: { code, intervalDays: dto.intervalDays },
        },
        tx,
      );
      return plan;
    });
  }

  /**
   * FSM-02: materialise due plans into PREVENTIVE work orders and roll each
   * plan's nextDueAt forward by its interval. Idempotent per due window —
   * a plan generates at most one WO per call and its due date advances.
   */
  async generateDue(user: AuthUser) {
    const now = new Date();
    const due = await this.prisma.maintenancePlan.findMany({
      where: { organizationId: user.organizationId, isActive: true, nextDueAt: { lte: now } },
      include: { asset: { select: { id: true, projectId: true, nameAr: true, nameEn: true } } },
    });

    const generated: string[] = [];
    for (const plan of due) {
      await this.prisma.$transaction(async (tx) => {
        const code = await this.numbering.next(user.organizationId, 'WORK_ORDER', tx);
        // Copy the plan's checklist template onto the WO so the technician
        // actually sees the items (mandatory ones enforced at complete()).
        const template =
          (plan.checklistTemplateJson as Array<{ labelAr?: string; labelEn: string; mandatory?: boolean }> | null) ??
          [];
        const checklist = template.map((i) => ({
          label: i.labelAr ?? i.labelEn,
          labelAr: i.labelAr ?? i.labelEn,
          labelEn: i.labelEn,
          mandatory: !!i.mandatory,
          done: false,
        }));
        await tx.workOrder.create({
          data: {
            organizationId: user.organizationId,
            code,
            titleAr: `صيانة وقائية: ${plan.nameAr}`,
            titleEn: `Preventive maintenance: ${plan.nameEn}`,
            woType: 'PREVENTIVE',
            origin: 'PLAN',
            priority: 'MEDIUM',
            assetId: plan.assetId,
            projectId: plan.projectId ?? plan.asset?.projectId,
            maintenancePlanId: plan.id,
            scheduledAt: plan.nextDueAt,
            slaDueAt: new Date(plan.nextDueAt.getTime() + 7 * 24 * 3600 * 1000),
            checklistJson: checklist.length ? checklist : undefined,
          },
        });
        // Roll forward from the due date (not "now") so cadence never drifts.
        const next = new Date(plan.nextDueAt.getTime() + plan.intervalDays * 24 * 3600 * 1000);
        await tx.maintenancePlan.update({
          where: { id: plan.id },
          data: { nextDueAt: next, lastGeneratedAt: now },
        });
        await this.audit.record(
          {
            organizationId: user.organizationId,
            actorId: user.userId,
            entityType: 'MaintenancePlan',
            entityId: plan.id,
            action: 'GENERATE_WO',
            after: { workOrderCode: code, nextDueAt: next.toISOString() },
          },
          tx,
        );
        generated.push(code);
      });
    }
    return { generated, count: generated.length };
  }
}
