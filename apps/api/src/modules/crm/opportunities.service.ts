import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@npi/db';
import {
  OPPORTUNITY_STAGE_FLOW,
  OPPORTUNITY_STAGES,
  OPPORTUNITY_TYPES,
  WF_EVENTS,
  isBackwardMove,
  isOpenStage,
  opportunityTransition,
} from '@npi/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { NumberingService } from '../../common/numbering.service';
import { AuditService } from '../../common/audit.service';
import { OutboxService } from '../../common/workflow/outbox.service';
import type { AuthUser } from '../../common/auth-user';
import { ChangeStageDto, CreateOpportunityDto, UpdateOpportunityDto } from './dto';
import { canViewCosts, hideRevisionPricing } from '../commercial/revision-pricing';

type Tx = Prisma.TransactionClient;

type OpportunityType = 'DIRECT' | 'TENDER';

/** The only fields a closed (WON / LOST) opportunity still accepts. */
const CLOSED_EDITABLE = new Set(['name', 'lossNotes']);

export interface OpportunityListFilters {
  stage?: string;
  type?: string;
  /** Only the open stages (neither WON nor LOST). Ignored when `stage` is given. */
  open?: boolean;
}

/** Everything the opportunity-side tender fields can be set from (create and update bodies). */
interface TenderInput {
  tenderReference?: string | null;
  tenderCloseDate?: string | null;
  bidBondAmount?: number | null;
  bidBondBank?: string | null;
  bidBondExpiry?: string | null;
  bidBondReference?: string | null;
}

const TENDER_KEYS = [
  'tenderReference',
  'tenderCloseDate',
  'bidBondAmount',
  'bidBondBank',
  'bidBondExpiry',
  'bidBondReference',
] as const;

/** A date the client sent as text: a bad one is a 400, never a database error. */
function parseDate(value: string | null | undefined, field: string): Date | null | undefined {
  if (value === undefined) return undefined; // not sent: leave as is
  if (value === null || value === '') return null; // sent empty: clear it
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`${field} must be a valid date`);
  return d;
}

const text = (v: string | null | undefined): string | null | undefined =>
  v === undefined ? undefined : v === null || v.trim() === '' ? null : v.trim();

/** Money enters the database as a Decimal, never a float. */
const money = (v: number | null | undefined): Prisma.Decimal | null | undefined =>
  v === undefined ? undefined : v === null ? null : new Prisma.Decimal(v);

const NO_TENDER = {
  tenderReference: null,
  tenderCloseDate: null,
  bidBondAmount: null,
  bidBondBank: null,
  bidBondExpiry: null,
  bidBondReference: null,
};

@Injectable()
export class OpportunitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  list(user: AuthUser, filters: OpportunityListFilters = {}) {
    const { stage, type, open } = filters;
    if (stage && !OPPORTUNITY_STAGES.some((s) => s.value === stage)) {
      throw new BadRequestException('Unknown opportunity stage');
    }
    if (type && !OPPORTUNITY_TYPES.some((t) => t.value === type)) {
      throw new BadRequestException('Unknown opportunity type');
    }
    return this.prisma.opportunity.findMany({
      where: {
        organizationId: user.organizationId,
        ...(stage
          ? { stage: stage as never }
          : open
            ? { stage: { in: [...OPPORTUNITY_STAGE_FLOW] as never[] } }
            : {}),
        ...(type ? { opportunityType: type as never } : {}),
      },
      include: {
        customer: { select: { id: true, nameAr: true, nameEn: true, code: true } },
        lossReason: { select: { nameAr: true, nameEn: true } },
        _count: { select: { proposals: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(user: AuthUser, id: string) {
    const opp = await this.prisma.opportunity.findFirst({
      where: { id, organizationId: user.organizationId },
      include: {
        customer: true,
        owner: { select: { id: true, nameAr: true, nameEn: true } },
        lossReason: { select: { id: true, nameAr: true, nameEn: true } },
        proposals: { include: { revisions: true } },
        designVersions: true,
        contracts: { select: { id: true, code: true, status: true, contractType: true, totalValue: true, currency: true } },
      },
    });
    if (!opp) throw new NotFoundException('Opportunity not found');
    if (canViewCosts(user)) return opp;
    return {
      ...opp,
      proposals: opp.proposals.map((pr) => ({ ...pr, revisions: pr.revisions.map(hideRevisionPricing) })),
    };
  }

  /**
   * The tender columns for a given type. DIRECT stores none (even if some were
   * sent); TENDER needs a close date — the last day a bid can be submitted.
   */
  private tenderColumns(type: OpportunityType, src: TenderInput) {
    if (type === 'DIRECT') return { ...NO_TENDER };
    const tenderCloseDate = parseDate(src.tenderCloseDate, 'tenderCloseDate');
    if (!tenderCloseDate) throw new BadRequestException('Tender close date is required');
    return {
      tenderReference: text(src.tenderReference) ?? null,
      tenderCloseDate,
      bidBondAmount: money(src.bidBondAmount) ?? null,
      bidBondBank: text(src.bidBondBank) ?? null,
      bidBondExpiry: parseDate(src.bidBondExpiry, 'bidBondExpiry') ?? null,
      bidBondReference: text(src.bidBondReference) ?? null,
    };
  }

  async create(user: AuthUser, dto: CreateOpportunityDto) {
    const type: OpportunityType = dto.opportunityType ?? 'DIRECT';
    // Refused before any query: a tender without its close date is not a tender.
    const tender = this.tenderColumns(type, dto);
    const expectedCloseDate = parseDate(dto.expectedCloseDate, 'expectedCloseDate') ?? null;

    // Ensure the customer belongs to this tenant.
    const customer = await this.prisma.customer.findFirst({
      where: { id: dto.customerId, organizationId: user.organizationId },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    // A duplicate that was merged away takes no new documents.
    if (customer.mergedIntoId) throw new ConflictException('Customer already merged');

    return this.prisma.$transaction(async (tx) => {
      const code = await this.numbering.next(user.organizationId, 'OPPORTUNITY', tx);
      const created = await tx.opportunity.create({
        data: {
          organizationId: user.organizationId,
          code,
          name: dto.name,
          customerId: dto.customerId,
          // Always born PROSPECTING: the funnel is walked through changeStage().
          stage: 'PROSPECTING',
          stageChangedAt: new Date(),
          opportunityType: type,
          estimatedKwp: money(dto.estimatedKwp),
          estimatedValue: money(dto.estimatedValue),
          expectedCloseDate,
          ownerId: user.userId,
          ...tender,
        },
      });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'Opportunity',
          entityId: created.id,
          action: 'CREATE',
          after: created,
        },
        tx,
      );
      return created;
    });
  }

  async update(user: AuthUser, id: string, dto: UpdateOpportunityDto) {
    if (dto.stage !== undefined) {
      throw new BadRequestException('Stage changes go through /stage');
    }

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.opportunity.findFirst({ where: { id, organizationId: user.organizationId } });
      if (!existing) throw new NotFoundException('Opportunity not found');

      // A closed opportunity is a historical record: only its name and its
      // loss notes can still be corrected.
      if (!isOpenStage(existing.stage)) {
        const sent = Object.entries(dto).filter(([, v]) => v !== undefined).map(([k]) => k);
        if (sent.some((k) => !CLOSED_EDITABLE.has(k))) throw new ConflictException('Opportunity is closed');
      }

      const data: Prisma.OpportunityUncheckedUpdateInput = {};
      if (dto.name !== undefined) data.name = dto.name;
      if (dto.estimatedKwp !== undefined) data.estimatedKwp = money(dto.estimatedKwp);
      if (dto.estimatedValue !== undefined) data.estimatedValue = money(dto.estimatedValue);
      const expected = parseDate(dto.expectedCloseDate, 'expectedCloseDate');
      if (expected !== undefined) data.expectedCloseDate = expected;
      if (dto.lossNotes !== undefined && existing.stage === 'LOST') data.lossNotes = text(dto.lossNotes);

      // Type and tender fields (open opportunities only — closed ones were refused above).
      if (isOpenStage(existing.stage)) {
        const newType: OpportunityType = dto.opportunityType ?? (existing.opportunityType as OpportunityType);
        if (newType === 'DIRECT') {
          // Going (or staying) direct: no tender data survives.
          if (existing.opportunityType === 'TENDER') Object.assign(data, NO_TENDER);
        } else {
          const sentTender = TENDER_KEYS.some((k) => dto[k] !== undefined);
          if (sentTender || existing.opportunityType !== 'TENDER') {
            // The merged picture must still have a close date.
            const merged: TenderInput = {
              tenderReference: dto.tenderReference ?? existing.tenderReference,
              tenderCloseDate:
                dto.tenderCloseDate !== undefined
                  ? dto.tenderCloseDate
                  : existing.tenderCloseDate?.toISOString() ?? null,
              bidBondAmount: dto.bidBondAmount ?? (existing.bidBondAmount ? Number(existing.bidBondAmount) : null),
              bidBondBank: dto.bidBondBank ?? existing.bidBondBank,
              bidBondExpiry:
                dto.bidBondExpiry !== undefined ? dto.bidBondExpiry : existing.bidBondExpiry?.toISOString() ?? null,
              bidBondReference: dto.bidBondReference ?? existing.bidBondReference,
            };
            Object.assign(data, this.tenderColumns('TENDER', merged));
          }
        }
        if (dto.opportunityType !== undefined && dto.opportunityType !== existing.opportunityType) {
          data.opportunityType = dto.opportunityType;
        }
      }

      const updated = await tx.opportunity.update({ where: { id: existing.id }, data });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'Opportunity',
          entityId: id,
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
   * The manual way through the funnel: POST /opportunities/:id/stage.
   *
   * One step forward, any step back among the open stages, LOST from anywhere
   * open (a loss reason is then mandatory), WON by hand from NEGOTIATION only;
   * WON and LOST are final. The write is guarded by the stage that was read, so
   * of two simultaneous requests exactly one succeeds.
   */
  async changeStage(user: AuthUser, id: string, dto: ChangeStageDto) {
    // Checked before the database is touched: no transaction for a bad request.
    if (dto.stage === 'LOST' && !dto.lossReasonId) {
      throw new BadRequestException('Loss reason is required');
    }

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.opportunity.findFirst({ where: { id, organizationId: user.organizationId } });
      if (!existing) throw new NotFoundException('Opportunity not found');

      const verdict = opportunityTransition(existing.stage, dto.stage);
      if (!verdict.ok) throw this.invalidTransition(existing.stage, dto.stage, verdict.reason);

      if (dto.stage === 'LOST') {
        // Active AND this organization's: an inactive or foreign reason is, to the caller, no reason at all.
        const reason = await tx.lossReason.findFirst({
          where: { id: dto.lossReasonId, organizationId: user.organizationId, isActive: true },
        });
        if (!reason) throw new NotFoundException('Loss reason not found');
      }

      return this.applyStageChange(tx, user, existing, dto.stage, {
        lossReasonId: dto.lossReasonId,
        lossNotes: dto.lossNotes,
      });
    });
  }

  /**
   * The proposal path: creating a proposal carries an opportunity that has not
   * reached «عرض سعر» yet to PROPOSAL, inside the proposal's own transaction.
   * A closed opportunity takes no new proposal (409).
   */
  async advanceOnProposal(tx: Tx, user: AuthUser, opportunityId: string): Promise<void> {
    const opp = await tx.opportunity.findFirst({ where: { id: opportunityId, organizationId: user.organizationId } });
    if (!opp) throw new NotFoundException('Opportunity not found');
    if (!isOpenStage(opp.stage)) throw new ConflictException('Opportunity is closed');
    if (opp.stage === 'PROSPECTING' || opp.stage === 'QUALIFICATION') {
      await this.applyStageChange(tx, user, opp, 'PROPOSAL', { via: 'proposal' });
    }
  }

  /**
   * The contract path: creating a contract wins the opportunity, from any open
   * stage, inside the contract's own transaction. A LOST opportunity is refused
   * (409); one that is already WON (a second contract) is left as it is.
   */
  async markWonViaContract(tx: Tx, user: AuthUser, opportunityId: string): Promise<void> {
    const opp = await tx.opportunity.findFirst({ where: { id: opportunityId, organizationId: user.organizationId } });
    if (!opp) throw new NotFoundException('Opportunity not found');
    if (opp.stage === 'LOST') throw new ConflictException('Opportunity is closed');
    if (opp.stage === 'WON') return;
    await this.applyStageChange(tx, user, opp, 'WON', { via: 'contract' });
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private invalidTransition(from: string, to: string, reason: string) {
    return new ConflictException({
      statusCode: 409,
      message: `Invalid stage transition: ${from} -> ${to}`,
      code: 'OPPORTUNITY_STAGE',
      from,
      to,
      reason,
    });
  }

  /**
   * The one place a stage is written. Guards the update with the stage that was
   * read (`count === 1`), stamps stageChangedAt (and closedAt when closing),
   * audits it as STAGE_CHANGE and — for WON / LOST only — emits the outbox event.
   */
  private async applyStageChange(
    tx: Tx,
    user: AuthUser,
    existing: { id: string; stage: string; code: string; customerId: string; estimatedValue: unknown } & Record<string, unknown>,
    to: string,
    extra: { via?: 'proposal' | 'contract'; lossReasonId?: string; lossNotes?: string } = {},
  ) {
    const now = new Date();
    const data: Prisma.OpportunityUncheckedUpdateManyInput = { stage: to as never, stageChangedAt: now };
    if (to === 'LOST') {
      data.closedAt = now;
      data.lossReasonId = extra.lossReasonId ?? null;
      data.lossNotes = text(extra.lossNotes) ?? null;
    } else if (to === 'WON') {
      data.closedAt = now;
      data.lossReasonId = null;
      data.lossNotes = null;
    }

    const { count } = await tx.opportunity.updateMany({
      where: { id: existing.id, organizationId: user.organizationId, stage: existing.stage as never },
      data,
    });
    if (count !== 1) {
      // Someone moved it between our read and our write.
      throw this.invalidTransition(existing.stage, to, 'CONCURRENT');
    }

    const after = await tx.opportunity.findUniqueOrThrow({ where: { id: existing.id } });
    await this.audit.record(
      {
        organizationId: user.organizationId,
        actorId: user.userId,
        entityType: 'Opportunity',
        entityId: existing.id,
        action: 'STAGE_CHANGE',
        before: existing,
        after: {
          ...after,
          ...(isBackwardMove(existing.stage, to) ? { backward: true } : {}),
          ...(extra.via ? { via: extra.via } : {}),
        },
      },
      tx,
    );

    if (to === 'WON' || to === 'LOST') {
      await this.outbox.emit(tx, {
        organizationId: user.organizationId,
        eventCode: to === 'WON' ? WF_EVENTS.OPPORTUNITY_WON : WF_EVENTS.OPPORTUNITY_LOST,
        payload: {
          opportunityId: existing.id,
          code: existing.code,
          customerId: existing.customerId,
          stage: to,
          lossReasonId: to === 'LOST' ? (extra.lossReasonId ?? null) : null,
          estimatedValue: existing.estimatedValue == null ? null : String(existing.estimatedValue),
        },
      });
    }
    return after;
  }
}
