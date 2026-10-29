import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@npi/db';
import { PERMISSIONS } from '@npi/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { NumberingService } from '../../common/numbering.service';
import { AuditService } from '../../common/audit.service';
import { NotificationService } from '../../common/notification.service';
import type { AuthUser } from '../../common/auth-user';
import { RequisitionsService } from './requisitions.service';
import {
  CreateMaterialIssueDto,
  CreateMaterialRequestDto,
  MaterialRequestLineDto,
  RaiseShortageDto,
  RejectMaterialRequestDto,
  UpdateMaterialRequestDto,
} from './material-requests.dto';

type Tx = Prisma.TransactionClient;
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const ZERO = D(0);

const DETAIL_INCLUDE = {
  project: { select: { id: true, code: true, nameAr: true, nameEn: true, projectManagerId: true } },
  lines: {
    orderBy: { id: 'asc' },
    include: {
      item: { select: { id: true, sku: true, nameAr: true, nameEn: true, uom: true, isSerialised: true } },
      wbsElement: { select: { id: true, code: true, nameAr: true, nameEn: true } },
    },
  },
  issues: {
    orderBy: { issuedAt: 'asc' },
    include: {
      fromLocation: { select: { id: true, code: true, nameAr: true, nameEn: true } },
      toLocation: { select: { id: true, code: true, nameAr: true, nameEn: true } },
      lines: true,
    },
  },
  requisitions: { select: { id: true, code: true, status: true } },
} as const;

/**
 * Package 4 · P4-2 / P4-3 (ADR-04 §4-2, §4-3; owner work cycle steps 11–12).
 *
 *   engineer: DRAFT ─submit─▶ SUBMITTED ─projects GM─▶ APPROVED ─keeper issues─▶ … ─engineer confirms─▶ PARTIAL / FULFILLED
 *                                        └─reject (note)─▶ REJECTED
 *
 * Keys (no new ones): raise with scm.requisition.write, approve with
 * scm.procurement.approve (never the requester), issue and raise a shortage
 * requisition with scm.procurement.write, confirm receipt with
 * scm.requisition.write (the requester or the project's engineer).
 *
 * Stock never moves on an issue voucher alone: the voucher reserves nothing
 * and is checked against stock twice — when issued (net of other vouchers still
 * in transit from the same store) and again when the engineer confirms, inside
 * the transaction that moves it.
 */
@Injectable()
export class MaterialRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly requisitions: RequisitionsService,
  ) {}

  // ── reading ───────────────────────────────────────────────────────────────

  list(user: AuthUser, filter: { projectId?: string; status?: string }) {
    return this.prisma.materialRequest.findMany({
      where: {
        organizationId: user.organizationId,
        ...(filter.projectId ? { projectId: filter.projectId } : {}),
        ...(filter.status ? { status: filter.status as never } : {}),
      },
      include: {
        project: { select: { id: true, code: true, nameAr: true, nameEn: true } },
        _count: { select: { lines: true, issues: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(user: AuthUser, id: string) {
    const mr = await this.prisma.materialRequest.findFirst({
      where: { id, organizationId: user.organizationId },
      include: DETAIL_INCLUDE,
    });
    if (!mr) throw new NotFoundException('Material request not found');
    return mr;
  }

  // ── the engineer's request ────────────────────────────────────────────────

  async create(user: AuthUser, dto: CreateMaterialRequestDto) {
    const project = await this.openProject(user, dto.projectId);
    await this.assertLines(user, project.id, dto.lines);
    return this.prisma.$transaction(async (tx) => {
      const code = await this.numbering.next(user.organizationId, 'MATERIAL_REQUEST', tx);
      const mr = await tx.materialRequest.create({
        data: {
          organizationId: user.organizationId,
          code,
          projectId: project.id,
          requestedById: user.userId,
          neededBy: dto.neededBy ? new Date(dto.neededBy) : null,
          notes: dto.notes?.trim() || null,
          lines: { create: dto.lines.map(lineRow) },
        },
        include: { lines: true },
      });
      await this.record(tx, user, mr.id, 'CREATE', null, { code, projectId: project.id, lines: mr.lines.length });
      return mr;
    });
  }

  async update(user: AuthUser, id: string, dto: UpdateMaterialRequestDto) {
    const mr = await this.get(user, id);
    if (mr.status !== 'DRAFT') throw new ConflictException('Only a draft material request can be edited');
    if (mr.requestedById !== user.userId) throw new ForbiddenException('Only the requester edits a draft');
    if (dto.lines) await this.assertLines(user, mr.projectId, dto.lines);
    return this.prisma.$transaction(async (tx) => {
      if (dto.lines) await tx.materialRequestLine.deleteMany({ where: { requestId: mr.id } });
      const updated = await tx.materialRequest.update({
        where: { id: mr.id },
        data: {
          ...(dto.neededBy !== undefined ? { neededBy: dto.neededBy ? new Date(dto.neededBy) : null } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes?.trim() || null } : {}),
          ...(dto.lines ? { lines: { create: dto.lines.map(lineRow) } } : {}),
        },
        include: { lines: true },
      });
      await this.record(tx, user, mr.id, 'UPDATE', { lines: mr.lines.length }, { lines: updated.lines.length });
      return updated;
    });
  }

  async submit(user: AuthUser, id: string) {
    const mr = await this.get(user, id);
    if (mr.status !== 'DRAFT') throw new ConflictException('Only a draft material request can be submitted');
    if (mr.lines.length === 0) throw new BadRequestException('A material request needs at least one line');
    const updated = await this.move(user, mr, 'SUBMITTED', { submittedAt: new Date() });
    await this.notifications.notifyBestEffort({
      organizationId: user.organizationId,
      permission: PERMISSIONS.PROCUREMENT_APPROVE,
      excludeUserId: user.userId,
      type: 'MATERIAL_REQUEST_SUBMITTED',
      titleAr: `طلب مواد بانتظار اعتمادك: ${mr.code} (${mr.project.code})`,
      titleEn: `Material request awaiting your approval: ${mr.code} (${mr.project.code})`,
      linkPath: `/requisitions/materials/${mr.id}`,
    });
    return updated;
  }

  async cancel(user: AuthUser, id: string) {
    const mr = await this.get(user, id);
    if (!['DRAFT', 'SUBMITTED'].includes(mr.status)) {
      throw new ConflictException('Only a draft or submitted material request can be cancelled');
    }
    if (mr.requestedById !== user.userId) throw new ForbiddenException('Only the requester cancels a request');
    return this.move(user, mr, 'CANCELLED');
  }

  // ── the projects general manager ──────────────────────────────────────────

  async approve(user: AuthUser, id: string) {
    const mr = await this.get(user, id);
    if (mr.status !== 'SUBMITTED') throw new ConflictException('Only a submitted material request can be approved');
    if (mr.requestedById === user.userId) {
      throw new ForbiddenException('The requester cannot approve their own material request');
    }
    const updated = await this.move(user, mr, 'APPROVED', { approvedAt: new Date(), approvedById: user.userId });
    await this.notifications.notifyBestEffort({
      organizationId: user.organizationId,
      permission: PERMISSIONS.PROCUREMENT_WRITE,
      excludeUserId: user.userId,
      type: 'MATERIAL_REQUEST_APPROVED',
      titleAr: `طلب مواد معتمد للصرف: ${mr.code} (${mr.project.code})`,
      titleEn: `Material request approved for issue: ${mr.code} (${mr.project.code})`,
      bodyAr: 'اصرف المتوفر إلى موقع المشروع، وارفع طلب شراء بالنقص.',
      bodyEn: 'Issue what is in stock to the project site and raise a requisition for the shortage.',
      linkPath: `/requisitions/materials/${mr.id}`,
    });
    return updated;
  }

  async reject(user: AuthUser, id: string, dto: RejectMaterialRequestDto) {
    const mr = await this.get(user, id);
    if (mr.status !== 'SUBMITTED') throw new ConflictException('Only a submitted material request can be rejected');
    if (mr.requestedById === user.userId) {
      throw new ForbiddenException('The requester cannot reject their own material request');
    }
    const updated = await this.move(user, mr, 'REJECTED', { rejectionNote: dto.note.trim() });
    await this.notifications.notifyUserBestEffort({
      organizationId: user.organizationId,
      userId: mr.requestedById,
      type: 'MATERIAL_REQUEST_REJECTED',
      titleAr: `رُفض طلب المواد ${mr.code}`,
      titleEn: `Material request ${mr.code} was rejected`,
      bodyAr: dto.note.trim(),
      bodyEn: dto.note.trim(),
      linkPath: `/requisitions/materials/${mr.id}`,
    });
    return updated;
  }

  // ── the warehouse keeper ──────────────────────────────────────────────────

  /** إذن صرف: from one store to the project's site location, for approved lines. */
  async issue(user: AuthUser, id: string, dto: CreateMaterialIssueDto) {
    const mr = await this.get(user, id);
    if (!['APPROVED', 'PARTIAL'].includes(mr.status)) {
      throw new ConflictException('Only an approved material request can be issued against');
    }
    const from = await this.prisma.location.findFirst({
      where: { id: dto.fromLocationId, organizationId: user.organizationId },
    });
    if (!from) throw new NotFoundException('Source location not found');
    const site = await this.siteOf(user, mr.projectId);
    if (from.id === site.id) throw new BadRequestException('The source is already the project site');

    const byLine = new Map(mr.lines.map((l) => [l.id, l]));
    const seen = new Set<string>();
    for (const l of dto.lines) {
      const line = byLine.get(l.requestLineId);
      if (!line) throw new BadRequestException('A line is not on this material request');
      if (seen.has(line.id)) throw new BadRequestException('A request line appears twice on one voucher');
      seen.add(line.id);
      const left = D(line.qty).sub(line.issuedQty);
      if (D(l.qty).gt(left)) {
        throw new BadRequestException(`${line.item.sku}: issuing ${l.qty}, only ${left.toString()} left on the request`);
      }
      if (line.item.isSerialised) {
        await this.assertSerials(user, from.id, line.itemId, l.qty, l.serialUnitIds ?? []);
      } else {
        if (l.serialUnitIds?.length) throw new BadRequestException(`${line.item.sku} is not serialised`);
        const available = await this.availableBulk(user, from.id, line.itemId);
        if (D(l.qty).gt(available)) {
          throw new BadRequestException(
            `${line.item.sku}: ${available.toString()} available at ${from.code} after vouchers in transit, issuing ${l.qty}`,
          );
        }
      }
    }

    const issue = await this.prisma.$transaction(async (tx) => {
      const code = await this.numbering.next(user.organizationId, 'MATERIAL_ISSUE', tx);
      const created = await tx.materialIssue.create({
        data: {
          organizationId: user.organizationId,
          code,
          requestId: mr.id,
          fromLocationId: from.id,
          toLocationId: site.id,
          issuedById: user.userId,
          notes: dto.notes?.trim() || null,
          lines: {
            create: dto.lines.map((l) => ({
              requestLineId: l.requestLineId,
              itemId: byLine.get(l.requestLineId)!.itemId,
              qty: l.qty,
              serialUnitIds: l.serialUnitIds ?? [],
            })),
          },
        },
        include: { lines: true },
      });
      for (const l of dto.lines) {
        await tx.materialRequestLine.update({ where: { id: l.requestLineId }, data: { issuedQty: { increment: l.qty } } });
      }
      await this.record(tx, user, mr.id, 'ISSUE', null, { issue: code, from: from.code, to: site.code, lines: dto.lines });
      return created;
    });

    // The engineer confirms what actually reached the site.
    const engineer = mr.project.projectManagerId;
    for (const userId of new Set([mr.requestedById, ...(engineer ? [engineer] : [])])) {
      await this.notifications.notifyUserBestEffort({
        organizationId: user.organizationId,
        userId,
        type: 'MATERIAL_ISSUED',
        titleAr: `إذن صرف ${issue.code} في الطريق إلى ${mr.project.code}`,
        titleEn: `Issue voucher ${issue.code} is on its way to ${mr.project.code}`,
        bodyAr: 'أكّد الاستلام عند وصول المواد إلى الموقع.',
        bodyEn: 'Confirm receipt when the materials reach the site.',
        linkPath: `/requisitions/materials/${mr.id}`,
      });
    }
    return issue;
  }

  /**
   * What the keeper can send from one store for each line still owed: bulk
   * quantity net of vouchers in transit, or the serial units in stock there
   * that are not already on a voucher in transit.
   */
  async stockFor(user: AuthUser, id: string, fromLocationId: string) {
    const mr = await this.get(user, id);
    const from = await this.prisma.location.findFirst({ where: { id: fromLocationId, organizationId: user.organizationId } });
    if (!from) throw new NotFoundException('Source location not found');
    const busy = new Set(
      (
        await this.prisma.materialIssueLine.findMany({
          where: { issue: { organizationId: user.organizationId, status: 'ISSUED' } },
          select: { serialUnitIds: true },
        })
      ).flatMap((l) => l.serialUnitIds),
    );
    return Promise.all(
      mr.lines.map(async (l) => {
        const left = D(l.qty).sub(l.issuedQty);
        if (!l.item.isSerialised) {
          return { requestLineId: l.id, left: left.toString(), available: (await this.availableBulk(user, from.id, l.itemId)).toString(), units: [] };
        }
        const units = (
          await this.prisma.serialUnit.findMany({
            where: { organizationId: user.organizationId, itemId: l.itemId, locationId: from.id, currentState: 'IN_STOCK' },
            select: { id: true, serialNo: true },
            orderBy: { serialNo: 'asc' },
          })
        ).filter((u) => !busy.has(u.id));
        return { requestLineId: l.id, left: left.toString(), available: String(units.length), units };
      }),
    );
  }

  async cancelIssue(user: AuthUser, issueId: string) {
    const issue = await this.ownedIssue(user, issueId);
    if (issue.status !== 'ISSUED') throw new ConflictException('Only a voucher still in transit can be cancelled');
    return this.prisma.$transaction(async (tx) => {
      for (const l of issue.lines) {
        await tx.materialRequestLine.update({ where: { id: l.requestLineId }, data: { issuedQty: { decrement: l.qty } } });
      }
      const updated = await tx.materialIssue.update({ where: { id: issue.id }, data: { status: 'CANCELLED' } });
      await this.record(tx, user, issue.requestId, 'ISSUE_CANCEL', { issue: issue.code }, { status: 'CANCELLED' });
      return updated;
    });
  }

  // ── the engineer confirms ─────────────────────────────────────────────────

  /**
   * The materials reached the site: stock moves from the store to the project
   * location (each line re-checked here, in the moving transaction), the
   * received quantities rise, and the request becomes PARTIAL or FULFILLED.
   */
  async confirmReceipt(user: AuthUser, issueId: string) {
    const issue = await this.ownedIssue(user, issueId);
    if (issue.status !== 'ISSUED') throw new ConflictException('This voucher is not awaiting receipt');
    const mr = await this.get(user, issue.requestId);
    if (user.userId !== mr.requestedById && user.userId !== mr.project.projectManagerId) {
      throw new ForbiddenException("Only the requester or the project's engineer confirms receipt");
    }

    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      for (const l of issue.lines) {
        if (l.serialUnitIds.length > 0) await this.moveSerials(tx, user, issue, l);
        else await this.moveBulk(tx, user, issue, l);
        await tx.materialRequestLine.update({ where: { id: l.requestLineId }, data: { receivedQty: { increment: l.qty } } });
      }
      const received = await tx.materialIssue.update({
        where: { id: issue.id },
        data: { status: 'RECEIVED', receivedById: user.userId, receivedAt: now },
      });
      const lines = await tx.materialRequestLine.findMany({ where: { requestId: mr.id } });
      const done = lines.every((l) => D(l.receivedQty).gte(l.qty));
      const status = done ? 'FULFILLED' : 'PARTIAL';
      await tx.materialRequest.update({ where: { id: mr.id }, data: { status } });
      await this.record(tx, user, mr.id, 'RECEIVE', { issue: issue.code, status: mr.status }, { status });
      return { issue: received, requestStatus: status };
    });
  }

  // ── the shortage goes to purchasing ───────────────────────────────────────

  /**
   * «في حالة عدم توافر يقوم أمين المستودع برفع طلب شراء لتلك المواد»: one
   * requisition for everything neither issued nor already sent to purchasing,
   * on the request's project and budget lines. It then takes the purchase
   * chain like any other requisition.
   */
  async raiseShortage(user: AuthUser, id: string, dto: RaiseShortageDto) {
    const mr = await this.get(user, id);
    if (!['APPROVED', 'PARTIAL'].includes(mr.status)) {
      throw new ConflictException('Only an approved material request can raise a requisition');
    }
    const short = mr.lines
      .map((l) => ({ line: l, qty: D(l.qty).sub(l.issuedQty).sub(l.purchasedQty) }))
      .filter((x) => x.qty.gt(ZERO));
    if (short.length === 0) throw new ConflictException('Nothing is left to buy on this request');

    const pr = await this.requisitions.create(user, {
      justification:
        dto.justification?.trim() || `نقص في طلب المواد ${mr.code} للمشروع ${mr.project.code} / Shortage on ${mr.code}`,
      projectId: mr.projectId,
      lines: short.map((x) => ({
        itemId: x.line.itemId,
        qty: Number(x.qty.toFixed(3)),
        wbsElementId: x.line.wbsElementId ?? undefined,
      })),
    });
    await this.prisma.$transaction(async (tx) => {
      await tx.purchaseRequisition.update({ where: { id: pr.id }, data: { materialRequestId: mr.id } });
      for (const x of short) {
        await tx.materialRequestLine.update({ where: { id: x.line.id }, data: { purchasedQty: { increment: x.qty } } });
      }
      await this.record(tx, user, mr.id, 'RAISE_REQUISITION', null, { requisition: pr.code, lines: short.length });
    });
    return pr;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async openProject(user: AuthUser, projectId: string) {
    const project = await this.prisma.project.findFirst({ where: { id: projectId, organizationId: user.organizationId } });
    if (!project) throw new NotFoundException('Project not found');
    if (project.stage === 'CLOSED') throw new ConflictException('The project is closed');
    return project;
  }

  /** Items of this tenant; budget lines of this project. */
  private async assertLines(user: AuthUser, projectId: string, lines: MaterialRequestLineDto[]) {
    const itemIds = [...new Set(lines.map((l) => l.itemId))];
    const items = await this.prisma.item.count({ where: { id: { in: itemIds }, organizationId: user.organizationId } });
    if (items !== itemIds.length) throw new BadRequestException('One or more items are invalid for this tenant');
    const wbsIds = [...new Set(lines.map((l) => l.wbsElementId).filter((x): x is string => !!x))];
    if (wbsIds.length) {
      const found = await this.prisma.wbsElement.count({ where: { id: { in: wbsIds }, projectId } });
      if (found !== wbsIds.length) throw new BadRequestException('A budget line is not on this project');
    }
  }

  /** The project's SITE location, created on the spot for a project opened before P4-1. */
  private async siteOf(user: AuthUser, projectId: string) {
    const existing = await this.prisma.location.findFirst({
      where: { organizationId: user.organizationId, projectId, locationType: 'SITE' },
    });
    if (existing) return existing;
    const project = await this.prisma.project.findFirstOrThrow({ where: { id: projectId } });
    return this.prisma.location.create({
      data: {
        organizationId: user.organizationId,
        code: `SITE-${project.code}`,
        nameAr: `موقع ${project.nameAr}`,
        nameEn: `Site — ${project.nameEn}`,
        locationType: 'SITE',
        projectId,
      },
    });
  }

  /** Bulk stock at a store, net of vouchers still in transit from it. */
  private async availableBulk(user: AuthUser, locationId: string, itemId: string) {
    const [level, pending] = await Promise.all([
      this.prisma.stockLevel.findFirst({ where: { organizationId: user.organizationId, itemId, locationId } }),
      this.prisma.materialIssueLine.aggregate({
        where: { itemId, issue: { organizationId: user.organizationId, fromLocationId: locationId, status: 'ISSUED' } },
        _sum: { qty: true },
      }),
    ]);
    return D(level?.qty ?? 0).sub(pending._sum.qty ?? 0);
  }

  /** The named units: this item, in stock at the store, not on another voucher in transit; as many as the quantity. */
  private async assertSerials(user: AuthUser, locationId: string, itemId: string, qty: number, ids: string[]) {
    if (!Number.isInteger(qty) || ids.length !== qty || new Set(ids).size !== ids.length) {
      throw new BadRequestException('A serialised item is issued by naming each unit (as many as the quantity)');
    }
    const ok = await this.prisma.serialUnit.count({
      where: { id: { in: ids }, organizationId: user.organizationId, itemId, locationId, currentState: 'IN_STOCK' },
    });
    if (ok !== ids.length) throw new BadRequestException('A unit is not in stock at the source location');
    const busy = await this.prisma.materialIssueLine.count({
      where: { serialUnitIds: { hasSome: ids }, issue: { organizationId: user.organizationId, status: 'ISSUED' } },
    });
    if (busy > 0) throw new BadRequestException('A unit is already on a voucher in transit');
  }

  private async moveBulk(
    tx: Tx,
    user: AuthUser,
    issue: { id: string; code: string; fromLocationId: string; toLocationId: string },
    l: { itemId: string; qty: Prisma.Decimal },
  ) {
    const level = await tx.stockLevel.findFirst({
      where: { organizationId: user.organizationId, itemId: l.itemId, locationId: issue.fromLocationId },
    });
    if (!level || D(level.qty).lt(l.qty)) {
      throw new ConflictException(`Not enough stock left at the source to receive ${issue.code} — ask the warehouse`);
    }
    await tx.stockLevel.update({ where: { id: level.id }, data: { qty: { decrement: l.qty } } });
    await tx.stockLevel.upsert({
      where: {
        organizationId_itemId_locationId: {
          organizationId: user.organizationId,
          itemId: l.itemId,
          locationId: issue.toLocationId,
        },
      },
      update: { qty: { increment: l.qty } },
      create: { organizationId: user.organizationId, itemId: l.itemId, locationId: issue.toLocationId, qty: l.qty },
    });
    await tx.stockMovement.create({
      data: {
        organizationId: user.organizationId,
        itemId: l.itemId,
        fromLocationId: issue.fromLocationId,
        toLocationId: issue.toLocationId,
        qty: l.qty,
        movementType: 'TRANSFER',
        sourceType: 'MaterialIssue',
        sourceId: issue.id,
      },
    });
  }

  private async moveSerials(
    tx: Tx,
    user: AuthUser,
    issue: { id: string; code: string; fromLocationId: string; toLocationId: string; request?: unknown },
    l: { itemId: string; serialUnitIds: string[] },
  ) {
    const units = await tx.serialUnit.findMany({
      where: {
        id: { in: l.serialUnitIds },
        organizationId: user.organizationId,
        locationId: issue.fromLocationId,
        currentState: 'IN_STOCK',
      },
      select: { id: true },
    });
    if (units.length !== l.serialUnitIds.length) {
      throw new ConflictException(`A unit on ${issue.code} is no longer in stock at the source — ask the warehouse`);
    }
    const project = await tx.location.findUniqueOrThrow({ where: { id: issue.toLocationId }, select: { projectId: true } });
    await tx.serialUnit.updateMany({
      where: { id: { in: l.serialUnitIds } },
      data: { locationId: issue.toLocationId, ...(project.projectId ? { projectId: project.projectId } : {}) },
    });
    await tx.stockMovement.createMany({
      data: l.serialUnitIds.map((serialUnitId) => ({
        organizationId: user.organizationId,
        itemId: l.itemId,
        serialUnitId,
        fromLocationId: issue.fromLocationId,
        toLocationId: issue.toLocationId,
        qty: 1,
        movementType: 'TRANSFER',
        sourceType: 'MaterialIssue',
        sourceId: issue.id,
      })),
    });
  }

  private async ownedIssue(user: AuthUser, issueId: string) {
    const issue = await this.prisma.materialIssue.findFirst({
      where: { id: issueId, organizationId: user.organizationId },
      include: { lines: true },
    });
    if (!issue) throw new NotFoundException('Issue voucher not found');
    return issue;
  }

  private async move(
    user: AuthUser,
    mr: { id: string; status: string },
    status: 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'CANCELLED',
    extra: Prisma.MaterialRequestUpdateInput = {},
  ) {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.materialRequest.update({ where: { id: mr.id }, data: { ...extra, status } });
      await this.record(tx, user, mr.id, status, { status: mr.status }, { status });
      return updated;
    });
  }

  private record(tx: Tx, user: AuthUser, id: string, action: string, before: unknown, after: unknown) {
    return this.audit.record(
      {
        organizationId: user.organizationId,
        actorId: user.userId,
        entityType: 'MaterialRequest',
        entityId: id,
        action,
        before,
        after,
      },
      tx,
    );
  }
}

/** One request line as written. */
function lineRow(l: MaterialRequestLineDto) {
  return {
    itemId: l.itemId,
    wbsElementId: l.wbsElementId ?? null,
    qty: l.qty,
    notes: l.notes?.trim() || null,
  };
}
