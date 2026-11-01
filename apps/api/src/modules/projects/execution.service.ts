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
import { ProjectsService } from './projects.service';
import type { AuthUser } from '../../common/auth-user';
import type { AttendanceDto, CheckOutDto, RecordProgressDto, RequestOverrunDto } from './execution.dto';

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const dayOf = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);

/**
 * Package 5 (ADR-05) — owner work cycle step 14: what was executed on each
 * budget line, what is left, who was on site, and the overrun that needs two
 * signatures before anything beyond the approved quantity may be recorded.
 *
 * The cap of a line is its budgeted quantity plus every APPROVED overrun on
 * it; a line opened without a quantity (projects budgeted by category before
 * package 4) is recorded against with no cap and no percentage.
 */
@Injectable()
export class ExecutionService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalService,
    private readonly notifications: NotificationService,
    private readonly projects: ProjectsService,
  ) {}

  onModuleInit(): void {
    this.approvals.register(
      'EXECUTION_OVERRUN',
      (user, id) => this.decideOverrun(user, id, 'APPROVED'),
      (user, id, note) => this.decideOverrun(user, id, 'REJECTED', note),
    );
  }

  // ── reading ───────────────────────────────────────────────────────────────

  /**
   * Every budget line with its quantity, executed, cap, remaining, progress
   * and the job-costing columns (budget, committed, actual, variance) — the
   * «budget vs actual per line» report — plus the day log and the overruns.
   */
  async summary(user: AuthUser, projectId: string) {
    const project = await this.projects.get(user, projectId);
    const [executed, approved, entries, overruns] = await Promise.all([
      this.prisma.workProgressEntry.groupBy({
        by: ['wbsElementId'],
        where: { organizationId: user.organizationId, projectId },
        _sum: { qty: true },
      }),
      this.prisma.executionOverrun.groupBy({
        by: ['wbsElementId'],
        where: { organizationId: user.organizationId, projectId, status: 'APPROVED' },
        _sum: { extraQty: true },
      }),
      this.prisma.workProgressEntry.findMany({
        where: { organizationId: user.organizationId, projectId },
        include: { wbsElement: { select: { code: true, nameAr: true, nameEn: true, uom: true } } },
        orderBy: [{ workDate: 'desc' }, { createdAt: 'desc' }],
        take: 500,
      }),
      this.prisma.executionOverrun.findMany({
        where: { organizationId: user.organizationId, projectId },
        include: { wbsElement: { select: { code: true, nameAr: true, nameEn: true, uom: true } } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    const exec = new Map(executed.map((r) => [r.wbsElementId, Number(r._sum.qty ?? 0)]));
    const extra = new Map(approved.map((r) => [r.wbsElementId, Number(r._sum.extraQty ?? 0)]));
    const pending = await this.approvals.pendingFor(
      user.organizationId,
      'EXECUTION_OVERRUN',
      overruns.filter((o) => o.status === 'PENDING').map((o) => o.id),
    );

    const lines = project.wbsElements.map((w) => {
      const planned = w.qty === null || w.qty === undefined ? null : Number(w.qty);
      const done = exec.get(w.id) ?? 0;
      const cap = planned === null ? null : planned + (extra.get(w.id) ?? 0);
      return {
        id: w.id,
        code: w.code,
        nameAr: w.nameAr,
        nameEn: w.nameEn,
        uom: w.uom,
        plannedStart: w.plannedStart,
        plannedEnd: w.plannedEnd,
        plannedQty: planned,
        approvedExtraQty: extra.get(w.id) ?? 0,
        capQty: cap,
        executedQty: done,
        remainingQty: cap === null ? null : Math.max(0, cap - done),
        progressPct: planned ? round2(Math.min(100, (done / planned) * 100)) : null,
        budget: Number(w.budgetAmount),
        committed: w.committed,
        actual: w.actual,
        variance: w.variance,
      };
    });
    // Weighted by budget, so a cheap line finished early does not read as half the project.
    const weighted = lines.filter((l) => l.progressPct !== null && l.budget > 0);
    const weight = weighted.reduce((s, l) => s + l.budget, 0);
    const progressPct = weight ? round2(weighted.reduce((s, l) => s + l.budget * (l.progressPct ?? 0), 0) / weight) : null;

    return {
      project: { id: project.id, code: project.code, nameAr: project.nameAr, nameEn: project.nameEn, stage: project.stage },
      progressPct,
      costSummary: project.costSummary,
      lines,
      entries,
      overruns: overruns.map((o) => this.redact(user, { ...o, pendingApproval: pending.get(o.id) ?? null })),
    };
  }

  // ── daily progress (P5-1) ─────────────────────────────────────────────────

  async recordProgress(user: AuthUser, projectId: string, dto: RecordProgressDto) {
    await this.openProject(user, projectId);
    const workDate = dayOf(dto.workDate);
    if (workDate.getTime() > Date.now()) throw new BadRequestException('Progress cannot be recorded for a future day');

    const ids = [...new Set(dto.lines.map((l) => l.wbsElementId))];
    const wbs = await this.prisma.wbsElement.findMany({ where: { id: { in: ids }, projectId } });
    if (wbs.length !== ids.length) throw new BadRequestException('A line is not a budget line of this project');

    return this.prisma.$transaction(async (tx) => {
      for (const w of wbs) {
        if (w.qty === null) continue; // no planned quantity: no cap
        const adding = dto.lines.filter((l) => l.wbsElementId === w.id).reduce((s, l) => s + l.qty, 0);
        const [done, extra] = await Promise.all([
          tx.workProgressEntry.aggregate({ where: { wbsElementId: w.id }, _sum: { qty: true } }),
          tx.executionOverrun.aggregate({ where: { wbsElementId: w.id, status: 'APPROVED' }, _sum: { extraQty: true } }),
        ]);
        const cap = D(w.qty).add(extra._sum.extraQty ?? 0);
        const after = D(done._sum.qty ?? 0).add(adding);
        if (after.gt(cap)) {
          const left = cap.sub(done._sum.qty ?? 0);
          throw new ConflictException(
            `${w.code}: only ${left.toString()}${w.uom ? ` ${w.uom}` : ''} left of the approved quantity — request an overrun (projects GM and general manager) to record more`,
          );
        }
      }
      const created = [];
      for (const l of dto.lines) {
        created.push(
          await tx.workProgressEntry.create({
            data: {
              organizationId: user.organizationId,
              projectId,
              wbsElementId: l.wbsElementId,
              workDate,
              qty: l.qty,
              notes: l.notes?.trim() || null,
              createdById: user.userId,
            },
          }),
        );
      }
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'Project',
          entityId: projectId,
          action: 'PROGRESS',
          after: { workDate: dto.workDate.slice(0, 10), lines: dto.lines },
        },
        tx,
      );
      return created;
    });
  }

  /** Only the author, the same day it was entered, and only an entry that is not already relied on by an overrun. */
  async deleteProgress(user: AuthUser, entryId: string) {
    const entry = await this.prisma.workProgressEntry.findFirst({
      where: { id: entryId, organizationId: user.organizationId },
    });
    if (!entry) throw new NotFoundException('Progress entry not found');
    if (entry.createdById !== user.userId) throw new ForbiddenException('Only the engineer who recorded it can remove it');
    if (Date.now() - entry.createdAt.getTime() > 24 * 3600 * 1000) {
      throw new ConflictException('An entry older than a day is part of the record — record a correction instead');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.workProgressEntry.delete({ where: { id: entry.id } });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'Project',
          entityId: entry.projectId,
          action: 'PROGRESS_DELETE',
          before: { wbsElementId: entry.wbsElementId, qty: entry.qty.toString(), workDate: entry.workDate },
        },
        tx,
      );
    });
    return { deleted: true };
  }

  // ── overrun (P5-2) ────────────────────────────────────────────────────────

  async requestOverrun(user: AuthUser, projectId: string, dto: RequestOverrunDto) {
    await this.openProject(user, projectId);
    const w = await this.prisma.wbsElement.findFirst({ where: { id: dto.wbsElementId, projectId } });
    if (!w) throw new BadRequestException('Not a budget line of this project');
    if (w.qty === null || D(w.qty).lte(0)) {
      throw new BadRequestException('This line has no planned quantity, so it has nothing to exceed');
    }
    const open = await this.prisma.executionOverrun.count({ where: { wbsElementId: w.id, status: 'PENDING' } });
    if (open > 0) throw new ConflictException(`${w.code} already has an overrun awaiting approval`);

    const unitCost = D(w.budgetAmount).div(w.qty);
    const amount = round2(unitCost.mul(dto.extraQty).toNumber());
    const overrun = await this.prisma.$transaction(async (tx) => {
      const code = await this.numbering.next(user.organizationId, 'EXECUTION_OVERRUN', tx);
      const row = await tx.executionOverrun.create({
        data: {
          organizationId: user.organizationId,
          code,
          projectId,
          wbsElementId: w.id,
          extraQty: dto.extraQty,
          amount,
          reason: dto.reason.trim(),
          requestedById: user.userId,
        },
      });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'ExecutionOverrun',
          entityId: row.id,
          action: 'REQUEST',
          after: { code, wbs: w.code, extraQty: dto.extraQty, amount },
        },
        tx,
      );
      return row;
    });

    // The owner made two signatures a condition (2026-10-29 (a)): with no rule
    // in the matrix nothing may clear on its own, so the request is withdrawn.
    const verdict = await this.approvals.gate(user, {
      documentType: 'EXECUTION_OVERRUN',
      documentId: overrun.id,
      documentCode: overrun.code,
      amount,
      departmentId: null,
    });
    if (verdict.cleared) {
      await this.prisma.executionOverrun.delete({ where: { id: overrun.id } });
      throw new ConflictException(
        'No approval rule routes budget overruns — the administrator must set the EXECUTION_OVERRUN rule (projects GM, then general manager)',
      );
    }
    return this.redact(user, { ...overrun, pendingApproval: verdict.request });
  }

  /**
   * An overrun's amount is extra quantity × the line's cost per unit, so it
   * would hand the unit cost to anyone who can see the quantity. `amount` is
   * too generic a key for COST_FIELDS, so it is removed here, with the chain's
   * copy of it, for a user without finance.costs.view.
   */
  private redact<T extends { amount: unknown; pendingApproval: unknown }>(user: AuthUser, o: T): T {
    if (user.permissions.includes(PERMISSIONS.COSTS_VIEW)) return o;
    const chain = o.pendingApproval as Record<string, unknown> | null;
    return { ...o, amount: null, pendingApproval: chain ? { ...chain, amount: null } : null };
  }

  /** The matrix's applier and rejecter: the chain has already decided. */
  private async decideOverrun(user: AuthUser, id: string, status: 'APPROVED' | 'REJECTED', note?: string) {
    const o = await this.prisma.executionOverrun.findFirst({
      where: { id, organizationId: user.organizationId },
      include: { wbsElement: { select: { code: true } } },
    });
    if (!o || o.status !== 'PENDING') return null;
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.executionOverrun.update({
        where: { id: o.id },
        data: { status, decidedAt: new Date(), decisionNote: note?.trim() || null },
      });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'ExecutionOverrun',
          entityId: o.id,
          action: status === 'APPROVED' ? 'APPROVE' : 'REJECT',
          before: { status: 'PENDING' },
          after: { status, note },
        },
        tx,
      );
      return row;
    });
    await this.notifications.notifyUserBestEffort({
      organizationId: user.organizationId,
      userId: o.requestedById,
      type: status === 'APPROVED' ? 'OVERRUN_APPROVED' : 'OVERRUN_REJECTED',
      titleAr:
        status === 'APPROVED'
          ? `اعتُمد تجاوز ${o.wbsElement.code} (${o.code}) — يمكنك تسجيل الكمية الزائدة`
          : `رُفض تجاوز ${o.wbsElement.code} (${o.code})`,
      titleEn:
        status === 'APPROVED'
          ? `Overrun on ${o.wbsElement.code} approved (${o.code}) — the extra quantity can be recorded`
          : `Overrun on ${o.wbsElement.code} rejected (${o.code})`,
      linkPath: `/projects/${o.projectId}/execution`,
    });
    return updated;
  }

  async overrunRef(user: AuthUser, id: string) {
    const o = await this.prisma.executionOverrun.findFirst({
      where: { id, organizationId: user.organizationId },
      select: { id: true, code: true, projectId: true },
    });
    if (!o) throw new NotFoundException('Overrun not found');
    return o;
  }

  // ── attendance (P5-3) ─────────────────────────────────────────────────────

  async attendance(user: AuthUser, projectId: string, date?: string) {
    await this.openProject(user, projectId, false);
    return this.prisma.siteAttendance.findMany({
      where: {
        organizationId: user.organizationId,
        projectId,
        ...(date ? { workDate: dayOf(date) } : {}),
      },
      orderBy: [{ workDate: 'desc' }, { checkInAt: 'asc' }],
      take: 500,
    });
  }

  async checkIn(user: AuthUser, projectId: string, dto: AttendanceDto) {
    await this.openProject(user, projectId);
    const checkInAt = new Date(dto.checkInAt);
    const checkOutAt = dto.checkOutAt ? new Date(dto.checkOutAt) : null;
    if (checkOutAt && checkOutAt <= checkInAt) throw new BadRequestException('Check-out must be after check-in');
    return this.prisma.siteAttendance.create({
      data: {
        organizationId: user.organizationId,
        projectId,
        workDate: dayOf(dto.workDate),
        workerName: dto.workerName.trim(),
        trade: dto.trade?.trim() || null,
        checkInAt,
        checkOutAt,
        notes: dto.notes?.trim() || null,
        createdById: user.userId,
      },
    });
  }

  async checkOut(user: AuthUser, attendanceId: string, dto: CheckOutDto) {
    const row = await this.prisma.siteAttendance.findFirst({
      where: { id: attendanceId, organizationId: user.organizationId },
    });
    if (!row) throw new NotFoundException('Attendance row not found');
    const out = new Date(dto.checkOutAt);
    if (out <= row.checkInAt) throw new BadRequestException('Check-out must be after check-in');
    return this.prisma.siteAttendance.update({ where: { id: row.id }, data: { checkOutAt: out } });
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** The project, refusing writes once it is closed. */
  private async openProject(user: AuthUser, projectId: string, writing = true) {
    const p = await this.prisma.project.findFirst({
      where: { id: projectId, organizationId: user.organizationId },
      select: { id: true, stage: true },
    });
    if (!p) throw new NotFoundException('Project not found');
    if (writing && p.stage === 'CLOSED') {
      throw new ConflictException('The project is closed');
    }
    return p;
  }
}
