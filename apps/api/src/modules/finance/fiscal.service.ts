import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../common/audit.service';
import { PostingService } from '../../common/posting.service';
import type { AuthUser } from '../../common/auth-user';

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Journal source type for the year-end result sweep. */
const YEAR_END_SOURCE = 'YearEndClose';

/**
 * The fiscal calendar and period close.
 *
 * Until now a journal could be posted to any date forever: nothing could be
 * closed, so no reported figure was ever final. A closed period refuses new
 * postings (enforced centrally in PostingService.journal), and closing a year
 * sweeps revenue and expense into retained earnings so the next year starts
 * from a clean result.
 */
@Injectable()
export class FiscalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly posting: PostingService,
  ) {}

  listYears(user: AuthUser) {
    return this.prisma.fiscalYear.findMany({
      where: { organizationId: user.organizationId },
      include: { periods: { orderBy: { month: 'asc' } } },
      orderBy: { year: 'desc' },
    });
  }

  /**
   * Open a calendar year and its twelve months in one go. Period bounds are
   * built in UTC and the end bound is the last millisecond of the month, so
   * `startDate <= postingDate <= endDate` covers the month with no gap between
   * one period and the next.
   */
  async openYear(user: AuthUser, year: number) {
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('Year must be between 2000 and 2100');
    }
    const existing = await this.prisma.fiscalYear.findFirst({
      where: { organizationId: user.organizationId, year },
    });
    if (existing) throw new BadRequestException(`Fiscal year ${year} already exists`);

    const monthStart = (m: number) => new Date(Date.UTC(year, m - 1, 1));
    const monthEnd = (m: number) => new Date(Date.UTC(year, m, 1) - 1);

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.fiscalYear.create({
        data: {
          organizationId: user.organizationId,
          year,
          startDate: monthStart(1),
          endDate: monthEnd(12),
          periods: {
            create: Array.from({ length: 12 }, (_, i) => ({
              organizationId: user.organizationId,
              month: i + 1,
              startDate: monthStart(i + 1),
              endDate: monthEnd(i + 1),
            })),
          },
        },
        include: { periods: { orderBy: { month: 'asc' } } },
      });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'FiscalYear',
          entityId: created.id,
          action: 'OPEN_YEAR',
          after: { year },
        },
        tx,
      );
      return created;
    });
  }

  async setPeriodStatus(user: AuthUser, periodId: string, status: 'OPEN' | 'CLOSED') {
    const period = await this.prisma.fiscalPeriod.findFirst({
      where: { id: periodId, organizationId: user.organizationId },
      include: { fiscalYear: true },
    });
    if (!period) throw new NotFoundException('Period not found');
    if (period.fiscalYear.status === 'CLOSED') {
      throw new BadRequestException('The fiscal year is closed — reopen the year first');
    }
    if (period.status === status) {
      throw new BadRequestException(`Period is already ${status.toLowerCase()}`);
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.fiscalPeriod.update({
        where: { id: period.id },
        data: {
          status,
          closedAt: status === 'CLOSED' ? new Date() : null,
          closedById: status === 'CLOSED' ? user.userId : null,
        },
      });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'FiscalPeriod',
          entityId: period.id,
          action: status === 'CLOSED' ? 'CLOSE_PERIOD' : 'REOPEN_PERIOD',
          before: { status: period.status },
          after: { status },
        },
        tx,
      );
      return updated;
    });
  }

  // ── Year-end ──────────────────────────────────────────────────────────────

  /** Signed net (debit − credit) per P&L account over the year. */
  private async resultBalances(organizationId: string, from: Date, to: Date) {
    const lines = await this.prisma.journalLine.findMany({
      where: {
        account: { organizationId, accountType: { in: ['REVENUE', 'EXPENSE'] } },
        journalEntry: {
          organizationId,
          postingDate: { gte: from, lte: to },
          // A previous close (later reversed) must not be swept a second time.
          sourceType: { not: YEAR_END_SOURCE },
        },
      },
      select: { accountId: true, debit: true, credit: true },
    });
    const net = new Map<string, number>();
    for (const l of lines) {
      net.set(l.accountId, round2((net.get(l.accountId) ?? 0) + Number(l.debit) - Number(l.credit)));
    }
    return net;
  }

  /**
   * Close the year: zero every revenue and expense account against retained
   * earnings, then lock the year and all its periods.
   *
   * The closing entry is written before the lock lands — it is the one posting
   * that belongs to a year being closed, so it is created directly rather than
   * through the period guard it is about to trip.
   */
  async closeYear(user: AuthUser, yearId: string) {
    const year = await this.prisma.fiscalYear.findFirst({
      where: { id: yearId, organizationId: user.organizationId },
    });
    if (!year) throw new NotFoundException('Fiscal year not found');
    if (year.status === 'CLOSED') throw new BadRequestException('Fiscal year is already closed');

    const net = await this.resultBalances(user.organizationId, year.startDate, year.endDate);
    const acc = await this.posting.accounts(user.organizationId, ['RETAINED_EARNINGS'] as const);

    // Reverse each P&L balance; the net of them all lands on retained earnings.
    const lines: Array<{ accountId: string; debit: number; credit: number }> = [];
    let result = 0;
    for (const [accountId, balance] of net) {
      if (Math.abs(balance) < 0.01) continue;
      result = round2(result + balance);
      lines.push(
        balance > 0
          ? { accountId, debit: 0, credit: round2(balance) } // expense → credited away
          : { accountId, debit: round2(-balance), credit: 0 }, // revenue → debited away
      );
    }
    // result = Σ(debit − credit) over P&L: negative means a profit.
    if (lines.length > 0) {
      lines.push(
        result < 0
          ? { accountId: acc.RETAINED_EARNINGS, debit: 0, credit: round2(-result) }
          : { accountId: acc.RETAINED_EARNINGS, debit: round2(result), credit: 0 },
      );
    }

    return this.prisma.$transaction(async (tx) => {
      if (lines.length > 0) {
        await tx.journalEntry.create({
          data: {
            organizationId: user.organizationId,
            postingDate: year.endDate,
            sourceType: YEAR_END_SOURCE,
            sourceId: year.id,
            memo: `Year-end close ${year.year} — result swept to retained earnings`,
            lines: { create: lines.map((l) => ({ ...l, currency: 'SAR' })) },
          },
        });
      }

      const closedAt = new Date();
      await tx.fiscalPeriod.updateMany({
        where: { fiscalYearId: year.id },
        data: { status: 'CLOSED', closedAt, closedById: user.userId },
      });
      const updated = await tx.fiscalYear.update({
        where: { id: year.id },
        data: { status: 'CLOSED', closedAt, closedById: user.userId },
        include: { periods: { orderBy: { month: 'asc' } } },
      });

      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'FiscalYear',
          entityId: year.id,
          action: 'CLOSE_YEAR',
          after: { year: year.year, netResult: round2(-result), sweptAccounts: lines.length - 1 },
        },
        tx,
      );
      return updated;
    });
  }

  /**
   * Reopen a closed year. The closing entry is reversed rather than deleted —
   * the ledger is append-only, so a correction is always a new entry.
   */
  async reopenYear(user: AuthUser, yearId: string) {
    const year = await this.prisma.fiscalYear.findFirst({
      where: { id: yearId, organizationId: user.organizationId },
    });
    if (!year) throw new NotFoundException('Fiscal year not found');
    if (year.status === 'OPEN') throw new BadRequestException('Fiscal year is already open');

    const closing = await this.prisma.journalEntry.findFirst({
      where: {
        organizationId: user.organizationId,
        sourceType: YEAR_END_SOURCE,
        sourceId: year.id,
        isReversal: false,
      },
      include: { lines: true },
      orderBy: { createdAt: 'desc' },
    });
    // Already-reversed closings leave a matching reversal behind; only reverse
    // one that is still standing.
    const reversed = closing
      ? await this.prisma.journalEntry.findFirst({
          where: { reversedEntryId: closing.id },
          select: { id: true },
        })
      : null;

    return this.prisma.$transaction(async (tx) => {
      if (closing && !reversed) {
        await tx.journalEntry.create({
          data: {
            organizationId: user.organizationId,
            postingDate: year.endDate,
            sourceType: YEAR_END_SOURCE,
            sourceId: year.id,
            isReversal: true,
            reversedEntryId: closing.id,
            memo: `Reversal of year-end close ${year.year}`,
            lines: {
              create: closing.lines.map((l) => ({
                accountId: l.accountId,
                debit: Number(l.credit),
                credit: Number(l.debit),
                currency: l.currency,
              })),
            },
          },
        });
      }

      await tx.fiscalPeriod.updateMany({
        where: { fiscalYearId: year.id },
        data: { status: 'OPEN', closedAt: null, closedById: null },
      });
      const updated = await tx.fiscalYear.update({
        where: { id: year.id },
        data: { status: 'OPEN', closedAt: null, closedById: null },
        include: { periods: { orderBy: { month: 'asc' } } },
      });

      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'FiscalYear',
          entityId: year.id,
          action: 'REOPEN_YEAR',
          after: { year: year.year, reversedEntryId: closing?.id ?? null },
        },
        tx,
      );
      return updated;
    });
  }
}
