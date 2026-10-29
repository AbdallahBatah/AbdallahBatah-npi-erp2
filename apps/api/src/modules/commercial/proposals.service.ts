import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { Prisma, type ProposalRevision } from '@npi/db';
import {
  PERMISSIONS,
  WF_ACTIONS,
  WF_FLOWS,
  costAge,
  isOpenStage,
  isStale,
  isValidityExpired,
  isValidityFuture,
  normalizeValidUntil,
} from '@npi/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { NumberingService } from '../../common/numbering.service';
import { AuditService } from '../../common/audit.service';
import { ApprovalService, type ApprovalRequestView } from '../../common/approval.service';
import { OrgSettingsService, ORG_SETTING_DEFAULTS, ORG_SETTING_KEYS } from '../../common/org-settings.service';
import { WorkflowEngine } from '../../common/workflow/workflow.engine';
import { NotificationService } from '../../common/notification.service';
import { budgetTotals, priceRevision, sellingPrice } from '../../common/proposal-pricing';
import { holdsEffectively, holdsRole } from '../../common/permission-predicates';
import type { AuthUser } from '../../common/auth-user';
import { BomLineDto, CreateProposalDto, CreateRevisionDto, RejectProposalDto } from './dto';
import { OpportunitiesService } from '../crm/opportunities.service';
import { ContractsService } from './contracts.service';
import { ItemCostService, type LastCost } from './item-cost.service';
import { assertCanSetCosts, canViewCosts, hideRevisionPricing } from './revision-pricing';

type Tx = Prisma.TransactionClient;
type Status =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'SENT'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'SUPERSEDED';

/** The workflow's document type for a proposal (WF_FLOW_DOCUMENT_TYPE.PROPOSAL). */
const DOC = 'Proposal';
const DAY_MS = 86_400_000;
const SYSTEM_EXPIRY_NOTE = 'Expired automatically — validity passed';
/** States from which a change is a new numbered revision (the previous one is locked as superseded). */
const REVISABLE: ReadonlySet<string> = new Set(['APPROVED', 'SENT', 'REJECTED', 'EXPIRED']);
/** Actions that belong to the approval matrix and the clock — never offered to the page as buttons. */
const NOT_A_BUTTON: ReadonlySet<string> = new Set([WF_ACTIONS.APPROVE, WF_ACTIONS.RETURN, WF_ACTIONS.EXPIRE]);

/** A proposal with just what the lifecycle decisions need: its current revision, contracts and opportunity stage. */
const LIFECYCLE_INCLUDE = {
  opportunity: { select: { id: true, stage: true } },
  revisions: {
    orderBy: { revisionNo: 'desc' },
    take: 1,
    include: { bomLines: { select: { id: true } } },
  },
  contracts: { select: { id: true }, take: 1 },
} as const;

type RevisionWithLines = Prisma.ProposalRevisionGetPayload<{ include: { bomLines: true } }>;

/** What submit() answers: the proposal's new standing, and the open signature chain if one was opened. */
interface SubmitOutcome {
  id: string;
  code: string;
  status: string;
  pendingApproval?: ApprovalRequestView;
}

type LoadedProposal = Prisma.ProposalGetPayload<{ include: typeof LIFECYCLE_INCLUDE }>;
type CurrentRevision = LoadedProposal['revisions'][number];

/** One BOM line, costed and priced, ready to be written. */
interface PreparedLine {
  itemId: string | null;
  workItemId: string | null;
  description: string | null;
  uom: string | null;
  qty: Prisma.Decimal;
  isAdder: boolean;
  unitCost: Prisma.Decimal;
  originalUnitCost: Prisma.Decimal;
  costSource: 'GRN' | 'PO' | 'CATALOGUE' | 'MANUAL';
  costDate: Date | null;
  costAgeDays: number | null;
  costOverrideReason: string | null;
  costOverriddenAt: Date | null;
  costOverriddenById: string | null;
  unitPrice: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
}

interface PreparedRevision {
  validUntil: Date;
  pricingSchemeId: string | null;
  lines: PreparedLine[];
  subtotal: Prisma.Decimal;
  marginAmount: Prisma.Decimal;
  totalAmount: Prisma.Decimal;
  overridden: number;
  // Package 3 · P3-4 (ADR-03 §4-4)
  pricingMode: 'PER_LINE' | 'LUMP_SUM';
  sellingTotal: Prisma.Decimal | null;
  contingencyPct: Prisma.Decimal;
  contingencyAmount: Prisma.Decimal;
  riskNotes: string | null;
  templateId: string | null;
}

/** The revision columns a write sets from a PreparedRevision (both add and edit). */
const revisionFigures = (p: PreparedRevision) => ({
  pricingSchemeId: p.pricingSchemeId,
  subtotal: p.subtotal,
  marginAmount: p.marginAmount,
  totalAmount: p.totalAmount,
  validUntil: p.validUntil,
  pricingMode: p.pricingMode,
  sellingTotal: p.sellingTotal,
  contingencyPct: p.contingencyPct,
  contingencyAmount: p.contingencyAmount,
  riskNotes: p.riskNotes,
  templateId: p.templateId,
});

const round2 = (v: Prisma.Decimal) => v.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

@Injectable()
export class ProposalsService implements OnModuleInit {
  private readonly logger = new Logger(ProposalsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly opportunities: OpportunitiesService,
    private readonly engine: WorkflowEngine,
    private readonly approvals: ApprovalService,
    private readonly itemCosts: ItemCostService,
    private readonly settings: OrgSettingsService,
    private readonly notifications: NotificationService,
    private readonly contracts: ContractsService,
  ) {}

  /**
   * Hand the matrix the two state changes it may complete on our behalf. The kernel
   * never imports this module (the dependency runs one way), and the application
   * refuses to start if a document type the matrix advertises has no applier.
   */
  onModuleInit(): void {
    this.approvals.register(
      'PROPOSAL',
      (user, id) => this.applyApproval(user, id),
      (user, id, note) => this.applyRejection(user, id, note),
    );
  }

  // ── reading ───────────────────────────────────────────────────────────────

  async list(user: AuthUser) {
    const rows = await this.prisma.proposal.findMany({
      where: { organizationId: user.organizationId },
      include: {
        opportunity: { select: { id: true, code: true, name: true } },
        revisions: { orderBy: { revisionNo: 'desc' }, take: 1 },
      },
      orderBy: { createdAt: 'desc' },
    });
    // One query for the whole page: the rows that are waiting on a signature.
    const pending = await this.approvals.pendingFor(
      user.organizationId,
      'PROPOSAL',
      rows.map((p) => p.id),
    );
    const costs = canViewCosts(user);
    return rows.map((p) => ({
      ...p,
      revisions: costs ? p.revisions : p.revisions.map(hideRevisionPricing),
      pendingApproval: pending.get(p.id) ?? null,
    }));
  }

  async get(user: AuthUser, id: string) {
    const proposal = await this.prisma.proposal.findFirst({
      where: { id, organizationId: user.organizationId },
      include: {
        opportunity: { include: { customer: true } },
        contracts: { select: { id: true, code: true, status: true } },
        revisions: {
          orderBy: { revisionNo: 'asc' },
          include: {
            bomLines: {
              include: {
                item: true,
                workItem: { select: { id: true, code: true, nameAr: true, nameEn: true, kind: true, uom: true } },
              },
            },
            designVersion: true,
            pricingScheme: true,
            createdBy: { select: { id: true, nameAr: true, nameEn: true } },
          },
        },
      },
    });
    if (!proposal) throw new NotFoundException('Proposal not found');

    const current = proposal.revisions[proposal.revisions.length - 1];
    const total = current ? Number(current.totalAmount) : 0;
    const [approval, available, history, validityDays, costAgeWarnDays] = await Promise.all([
      this.approvals.forDocument(user, 'PROPOSAL', proposal.id),
      this.engine.available(user, DOC, proposal.id, { total }),
      this.engine.history(user.organizationId, DOC, proposal.id),
      this.settings.get(
        user.organizationId,
        ORG_SETTING_KEYS.PROPOSAL_VALIDITY_DAYS,
        ORG_SETTING_DEFAULTS[ORG_SETTING_KEYS.PROPOSAL_VALIDITY_DAYS],
      ),
      this.settings.get(
        user.organizationId,
        ORG_SETTING_KEYS.PROPOSAL_COST_AGE_WARN_DAYS,
        ORG_SETTING_DEFAULTS[ORG_SETTING_KEYS.PROPOSAL_COST_AGE_WARN_DAYS],
      ),
    ]);

    // For a draft: who the matrix will ask to sign this total, so the confirmation can name them.
    let submitTo: { id: string; nameAr: string; nameEn: string } | null = null;
    if (current?.status === 'DRAFT') {
      const me = await this.prisma.user.findUnique({ where: { id: user.userId }, select: { departmentId: true } });
      const rule = await this.approvals.resolveRule(user.organizationId, 'PROPOSAL', total, me?.departmentId ?? null);
      if (rule) {
        submitTo = await this.prisma.role.findUnique({
          where: { id: rule.steps[0].roleId },
          select: { id: true, nameAr: true, nameEn: true },
        });
      }
    }

    // Without finance.costs.view the cost build-up is hidden; the selling price stays.
    const revisions = canViewCosts(user) ? proposal.revisions : proposal.revisions.map(hideRevisionPricing);
    return {
      ...proposal,
      revisions,
      submitTo,
      currentRevisionNo: current?.revisionNo ?? null,
      approval,
      pendingApproval: approval?.status === 'PENDING' ? approval : null,
      // What the page may offer as buttons. APPROVE / RETURN belong to the matrix and
      // EXPIRE to the clock: a person never triggers them from here.
      actions: available.filter((a) => !NOT_A_BUTTON.has(a.actionCode)),
      history,
      settings: { validityDays, costAgeWarnDays },
    };
  }

  /**
   * Package 3 · P3-6 (ADR-03 §4-6, owner work cycle step 6) — the general
   * manager's card: every estimated budget waiting on a signature the caller
   * can give now, with the figures he decides on (price, cost, contingency,
   * profit, margin) and whether the margin is under the configured floor. The
   * cost figures are omitted (null) for a caller without finance.costs.view.
   */
  async awaitingMyApproval(user: AuthUser) {
    const minMarginPct = await this.settings.get(
      user.organizationId,
      ORG_SETTING_KEYS.PROPOSAL_MIN_MARGIN_PCT,
      ORG_SETTING_DEFAULTS[ORG_SETTING_KEYS.PROPOSAL_MIN_MARGIN_PCT],
    );
    const inbox = await this.approvals.inbox(user);
    const mine = inbox.filter((r) => r.documentType === 'PROPOSAL' && r.canDecide);
    if (mine.length === 0) return { minMarginPct, rows: [] };

    const proposals = await this.prisma.proposal.findMany({
      where: { id: { in: mine.map((r) => r.documentId) }, organizationId: user.organizationId },
      include: {
        opportunity: { select: { id: true, name: true, customer: { select: { nameAr: true, nameEn: true } } } },
        revisions: {
          orderBy: { revisionNo: 'desc' },
          take: 1,
          include: { designVersion: { select: { capacityKwp: true } } },
        },
      },
    });
    const byId = new Map(proposals.map((p) => [p.id, p]));
    const costs = canViewCosts(user);

    const rows = mine.flatMap((req) => {
      const p = byId.get(req.documentId);
      const rev = p?.revisions[0];
      if (!p || !rev) return [];
      const total = new Prisma.Decimal(rev.totalAmount);
      const margin = new Prisma.Decimal(rev.marginAmount);
      const pct = total.gt(0) ? margin.div(total).mul(100).toDecimalPlaces(1) : null;
      return [
        {
          requestId: req.id,
          proposalId: p.id,
          code: p.code,
          revisionNo: rev.revisionNo,
          opportunity: { id: p.opportunity.id, name: p.opportunity.name },
          customer: p.opportunity.customer,
          capacityKwp: rev.designVersion?.capacityKwp ?? null,
          pricingMode: rev.pricingMode,
          totalAmount: total.toFixed(2),
          estimatedCost: costs ? new Prisma.Decimal(rev.subtotal).toFixed(2) : null,
          contingencyAmount: costs ? new Prisma.Decimal(rev.contingencyAmount).toFixed(2) : null,
          marginAmount: costs ? margin.toFixed(2) : null,
          marginPct: costs && pct ? Number(pct) : null,
          belowFloor: costs && pct !== null ? pct.lt(minMarginPct) : null,
          raisedBy: req.raisedBy,
          waitingSince: req.currentStepAt,
        },
      ];
    });
    return { minMarginPct, rows };
  }

  /**
   * The cost of items as a new line would get it, for the form to show before the
   * author commits (cost, where it came from, how old it is, whether that is too old).
   * For those who may see costs; items of other organizations are simply absent.
   */
  async costLookup(user: AuthUser, query: { itemIds: string[]; currency?: string }) {
    assertCanSetCosts(user);
    const costs = await this.itemCosts.lastPurchaseCosts(user.organizationId, query.itemIds, query.currency || 'SAR');
    const warnDays = await this.settings.get(
      user.organizationId,
      ORG_SETTING_KEYS.PROPOSAL_COST_AGE_WARN_DAYS,
      ORG_SETTING_DEFAULTS[ORG_SETTING_KEYS.PROPOSAL_COST_AGE_WARN_DAYS],
    );
    const now = new Date();
    return [...costs.entries()].map(([itemId, c]) => {
      const ageDays = costAge(c.costDate, now);
      return {
        itemId,
        unitCost: c.unitCost.toFixed(2),
        costSource: c.costSource,
        costDate: c.costDate,
        costAgeDays: ageDays,
        stale: isStale(ageDays, warnDays),
        warnDays,
      };
    });
  }

  // ── creating ──────────────────────────────────────────────────────────────

  async create(user: AuthUser, dto: CreateProposalDto) {
    const opp = await this.prisma.opportunity.findFirst({
      where: { id: dto.opportunityId, organizationId: user.organizationId },
    });
    if (!opp) throw new NotFoundException('Opportunity not found');

    return this.prisma.$transaction(async (tx) => {
      // CRM Step 3: a proposal carries the opportunity to «عرض سعر» in this same
      // transaction, and a closed (WON / LOST) opportunity takes no proposal (409).
      await this.opportunities.advanceOnProposal(tx, user, dto.opportunityId);
      const code = await this.numbering.next(user.organizationId, 'PROPOSAL', tx);
      const created = await tx.proposal.create({
        data: {
          organizationId: user.organizationId,
          code,
          opportunityId: dto.opportunityId,
          currency: dto.currency ?? 'SAR',
          status: 'DRAFT',
        },
      });
      // CRM Step 4: opened with the document, never after it — a proposal without
      // its flow instance has a state nobody can know.
      await this.engine.open(tx, {
        organizationId: user.organizationId,
        flowCode: WF_FLOWS.PROPOSAL,
        documentId: created.id,
        documentCode: created.code,
        assigneeRoleId: user.roleId,
      });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'Proposal',
          entityId: created.id,
          action: 'CREATE',
          after: created,
        },
        tx,
      );
      return created;
    });
  }

  /**
   * Add a numbered revision: the server fetches every line's cost from the last
   * purchase, the author prices it (or names a margin), and the totals are stored.
   *
   * The first revision of a proposal is simply born a draft. Any later one is only
   * possible when the current revision is closed (approved, sent, refused by the
   * customer or expired) — it then enters through the engine's REVISE move, which
   * locks the previous revision as superseded; a draft is edited in place and a
   * revision awaiting approval is not touched.
   */
  async addRevision(user: AuthUser, proposalId: string, dto: CreateRevisionDto) {
    // Margin, pricing scheme and costs are cost-side inputs: setting them needs the
    // same permission as seeing them.
    this.assertCostInputsAllowed(user, dto);
    const proposal = await this.loadProposal(user.organizationId, proposalId);
    const current = proposal.revisions[0] ?? null;
    this.assertCanAddRevision(proposal, current);
    const prepared = await this.prepareRevision(user, proposal.currency, dto);

    const now = new Date();
    const out: { revision?: RevisionWithLines } = {};
    const write = async (tx: Tx) => {
      const last = await tx.proposalRevision.findFirst({ where: { proposalId }, orderBy: { revisionNo: 'desc' } });
      const revisionNo = (last?.revisionNo ?? 0) + 1;

      let designVersionId: string | undefined;
      if (dto.designVersion) {
        const dv = await tx.designVersion.create({
          data: {
            organizationId: user.organizationId,
            opportunityId: proposal.opportunityId,
            sourceTool: dto.designVersion.sourceTool ?? 'manual',
            externalRef: dto.designVersion.externalRef,
            versionNo: revisionNo,
            capacityKwp: dto.designVersion.capacityKwp ?? 0,
            expectedAnnualKwh: dto.designVersion.expectedAnnualKwh ?? 0,
          },
        });
        designVersionId = dv.id;
      }

      const revision = await tx.proposalRevision.create({
        data: {
          proposalId,
          revisionNo,
          designVersionId,
          ...revisionFigures(prepared),
          status: 'DRAFT',
          createdById: user.userId,
          bomLines: { create: prepared.lines.map((l) => this.lineData(l)) },
        },
        include: { bomLines: true },
      });

      // The previous revision is locked and points at the one that replaced it.
      if (current && REVISABLE.has(current.status)) {
        await tx.proposalRevision.update({
          where: { id: current.id },
          data: { status: 'SUPERSEDED', closedAt: now, supersededById: revision.id },
        });
      }
      await tx.proposal.update({ where: { id: proposalId }, data: { status: 'DRAFT' } });

      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'ProposalRevision',
          entityId: revision.id,
          action: 'CREATE',
          after: {
            revisionNo,
            pricingMode: prepared.pricingMode,
            subtotal: prepared.subtotal.toFixed(2),
            contingencyAmount: prepared.contingencyAmount.toFixed(2),
            marginAmount: prepared.marginAmount.toFixed(2),
            totalAmount: prepared.totalAmount.toFixed(2),
            validUntil: prepared.validUntil,
            lines: prepared.lines.length,
            manualCostLines: prepared.overridden,
          },
        },
        tx,
      );
      return revision;
    };

    try {
      if (current && REVISABLE.has(current.status)) {
        await this.ensureInstance(user.organizationId, proposal);
        await this.engine.transition(user, {
          documentType: DOC,
          documentId: proposalId,
          actionCode: WF_ACTIONS.REVISE,
          assigneeRoleId: user.roleId,
          apply: async (tx) => {
            out.revision = await write(tx);
          },
        });
      } else {
        out.revision = await this.prisma.$transaction(write);
      }
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('Another revision was added at the same moment — reload and try again');
      }
      throw err;
    }

    // The caller supplied the selling prices, but the revision's totals can embed a
    // margin they may not see — return the redacted shape.
    const created = out.revision!;
    return canViewCosts(user) ? created : hideRevisionPricing(created);
  }

  /** Edit the current DRAFT revision in place: the same body as adding one, lines replaced as a whole. */
  async updateRevision(user: AuthUser, proposalId: string, revisionId: string, dto: CreateRevisionDto) {
    this.assertCostInputsAllowed(user, dto);
    const proposal = await this.loadProposal(user.organizationId, proposalId);
    const current = proposal.revisions[0] ?? null;
    if (!current || current.id !== revisionId || current.status !== 'DRAFT') {
      throw new ConflictException('Only a draft revision can be edited — add a new revision');
    }
    const prepared = await this.prepareRevision(user, proposal.currency, dto);

    const updated = await this.prisma.$transaction(async (tx) => {
      let designVersionId = current.designVersionId ?? undefined;
      if (dto.designVersion) {
        const fields = {
          sourceTool: dto.designVersion.sourceTool ?? 'manual',
          externalRef: dto.designVersion.externalRef,
          capacityKwp: dto.designVersion.capacityKwp ?? 0,
          expectedAnnualKwh: dto.designVersion.expectedAnnualKwh ?? 0,
        };
        if (designVersionId) {
          await tx.designVersion.update({ where: { id: designVersionId }, data: fields });
        } else {
          const dv = await tx.designVersion.create({
            data: {
              organizationId: user.organizationId,
              opportunityId: proposal.opportunityId,
              versionNo: current.revisionNo,
              ...fields,
            },
          });
          designVersionId = dv.id;
        }
      }

      await tx.bomLine.deleteMany({ where: { proposalRevisionId: revisionId } });
      const revision = await tx.proposalRevision.update({
        where: { id: revisionId },
        data: {
          designVersionId,
          ...revisionFigures(prepared),
          bomLines: { create: prepared.lines.map((l) => this.lineData(l)) },
        },
        include: { bomLines: true },
      });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'ProposalRevision',
          entityId: revisionId,
          action: 'UPDATE',
          before: { totalAmount: String(current.totalAmount), validUntil: current.validUntil, lines: current.bomLines.length },
          after: {
            pricingMode: prepared.pricingMode,
            totalAmount: prepared.totalAmount.toFixed(2),
            subtotal: prepared.subtotal.toFixed(2),
            contingencyAmount: prepared.contingencyAmount.toFixed(2),
            validUntil: prepared.validUntil,
            lines: prepared.lines.length,
            manualCostLines: prepared.overridden,
          },
        },
        tx,
      );
      return revision;
    });
    return canViewCosts(user) ? updated : hideRevisionPricing(updated);
  }

  // ── approval ──────────────────────────────────────────────────────────────

  /**
   * Raise the current draft for approval. The order is the purchase order's, and
   * for the same reason: ask the engine if SUBMIT is legal at all, then ask the
   * matrix whether this total needs signatures, then move the document — reversed,
   * people could be asked to sign something that can never be applied.
   *
   * Two things the purchase order does not need: the proposal is refused up front
   * if the raiser is the only person who could sign it (the engine would otherwise
   * park it for ever), and the whole of it runs under a per-proposal lock so two
   * simultaneous submits cannot open two signature chains.
   */
  submit(user: AuthUser, proposalId: string): Promise<SubmitOutcome> {
    return this.withProposalLock(proposalId, async () => {
      const proposal = await this.loadProposal(user.organizationId, proposalId);
      const current = proposal.revisions[0] ?? null;
      if (!current || current.status !== 'DRAFT') {
        throw new ConflictException('Only a draft revision can be submitted');
      }
      if (current.bomLines.length === 0) {
        throw new BadRequestException('Proposal needs at least one line');
      }
      // Package 3 · P3-4: a budget goes to the general manager with a price on it.
      if (new Prisma.Decimal(current.totalAmount).lte(0)) {
        throw new BadRequestException('The budget needs a selling price before it is raised for approval');
      }
      if (!current.validUntil || !isValidityFuture(current.validUntil)) {
        throw new BadRequestException('Validity date must be in the future');
      }
      await this.ensureInstance(user.organizationId, proposal);

      const total = Number(current.totalAmount);
      const context = { total };
      await this.engine.assertCan(user, {
        documentType: DOC,
        documentId: proposal.id,
        actionCode: WF_ACTIONS.SUBMIT,
        context,
      });

      const submitter = await this.prisma.user.findUnique({
        where: { id: user.userId },
        select: { departmentId: true },
      });
      const departmentId = submitter?.departmentId ?? null;
      const rule = await this.approvals.resolveRule(user.organizationId, 'PROPOSAL', total, departmentId);
      if (rule && !(await this.hasOtherApprover(user, rule.steps[0].roleId))) {
        throw new ConflictException('No other approver is available for this proposal');
      }

      const verdict = await this.approvals.gate(user, {
        documentType: 'PROPOSAL',
        documentId: proposal.id,
        documentCode: `${proposal.code} R${current.revisionNo}`,
        amount: total,
        departmentId,
      });
      if (verdict.cleared && !user.permissions.includes(PERMISSIONS.PROPOSAL_APPROVE)) {
        // Separated rights: a role that may write/submit but not approve must not
        // self-approve when no matrix band applies. Fail before any state change.
        throw new ForbiddenException(
          'Approving this document requires the approve permission; no approval rule routes it to someone else',
        );
      }

      const nextRole = verdict.cleared
        ? user.roleId
        : (verdict.request.steps.find((st) => st.sequence === verdict.request.currentStep)?.role.id ?? null);

      await this.engine.transition(user, {
        documentType: DOC,
        documentId: proposal.id,
        actionCode: WF_ACTIONS.SUBMIT,
        context,
        assigneeRoleId: nextRole,
        apply: async (tx) => {
          await this.mirror(tx, proposal.id, current.id, 'PENDING_APPROVAL', { submittedAt: new Date() });
        },
      });

      if (!verdict.cleared) {
        return { id: proposal.id, code: proposal.code, status: 'PENDING_APPROVAL', pendingApproval: verdict.request };
      }
      const applied = await this.applyApproval(user, proposalId);
      if (!applied) throw new ConflictException('Proposal could not be approved');
      return applied;
    });
  }

  /**
   * The last signature landed (or no rule applied and the submitter may approve):
   * the revision is approved under the APPROVER's identity. Re-reads and re-checks
   * rather than trusting the caller — between submission and the last signature,
   * anything could have happened to the proposal. If the validity has run out by
   * now, the approval is followed at once by an automatic expiry: two honest rows.
   */
  private async applyApproval(user: AuthUser, proposalId: string): Promise<SubmitOutcome | null> {
    const proposal = await this.loadProposal(user.organizationId, proposalId);
    const current = proposal.revisions[0] ?? null;
    if (!current || current.status !== 'PENDING_APPROVAL') {
      this.logger.warn(`Approval arrived for proposal ${proposalId} that is not awaiting it — ignored`);
      return null;
    }
    await this.ensureInstance(user.organizationId, proposal);
    const assignee = await this.authorRole(current.createdById);

    await this.engine.transition(user, {
      documentType: DOC,
      documentId: proposal.id,
      actionCode: WF_ACTIONS.APPROVE,
      context: { total: Number(current.totalAmount) },
      assigneeRoleId: assignee,
      eventPayload: this.eventPayload(proposal, current),
      apply: async (tx) => {
        await this.mirror(tx, proposal.id, current.id, 'APPROVED', { approvedAt: new Date() });
      },
    });

    if (current.validUntil && isValidityExpired(current.validUntil)) {
      await this.expireRevision(user.organizationId, proposal, current, new Date());
      return { id: proposal.id, code: proposal.code, status: 'EXPIRED' };
    }
    return { id: proposal.id, code: proposal.code, status: 'APPROVED' };
  }

  /**
   * The approver refused. The proposal returns to DRAFT with their note on the
   * history, so its author can fix it and raise it again — «مرفوض» is reserved for
   * the customer's refusal. Nothing to do if it is not parked.
   */
  private async applyRejection(user: AuthUser, proposalId: string, note: string) {
    const proposal = await this.loadProposal(user.organizationId, proposalId);
    const current = proposal.revisions[0] ?? null;
    if (!current || current.status !== 'PENDING_APPROVAL') return null;
    await this.ensureInstance(user.organizationId, proposal);
    const assignee = await this.authorRole(current.createdById);

    return this.engine.transition(user, {
      documentType: DOC,
      documentId: proposal.id,
      actionCode: WF_ACTIONS.RETURN,
      comment: note,
      context: { total: Number(current.totalAmount) },
      assigneeRoleId: assignee,
      apply: async (tx) => {
        await this.mirror(tx, proposal.id, current.id, 'DRAFT', { submittedAt: null });
      },
    });
  }

  // ── sending, and what the customer does ───────────────────────────────────

  /** Approved → sent to the customer. A revision whose validity ran out cannot be sent: it expires instead (409). */
  async send(user: AuthUser, proposalId: string) {
    const proposal = await this.loadProposal(user.organizationId, proposalId);
    const current = proposal.revisions[0] ?? null;
    if (!current || current.status !== 'APPROVED') {
      throw new ConflictException('Only an approved revision can be sent');
    }
    await this.ensureInstance(user.organizationId, proposal);
    await this.engine.assertCan(user, {
      documentType: DOC,
      documentId: proposal.id,
      actionCode: WF_ACTIONS.SEND,
      context: { total: Number(current.totalAmount) },
    });
    if (current.validUntil && isValidityExpired(current.validUntil)) {
      await this.expireRevision(user.organizationId, proposal, current, new Date());
      throw new ConflictException('Proposal revision has expired');
    }

    await this.engine.transition(user, {
      documentType: DOC,
      documentId: proposal.id,
      actionCode: WF_ACTIONS.SEND,
      context: { total: Number(current.totalAmount) },
      assigneeRoleId: user.roleId,
      eventPayload: this.eventPayload(proposal, current),
      apply: async (tx) => {
        await this.mirror(tx, proposal.id, current.id, 'SENT', { sentAt: new Date() });
      },
    });
    return { id: proposal.id, code: proposal.code, status: 'SENT' };
  }

  /** The customer accepted the current, sent revision: it becomes the winning one. */
  async acceptRevision(user: AuthUser, proposalId: string, revisionId: string) {
    const proposal = await this.loadProposal(user.organizationId, proposalId);
    const current = proposal.revisions[0] ?? null;
    if (!current || current.id !== revisionId || current.status !== 'SENT') {
      throw new ConflictException('Only the current sent revision can be accepted');
    }
    await this.ensureInstance(user.organizationId, proposal);
    if (current.validUntil && isValidityExpired(current.validUntil)) {
      // Not yet swept, but already out of date: it cannot be accepted.
      await this.expireRevision(user.organizationId, proposal, current, new Date());
      throw new ConflictException('Proposal revision has expired');
    }
    // Package 3 · P3-8 (owner work cycle step 8): acceptance is recorded with the
    // customer's approval attached — a file filed on the proposal after this
    // revision went to the customer (an older file approved an older offer).
    const approval = await this.prisma.attachment.findFirst({
      where: {
        organizationId: user.organizationId,
        entityType: 'PROPOSAL',
        entityId: proposal.id,
        ...(current.sentAt ? { createdAt: { gte: current.sentAt } } : {}),
      },
      select: { id: true, fileName: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!approval) {
      throw new BadRequestException("Attach the customer's approval to the proposal before accepting it");
    }

    const out: { winning?: ProposalRevision; contractId?: string; contractCode?: string } = {};
    await this.engine.transition(user, {
      documentType: DOC,
      documentId: proposal.id,
      actionCode: WF_ACTIONS.ACCEPT,
      context: { total: Number(current.totalAmount) },
      eventPayload: this.eventPayload(proposal, current),
      apply: async (tx) => {
        await tx.proposalRevision.updateMany({ where: { proposalId }, data: { isWinning: false } });
        out.winning = await this.mirror(tx, proposal.id, current.id, 'ACCEPTED', {
          isWinning: true,
          closedAt: new Date(),
        });
        // Package 2 · P2-3: the draft contract is born with the acceptance, in
        // the same transaction (ADR-01 §3) — accepted price, 50 / 30 / 20.
        const draft = await this.contracts.draftFromAcceptance(tx, user, current.id);
        out.contractId = draft.id;
        out.contractCode = draft.code;
      },
    });
    const winning = out.winning!;

    // Owner work cycle step 8: «ترحيله إلى المدير العام». Whoever approves
    // proposals hears of it (best effort: the acceptance has committed).
    await this.notifications.notifyBestEffort({
      organizationId: user.organizationId,
      permission: PERMISSIONS.PROPOSAL_APPROVE,
      excludeUserId: user.userId,
      type: 'PROPOSAL_ACCEPTED',
      titleAr: `قَبِل العميل عرض السعر ${proposal.code}`,
      titleEn: `The customer accepted quote ${proposal.code}`,
      bodyAr: `النسخة ${current.revisionNo} مقبولة وموافقة العميل مرفقة (${approval.fileName}). مسودة العقد ${out.contractCode ?? ''} أُنشئت وستصلك للاعتماد بعد ضبط شروطها.`,
      bodyEn: `Revision ${current.revisionNo} is accepted with the customer's approval attached (${approval.fileName}). Draft contract ${out.contractCode ?? ''} was created and comes to you for approval once its terms are set.`,
      linkPath: out.contractId ? `/contracts/${out.contractId}` : `/proposals/${proposal.id}`,
    });
    const shown = canViewCosts(user) ? winning : hideRevisionPricing(winning);
    return { ...shown, contractId: out.contractId ?? null };
  }

  /** The customer refused the current, sent revision. The reason is mandatory; the opportunity is untouched. */
  async rejectByCustomer(user: AuthUser, proposalId: string, dto: RejectProposalDto) {
    const reason = dto.reason?.trim();
    if (!reason) throw new BadRequestException('Rejection reason is required');
    const proposal = await this.loadProposal(user.organizationId, proposalId);
    const current = proposal.revisions[0] ?? null;
    if (!current || current.status !== 'SENT') {
      throw new ConflictException('Only a sent revision can be rejected');
    }
    await this.ensureInstance(user.organizationId, proposal);

    await this.engine.transition(user, {
      documentType: DOC,
      documentId: proposal.id,
      actionCode: WF_ACTIONS.REJECT,
      comment: reason,
      context: { total: Number(current.totalAmount) },
      apply: async (tx) => {
        await this.mirror(tx, proposal.id, current.id, 'REJECTED', { closedAt: new Date() });
      },
    });
    return { id: proposal.id, code: proposal.code, status: 'REJECTED' };
  }

  // ── time ──────────────────────────────────────────────────────────────────

  /**
   * Expire the current revision if it is approved or sent and its valid-until day is
   * over — as the system actor, since no person does this. Returns whether it moved.
   * Used by the nightly sweep; scoped to the organization so an id from another
   * organization is, to it, nothing.
   */
  async expireBySystem(organizationId: string, proposalId: string, now: Date = new Date()): Promise<boolean> {
    const proposal = await this.prisma.proposal.findFirst({
      where: { id: proposalId, organizationId },
      include: LIFECYCLE_INCLUDE,
    });
    if (!proposal) return false;
    const current = proposal.revisions[0] ?? null;
    if (!current || (current.status !== 'APPROVED' && current.status !== 'SENT')) return false;
    // Re-checked at the moment of the move, not trusted from the sweep's query.
    if (current.validUntil && !isValidityExpired(current.validUntil, now)) return false;
    await this.ensureInstance(organizationId, proposal);
    await this.expireRevision(organizationId, proposal, current, now);
    return true;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async loadProposal(organizationId: string, id: string): Promise<LoadedProposal> {
    const proposal = await this.prisma.proposal.findFirst({
      where: { id, organizationId },
      include: LIFECYCLE_INCLUDE,
    });
    if (!proposal) throw new NotFoundException('Proposal not found');
    return proposal;
  }

  private assertCostInputsAllowed(user: AuthUser, dto: CreateRevisionDto) {
    if (
      dto.marginPct !== undefined ||
      dto.pricingSchemeId !== undefined ||
      dto.contingencyPct !== undefined ||
      dto.riskNotes !== undefined ||
      dto.bomLines.some((l) => l.unitCost !== undefined || l.costOverrideReason !== undefined)
    ) {
      assertCanSetCosts(user);
    }
  }

  private assertCanAddRevision(proposal: LoadedProposal, current: CurrentRevision | null) {
    if (proposal.contracts.length > 0 || proposal.status === 'ACCEPTED' || current?.status === 'ACCEPTED') {
      throw new ConflictException('Proposal is accepted — changes go through a change order');
    }
    if (!isOpenStage(proposal.opportunity.stage)) throw new ConflictException('Opportunity is closed');
    if (current?.status === 'PENDING_APPROVAL') throw new ConflictException('Previous revision is awaiting approval');
    if (current?.status === 'DRAFT') {
      throw new ConflictException('Current revision is still a draft — edit it instead');
    }
  }

  /**
   * Everything a revision write needs, computed before anything is written: the
   * validity date, the margin, every line's cost fetched by the server (and any
   * manual change checked for its reason), every line's selling price, the totals.
   */
  private async prepareRevision(user: AuthUser, currency: string, dto: CreateRevisionDto): Promise<PreparedRevision> {
    const now = new Date();

    // Validity: mandatory — defaulted from the settings when the author names none.
    let validUntil: Date | null;
    if (dto.validUntil !== undefined) {
      validUntil = normalizeValidUntil(dto.validUntil);
      if (!validUntil) throw new BadRequestException('Validity date must be a valid date');
    } else {
      const days = await this.settings.get(
        user.organizationId,
        ORG_SETTING_KEYS.PROPOSAL_VALIDITY_DAYS,
        ORG_SETTING_DEFAULTS[ORG_SETTING_KEYS.PROPOSAL_VALIDITY_DAYS],
      );
      validUntil = normalizeValidUntil(new Date(now.getTime() + days * DAY_MS));
    }
    if (!validUntil || !isValidityFuture(validUntil, now)) {
      throw new BadRequestException('Validity date must be in the future');
    }

    const pricingMode = dto.pricingMode ?? 'PER_LINE';
    const lineSpec = await this.resolveLineSubjects(user.organizationId, dto.bomLines);
    // P3-5: the template the lines came from is recorded, never followed.
    if (dto.templateId) {
      const template = await this.prisma.budgetTemplate.findFirst({
        where: { id: dto.templateId, organizationId: user.organizationId },
        select: { id: true },
      });
      if (!template) throw new BadRequestException('Unknown budget template');
    }

    // The margin: an explicit one wins, else the pricing scheme's.
    let marginPct: Prisma.Decimal | null = dto.marginPct !== undefined ? new Prisma.Decimal(dto.marginPct) : null;
    if (dto.pricingSchemeId) {
      const scheme = await this.prisma.pricingScheme.findFirst({
        where: { id: dto.pricingSchemeId, organizationId: user.organizationId },
      });
      if (!scheme) throw new NotFoundException('Pricing scheme not found');
      if (marginPct === null) marginPct = new Prisma.Decimal(scheme.marginPct);
    }

    // The cost is the server's to fetch — never taken on trust from the client:
    // the last purchase of the stock item, else the work item's default cost.
    const itemIds = [...new Set(lineSpec.map((l) => l.itemId).filter((id): id is string => !!id))];
    const costs = itemIds.length
      ? await this.itemCosts.lastPurchaseCosts(user.organizationId, itemIds, currency)
      : new Map<string, LastCost>();
    const mayPrice = canViewCosts(user);
    let overridden = 0;
    const lines: Array<Omit<PreparedLine, 'lineTotal'>> = dto.bomLines.map((l, idx) => {
      const subject = lineSpec[idx];
      const fetched: LastCost | undefined = subject.itemId
        ? costs.get(subject.itemId)
        : { unitCost: subject.workItemCost!, costSource: 'CATALOGUE', costDate: null };
      if (!fetched) throw new BadRequestException('One or more BOM items are invalid for this tenant');
      const cost = this.resolveCost(user, l, fetched, now);
      if (cost.costSource === 'MANUAL') overridden += 1;
      let unitPrice: Prisma.Decimal;
      if (pricingMode === 'LUMP_SUM') {
        // A lump-sum budget is priced as a whole: the lines carry cost only.
        if (l.unitPrice !== undefined) {
          throw new BadRequestException('Line prices are not used in a lump-sum budget — set the selling total');
        }
        unitPrice = new Prisma.Decimal(0);
      } else if (l.unitPrice !== undefined) {
        unitPrice = round2(new Prisma.Decimal(l.unitPrice));
      } else if (mayPrice) {
        unitPrice = sellingPrice(cost.unitCost, marginPct ?? 0);
      } else {
        throw new BadRequestException('Selling price is required');
      }
      return {
        itemId: subject.itemId,
        workItemId: subject.workItemId,
        description: l.description?.trim() || null,
        uom: l.uom?.trim() || subject.uom,
        qty: new Prisma.Decimal(l.qty),
        isAdder: l.isAdder ?? false,
        ...cost,
        unitPrice,
      };
    });

    const priced = priceRevision(lines.map((l) => ({ qty: l.qty, unitCost: l.unitCost, unitPrice: l.unitPrice })));
    const totals = budgetTotals({
      pricingMode,
      subtotal: priced.subtotal,
      lineTotal: priced.totalAmount,
      sellingTotal: dto.sellingTotal,
      contingencyPct: dto.contingencyPct,
    });
    return {
      validUntil,
      pricingSchemeId: dto.pricingSchemeId ?? null,
      lines: lines.map((l, i) => ({ ...l, lineTotal: priced.lines[i].lineTotal })),
      subtotal: priced.subtotal,
      ...totals,
      riskNotes: dto.riskNotes?.trim() || null,
      templateId: dto.templateId ?? null,
      overridden,
    };
  }

  /**
   * Package 3 · P3-4 — what each line is about: its stock item, its work item, or
   * both. A work item of the tenant brings its own stock item (MATERIAL) and its
   * default cost; a stock item named beside a work item must be that one. Every
   * id is checked against the caller's organization.
   */
  private async resolveLineSubjects(organizationId: string, bomLines: BomLineDto[]) {
    const workItemIds = [...new Set(bomLines.map((l) => l.workItemId).filter((id): id is string => !!id))];
    const workItems = workItemIds.length
      ? await this.prisma.workItem.findMany({
          where: { id: { in: workItemIds }, organizationId },
          select: { id: true, itemId: true, uom: true, defaultUnitCost: true },
        })
      : [];
    if (workItems.length !== workItemIds.length) {
      throw new BadRequestException('One or more work items are invalid for this tenant');
    }
    const byId = new Map(workItems.map((w) => [w.id, w]));

    const spec = bomLines.map((l) => {
      if (!l.itemId && !l.workItemId) throw new BadRequestException('Each line needs a work item or a stock item');
      const w = l.workItemId ? byId.get(l.workItemId)! : null;
      if (w && l.itemId && w.itemId && w.itemId !== l.itemId) {
        throw new BadRequestException('The stock item does not match the work item');
      }
      return {
        itemId: l.itemId ?? w?.itemId ?? null,
        workItemId: w?.id ?? null,
        uom: w?.uom ?? null,
        workItemCost: w ? round2(new Prisma.Decimal(w.defaultUnitCost)) : null,
      };
    });

    // Every stock item (named or brought by a work item) belongs to this tenant.
    const itemIds = [...new Set(spec.map((x) => x.itemId).filter((id): id is string => !!id))];
    if (itemIds.length) {
      const items = await this.prisma.item.findMany({
        where: { id: { in: itemIds }, organizationId },
        select: { id: true },
      });
      if (items.length !== itemIds.length) {
        throw new BadRequestException('One or more BOM items are invalid for this tenant');
      }
    }
    return spec;
  }

  /** A line's cost: what the server fetched, unless the author changed it — which needs a reason, and keeps the original. */
  private resolveCost(user: AuthUser, line: BomLineDto, fetched: LastCost, now: Date) {
    const original = round2(new Prisma.Decimal(fetched.unitCost));
    const base = {
      originalUnitCost: original,
      costDate: fetched.costDate,
      costAgeDays: costAge(fetched.costDate, now),
    };
    if (line.unitCost !== undefined) {
      const typed = round2(new Prisma.Decimal(line.unitCost));
      if (!typed.equals(original)) {
        const reason = line.costOverrideReason?.trim();
        if (!reason) throw new BadRequestException('Cost override reason is required');
        return {
          ...base,
          unitCost: typed,
          costSource: 'MANUAL' as const,
          costOverrideReason: reason,
          costOverriddenAt: now,
          costOverriddenById: user.userId,
        };
      }
    }
    return {
      ...base,
      unitCost: original,
      costSource: fetched.costSource,
      costOverrideReason: null,
      costOverriddenAt: null,
      costOverriddenById: null,
    };
  }

  private lineData(l: PreparedLine): Prisma.BomLineUncheckedCreateWithoutProposalRevisionInput {
    return {
      itemId: l.itemId,
      workItemId: l.workItemId,
      description: l.description,
      uom: l.uom,
      qty: l.qty,
      isAdder: l.isAdder,
      unitCost: l.unitCost,
      originalUnitCost: l.originalUnitCost,
      costSource: l.costSource,
      costDate: l.costDate,
      costAgeDays: l.costAgeDays,
      costOverrideReason: l.costOverrideReason,
      costOverriddenAt: l.costOverriddenAt,
      costOverriddenById: l.costOverriddenById,
      unitPrice: l.unitPrice,
      lineTotal: l.lineTotal,
    };
  }

  /** The revision and its proposal move together: the proposal's status mirrors the current revision's. */
  private async mirror(
    tx: Tx,
    proposalId: string,
    revisionId: string,
    status: Status,
    revisionData: Prisma.ProposalRevisionUncheckedUpdateInput = {},
  ) {
    const revision = await tx.proposalRevision.update({
      where: { id: revisionId },
      data: { ...revisionData, status },
    });
    await tx.proposal.update({ where: { id: proposalId }, data: { status } });
    return revision;
  }

  private async expireRevision(
    organizationId: string,
    proposal: LoadedProposal,
    current: CurrentRevision,
    now: Date,
  ): Promise<void> {
    await this.engine.transition(
      { system: true, organizationId },
      {
        documentType: DOC,
        documentId: proposal.id,
        actionCode: WF_ACTIONS.EXPIRE,
        comment: SYSTEM_EXPIRY_NOTE,
        context: { total: Number(current.totalAmount) },
        eventPayload: this.eventPayload(proposal, current),
        apply: async (tx) => {
          await this.mirror(tx, proposal.id, current.id, 'EXPIRED', { closedAt: now });
        },
      },
    );
    // Tell the author, best effort: the move has committed and a bell must never undo it.
    if (current.createdById) {
      try {
        await this.prisma.notification.create({
          data: {
            organizationId,
            userId: current.createdById,
            type: 'PROPOSAL_EXPIRED',
            titleAr: `انتهت صلاحية عرض السعر ${proposal.code}`,
            titleEn: `Proposal ${proposal.code} has expired`,
            bodyAr: `انتهت مدة صلاحية النسخة ${current.revisionNo} من عرض السعر قبل قبولها. أنشئ نسخة جديدة إن كان العرض ما زال قائماً.`,
            bodyEn: `Revision ${current.revisionNo} of the proposal passed its validity date before it was accepted. Add a new revision if the offer still stands.`,
            linkPath: `/proposals/${proposal.id}`,
          },
        });
      } catch (err) {
        this.logger.error(
          `Expiry notification failed for proposal ${proposal.code}`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }
  }

  private eventPayload(
    proposal: { id: string; code: string; opportunityId: string },
    revision: { revisionNo: number; totalAmount: unknown },
  ) {
    return {
      proposalId: proposal.id,
      code: proposal.code,
      revisionNo: revision.revisionNo,
      opportunityId: proposal.opportunityId,
      totalAmount: Number(revision.totalAmount),
    };
  }

  /** The role of the person who wrote the revision: who owes the next action once it comes back or is approved. */
  private async authorRole(createdById: string | null): Promise<string | null> {
    if (!createdById) return null;
    const author = await this.prisma.user.findUnique({ where: { id: createdById }, select: { roleId: true } });
    return author?.roleId ?? null;
  }

  /**
   * A legacy proposal (written before the engine knew proposals) has no flow
   * instance; it is adopted at the state it is in, the first time anything moves it.
   */
  private async ensureInstance(organizationId: string, proposal: { id: string; code: string; status: string }) {
    const instance = await this.engine.instanceFor(organizationId, DOC, proposal.id);
    if (instance) return;
    try {
      await this.prisma.$transaction((tx) =>
        this.engine.adopt(tx, {
          organizationId,
          flowCode: WF_FLOWS.PROPOSAL,
          documentId: proposal.id,
          documentCode: proposal.code,
          stateCode: proposal.status,
        }),
      );
    } catch (err) {
      // Someone adopted it at the same moment: the instance exists, which is all we wanted.
      if (!isUniqueViolation(err)) throw err;
    }
  }

  /**
   * Is there someone other than the raiser who could sign the first step? An active
   * holder of the step's role (primary or extra) who also holds the approve key
   * effectively (through any role or a GRANT, not DENIED — ADR-02), or an active
   * delegate who is not the raiser, holds the key effectively, and borrows the role
   * from a holder who is not the raiser either (the matrix refuses the raiser's own
   * delegation). There is deliberately no standing deputy: absence is covered by the
   * temporary delegation, nothing else (CRM-S4-a).
   */
  private async hasOtherApprover(user: AuthUser, roleId: string): Promise<boolean> {
    const approve = PERMISSIONS.PROPOSAL_APPROVE;
    const direct = await this.prisma.user.count({
      where: {
        organizationId: user.organizationId,
        isActive: true,
        id: { not: user.userId },
        AND: [holdsRole(roleId), holdsEffectively(approve)],
      },
    });
    if (direct > 0) return true;

    const now = new Date();
    const lent = await this.prisma.approvalDelegation.count({
      where: {
        organizationId: user.organizationId,
        isActive: true,
        startsAt: { lte: now },
        endsAt: { gte: now },
        toUserId: { not: user.userId },
        fromUserId: { not: user.userId },
        toUser: { isActive: true, AND: [holdsEffectively(approve)] },
        // The delegator must still hold the key too: decide() refuses a
        // delegation whose delegator was denied it (ADR-02 §3-1).
        fromUser: { isActive: true, roleId, AND: [holdsEffectively(approve)] },
      },
    });
    return lent > 0;
  }

  /**
   * Serialise everything one proposal's submission does. Without it two simultaneous
   * submits both pass the checks, both ask the matrix, and both open a chain (the
   * matrix's own "already awaiting approval" check is a read followed by a write).
   * A Postgres advisory lock taken for the length of a transaction, released when it
   * ends, whichever process holds the other submit.
   */
  private withProposalLock<T>(proposalId: string, fn: () => Promise<T>): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`proposal:${proposalId}`}))`;
        return fn();
      },
      { timeout: 60_000, maxWait: 60_000 },
    );
  }
}
