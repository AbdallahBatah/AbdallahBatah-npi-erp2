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
import { ApprovalService } from '../../common/approval.service';
import { NotificationService } from '../../common/notification.service';
import { isValidStageTransition, PERMISSIONS } from '@npi/shared';
import type { AuthUser } from '../../common/auth-user';
import type { AssignProjectDto, CreateChangeOrderDto, CreateProjectDto, PlanElementDto, SetStageDto } from './dto';

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

/**
 * Package 3 · P3-4 (ADR-03 §4-7): a budget line that is a work item without a
 * stock item (labour, rental, expenses…) is bucketed by its kind. Turning the
 * budget lines into WBS elements one by one is package 4's first task.
 */
const WORK_KIND_BUCKETS: Record<string, { code: string; nameAr: string; nameEn: string }> = {
  MATERIAL: { code: 'MAT', nameAr: 'مواد', nameEn: 'Materials' },
  LABOUR: { code: 'LAB', nameAr: 'المصنعيات', nameEn: 'Labour' },
  EQUIPMENT: { code: 'EQP', nameAr: 'إيجار المعدات', nameEn: 'Equipment rental' },
  SUBCONTRACT: { code: 'SUB', nameAr: 'مقاولو الباطن', nameEn: 'Subcontract' },
  EXPENSE: { code: 'EXP', nameAr: 'المصاريف', nameEn: 'Expenses' },
  FINANCING: { code: 'FIN', nameAr: 'التمويل', nameEn: 'Financing' },
};

/** Where a budget line's cost lands in the project budget: its item's category, else its work item's kind. */
function bucketOf(line: {
  item: { itemCategory: string } | null;
  workItem: { kind: string } | null;
}): { key: string; code: string; nameAr: string; nameEn: string } {
  if (line.item) {
    const cat = line.item.itemCategory;
    return { key: cat, ...(WBS_BUCKETS[cat] ?? { code: cat, nameAr: cat, nameEn: cat }) };
  }
  const kind = line.workItem?.kind ?? 'EXPENSE';
  return { key: `WK_${kind}`, ...WORK_KIND_BUCKETS[kind] };
}

/**
 * Package 4 · P4-1 — one WBS element per budget line, in the work-item list
 * order: code = the work item's code (a repeat gets -2, -3 …), name = the
 * line's own wording else the work item's, budget = qty × the cost recorded on
 * the line (what the general manager approved), never the catalogue's today.
 */
export function wbsPerBudgetLine(
  lines: Array<{
    qty: unknown;
    unitCost: unknown;
    uom: string | null;
    description: string | null;
    item: { nameAr: string; nameEn: string; uom: string } | null;
    workItem: { id: string; code: string; nameAr: string; nameEn: string; uom: string; sortOrder: number } | null;
  }>,
) {
  const used = new Map<string, number>();
  return [...lines]
    .sort((a, b) => (a.workItem?.sortOrder ?? 1e9) - (b.workItem?.sortOrder ?? 1e9))
    .map((l, i) => {
      const base = l.workItem?.code ?? `L${String(i + 1).padStart(2, '0')}`;
      const n = (used.get(base) ?? 0) + 1;
      used.set(base, n);
      const qty = Number(l.qty);
      return {
        code: n === 1 ? base : `${base}-${n}`,
        nameAr: l.description || l.workItem?.nameAr || l.item?.nameAr || base,
        nameEn: l.workItem?.nameEn || l.item?.nameEn || base,
        workItemId: l.workItem?.id ?? null,
        qty,
        uom: l.uom || l.workItem?.uom || l.item?.uom || null,
        budgetAmount: round2(qty * Number(l.unitCost ?? 0)),
      };
    });
}

@Injectable()
export class ProjectsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalService,
    private readonly notifications: NotificationService,
  ) {}

  onModuleInit(): void {
    this.approvals.register('CHANGE_ORDER', (user, id) =>
      this.applyChangeOrderApproval(user, id),
    );
  }

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
            bomLines: {
              include: {
                item: { select: { itemCategory: true, unitCost: true, nameAr: true, nameEn: true, uom: true } },
                workItem: { select: { id: true, kind: true, code: true, nameAr: true, nameEn: true, uom: true, sortOrder: true } },
              },
            },
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

    // Budget per WBS bucket from the BOM at cost. A stock-item line keeps the old
    // rule (catalogue cost); a work-item line without one has no catalogue cost and
    // brings the cost the approved budget recorded for it.
    const buckets = new Map<string, { code: string; nameAr: string; nameEn: string; budget: number }>();
    for (const l of contract.proposalRevision?.bomLines ?? []) {
      const b = bucketOf(l);
      const unit = l.item ? Number(l.item.unitCost) : Number(l.unitCost ?? 0);
      const cost = Number(l.qty) * unit;
      const row = buckets.get(b.key) ?? { code: b.code, nameAr: b.nameAr, nameEn: b.nameEn, budget: 0 };
      row.budget += cost;
      buckets.set(b.key, row);
    }

    // Package 4 · P4-1 (ADR-04 §4-1): a project opened from a lump-sum budget gets
    // one element per budget line — the line's work item, quantity, unit and the
    // cost the general manager approved — so material requests, purchases and
    // later the daily log land on the very line they were budgeted on.
    const perLine = contract.proposalRevision?.pricingMode === 'LUMP_SUM';
    const lineElements = perLine ? wbsPerBudgetLine(contract.proposalRevision?.bomLines ?? []) : null;

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
            create: lineElements && lineElements.length > 0
              ? lineElements
              : buckets.size > 0
                ? [...buckets.values()].map((b) => ({
                    code: b.code,
                    nameAr: b.nameAr,
                    nameEn: b.nameEn,
                    budgetAmount: round2(b.budget),
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
      // P4-1 (ADR-04 §3 rule 4): the project's own stock location, where the
      // warehouse sends its materials and the engineer confirms them.
      await tx.location.create({
        data: {
          organizationId: user.organizationId,
          code: `SITE-${code}`,
          nameAr: `موقع ${created.nameAr}`,
          nameEn: `Site — ${created.nameEn}`,
          locationType: 'SITE',
          projectId: created.id,
        },
      });
      return created;
    });

    return project;
  }

  /**
   * Package 4 · P4-1 (owner work cycle step 6 «تعيين مهندس المشروع»): the projects
   * general manager names the site engineer and the project's planned dates.
   * The engineer is told (best effort).
   */
  async assign(user: AuthUser, id: string, dto: AssignProjectDto) {
    const project = await this.prisma.project.findFirst({ where: { id, organizationId: user.organizationId } });
    if (!project) throw new NotFoundException('Project not found');
    if (project.stage === 'CLOSED') throw new BadRequestException('The project is closed');
    let engineer: { id: string; nameAr: string } | null = null;
    if (dto.engineerId) {
      engineer = await this.prisma.user.findFirst({
        where: { id: dto.engineerId, organizationId: user.organizationId, isActive: true },
        select: { id: true, nameAr: true },
      });
      if (!engineer) throw new BadRequestException('Unknown or inactive user');
    }
    const start = dto.plannedStart === undefined ? undefined : dto.plannedStart ? new Date(dto.plannedStart) : null;
    const end = dto.plannedEnd === undefined ? undefined : dto.plannedEnd ? new Date(dto.plannedEnd) : null;
    const s = start === undefined ? project.plannedStart : start;
    const e = end === undefined ? project.plannedEnd : end;
    if (s && e && e < s) throw new BadRequestException('The planned end is before the planned start');

    const updated = await this.prisma.project.update({
      where: { id },
      data: {
        ...(dto.engineerId !== undefined ? { projectManagerId: dto.engineerId || null } : {}),
        ...(start !== undefined ? { plannedStart: start } : {}),
        ...(end !== undefined ? { plannedEnd: end } : {}),
      },
    });
    await this.audit.record({
      organizationId: user.organizationId,
      actorId: user.userId,
      entityType: 'Project',
      entityId: id,
      action: 'ASSIGN',
      before: { projectManagerId: project.projectManagerId, plannedStart: project.plannedStart, plannedEnd: project.plannedEnd },
      after: { projectManagerId: updated.projectManagerId, plannedStart: updated.plannedStart, plannedEnd: updated.plannedEnd },
    });
    if (engineer && engineer.id !== project.projectManagerId) {
      await this.notifications.notifyUserBestEffort({
        organizationId: user.organizationId,
        userId: engineer.id,
        type: 'PROJECT_ASSIGNED',
        titleAr: `أُسند إليك المشروع ${project.code}`,
        titleEn: `You are the engineer of project ${project.code}`,
        bodyAr: 'أعدّ خطة التنفيذ على بنود الموازنة وناقشها مع مدير عام المشاريع.',
        bodyEn: 'Prepare the execution plan on the budget lines and go through it with the projects general manager.',
        linkPath: `/projects/${id}`,
      });
    }
    return updated;
  }

  /** Package 4 · P4-1 (work cycle step 10): the engineer's planned dates for one budget line. */
  async planElement(user: AuthUser, projectId: string, wbsId: string, dto: PlanElementDto) {
    const el = await this.prisma.wbsElement.findFirst({
      where: { id: wbsId, projectId, project: { organizationId: user.organizationId } },
    });
    if (!el) throw new NotFoundException('WBS element not found');
    const start = dto.plannedStart ? new Date(dto.plannedStart) : null;
    const end = dto.plannedEnd ? new Date(dto.plannedEnd) : null;
    if (start && end && end < start) throw new BadRequestException('The planned end is before the planned start');
    const updated = await this.prisma.wbsElement.update({
      where: { id: el.id },
      data: { plannedStart: start, plannedEnd: end },
    });
    await this.audit.record({
      organizationId: user.organizationId,
      actorId: user.userId,
      entityType: 'WbsElement',
      entityId: el.id,
      action: 'PLAN',
      before: { plannedStart: el.plannedStart, plannedEnd: el.plannedEnd },
      after: { plannedStart: updated.plannedStart, plannedEnd: updated.plannedEnd },
    });
    return updated;
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

    // Two batch lookups, not one per row: mark the change orders and claims
    // that are sitting in the approval matrix so the screen can say why their
    // approve button did nothing.
    const claims = project.subcontracts.flatMap((s) => s.claims);
    const [coPending, claimPending] = await Promise.all([
      this.approvals.pendingFor(
        user.organizationId,
        'CHANGE_ORDER',
        project.changeOrders.map((c) => c.id),
      ),
      this.approvals.pendingFor(user.organizationId, 'PROGRESS_CLAIM', claims.map((c) => c.id)),
    ]);
    // P4-1: who the engineer is, and the project's own stock location.
    const [engineer, siteLocation] = await Promise.all([
      project.projectManagerId
        ? this.prisma.user.findFirst({
            where: { id: project.projectManagerId, organizationId: user.organizationId },
            select: { id: true, nameAr: true, nameEn: true },
          })
        : Promise.resolve(null),
      this.prisma.location.findFirst({
        where: { organizationId: user.organizationId, projectId: project.id, locationType: 'SITE' },
        select: { id: true, code: true, nameAr: true, nameEn: true },
      }),
    ]);

    return {
      ...project,
      engineer,
      siteLocation,
      changeOrders: project.changeOrders.map((c) => ({
        ...c,
        pendingApproval: coPending.get(c.id) ?? null,
      })),
      subcontracts: project.subcontracts.map((s) => ({
        ...s,
        claims: s.claims.map((c) => ({ ...c, pendingApproval: claimPending.get(c.id) ?? null })),
      })),
      wbsElements: wbs,
      costSummary: { ...totals, variance: round2(totals.budget - totals.actual - totals.committed) },
    };
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
   * A change order moves the contract value, so the matrix bands on the
   * *absolute* delta: a −900,000 variation is every bit as consequential as a
   * +900,000 one and must not slip through as "a small number".
   */
  async approveChangeOrder(user: AuthUser, changeOrderId: string) {
    const co = await this.prisma.changeOrder.findFirst({
      where: { id: changeOrderId, organizationId: user.organizationId },
    });
    if (!co) throw new NotFoundException('Change order not found');
    if (co.status !== 'DRAFT') throw new BadRequestException('Only draft change orders can be approved');

    const verdict = await this.approvals.gate(user, {
      documentType: 'CHANGE_ORDER',
      documentId: co.id,
      documentCode: co.code,
      amount: Number(co.amountDelta),
    });
    if (verdict.cleared && !user.permissions.includes(PERMISSIONS.PROJECT_APPROVE)) {
      // Separated rights (Step 1): a role that may write/submit but not approve must
      // not self-approve when no matrix band applies. Fail before any state change.
      throw new ForbiddenException('Approving this document requires the approve permission; no approval rule routes it to someone else');
    }
    if (!verdict.cleared) return { ...co, pendingApproval: verdict.request };

    return this.applyChangeOrderApproval(user, changeOrderId);
  }

  /**
   * Approval applies the variation: contract value moves by the delta (POC and
   * profitability re-derive automatically), and the targeted WBS budget — if
   * any — absorbs the same delta so job costing keeps a matching baseline.
   */
  private async applyChangeOrderApproval(user: AuthUser, changeOrderId: string) {
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
