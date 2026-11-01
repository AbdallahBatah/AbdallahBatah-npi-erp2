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
import { moveBulk, moveSerials } from './site-stock';
import type { CreateMaterialReturnDto, ReceiveMaterialReturnDto } from './material-returns.dto';

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

const DETAIL = {
  project: { select: { id: true, code: true, nameAr: true, nameEn: true } },
  fromLocation: { select: { id: true, code: true, nameAr: true, nameEn: true } },
  toLocation: { select: { id: true, code: true, nameAr: true, nameEn: true } },
  lines: { include: { item: { select: { id: true, sku: true, nameAr: true, nameEn: true, uom: true, isSerialised: true } } } },
} as const;

/**
 * Package 5 · P5-4 (ADR-05, owner work cycle step 14) — materials left on a
 * project's site go back to the store on a return voucher. The engineer raises
 * it from what the site holds (net of returns already in transit); stock moves
 * only when the keeper confirms receipt, in that transaction.
 */
@Injectable()
export class MaterialReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  list(user: AuthUser, filter: { projectId?: string; status?: string }) {
    return this.prisma.materialReturn.findMany({
      where: {
        organizationId: user.organizationId,
        projectId: filter.projectId || undefined,
        status: (filter.status as never) || undefined,
      },
      include: {
        project: { select: { id: true, code: true, nameAr: true, nameEn: true } },
        toLocation: { select: { code: true } },
        _count: { select: { lines: true } },
      },
      orderBy: { raisedAt: 'desc' },
      take: 200,
    });
  }

  async get(user: AuthUser, id: string) {
    const r = await this.prisma.materialReturn.findFirst({
      where: { id, organizationId: user.organizationId },
      include: DETAIL,
    });
    if (!r) throw new NotFoundException('Material return not found');
    return r;
  }

  /** What the project's site holds, item by item, net of returns in transit, with its serial units. */
  async siteStock(user: AuthUser, projectId: string) {
    const site = await this.siteOf(user, projectId);
    if (!site) return { site: null, items: [] };
    const [levels, pending, units, busy] = await Promise.all([
      this.prisma.stockLevel.findMany({
        where: { organizationId: user.organizationId, locationId: site.id, qty: { gt: 0 } },
        include: { item: { select: { id: true, sku: true, nameAr: true, nameEn: true, uom: true, isSerialised: true } } },
      }),
      this.prisma.materialReturnLine.groupBy({
        by: ['itemId'],
        where: { materialReturn: { organizationId: user.organizationId, fromLocationId: site.id, status: 'RAISED' } },
        _sum: { qty: true },
      }),
      this.prisma.serialUnit.findMany({
        where: { organizationId: user.organizationId, locationId: site.id, currentState: 'IN_STOCK' },
        select: { id: true, serialNo: true, itemId: true, item: { select: { id: true, sku: true, nameAr: true, nameEn: true, uom: true, isSerialised: true } } },
        orderBy: { serialNo: 'asc' },
      }),
      this.busySerials(user),
    ]);
    const inTransit = new Map(pending.map((p) => [p.itemId, D(p._sum.qty ?? 0)]));
    const items = new Map<string, { item: unknown; available: string; units: Array<{ id: string; serialNo: string }> }>();
    for (const l of levels) {
      if (l.item.isSerialised) continue;
      const left = D(l.qty).sub(inTransit.get(l.itemId) ?? 0);
      if (left.gt(0)) items.set(l.itemId, { item: l.item, available: left.toString(), units: [] });
    }
    for (const u of units) {
      if (busy.has(u.id)) continue;
      const row = items.get(u.itemId) ?? { item: u.item, available: '0', units: [] };
      row.units.push({ id: u.id, serialNo: u.serialNo });
      row.available = String(row.units.length);
      items.set(u.itemId, row);
    }
    return { site, items: [...items.values()] };
  }

  async create(user: AuthUser, dto: CreateMaterialReturnDto) {
    const project = await this.prisma.project.findFirst({
      where: { id: dto.projectId, organizationId: user.organizationId },
      select: { id: true, code: true },
    });
    if (!project) throw new NotFoundException('Project not found');
    const site = await this.siteOf(user, project.id);
    if (!site) throw new ConflictException('The project has no site location, so nothing is on site to return');
    const to = await this.storeOf(user, dto.toLocationId);

    const stock = await this.siteStock(user, project.id);
    const byItem = new Map(
      stock.items.map((r) => [(r.item as { id: string }).id, r]),
    );
    for (const l of dto.lines) {
      const row = byItem.get(l.itemId);
      const isSerial = (row?.item as { isSerialised?: boolean } | undefined)?.isSerialised;
      if (!row) throw new BadRequestException(`Item ${l.itemId} is not on site`);
      if (isSerial) {
        const ids = l.serialUnitIds ?? [];
        if (!Number.isInteger(l.qty) || ids.length !== l.qty || new Set(ids).size !== ids.length) {
          throw new BadRequestException('A serialised item is returned by naming each unit (as many as the quantity)');
        }
        const onSite = new Set(row.units.map((u) => u.id));
        if (ids.some((id) => !onSite.has(id))) throw new BadRequestException('A unit is not on site or is already being returned');
      } else if (D(l.qty).gt(row.available)) {
        throw new BadRequestException(`Only ${row.available} of ${l.itemId} is on site to return`);
      }
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const code = await this.numbering.next(user.organizationId, 'MATERIAL_RETURN', tx);
      const r = await tx.materialReturn.create({
        data: {
          organizationId: user.organizationId,
          code,
          projectId: project.id,
          fromLocationId: site.id,
          toLocationId: to.id,
          raisedById: user.userId,
          notes: dto.notes?.trim() || null,
          lines: {
            create: dto.lines.map((l) => ({ itemId: l.itemId, qty: l.qty, serialUnitIds: l.serialUnitIds ?? [] })),
          },
        },
      });
      await this.record(tx, user, r.id, 'RAISE', null, { code, project: project.code, lines: dto.lines });
      return r;
    });
    await this.notifications.notifyBestEffort({
      organizationId: user.organizationId,
      permission: PERMISSIONS.PROCUREMENT_WRITE,
      excludeUserId: user.userId,
      type: 'MATERIAL_RETURN_RAISED',
      titleAr: `مرتجع مواد من ${project.code} بانتظار استلامك: ${created.code}`,
      titleEn: `Material return from ${project.code} awaiting your receipt: ${created.code}`,
      linkPath: `/requisitions/returns/${created.id}`,
    });
    return this.get(user, created.id);
  }

  /** The keeper confirms what arrived; stock moves site → store in this transaction. */
  async receive(user: AuthUser, id: string, dto: ReceiveMaterialReturnDto) {
    const r = await this.prisma.materialReturn.findFirst({
      where: { id, organizationId: user.organizationId },
      include: { lines: true },
    });
    if (!r) throw new NotFoundException('Material return not found');
    if (r.status !== 'RAISED') throw new ConflictException('Only a return in transit can be received');
    if (r.raisedById === user.userId) throw new ForbiddenException('The engineer who raised a return does not receive it');
    const to = dto.toLocationId ? await this.storeOf(user, dto.toLocationId) : { id: r.toLocationId };

    const doc = { id: r.id, code: r.code, fromLocationId: r.fromLocationId, toLocationId: to.id };
    await this.prisma.$transaction(async (tx) => {
      for (const l of r.lines) {
        if (l.serialUnitIds.length > 0) await moveSerials(tx, user, doc, l, 'MaterialReturn');
        else await moveBulk(tx, user, doc, l, 'MaterialReturn');
      }
      await tx.materialReturn.update({
        where: { id: r.id },
        data: { status: 'RECEIVED', toLocationId: to.id, receivedById: user.userId, receivedAt: new Date() },
      });
      await this.record(tx, user, r.id, 'RECEIVE', { status: 'RAISED' }, { status: 'RECEIVED', toLocationId: to.id });
    });
    await this.notifications.notifyUserBestEffort({
      organizationId: user.organizationId,
      userId: r.raisedById,
      type: 'MATERIAL_RETURN_RECEIVED',
      titleAr: `استُلم مرتجع المواد ${r.code} في المستودع`,
      titleEn: `Material return ${r.code} received at the store`,
      linkPath: `/requisitions/returns/${r.id}`,
    });
    return this.get(user, r.id);
  }

  async cancel(user: AuthUser, id: string) {
    const r = await this.get(user, id);
    if (r.status !== 'RAISED') throw new ConflictException('Only a return in transit can be cancelled');
    if (r.raisedById !== user.userId && !user.permissions.includes(PERMISSIONS.PROCUREMENT_WRITE)) {
      throw new ForbiddenException('Only the engineer who raised it, or the warehouse, can cancel a return');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.materialReturn.update({ where: { id: r.id }, data: { status: 'CANCELLED' } });
      await this.record(tx, user, r.id, 'CANCEL', { status: 'RAISED' }, { status: 'CANCELLED' });
    });
    return this.get(user, r.id);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private siteOf(user: AuthUser, projectId: string) {
    return this.prisma.location.findFirst({
      where: { organizationId: user.organizationId, projectId, locationType: 'SITE' },
      select: { id: true, code: true, nameAr: true, nameEn: true },
    });
  }

  /** The named store, or the main (first) warehouse. Never a project site. */
  private async storeOf(user: AuthUser, locationId?: string) {
    const loc = await this.prisma.location.findFirst({
      where: {
        organizationId: user.organizationId,
        ...(locationId ? { id: locationId } : { locationType: 'WAREHOUSE' }),
      },
      orderBy: { code: 'asc' },
    });
    if (!loc) throw new NotFoundException(locationId ? 'Store not found' : 'No warehouse to return to');
    if (loc.locationType === 'SITE') throw new BadRequestException('Materials are returned to a store, not to a site');
    return loc;
  }

  private async busySerials(user: AuthUser) {
    const rows = await this.prisma.materialReturnLine.findMany({
      where: { materialReturn: { organizationId: user.organizationId, status: 'RAISED' } },
      select: { serialUnitIds: true },
    });
    return new Set(rows.flatMap((r) => r.serialUnitIds));
  }

  private record(tx: Prisma.TransactionClient, user: AuthUser, id: string, action: string, before: unknown, after: unknown) {
    return this.audit.record(
      { organizationId: user.organizationId, actorId: user.userId, entityType: 'MaterialReturn', entityId: id, action, before, after },
      tx,
    );
  }
}
