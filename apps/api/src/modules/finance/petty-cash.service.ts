import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@npi/db';
import { PERMISSIONS } from '@npi/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { NumberingService } from '../../common/numbering.service';
import { AuditService } from '../../common/audit.service';
import { ApprovalService } from '../../common/approval.service';
import { NotificationService } from '../../common/notification.service';
import { PostingService } from '../../common/posting.service';
import type { AuthUser } from '../../common/auth-user';
import type { CashAmountDto, CreateCustodyDto, CreateSettlementDto } from './field-money.dto';

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const dayOf = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);

/**
 * Package 6 · P6-2 (ADR-06) — «العُهدة»: cash held by one custodian.
 *
 *  FUND        accountant hands cash          Dr petty cash / Cr bank      balance +
 *  SETTLEMENT  custodian's spending, signed   Dr project WIP / Cr petty    balance −
 *              by the projects GM, each line charged to a project and budget line
 *              (a ProjectCostEntry, so it shows as actual on the line)
 *  RETURN      unspent cash handed back       Dr bank / Cr petty cash      balance −
 *
 * Replenishment is simply another FUND. A custody closes at zero balance with
 * nothing pending.
 */
@Injectable()
export class PettyCashService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalService,
    private readonly notifications: NotificationService,
    private readonly posting: PostingService,
  ) {}

  onModuleInit(): void {
    this.approvals.register(
      'PETTY_CASH_SETTLEMENT',
      (user, id) => this.applySettlement(user, id),
      (user, id, note) => this.rejectSettlement(user, id, note),
    );
  }

  async list(user: AuthUser) {
    const all = this.isFinance(user) || user.permissions.includes(PERMISSIONS.PROCUREMENT_APPROVE);
    const rows = await this.prisma.pettyCashCustody.findMany({
      where: { organizationId: user.organizationId, ...(all ? {} : { custodianId: user.userId }) },
      include: { _count: { select: { movements: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return this.withCustodians(user, rows);
  }

  async get(user: AuthUser, id: string) {
    const c = await this.prisma.pettyCashCustody.findFirst({
      where: { id, organizationId: user.organizationId },
      include: {
        movements: {
          orderBy: { createdAt: 'desc' },
          include: {
            lines: {
              include: {
                project: { select: { id: true, code: true } },
                wbsElement: { select: { code: true, nameAr: true, nameEn: true } },
              },
            },
          },
        },
      },
    });
    if (!c) throw new NotFoundException('Custody not found');
    this.assertCanSee(user, c.custodianId);
    const pending = c.movements.filter((m) => m.status === 'PENDING').map((m) => m.id);
    const chains = await this.approvals.pendingFor(user.organizationId, 'PETTY_CASH_SETTLEMENT', pending);
    const [withName] = await this.withCustodians(user, [c]);
    return {
      ...withName,
      available: round2(Number(c.balance) - (await this.pendingTotal(c.id))),
      movements: c.movements.map((m) => ({ ...m, pendingApproval: chains.get(m.id) ?? null })),
    };
  }

  /** The inbox links a settlement by the movement's id. */
  async movementRef(user: AuthUser, movementId: string) {
    const m = await this.prisma.pettyCashMovement.findFirst({
      where: { id: movementId, custody: { organizationId: user.organizationId } },
      select: { id: true, code: true, custodyId: true },
    });
    if (!m) throw new NotFoundException('Movement not found');
    return m;
  }

  async create(user: AuthUser, dto: CreateCustodyDto) {
    const custodian = await this.prisma.user.findFirst({
      where: { id: dto.custodianId, organizationId: user.organizationId, isActive: true },
      select: { id: true },
    });
    if (!custodian) throw new NotFoundException('Custodian not found');
    return this.prisma.$transaction(async (tx) => {
      const code = await this.numbering.next(user.organizationId, 'PETTY_CASH_CUSTODY', tx);
      const c = await tx.pettyCashCustody.create({
        data: {
          organizationId: user.organizationId,
          code,
          custodianId: custodian.id,
          notes: dto.notes?.trim() || null,
          createdById: user.userId,
        },
      });
      await this.record(tx, user, c.id, 'CREATE', null, { code, custodianId: custodian.id });
      return c;
    });
  }

  async fund(user: AuthUser, id: string, dto: CashAmountDto) {
    const c = await this.openCustody(user, id);
    if (c.custodianId === user.userId) throw new ForbiddenException('A custodian does not fund his own custody');
    const acc = await this.posting.accounts(user.organizationId, ['PETTY_CASH', 'BANK'] as const);
    const out = await this.prisma.$transaction(async (tx) => {
      const m = await this.movement(tx, user, c.id, 'FUND', 'POSTED', dto.amount, dto.memo);
      await this.posting.journal(tx, {
        organizationId: user.organizationId,
        sourceType: 'PettyCashMovement',
        sourceId: m.id,
        memo: `Petty cash ${c.code} funded — ${m.code}`,
        lines: [
          { accountId: acc.PETTY_CASH, debit: dto.amount, credit: 0 },
          { accountId: acc.BANK, debit: 0, credit: dto.amount },
        ],
      });
      await tx.pettyCashCustody.update({ where: { id: c.id }, data: { balance: { increment: dto.amount } } });
      await this.record(tx, user, c.id, 'FUND', null, { movement: m.code, amount: dto.amount });
      return m;
    });
    await this.notifications.notifyUserBestEffort({
      organizationId: user.organizationId,
      userId: c.custodianId,
      type: 'PETTY_CASH_FUNDED',
      titleAr: `أُضيف ${dto.amount.toLocaleString('en-US')} ريال إلى عهدتك ${c.code}`,
      titleEn: `SAR ${dto.amount.toLocaleString('en-US')} added to your petty cash ${c.code}`,
      linkPath: `/projects/petty-cash/${c.id}`,
    });
    return out;
  }

  /** The custodian accounts for what he spent; each line on a project and budget line. */
  async settle(user: AuthUser, id: string, dto: CreateSettlementDto) {
    const c = await this.openCustody(user, id);
    if (c.custodianId !== user.userId) throw new ForbiddenException('Only the custodian settles his custody');
    const total = round2(dto.lines.reduce((s, l) => s + l.amount, 0));
    const available = round2(Number(c.balance) - (await this.pendingTotal(c.id)));
    if (total > available + 0.005) {
      throw new BadRequestException(`The settlement (${total}) exceeds the cash held (${available})`);
    }
    const projectIds = [...new Set(dto.lines.map((l) => l.projectId))];
    const projects = await this.prisma.project.findMany({
      where: { id: { in: projectIds }, organizationId: user.organizationId },
      select: { id: true },
    });
    if (projects.length !== projectIds.length) throw new BadRequestException('A line names an unknown project');
    for (const l of dto.lines.filter((x) => x.wbsElementId)) {
      const w = await this.prisma.wbsElement.findFirst({ where: { id: l.wbsElementId, projectId: l.projectId } });
      if (!w) throw new BadRequestException('A line names a budget line of another project');
    }

    const m = await this.prisma.$transaction(async (tx) => {
      const row = await this.movement(tx, user, c.id, 'SETTLEMENT', 'PENDING', total, dto.memo);
      await tx.pettyCashLine.createMany({
        data: dto.lines.map((l) => ({
          movementId: row.id,
          projectId: l.projectId,
          wbsElementId: l.wbsElementId ?? null,
          description: l.description.trim(),
          amount: l.amount,
          spentOn: dayOf(l.spentOn),
        })),
      });
      await this.record(tx, user, c.id, 'SETTLE', null, { movement: row.code, total });
      return row;
    });
    const verdict = await this.approvals.gate(user, {
      documentType: 'PETTY_CASH_SETTLEMENT',
      documentId: m.id,
      documentCode: `${m.code} · ${c.code}`,
      amount: total,
      departmentId: null,
    });
    if (verdict.cleared) {
      await this.prisma.pettyCashMovement.delete({ where: { id: m.id } });
      throw new ConflictException(
        'No approval rule routes petty cash settlements — the administrator must set the PETTY_CASH_SETTLEMENT rule',
      );
    }
    return { ...m, pendingApproval: verdict.request };
  }

  async returnCash(user: AuthUser, id: string, dto: CashAmountDto) {
    const c = await this.openCustody(user, id);
    const available = round2(Number(c.balance) - (await this.pendingTotal(c.id)));
    if (dto.amount > available + 0.005) throw new BadRequestException(`Only ${available} is free to return`);
    const acc = await this.posting.accounts(user.organizationId, ['PETTY_CASH', 'BANK'] as const);
    return this.prisma.$transaction(async (tx) => {
      const m = await this.movement(tx, user, c.id, 'RETURN', 'POSTED', dto.amount, dto.memo);
      await this.posting.journal(tx, {
        organizationId: user.organizationId,
        sourceType: 'PettyCashMovement',
        sourceId: m.id,
        memo: `Petty cash ${c.code} returned — ${m.code}`,
        lines: [
          { accountId: acc.BANK, debit: dto.amount, credit: 0 },
          { accountId: acc.PETTY_CASH, debit: 0, credit: dto.amount },
        ],
      });
      await tx.pettyCashCustody.update({ where: { id: c.id }, data: { balance: { decrement: dto.amount } } });
      await this.record(tx, user, c.id, 'RETURN', null, { movement: m.code, amount: dto.amount });
      return m;
    });
  }

  async close(user: AuthUser, id: string) {
    const c = await this.openCustody(user, id);
    if (D(c.balance).gt(0)) throw new ConflictException('Return or settle the remaining cash before closing');
    if ((await this.pendingTotal(c.id)) > 0) throw new ConflictException('A settlement is still awaiting approval');
    return this.prisma.$transaction(async (tx) => {
      const out = await tx.pettyCashCustody.update({ where: { id: c.id }, data: { status: 'CLOSED', closedAt: new Date() } });
      await this.record(tx, user, c.id, 'CLOSE', { status: 'OPEN' }, { status: 'CLOSED' });
      return out;
    });
  }

  // ── the matrix's applier and rejecter ────────────────────────────────────

  private async applySettlement(user: AuthUser, movementId: string) {
    const m = await this.prisma.pettyCashMovement.findFirst({
      where: { id: movementId, custody: { organizationId: user.organizationId } },
      include: { lines: true, custody: true },
    });
    if (!m || m.status !== 'PENDING') return null;
    const acc = await this.posting.accounts(user.organizationId, ['WIP', 'PETTY_CASH'] as const);
    const byProject = new Map<string, number>();
    for (const l of m.lines) byProject.set(l.projectId, round2((byProject.get(l.projectId) ?? 0) + Number(l.amount)));

    await this.prisma.$transaction(async (tx) => {
      // One journal per project, so the WIP balance stays readable per project.
      for (const [projectId, amount] of byProject) {
        await this.posting.journal(tx, {
          organizationId: user.organizationId,
          sourceType: 'PettyCashMovement',
          sourceId: m.id,
          projectId,
          memo: `Petty cash settlement ${m.code} — ${m.custody.code}`,
          lines: [
            { accountId: acc.WIP, debit: amount, credit: 0 },
            { accountId: acc.PETTY_CASH, debit: 0, credit: amount },
          ],
        });
      }
      await tx.projectCostEntry.createMany({
        data: m.lines.map((l) => ({
          organizationId: user.organizationId,
          projectId: l.projectId,
          wbsElementId: l.wbsElementId,
          costType: 'OVERHEAD' as const,
          sourceType: 'PettyCashMovement',
          sourceId: m.id,
          amount: l.amount,
          memo: l.description,
        })),
      });
      await tx.pettyCashMovement.update({ where: { id: m.id }, data: { status: 'POSTED', decidedAt: new Date() } });
      await tx.pettyCashCustody.update({ where: { id: m.custodyId }, data: { balance: { decrement: m.amount } } });
      await this.record(tx, user, m.custodyId, 'SETTLEMENT_APPROVED', null, { movement: m.code, amount: Number(m.amount) });
    });
    await this.notifications.notifyUserBestEffort({
      organizationId: user.organizationId,
      userId: m.custody.custodianId,
      type: 'PETTY_CASH_SETTLED',
      titleAr: `اعتُمدت تسوية العهدة ${m.code}`,
      titleEn: `Petty cash settlement ${m.code} approved`,
      linkPath: `/projects/petty-cash/${m.custodyId}`,
    });
    return { status: 'POSTED' };
  }

  private async rejectSettlement(user: AuthUser, movementId: string, note: string) {
    const m = await this.prisma.pettyCashMovement.findFirst({
      where: { id: movementId, custody: { organizationId: user.organizationId } },
      include: { custody: true },
    });
    if (!m || m.status !== 'PENDING') return null;
    await this.prisma.pettyCashMovement.update({
      where: { id: m.id },
      data: { status: 'REJECTED', decidedAt: new Date(), decisionNote: note?.trim() || null },
    });
    await this.notifications.notifyUserBestEffort({
      organizationId: user.organizationId,
      userId: m.custody.custodianId,
      type: 'PETTY_CASH_REJECTED',
      titleAr: `رُفضت تسوية العهدة ${m.code}`,
      titleEn: `Petty cash settlement ${m.code} rejected`,
      bodyAr: note,
      bodyEn: note,
      linkPath: `/projects/petty-cash/${m.custodyId}`,
    });
    return { status: 'REJECTED' };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private isFinance(user: AuthUser) {
    return user.permissions.includes(PERMISSIONS.PAYMENT_READ);
  }

  private assertCanSee(user: AuthUser, custodianId: string) {
    if (custodianId === user.userId || this.isFinance(user) || user.permissions.includes(PERMISSIONS.PROCUREMENT_APPROVE)) return;
    throw new NotFoundException('Custody not found');
  }

  private async openCustody(user: AuthUser, id: string) {
    const c = await this.prisma.pettyCashCustody.findFirst({ where: { id, organizationId: user.organizationId } });
    if (!c) throw new NotFoundException('Custody not found');
    if (c.status !== 'OPEN') throw new ConflictException('The custody is closed');
    return c;
  }

  private async pendingTotal(custodyId: string) {
    const agg = await this.prisma.pettyCashMovement.aggregate({
      where: { custodyId, status: 'PENDING' },
      _sum: { amount: true },
    });
    return Number(agg._sum.amount ?? 0);
  }

  private async movement(
    tx: Prisma.TransactionClient,
    user: AuthUser,
    custodyId: string,
    kind: 'FUND' | 'SETTLEMENT' | 'RETURN',
    status: 'PENDING' | 'POSTED',
    amount: number,
    memo?: string,
  ) {
    return tx.pettyCashMovement.create({
      data: {
        custodyId,
        code: await this.numbering.next(user.organizationId, 'PETTY_CASH_MOVEMENT', tx),
        kind,
        status,
        amount,
        memo: memo?.trim() || null,
        createdById: user.userId,
      },
    });
  }

  private async withCustodians<T extends { custodianId: string }>(user: AuthUser, rows: T[]) {
    const users = await this.prisma.user.findMany({
      where: { organizationId: user.organizationId, id: { in: [...new Set(rows.map((r) => r.custodianId))] } },
      select: { id: true, nameAr: true, nameEn: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    return rows.map((r) => ({ ...r, custodian: byId.get(r.custodianId) ?? null }));
  }

  private record(tx: Prisma.TransactionClient, user: AuthUser, id: string, action: string, before: unknown, after: unknown) {
    return this.audit.record(
      { organizationId: user.organizationId, actorId: user.userId, entityType: 'PettyCashCustody', entityId: id, action, before, after },
      tx,
    );
  }
}
