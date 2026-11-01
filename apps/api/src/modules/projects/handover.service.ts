import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@npi/db';
import { HANDOVER_CHECKLIST, PERMISSIONS, WARRANTY_KINDS } from '@npi/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { NumberingService } from '../../common/numbering.service';
import { AuditService } from '../../common/audit.service';
import { ApprovalService } from '../../common/approval.service';
import { NotificationService } from '../../common/notification.service';
import type { AuthUser } from '../../common/auth-user';
import type { SaveHandoverDto } from './handover.dto';

const dayOf = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
const addYears = (d: Date, years: number) => {
  const out = new Date(d);
  out.setUTCFullYear(out.getUTCFullYear() + years);
  return out;
};
type CheckRow = { key: string; ok: boolean; note?: string };

/**
 * Package 7 (ADR-07) — owner work cycle step 16 and contract annex 2.
 *
 * The engineer proves completion on the handover: the certificate's eight
 * inspection items, the test readings, any remaining snags with their
 * deadline, the client's representative, and the files on the project
 * (photos, the client's signed acceptance). Submitted, it goes to the projects
 * GM and the general manager (PROJECT_CLOSURE). Their approval is the moment
 * of acceptance: the project closes, the warranties start, and the final
 * payment milestone becomes due. Closing a project any other way is refused.
 */
@Injectable()
export class HandoverService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalService,
    private readonly notifications: NotificationService,
  ) {}

  onModuleInit(): void {
    this.approvals.register(
      'PROJECT_CLOSURE',
      (user, id) => this.applyClosure(user, id),
      (user, id, note) => this.applyRejection(user, id, note),
    );
  }

  async get(user: AuthUser, projectId: string) {
    const project = await this.project(user, projectId);
    const [handover, warranties, files, pendingOverruns, openReturns] = await Promise.all([
      this.prisma.projectHandover.findUnique({ where: { projectId } }),
      this.prisma.projectWarranty.findMany({ where: { projectId }, orderBy: { kind: 'asc' } }),
      this.prisma.attachment.count({
        where: { organizationId: user.organizationId, entityType: 'PROJECT', entityId: projectId },
      }),
      this.prisma.executionOverrun.count({ where: { projectId, status: 'PENDING' } }),
      this.prisma.materialReturn.count({ where: { projectId, status: 'RAISED' } }),
    ]);
    const pendingApproval = handover
      ? await this.approvals.forDocument(user, 'PROJECT_CLOSURE', handover.id)
      : null;
    return {
      project: { id: project.id, code: project.code, nameAr: project.nameAr, nameEn: project.nameEn, stage: project.stage },
      handover,
      warranties,
      pendingApproval: pendingApproval?.status === 'PENDING' ? pendingApproval : null,
      // What submit() checks, shown before the engineer presses it.
      readiness: {
        stageIsCommissioning: project.stage === 'COMMISSIONING',
        files,
        pendingOverruns,
        openReturns,
      },
    };
  }

  /** The inbox links a closure by the handover's own id. */
  async ref(user: AuthUser, handoverId: string) {
    const h = await this.prisma.projectHandover.findFirst({
      where: { id: handoverId, organizationId: user.organizationId },
      select: { id: true, code: true, projectId: true },
    });
    if (!h) throw new NotFoundException('Handover not found');
    return h;
  }

  /** Create or edit the draft. A rejected handover goes back to draft on its first edit. */
  async save(user: AuthUser, projectId: string, dto: SaveHandoverDto) {
    const project = await this.project(user, projectId);
    if (project.stage === 'CLOSED') throw new ConflictException('The project is already closed');
    const existing = await this.prisma.projectHandover.findUnique({ where: { projectId } });
    if (existing && ['SUBMITTED', 'APPROVED'].includes(existing.status)) {
      throw new ConflictException('The handover is with the approvers — it cannot be edited now');
    }
    if (dto.checklist) this.assertChecklistKeys(dto.checklist);
    if (dto.warrantyYears) this.assertWarrantyYears(dto.warrantyYears);

    const data = {
      completionDate: dto.completionDate ? dayOf(dto.completionDate) : undefined,
      commissionedAt: dto.commissionedAt ? dayOf(dto.commissionedAt) : undefined,
      checklist: (dto.checklist as unknown as Prisma.InputJsonValue) ?? undefined,
      readings: (dto.readings as unknown as Prisma.InputJsonValue) ?? undefined,
      snags: dto.snags === undefined ? undefined : dto.snags.trim() || null,
      snagsDueDate: dto.snagsDueDate ? dayOf(dto.snagsDueDate) : undefined,
      clientRepName: dto.clientRepName === undefined ? undefined : dto.clientRepName.trim() || null,
      warrantyYears: (dto.warrantyYears as Prisma.InputJsonValue) ?? undefined,
      notes: dto.notes === undefined ? undefined : dto.notes.trim() || null,
    };
    return this.prisma.$transaction(async (tx) => {
      const row = existing
        ? await tx.projectHandover.update({
            where: { id: existing.id },
            data: { ...data, status: 'DRAFT' },
          })
        : await tx.projectHandover.create({
            data: {
              organizationId: user.organizationId,
              code: await this.numbering.next(user.organizationId, 'PROJECT_HANDOVER', tx),
              projectId,
              createdById: user.userId,
              warrantyYears: Object.fromEntries(WARRANTY_KINDS.map((k) => [k.value, k.defaultYears])),
              ...data,
            },
          });
      await this.record(tx, user, row.id, existing ? 'UPDATE' : 'CREATE', null, dto);
      return row;
    });
  }

  async submit(user: AuthUser, projectId: string) {
    const project = await this.project(user, projectId);
    const h = await this.prisma.projectHandover.findUnique({ where: { projectId } });
    if (!h) throw new BadRequestException('Fill in the handover first');
    if (!['DRAFT', 'REJECTED'].includes(h.status)) throw new ConflictException('The handover is already submitted');
    if (project.stage !== 'COMMISSIONING') {
      throw new ConflictException('A project is handed over from the commissioning stage');
    }

    const problems: string[] = [];
    if (!h.completionDate) problems.push('completion date');
    if (!h.commissionedAt) problems.push('commissioning date');
    const checklist = (h.checklist as unknown as CheckRow[]) ?? [];
    const missing = HANDOVER_CHECKLIST.filter((c) => !checklist.some((r) => r.key === c.key));
    if (missing.length) problems.push(`inspection items ${missing.map((m) => m.key).join(', ')}`);
    const failed = checklist.filter((r) => !r.ok);
    if (failed.length && !(h.snags?.trim() && h.snagsDueDate)) {
      problems.push('the snags and their deadline for the items not passed');
    }
    if (!h.clientRepName) problems.push("the client representative's name");
    const [files, pendingOverruns, openReturns] = await Promise.all([
      this.prisma.attachment.count({
        where: { organizationId: user.organizationId, entityType: 'PROJECT', entityId: projectId },
      }),
      this.prisma.executionOverrun.count({ where: { projectId, status: 'PENDING' } }),
      this.prisma.materialReturn.count({ where: { projectId, status: 'RAISED' } }),
    ]);
    if (files === 0) problems.push("the completion photos and the client's acceptance on the project file");
    if (pendingOverruns) problems.push(`${pendingOverruns} overrun(s) still awaiting approval`);
    if (openReturns) problems.push(`${openReturns} material return(s) not yet received at the store`);
    if (problems.length) throw new BadRequestException(`Before submitting the handover: ${problems.join('; ')}`);

    await this.prisma.$transaction(async (tx) => {
      await tx.projectHandover.update({
        where: { id: h.id },
        data: { status: 'SUBMITTED', submittedById: user.userId, submittedAt: new Date(), decisionNote: null },
      });
      await this.record(tx, user, h.id, 'SUBMIT', { status: h.status }, { status: 'SUBMITTED' });
    });
    const verdict = await this.approvals.gate(user, {
      documentType: 'PROJECT_CLOSURE',
      documentId: h.id,
      documentCode: `${h.code} · ${project.code}`,
      amount: Number(project.contract?.totalValue ?? 0),
      departmentId: null,
    });
    if (verdict.cleared) {
      await this.prisma.projectHandover.update({ where: { id: h.id }, data: { status: h.status } });
      throw new ConflictException(
        'No approval rule routes project closure — the administrator must set the PROJECT_CLOSURE rule (projects GM, then general manager)',
      );
    }
    return { status: 'SUBMITTED', pendingApproval: verdict.request };
  }

  /** The register: every warranty, soonest to end first. */
  warranties(user: AuthUser) {
    return this.prisma.projectWarranty.findMany({
      where: { organizationId: user.organizationId },
      include: { project: { select: { id: true, code: true, nameAr: true, nameEn: true } } },
      orderBy: { endsAt: 'asc' },
    });
  }

  // ── the matrix's applier and rejecter ────────────────────────────────────

  private async applyClosure(user: AuthUser, handoverId: string) {
    const h = await this.prisma.projectHandover.findFirst({
      where: { id: handoverId, organizationId: user.organizationId },
      include: { project: { include: { contract: { include: { milestones: { orderBy: { sequence: 'asc' } } } } } } },
    });
    if (!h || h.status !== 'SUBMITTED') return null;
    const start = h.commissionedAt ?? h.completionDate ?? dayOf(new Date().toISOString());
    const years = (h.warrantyYears as Record<string, number>) ?? {};
    const finalMilestone = [...(h.project.contract?.milestones ?? [])]
      .reverse()
      .find((m) => m.status === 'PENDING');

    await this.prisma.$transaction(async (tx) => {
      await tx.projectHandover.update({ where: { id: h.id }, data: { status: 'APPROVED', decidedAt: new Date() } });
      await tx.project.update({ where: { id: h.projectId }, data: { stage: 'CLOSED' } });
      for (const k of WARRANTY_KINDS) {
        const y = Number(years[k.value] ?? k.defaultYears);
        if (!(y > 0)) continue;
        await tx.projectWarranty.upsert({
          where: { projectId_kind: { projectId: h.projectId, kind: k.value } },
          update: { years: y, startsAt: start, endsAt: addYears(start, y) },
          create: {
            organizationId: user.organizationId,
            projectId: h.projectId,
            kind: k.value,
            years: y,
            startsAt: start,
            endsAt: addYears(start, y),
          },
        });
      }
      // Acceptance makes the last payment due (contract annex 2).
      if (finalMilestone) {
        await tx.contractMilestone.update({
          where: { id: finalMilestone.id },
          data: {
            status: 'VERIFIED',
            verifiedAt: new Date(),
            verifiedById: user.userId,
            dueDate: finalMilestone.dueDate ?? new Date(),
          },
        });
      }
      await this.record(tx, user, h.id, 'APPROVE', { status: 'SUBMITTED' }, {
        status: 'APPROVED',
        projectStage: 'CLOSED',
        warrantiesFrom: start,
        finalMilestone: finalMilestone?.id ?? null,
      });
    });

    if (finalMilestone) {
      await this.notifications.notifyBestEffort({
        organizationId: user.organizationId,
        permission: PERMISSIONS.INVOICE_WRITE,
        type: 'FINAL_PAYMENT_DUE',
        titleAr: `استُلم المشروع ${h.project.code}: الدفعة الأخيرة مستحقة — أصدر فاتورتها`,
        titleEn: `${h.project.code} accepted: the final payment is due — issue its invoice`,
        linkPath: h.project.contract ? `/contracts/${h.project.contract.id}` : `/projects/${h.projectId}`,
      });
    }
    if (h.submittedById) {
      await this.notifications.notifyUserBestEffort({
        organizationId: user.organizationId,
        userId: h.submittedById,
        type: 'PROJECT_CLOSED',
        titleAr: `اعتُمد تسليم ${h.project.code} وأُغلق المشروع وبدأت الضمانات`,
        titleEn: `${h.project.code} handover approved: project closed, warranties started`,
        linkPath: `/projects/${h.projectId}/handover`,
      });
    }
    return { status: 'APPROVED' };
  }

  private async applyRejection(user: AuthUser, handoverId: string, note: string) {
    const h = await this.prisma.projectHandover.findFirst({
      where: { id: handoverId, organizationId: user.organizationId },
      include: { project: { select: { code: true } } },
    });
    if (!h || h.status !== 'SUBMITTED') return null;
    await this.prisma.$transaction(async (tx) => {
      await tx.projectHandover.update({
        where: { id: h.id },
        data: { status: 'REJECTED', decidedAt: new Date(), decisionNote: note?.trim() || null },
      });
      await this.record(tx, user, h.id, 'REJECT', { status: 'SUBMITTED' }, { status: 'REJECTED', note });
    });
    if (h.submittedById) {
      await this.notifications.notifyUserBestEffort({
        organizationId: user.organizationId,
        userId: h.submittedById,
        type: 'HANDOVER_REJECTED',
        titleAr: `أُعيد تسليم ${h.project.code} للاستكمال`,
        titleEn: `${h.project.code} handover sent back`,
        bodyAr: note,
        bodyEn: note,
        linkPath: `/projects/${h.projectId}/handover`,
      });
    }
    return { status: 'REJECTED' };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async project(user: AuthUser, projectId: string) {
    const p = await this.prisma.project.findFirst({
      where: { id: projectId, organizationId: user.organizationId },
      include: { contract: { select: { id: true, totalValue: true } } },
    });
    if (!p) throw new NotFoundException('Project not found');
    return p;
  }

  private assertChecklistKeys(rows: CheckRow[]) {
    const known = new Set(HANDOVER_CHECKLIST.map((c) => c.key));
    const bad = rows.find((r) => !known.has(r.key));
    if (bad) throw new BadRequestException(`Unknown inspection item ${bad.key}`);
  }

  private assertWarrantyYears(years: Record<string, number>) {
    const known = new Set<string>(WARRANTY_KINDS.map((k) => k.value));
    for (const [k, v] of Object.entries(years)) {
      if (!known.has(k)) throw new BadRequestException(`Unknown warranty ${k}`);
      if (!Number.isInteger(v) || v < 0 || v > 40) throw new BadRequestException(`Warranty years for ${k} must be 0–40`);
    }
  }

  private record(tx: Prisma.TransactionClient, user: AuthUser, id: string, action: string, before: unknown, after: unknown) {
    return this.audit.record(
      { organizationId: user.organizationId, actorId: user.userId, entityType: 'ProjectHandover', entityId: id, action, before, after },
      tx,
    );
  }
}
