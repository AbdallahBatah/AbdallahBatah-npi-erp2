import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NumberingService } from '../../common/numbering.service';
import { AuditService } from '../../common/audit.service';
import { isValidStageTransition } from '@npi/shared';
import type { AuthUser } from '../../common/auth-user';
import type { CreateChangeOrderDto, CreateProjectDto, SetStageDto } from './dto';

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Category → WBS element definition used when budgeting from the accepted BOM. */
const WBS_BUCKETS: Record<string, { code: string; nameAr: string; nameEn: string }> = {
  MODULE: { code: 'PV', nameAr: 'الألواح الشمسية', nameEn: 'PV Modules' },
  INVERTER: { code: 'INV', nameAr: 'العواكس', nameEn: 'Inverters' },
  MOUNTING: { code: 'MNT', nameAr: 'هياكل التثبيت', nameEn: 'Mounting' },
  CABLE: { code: 'ELE', nameAr: 'الكهرباء والكابلات', nameEn: 'Electrical & Cables' },
  BOS: { code: 'BOS', nameAr: 'مكونات مساعدة', nameEn: 'Balance of System' },
  SPARE: { code: 'SPR', nameAr: 'قطع الغيار', nameEn: 'Spares' },
  SERVICE: { code: 'SRV', nameAr: 'الخدمات والتركيب', nameEn: 'Services & Installation' },
};

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
  ) {}

  list(user: AuthUser) {
    return this.prisma.project.findMany({
      where: { organizationId: user.organizationId },
      include: {
        contract: {
          select: {
            code: true,
            totalValue: true,
            customer: { select: { nameAr: true, nameEn: true } },
          },
        },
        _count: { select: { purchaseOrders: true, serialUnits: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * PRJ-01/02/04: create the execution project from an ACTIVE contract.
   * The WBS is budgeted from the accepted proposal BOM at catalogue unit cost,
   * bucketed by item category — the take-off baseline job costing measures
   * against (PRJ-03).
   */
  async createFromContract(user: AuthUser, dto: CreateProjectDto) {
    const contract = await this.prisma.contract.findFirst({
      where: { id: dto.contractId, organizationId: user.organizationId },
      include: {
        customer: { select: { nameAr: true, nameEn: true } },
        project: { select: { id: true } },
        proposalRevision: {
          include: {
            designVersion: { select: { capacityKwp: true } },
            bomLines: { include: { item: { select: { itemCategory: true, unitCost: true } } } },
          },
        },
      },
    });
    if (!contract) throw new NotFoundException('Contract not found');
    if (contract.status !== 'ACTIVE') {
      throw new BadRequestException('Contract must be ACTIVE before opening a project');
    }
    if (contract.project) {
      throw new BadRequestException('Contract already has a project');
    }

    // Budget per WBS bucket from the BOM at cost.
    const buckets = new Map<string, number>();
    for (const l of contract.proposalRevision?.bomLines ?? []) {
      const cat = l.item.itemCategory as string;
      const cost = Number(l.qty) * Number(l.item.unitCost);
      buckets.set(cat, (buckets.get(cat) ?? 0) + cost);
    }

    const capacity =
      dto.capacityKwp ??
      (contract.proposalRevision?.designVersion?.capacityKwp
        ? Number(contract.proposalRevision.designVersion.capacityKwp)
        : null);

    const project = await this.prisma.$transaction(async (tx) => {
      const code = await this.numbering.next(user.organizationId, 'PROJECT', tx);
      const created = await tx.project.create({
        data: {
          organizationId: user.organizationId,
          code,
          contractId: contract.id,
          nameAr: dto.nameAr ?? `مشروع ${contract.customer.nameAr} — ${contract.code}`,
          nameEn: dto.nameEn ?? `${contract.customer.nameEn} project — ${contract.code}`,
          siteRef: dto.siteRef,
          capacityKwp: capacity ?? undefined,
          plannedStart: dto.plannedStart ? new Date(dto.plannedStart) : undefined,
          plannedEnd: dto.plannedEnd ? new Date(dto.plannedEnd) : undefined,
          wbsElements: {
            create:
              buckets.size > 0
                ? [...buckets.entries()].map(([cat, budget]) => ({
                    code: WBS_BUCKETS[cat]?.code ?? cat,
                    nameAr: WBS_BUCKETS[cat]?.nameAr ?? cat,
                    nameEn: WBS_BUCKETS[cat]?.nameEn ?? cat,
                    budgetAmount: round2(budget),
                  }))
                : [{ code: 'GEN', nameAr: 'عام', nameEn: 'General', budgetAmount: 0 }],
          },
        },
        include: { wbsElements: true },
      });

      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'Project',
          entityId: created.id,
          action: 'CREATE',
          after: { code, contractId: contract.id, wbsCount: created.wbsElements.length },
        },
        tx,
      );
      return created;
    });

    return project;
  }

  /**
   * PRJ-03 job costing: budget (WBS) vs committed (approved, not-yet-received
   * PO value) vs actual (append-only cost entries), per WBS and in total.
   */
  async get(user: AuthUser, id: string) {
    const project = await this.prisma.project.findFirst({
      where: { id, organizationId: user.organizationId },
      include: {
        contract: {
          select: {
            id: true,
            code: true,
            totalValue: true,
            customer: { select: { nameAr: true, nameEn: true } },
          },
        },
        wbsElements: { orderBy: { code: 'asc' } },
        purchaseOrders: {
          include: {
            vendor: { select: { nameAr: true, nameEn: true } },
            lines: true,
          },
          orderBy: { createdAt: 'desc' },
        },
        costEntries: { orderBy: { postedAt: 'desc' } },
        serialUnits: {
          include: {
            item: { select: { sku: true, nameAr: true, nameEn: true } },
            location: { select: { code: true, nameAr: true, nameEn: true } },
          },
          orderBy: { createdAt: 'desc' },
        },
        changeOrders: { orderBy: { createdAt: 'desc' } },
        subcontracts: {
          include: {
            vendor: { select: { nameAr: true, nameEn: true } },
            claims: { orderBy: { sequence: 'asc' } },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    if (!project) throw new NotFoundException('Project not found');

    // Committed = approved PO value not yet turned into actuals (unreceived qty).
    const committedByWbs = new Map<string | null, number>();
    for (const po of project.purchaseOrders) {
      if (!['APPROVED', 'PARTIALLY_RECEIVED'].includes(po.status)) continue;
      for (const l of po.lines) {
        const openQty = Math.max(0, Number(l.qty) - Number(l.receivedQty));
        const open = openQty * Number(l.unitPrice);
        const key = l.wbsElementId ?? null;
        committedByWbs.set(key, (committedByWbs.get(key) ?? 0) + open);
      }
    }
    const actualByWbs = new Map<string | null, number>();
    for (const ce of project.costEntries) {
      const key = ce.wbsElementId ?? null;
      actualByWbs.set(key, (actualByWbs.get(key) ?? 0) + Number(ce.amount));
    }

    const wbs = project.wbsElements.map((w) => {
      const budget = Number(w.budgetAmount);
      const committed = round2(committedByWbs.get(w.id) ?? 0);
      const actual = round2(actualByWbs.get(w.id) ?? 0);
      return { ...w, committed, actual, variance: round2(budget - actual - committed) };
    });
    const totals = {
      budget: round2(wbs.reduce((s, w) => s + Number(w.budgetAmount), 0)),
      committed: round2(
        [...committedByWbs.values()].reduce((s, v) => s + v, 0),
      ),
      actual: round2([...actualByWbs.values()].reduce((s, v) => s + v, 0)),
    };

    return { ...project, wbsElements: wbs, costSummary: { ...totals, variance: round2(totals.budget - totals.actual - totals.committed) } };
  }

  // ── PRJ-06: change orders ─────────────────────────────────────────────────

  /** Draft a variation against the project's contract. */
  async createChangeOrder(user: AuthUser, projectId: string, dto: CreateChangeOrderDto) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, organizationId: user.organizationId },
      select: { id: true, contractId: true },
    });
    if (!project) throw new NotFoundException('Project not found');
    if (dto.wbsElementId) {
      const wbs = await this.prisma.wbsElement.findFirst({
        where: { id: dto.wbsElementId, projectId },
      });
      if (!wbs) throw new BadRequestException('WBS element does not belong to this project');
    }

    return this.prisma.$transaction(async (tx) => {
      const code = await this.numbering.next(user.organizationId, 'CHANGE_ORDER', tx);
      const co = await tx.changeOrder.create({
        data: {
          organizationId: user.organizationId,
          code,
          contractId: project.contractId,
          projectId,
          wbsElementId: dto.wbsElementId,
          descriptionAr: dto.descriptionAr,
          descriptionEn: dto.descriptionEn,
          amountDelta: dto.amountDelta,
          scheduleImpactDays: dto.scheduleImpactDays ?? 0,
        },
      });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'ChangeOrder',
          entityId: co.id,
          action: 'CREATE',
          after: { code, amountDelta: dto.amountDelta },
        },
        tx,
      );
      return co;
    });
  }

  /**
   * Approval applies the variation: contract value moves by the delta (POC and
   * profitability re-derive automatically), and the targeted WBS budget — if
   * any — absorbs the same delta so job costing keeps a matching baseline.
   */
  async approveChangeOrder(user: AuthUser, changeOrderId: string) {
    const co = await this.prisma.changeOrder.findFirst({
      where: { id: changeOrderId, organizationId: user.organizationId },
      include: { contract: { select: { id: true, totalValue: true } } },
    });
    if (!co) throw new NotFoundException('Change order not found');
    if (co.status !== 'DRAFT') throw new BadRequestException('Only draft change orders can be approved');

    const delta = Number(co.amountDelta);
    const newValue = round2(Number(co.contract.totalValue) + delta);
    if (newValue < 0) throw new BadRequestException('Change order would make the contract value negative');

    return this.prisma.$transaction(async (tx) => {
      await tx.contract.update({
        where: { id: co.contractId },
        data: { totalValue: newValue },
      });
      if (co.wbsElementId) {
        await tx.wbsElement.update({
          where: { id: co.wbsElementId },
          data: { budgetAmount: { increment: delta } },
        });
      }
      const updated = await tx.changeOrder.update({
        where: { id: co.id },
        data: { status: 'APPROVED', approvedAt: new Date(), approvedById: user.userId },
      });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'ChangeOrder',
          entityId: co.id,
          action: 'APPROVE',
          before: { contractValue: Number(co.contract.totalValue) },
          after: { contractValue: newValue, amountDelta: delta },
        },
        tx,
      );
      return updated;
    });
  }

  async setStage(user: AuthUser, id: string, dto: SetStageDto) {
    const project = await this.prisma.project.findFirst({
      where: { id, organizationId: user.organizationId },
    });
    if (!project) throw new NotFoundException('Project not found');

    // The web app only ever offers the next stage, but that made the rule
    // advisory: a direct call could move a project straight from PLANNING to
    // CLOSED, skipping the procurement and execution it claims to have done.
    // The order is enforced here, from the shared definition both sides read.
    if (!isValidStageTransition(project.stage, dto.stage)) {
      throw new BadRequestException(
        `Cannot move a project from ${project.stage} to ${dto.stage}`,
      );
    }

    const updated = await this.prisma.project.update({
      where: { id },
      data: { stage: dto.stage },
    });
    await this.audit.record({
      organizationId: user.organizationId,
      actorId: user.userId,
      entityType: 'Project',
      entityId: id,
      action: 'STAGE_CHANGE',
      before: { stage: project.stage },
      after: { stage: dto.stage },
    });
    return updated;
  }
}
