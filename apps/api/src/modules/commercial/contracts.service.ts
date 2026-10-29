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
import { ApprovalService } from '../../common/approval.service';
import { NumberingService } from '../../common/numbering.service';
import { AuditService } from '../../common/audit.service';
import { NotificationService } from '../../common/notification.service';
import type { AuthUser } from '../../common/auth-user';
import { CreateContractDto, UpdateContractDto } from './dto';
import { OpportunitiesService } from '../crm/opportunities.service';
import { canViewCosts, hideRevisionPricing } from './revision-pricing';

type Tx = Prisma.TransactionClient;
const round2 = (v: Prisma.Decimal) => v.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

/**
 * Package 2 · P2-3 — the owner's default payment schedule, 50 / 30 / 20 with no
 * retention (decision of 2026-10-12, GAP §9), editable per contract before the
 * approval. The last payment takes the rounding, so the three always sum to
 * the contract value exactly.
 */
/** One payment as written: what the DTO carries and what the defaults produce. */
interface MilestoneRow {
  sequence: number;
  descriptionAr: string;
  descriptionEn: string;
  amount: Prisma.Decimal | number;
  triggerType?: 'DATE' | 'PROGRESS' | 'EVENT';
  dueDate?: string | null;
}

const milestoneData = (m: MilestoneRow) => ({
  sequence: m.sequence,
  descriptionAr: m.descriptionAr,
  descriptionEn: m.descriptionEn,
  triggerType: m.triggerType ?? ('PROGRESS' as const),
  amount: m.amount,
  dueDate: m.dueDate ? new Date(m.dueDate) : null,
});

export function defaultMilestones(total: Prisma.Decimal | number | string): MilestoneRow[] {
  const t = new Prisma.Decimal(total);
  const first = round2(t.mul(0.5));
  const second = round2(t.mul(0.3));
  const third = t.sub(first).sub(second);
  return [
    { sequence: 1, descriptionAr: 'الدفعة الأولى (50%)', descriptionEn: 'First payment (50%)', amount: first },
    { sequence: 2, descriptionAr: 'الدفعة الثانية (30%)', descriptionEn: 'Second payment (30%)', amount: second },
    { sequence: 3, descriptionAr: 'الدفعة الثالثة (20%)', descriptionEn: 'Third payment (20%)', amount: third },
  ];
}

/**
 * Package 2 (ADR-01 as amended 2026-10-29). A contract born from an accepted
 * quote follows the company's cycle (owner work cycle step 9):
 *
 *   DRAFT ──submit──▶ PENDING_APPROVAL ──general manager──▶ APPROVED ──signed copy──▶ ACTIVE
 *     ▲                     │ rejected (with the note)
 *     └─────────────────────┘
 *
 * One signature (the matrix's CONTRACT band, the proposal-approve key): the
 * approval of the accepted offer and of the contract's terms together. A
 * contract written by hand with no quote behind it keeps the old DRAFT → ACTIVE
 * move until the owner decides otherwise (open point in PROGRESS.md).
 */
@Injectable()
export class ContractsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly opportunities: OpportunitiesService,
    private readonly approvals: ApprovalService,
  ) {}

  onModuleInit(): void {
    this.approvals.register(
      'CONTRACT',
      (user, id) => this.applyApproval(user, id),
      (user, id, note) => this.applyRejection(user, id, note),
    );
  }

  list(user: AuthUser) {
    return this.prisma.contract.findMany({
      where: { organizationId: user.organizationId },
      include: {
        customer: { select: { id: true, code: true, nameAr: true, nameEn: true } },
        _count: { select: { milestones: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(user: AuthUser, id: string) {
    const contract = await this.prisma.contract.findFirst({
      where: { id, organizationId: user.organizationId },
      include: {
        customer: true,
        opportunity: { select: { id: true, code: true, name: true } },
        proposalRevision: true,
        milestones: { orderBy: { sequence: 'asc' } },
      },
    });
    if (!contract) throw new NotFoundException('Contract not found');
    // Package 2 · P2-4: the CONTRACT signature chain, for the page's banner.
    const approval = await this.approvals.forDocument(user, 'CONTRACT', contract.id);
    // The embedded revision carries the price build-up; hide it from callers
    // who may not see costs and margins (totalAmount stays).
    if (!canViewCosts(user) && contract.proposalRevision) {
      return { ...contract, approval, proposalRevision: hideRevisionPricing(contract.proposalRevision) };
    }
    return { ...contract, approval };
  }

  /**
   * Create a contract. When a winning proposal revision is supplied, the
   * customer, opportunity, proposal and total value are inherited from it and
   * the source opportunity is moved to WON — the "lead → contract" chain closes.
   */
  async create(user: AuthUser, dto: CreateContractDto) {
    let customerId = dto.customerId;
    let opportunityId: string | undefined;
    let proposalId: string | undefined;
    let totalValue = dto.totalValue ?? 0;

    if (dto.proposalRevisionId) {
      const revision = await this.prisma.proposalRevision.findFirst({
        where: {
          id: dto.proposalRevisionId,
          proposal: { organizationId: user.organizationId },
        },
        include: { proposal: { include: { opportunity: true } }, contract: true },
      });
      if (!revision) throw new NotFoundException('Proposal revision not found');
      // D-01: a contract fixes the price the customer agreed to. Any revision
      // that is not ACCEPTED carries a price nobody approved — refuse it here,
      // not just in the UI, because this endpoint is reachable directly.
      if (revision.status !== 'ACCEPTED') {
        throw new BadRequestException(
          `Contract requires an accepted proposal revision (status is ${revision.status})`,
        );
      }
      if (revision.contract) {
        throw new BadRequestException('This proposal revision already has a contract');
      }
      customerId = revision.proposal.opportunity.customerId;
      opportunityId = revision.proposal.opportunityId;
      proposalId = revision.proposalId;
      if (dto.totalValue === undefined) totalValue = Number(revision.totalAmount);
    }

    if (!customerId) {
      throw new BadRequestException('customerId or proposalRevisionId is required');
    }

    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, organizationId: user.organizationId },
    });
    if (!customer) throw new NotFoundException('Customer not found');

    return this.prisma.$transaction(async (tx) => {
      // Package 2 · P2-3: a contract from a quote starts with the owner's 50 / 30 / 20
      // schedule unless the caller supplies its own.
      const milestones: MilestoneRow[] | undefined =
        dto.milestones ?? (dto.proposalRevisionId ? defaultMilestones(totalValue) : undefined);
      // CRM Step 3 — the one rule for winning an opportunity through a contract:
      // refuses a closed opportunity, WON or LOST, (409) before anything is
      // written, guards against a concurrent stage change, audits via: contract
      // and emits opportunity.won (CRM-S3-b: a second contract on a won deal is
      // refused too).
      if (opportunityId) await this.opportunities.markWonViaContract(tx, user, opportunityId);

      const code = await this.numbering.next(user.organizationId, 'CONTRACT', tx);
      const contract = await tx.contract.create({
        data: {
          organizationId: user.organizationId,
          code,
          customerId: customerId!,
          opportunityId,
          proposalId,
          proposalRevisionId: dto.proposalRevisionId,
          contractType: dto.contractType,
          status: 'DRAFT',
          startDate: dto.startDate ? new Date(dto.startDate) : null,
          endDate: dto.endDate ? new Date(dto.endDate) : null,
          totalValue,
          retentionPct: dto.retentionPct ?? 0,
          advancePct: dto.advancePct ?? 0,
          milestones: milestones ? { create: milestones.map(milestoneData) } : undefined,
        },
        include: { milestones: true },
      });

      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'Contract',
          entityId: contract.id,
          action: 'CREATE',
          after: contract,
        },
        tx,
      );

      return contract;
    });
  }

  /**
   * Package 2 · P2-3 (owner work cycle steps 8–9; ADR-01 §3 «المسودة تُنشأ داخل
   * معاملة قبول العرض»): the draft contract is born inside the transaction that
   * accepts the quote — the accepted price, the 50 / 30 / 20 schedule, no
   * retention — and the opportunity is won with it. Idempotent per revision
   * (proposalRevisionId is unique): an existing contract is returned untouched.
   */
  async draftFromAcceptance(tx: Tx, user: AuthUser, revisionId: string) {
    const revision = await tx.proposalRevision.findFirst({
      where: { id: revisionId, proposal: { organizationId: user.organizationId } },
      include: { proposal: { include: { opportunity: true } }, contract: true },
    });
    if (!revision) throw new NotFoundException('Proposal revision not found');
    if (revision.contract) return revision.contract;

    await this.opportunities.markWonViaContract(tx, user, revision.proposal.opportunityId);
    const total = new Prisma.Decimal(revision.totalAmount);
    const code = await this.numbering.next(user.organizationId, 'CONTRACT', tx);
    const contract = await tx.contract.create({
      data: {
        organizationId: user.organizationId,
        code,
        customerId: revision.proposal.opportunity.customerId,
        opportunityId: revision.proposal.opportunityId,
        proposalId: revision.proposalId,
        proposalRevisionId: revision.id,
        contractType: 'EPC',
        status: 'DRAFT',
        totalValue: total,
        retentionPct: 0,
        advancePct: 0,
        milestones: { create: defaultMilestones(total).map(milestoneData) },
      },
      include: { milestones: true },
    });
    await this.audit.record(
      {
        organizationId: user.organizationId,
        actorId: user.userId,
        entityType: 'Contract',
        entityId: contract.id,
        action: 'CREATE',
        after: { ...contract, via: 'proposal-acceptance' },
      },
      tx,
    );
    return contract;
  }

  /** Package 2 · P2-1 (ADR-01 task 1): a draft's terms and payments, edited before it is raised. */
  async update(user: AuthUser, id: string, dto: UpdateContractDto) {
    const existing = await this.prisma.contract.findFirst({
      where: { id, organizationId: user.organizationId },
      include: { milestones: { orderBy: { sequence: 'asc' } } },
    });
    if (!existing) throw new NotFoundException('Contract not found');
    if (existing.status !== 'DRAFT') {
      throw new ConflictException('Only a draft contract can be edited');
    }
    if (dto.milestones) this.assertMilestoneShape(dto.milestones);

    const data: Prisma.ContractUpdateInput = {
      ...(dto.contractType !== undefined ? { contractType: dto.contractType } : {}),
      ...(dto.startDate !== undefined ? { startDate: dto.startDate ? new Date(dto.startDate) : null } : {}),
      ...(dto.endDate !== undefined ? { endDate: dto.endDate ? new Date(dto.endDate) : null } : {}),
      ...(dto.retentionPct !== undefined ? { retentionPct: dto.retentionPct } : {}),
      ...(dto.advancePct !== undefined ? { advancePct: dto.advancePct } : {}),
    };

    return this.prisma.$transaction(async (tx) => {
      if (dto.milestones) {
        await tx.contractMilestone.deleteMany({ where: { contractId: existing.id } });
        data.milestones = { create: dto.milestones.map(milestoneData) };
      }
      const updated = await tx.contract.update({
        where: { id: existing.id },
        data,
        include: { milestones: { orderBy: { sequence: 'asc' } } },
      });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'Contract',
          entityId: existing.id,
          action: 'UPDATE',
          before: existing,
          after: updated,
        },
        tx,
      );
      return updated;
    });
  }

  /**
   * Package 2 · P2-2 — raise a draft for the general manager. Refused unless the
   * payments sum to the contract value exactly (ADR-01 §2 rule 6). The matrix
   * band CONTRACT decides who signs; the raiser never signs their own, and with
   * no band at all only a holder of the approve key may clear it themselves.
   */
  async submit(user: AuthUser, id: string) {
    const contract = await this.prisma.contract.findFirst({
      where: { id, organizationId: user.organizationId },
      include: { milestones: true },
    });
    if (!contract) throw new NotFoundException('Contract not found');
    if (contract.status !== 'DRAFT') throw new ConflictException('Only a draft contract can be raised for approval');
    this.assertMilestoneShape(contract.milestones);
    const total = new Prisma.Decimal(contract.totalValue);
    const sum = contract.milestones.reduce((acc, m) => acc.add(m.amount), new Prisma.Decimal(0));
    if (total.lte(0)) throw new BadRequestException('The contract has no value');
    if (!round2(sum).equals(round2(total))) {
      throw new BadRequestException(
        `The payments add up to ${round2(sum).toFixed(2)}, not the contract value ${round2(total).toFixed(2)}`,
      );
    }

    const verdict = await this.approvals.gate(user, {
      documentType: 'CONTRACT',
      documentId: contract.id,
      documentCode: contract.code,
      amount: Number(total),
    });
    if (verdict.cleared && !user.permissions.includes(PERMISSIONS.PROPOSAL_APPROVE)) {
      throw new ForbiddenException(
        'Approving this document requires the approve permission; no approval rule routes it to someone else',
      );
    }
    const raised = await this.prisma.contract.update({
      where: { id: contract.id },
      data: { status: 'PENDING_APPROVAL', submittedAt: new Date() },
    });
    await this.audit.record({
      organizationId: user.organizationId,
      actorId: user.userId,
      entityType: 'Contract',
      entityId: contract.id,
      action: 'SUBMIT',
      before: { status: contract.status },
      after: { status: raised.status },
    });
    if (!verdict.cleared) return { ...raised, pendingApproval: verdict.request };
    return this.applyApproval(user, contract.id);
  }

  /** The last signature landed: the contract is approved, under the approver's identity. */
  private async applyApproval(user: AuthUser, id: string) {
    const contract = await this.prisma.contract.findFirst({ where: { id, organizationId: user.organizationId } });
    if (!contract) throw new NotFoundException('Contract not found');
    if (contract.status !== 'PENDING_APPROVAL') {
      throw new ConflictException('The contract is not awaiting approval');
    }
    const approved = await this.prisma.contract.update({
      where: { id },
      data: { status: 'APPROVED', approvedAt: new Date(), approvedById: user.userId },
    });
    await this.audit.record({
      organizationId: user.organizationId,
      actorId: user.userId,
      entityType: 'Contract',
      entityId: id,
      action: 'APPROVE',
      before: { status: contract.status },
      after: { status: 'APPROVED' },
    });
    // Whoever works contracts is told the next step: the customer's signature.
    await this.notifications.notifyBestEffort({
      organizationId: user.organizationId,
      permission: PERMISSIONS.CONTRACT_WRITE,
      excludeUserId: user.userId,
      type: 'CONTRACT_APPROVED',
      titleAr: `اعتُمد العقد ${contract.code}`,
      titleEn: `Contract ${contract.code} is approved`,
      bodyAr: 'التالي: توقيع العميل، ثم رفع النسخة الموقّعة وتفعيل العقد.',
      bodyEn: "Next: the customer's signature, then file the signed copy and activate the contract.",
      linkPath: `/contracts/${id}`,
    });
    return approved;
  }

  /** The general manager sent it back: a draft again, the note in the audit row. */
  private async applyRejection(user: AuthUser, id: string, note?: string | null) {
    const contract = await this.prisma.contract.findFirst({ where: { id, organizationId: user.organizationId } });
    if (!contract) throw new NotFoundException('Contract not found');
    if (contract.status !== 'PENDING_APPROVAL') return contract;
    const back = await this.prisma.contract.update({ where: { id }, data: { status: 'DRAFT', submittedAt: null } });
    await this.audit.record({
      organizationId: user.organizationId,
      actorId: user.userId,
      entityType: 'Contract',
      entityId: id,
      action: 'RETURN',
      before: { status: contract.status },
      after: { status: 'DRAFT', note: note ?? null },
    });
    return back;
  }

  /**
   * Activation. A contract from a quote must be APPROVED and carry the
   * customer's signed copy, filed on the contract after the approval (owner's
   * answer 4 of 2026-10-12). Then the work moves on (owner work cycle step 9):
   * finance registers the customer's account and cost centre, the projects
   * general manager opens the project and assigns its engineer.
   * A hand-written contract with no quote keeps the old DRAFT → ACTIVE move.
   */
  async activate(user: AuthUser, id: string) {
    const contract = await this.get(user, id);
    const fromQuote = !!contract.proposalRevisionId;
    if (fromQuote) {
      if (contract.status !== 'APPROVED') {
        throw new BadRequestException('Only an approved contract can be activated');
      }
      const signed = await this.prisma.attachment.findFirst({
        where: {
          organizationId: user.organizationId,
          entityType: 'CONTRACT',
          entityId: contract.id,
          ...(contract.approvedAt ? { createdAt: { gte: contract.approvedAt } } : {}),
        },
        select: { id: true },
      });
      if (!signed) {
        throw new BadRequestException("File the customer's signed copy on the contract before activating it");
      }
    } else if (contract.status !== 'DRAFT') {
      throw new BadRequestException('Only draft contracts can be activated');
    }
    const updated = await this.prisma.contract.update({
      where: { id: contract.id },
      data: { status: 'ACTIVE', activatedAt: new Date() },
    });
    await this.audit.record({
      organizationId: user.organizationId,
      actorId: user.userId,
      entityType: 'Contract',
      entityId: id,
      action: 'ACTIVATE',
      before: contract,
      after: updated,
    });
    if (fromQuote) {
      await this.notifications.notifyBestEffort({
        organizationId: user.organizationId,
        permission: PERMISSIONS.INVOICE_WRITE,
        excludeUserId: user.userId,
        type: 'CONTRACT_ACTIVATED_FINANCE',
        titleAr: `عقد مفعّل ${contract.code}: سجّل حساب العميل ومركز التكلفة`,
        titleEn: `Contract ${contract.code} is active: register the customer account and cost centre`,
        linkPath: `/contracts/${id}`,
      });
      await this.notifications.notifyBestEffort({
        organizationId: user.organizationId,
        permission: PERMISSIONS.PROJECT_WRITE,
        excludeUserId: user.userId,
        type: 'CONTRACT_ACTIVATED_PROJECTS',
        titleAr: `عقد مفعّل ${contract.code}: افتح المشروع وعيّن مهندسه`,
        titleEn: `Contract ${contract.code} is active: open the project and assign its engineer`,
        linkPath: `/contracts/${id}`,
      });
    }
    return updated;
  }

  /** Package 2 · P2-4: contracts waiting on the caller's signature (the general manager's card). */
  async awaitingMyApproval(user: AuthUser) {
    const inbox = await this.approvals.inbox(user);
    const mine = inbox.filter((r) => r.documentType === 'CONTRACT' && r.canDecide);
    if (mine.length === 0) return [];
    const rows = await this.prisma.contract.findMany({
      where: { id: { in: mine.map((r) => r.documentId) }, organizationId: user.organizationId },
      select: {
        id: true,
        code: true,
        totalValue: true,
        customer: { select: { nameAr: true, nameEn: true } },
        proposal: { select: { id: true, code: true } },
        _count: { select: { milestones: true } },
      },
    });
    const byId = new Map(rows.map((c) => [c.id, c]));
    return mine.flatMap((r) => {
      const c = byId.get(r.documentId);
      return c
        ? [{ requestId: r.id, ...c, totalValue: new Prisma.Decimal(c.totalValue).toFixed(2), waitingSince: r.currentStepAt, raisedBy: r.raisedBy }]
        : [];
    });
  }

  /** At least one payment, each with a description and a positive amount, numbered 1..n. */
  private assertMilestoneShape(milestones: Array<{ sequence: number; amount: unknown; descriptionAr: string }>) {
    if (milestones.length === 0) throw new BadRequestException('A contract needs at least one payment');
    const seqs = milestones.map((m) => m.sequence).sort((a, b) => a - b);
    if (seqs.some((q, i) => q !== i + 1)) throw new BadRequestException('Payments must be numbered 1, 2, 3 … without gaps');
    if (milestones.some((m) => !new Prisma.Decimal(m.amount as Prisma.Decimal.Value).gt(0))) {
      throw new BadRequestException('Every payment needs an amount above zero');
    }
  }

  /**
   * Verify a milestone. This is the seam where milestone-triggered ZATCA
   * invoicing (FIN-04) hooks in during W3 — today it records verification only.
   */
  async verifyMilestone(user: AuthUser, contractId: string, milestoneId: string) {
    const milestone = await this.prisma.contractMilestone.findFirst({
      where: {
        id: milestoneId,
        contractId,
        contract: { organizationId: user.organizationId },
      },
    });
    if (!milestone) throw new NotFoundException('Milestone not found');
    if (milestone.status !== 'PENDING') {
      throw new BadRequestException('Milestone is not pending');
    }

    const updated = await this.prisma.contractMilestone.update({
      where: { id: milestoneId },
      data: {
        status: 'VERIFIED',
        verifiedAt: new Date(),
        verifiedById: user.userId,
      },
    });
    await this.audit.record({
      organizationId: user.organizationId,
      actorId: user.userId,
      entityType: 'ContractMilestone',
      entityId: milestoneId,
      action: 'VERIFY',
      before: milestone,
      after: updated,
    });
    // The people who can invoice are the ones who need to hear a milestone
    // just became billable.
    const contract = await this.prisma.contract.findUnique({
      where: { id: contractId },
      select: { code: true },
    });
    await this.notifications.notifyBestEffort({
      organizationId: user.organizationId,
      permission: 'finance.invoice.write',
      excludeUserId: user.userId,
      type: 'MILESTONE_VERIFIED',
      titleAr: `مرحلة معتمدة في العقد ${contract?.code ?? ''} — جاهزة للفوترة`,
      titleEn: `Milestone verified on ${contract?.code ?? ''} — ready to invoice`,
      bodyAr: milestone.descriptionAr,
      bodyEn: milestone.descriptionEn,
      linkPath: `/contracts/${contractId}`,
    });
    return updated;
  }
}
