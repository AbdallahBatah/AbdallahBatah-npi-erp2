import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../common/audit.service';
import type { AuthUser } from '../../common/auth-user';

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Journal source type for IFRS-15 recognition adjustments. */
const REVREC_SOURCE = 'RevenueRecognition';
/** Accounts used by the recognition engine. */
const CONTRACT_ASSET = '1150'; // unbilled work performed
const CONTRACT_LIABILITY = '2400'; // deferred (over-billed) revenue
const REVENUE = '4000';

export interface PocRow {
  contractId: string;
  code: string;
  customer: { nameAr: string; nameEn: string };
  contractValue: number;
  progressPct: number; // output method: verified milestone value / total milestone value
  recognizedRevenue: number; // contractValue × progress
  billedRevenue: number; // Σ issued invoice subtotals
  postedAdjustment: number; // recognition journals already posted (signed)
  targetAdjustment: number; // recognized − billed (signed)
  unpostedDelta: number; // target − posted (what "recognize" would post now)
  position: 'CONTRACT_ASSET' | 'CONTRACT_LIABILITY' | 'BALANCED';
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Shared period parser. A bare `YYYY-MM-DD` "to" date is pushed to the end of
   * that day — a user asking for "up to 30 Sep" means the whole of 30 Sep, not
   * midnight. Defaults to the calendar year to date.
   */
  private parsePeriod(fromStr?: string, toStr?: string, defaultFrom?: Date) {
    const now = new Date();
    const from = fromStr
      ? new Date(fromStr)
      : (defaultFrom ?? new Date(Date.UTC(now.getUTCFullYear(), 0, 1)));
    let to = toStr ? new Date(toStr) : now;
    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      throw new BadRequestException('Invalid from/to date');
    }
    if (toStr && /^\d{4}-\d{2}-\d{2}$/.test(toStr.trim())) {
      to = new Date(to.getTime() + 24 * 60 * 60 * 1000 - 1);
    }
    if (to < from) throw new BadRequestException('Period end is before its start');
    return { from, to };
  }

  private async account(organizationId: string, code: string) {
    const a = await this.prisma.account.findFirst({ where: { organizationId, code } });
    if (!a) {
      throw new BadRequestException(`Missing GL account ${code} — re-run the seed to add IFRS-15 accounts`);
    }
    return a;
  }

  // ── FIN-05: IFRS-15 percentage of completion (output method) ──────────────

  /**
   * Progress is measured by the output method: value of milestones the customer
   * has certified (VERIFIED or INVOICED) over the total milestone value.
   * Recognized revenue = contract value × progress. The difference between
   * recognized and billed revenue is a contract asset (unbilled) or contract
   * liability (over-billed).
   */
  async poc(user: AuthUser): Promise<PocRow[]> {
    const contracts = await this.prisma.contract.findMany({
      where: { organizationId: user.organizationId, status: { in: ['ACTIVE', 'CLOSED'] } },
      include: {
        customer: { select: { nameAr: true, nameEn: true } },
        milestones: { select: { amount: true, status: true } },
        invoices: {
          where: { status: { in: ['ISSUED', 'CLEARED', 'PAID'] } },
          select: { subtotal: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    if (contracts.length === 0) return [];

    // Signed recognition position already posted per contract:
    // Σ(debit − credit) on the contract-asset and contract-liability accounts.
    const posted = await this.prisma.journalLine.findMany({
      where: {
        account: { organizationId: user.organizationId, code: { in: [CONTRACT_ASSET, CONTRACT_LIABILITY] } },
        journalEntry: {
          sourceType: REVREC_SOURCE,
          sourceId: { in: contracts.map((c) => c.id) },
        },
      },
      select: { debit: true, credit: true, journalEntry: { select: { sourceId: true } } },
    });
    const postedByContract = new Map<string, number>();
    for (const l of posted) {
      const key = l.journalEntry.sourceId;
      postedByContract.set(key, (postedByContract.get(key) ?? 0) + Number(l.debit) - Number(l.credit));
    }

    return contracts.map((c) => {
      const certified = c.milestones
        .filter((m) => m.status === 'VERIFIED' || m.status === 'INVOICED')
        .reduce((s, m) => s + Number(m.amount), 0);
      const contractValue = Number(c.totalValue);
      // Output method: revenue recognized IS the value of work the customer has
      // certified. Progress is measured against the contract value, so a
      // milestone schedule that under-covers the contract cannot inflate it.
      const recognizedRevenue = round2(Math.min(certified, contractValue || certified));
      const progress = contractValue > 0 ? recognizedRevenue / contractValue : 0;
      const billedRevenue = round2(c.invoices.reduce((s, i) => s + Number(i.subtotal), 0));
      const postedAdjustment = round2(postedByContract.get(c.id) ?? 0);
      const targetAdjustment = round2(recognizedRevenue - billedRevenue);
      const unpostedDelta = round2(targetAdjustment - postedAdjustment);
      return {
        contractId: c.id,
        code: c.code,
        customer: c.customer,
        contractValue,
        progressPct: round2(progress * 100),
        recognizedRevenue,
        billedRevenue,
        postedAdjustment,
        targetAdjustment,
        unpostedDelta,
        position:
          targetAdjustment > 0 ? 'CONTRACT_ASSET' : targetAdjustment < 0 ? 'CONTRACT_LIABILITY' : 'BALANCED',
      };
    });
  }

  /**
   * Post the incremental IFRS-15 adjustment for one contract:
   *  - under-billed (recognized > billed): Dr Contract Asset / Cr Revenue
   *  - over-billed  (billed > recognized): Dr Revenue / Cr Contract Liability
   * Re-running after further billing posts only the *delta*, and reverses
   * automatically as billing catches up with recognition.
   */
  async recognize(user: AuthUser, contractId: string) {
    const rows = await this.poc(user);
    const row = rows.find((r) => r.contractId === contractId);
    if (!row) throw new NotFoundException('Contract not found or not active');
    const delta = row.unpostedDelta;
    if (Math.abs(delta) < 0.01) {
      throw new BadRequestException('Nothing to recognize — ledger already matches the IFRS-15 position');
    }

    const [asset, liability, revenue] = await Promise.all([
      this.account(user.organizationId, CONTRACT_ASSET),
      this.account(user.organizationId, CONTRACT_LIABILITY),
      this.account(user.organizationId, REVENUE),
    ]);

    // Current per-account recognition balances for this contract, so a move in
    // the opposite direction unwinds the existing position before opening the
    // other side — IFRS-15 presents a single *net* asset OR liability per contract.
    const recLines = await this.prisma.journalLine.findMany({
      where: {
        accountId: { in: [asset.id, liability.id] },
        journalEntry: { sourceType: REVREC_SOURCE, sourceId: contractId },
      },
      select: { accountId: true, debit: true, credit: true },
    });
    const net = (accountId: string) =>
      recLines
        .filter((l) => l.accountId === accountId)
        .reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0);
    const assetNet = round2(net(asset.id)); // ≥ 0 (net debit)
    const liabilityNet = round2(-net(liability.id)); // ≥ 0 (net credit)

    // delta > 0 → accrue unbilled revenue; delta < 0 → defer over-billed revenue.
    const amount = round2(Math.abs(delta));
    const lines: Array<{ accountId: string; debit: number; credit: number }> = [];
    if (delta > 0) {
      lines.push({ accountId: revenue.id, debit: 0, credit: amount });
      const unwind = round2(Math.min(amount, Math.max(0, liabilityNet)));
      if (unwind > 0) lines.push({ accountId: liability.id, debit: unwind, credit: 0 });
      const rest = round2(amount - unwind);
      if (rest > 0) lines.push({ accountId: asset.id, debit: rest, credit: 0 });
    } else {
      lines.push({ accountId: revenue.id, debit: amount, credit: 0 });
      const unwind = round2(Math.min(amount, Math.max(0, assetNet)));
      if (unwind > 0) lines.push({ accountId: asset.id, debit: 0, credit: unwind });
      const rest = round2(amount - unwind);
      if (rest > 0) lines.push({ accountId: liability.id, debit: 0, credit: rest });
    }

    const entry = await this.prisma.$transaction(async (tx) => {
      const created = await tx.journalEntry.create({
        data: {
          organizationId: user.organizationId,
          sourceType: REVREC_SOURCE,
          sourceId: contractId,
          memo: `IFRS-15 POC adjustment for ${row.code} (progress ${row.progressPct}%)`,
          lines: { create: lines.map((l) => ({ ...l, currency: 'SAR' })) },
        },
        include: { lines: { include: { account: true } } },
      });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'JournalEntry',
          entityId: created.id,
          action: 'REVENUE_RECOGNITION',
          after: { contractId, delta, progressPct: row.progressPct },
        },
        tx,
      );
      return created;
    });

    return { entry, row: { ...row, postedAdjustment: row.targetAdjustment, unpostedDelta: 0 } };
  }

  // ── FIN-03 extension: VAT return (box-style, ZATCA layout) ────────────────

  /**
   * Output VAT from issued tax invoices; input VAT from posted vendor bills
   * (W2 procurement) — both bounded to the same period.
   */
  async vatReturn(user: AuthUser, fromStr?: string, toStr?: string) {
    const now = new Date();
    // Default period: current quarter (typical KSA filing frequency).
    const qStart = new Date(Date.UTC(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) * 3, 1));
    const { from, to } = this.parsePeriod(fromStr, toStr, qStart);

    const [invoices, bills, claims] = await Promise.all([
      this.prisma.invoice.findMany({
        where: {
          organizationId: user.organizationId,
          status: { in: ['ISSUED', 'CLEARED', 'PAID'] },
          issueDate: { gte: from, lte: to },
        },
        select: { subtotal: true, vatAmount: true },
      }),
      this.prisma.vendorBill.findMany({
        where: {
          organizationId: user.organizationId,
          status: { in: ['POSTED', 'PAID'] },
          billDate: { gte: from, lte: to },
        },
        select: { subtotal: true, vatAmount: true },
      }),
      // Approved subcontractor claims carry deductible input VAT too (PRJ-07).
      this.prisma.progressClaim.findMany({
        where: {
          organizationId: user.organizationId,
          status: { in: ['APPROVED', 'PAID'] },
          approvedAt: { gte: from, lte: to },
        },
        select: { claimedAmount: true, vatAmount: true },
      }),
    ]);

    const standardRatedSales = round2(invoices.reduce((s, i) => s + Number(i.subtotal), 0));
    const outputVat = round2(invoices.reduce((s, i) => s + Number(i.vatAmount), 0));
    const standardRatedPurchases = round2(
      bills.reduce((s, b) => s + Number(b.subtotal), 0) +
        claims.reduce((s, c) => s + Number(c.claimedAmount), 0),
    );
    const inputVat = round2(
      bills.reduce((s, b) => s + Number(b.vatAmount), 0) +
        claims.reduce((s, c) => s + Number(c.vatAmount), 0),
    );

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      invoiceCount: invoices.length,
      billCount: bills.length,
      boxes: {
        standardRatedSales, // box 1: standard-rated sales (15%)
        outputVat, // box 1 VAT
        zeroRatedSales: 0, // box 2/3: none yet (exports / zero-rated)
        exemptSales: 0, // box 4
        standardRatedPurchases, // box 7: posted vendor bills
        inputVat, // box 7 VAT (deductible)
      },
      netVatDue: round2(outputVat - inputVat),
    };
  }

  // ── FIN-07: contract profitability ────────────────────────────────────────

  /**
   * Estimated cost comes from the accepted proposal revision's BOM at catalogue
   * unit cost (qty × item.unitCost). Once the contract has a W2 project, the
   * append-only ProjectCostEntry ledger supplies actual cost to date.
   */
  async profitability(user: AuthUser) {
    const contracts = await this.prisma.contract.findMany({
      where: { organizationId: user.organizationId },
      include: {
        customer: { select: { nameAr: true, nameEn: true } },
        proposalRevision: {
          include: { bomLines: { include: { item: { select: { unitCost: true } } } } },
        },
        invoices: {
          where: { status: { in: ['ISSUED', 'CLEARED', 'PAID'] } },
          select: { subtotal: true },
        },
        milestones: { select: { amount: true, status: true } },
        project: { select: { id: true, code: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Actual cost to date per project from the append-only ledger (PRJ-03).
    const projectIds = contracts.map((c) => c.project?.id).filter(Boolean) as string[];
    const actuals = projectIds.length
      ? await this.prisma.projectCostEntry.groupBy({
          by: ['projectId'],
          where: { organizationId: user.organizationId, projectId: { in: projectIds } },
          _sum: { amount: true },
        })
      : [];
    const actualByProject = new Map(actuals.map((a) => [a.projectId, Number(a._sum.amount ?? 0)]));

    return contracts.map((c) => {
      const contractValue = Number(c.totalValue);
      const estCost = round2(
        (c.proposalRevision?.bomLines ?? []).reduce(
          (s, l) => s + Number(l.qty) * Number(l.item.unitCost),
          0,
        ),
      );
      const estMargin = round2(contractValue - estCost);
      const estMarginPct = contractValue > 0 ? round2((estMargin / contractValue) * 100) : 0;
      const billed = round2(c.invoices.reduce((s, i) => s + Number(i.subtotal), 0));
      const certified = c.milestones
        .filter((m) => m.status === 'VERIFIED' || m.status === 'INVOICED')
        .reduce((s, m) => s + Number(m.amount), 0);
      // Same output-method basis as the POC report: certified value ÷ contract value.
      const progressPct = contractValue > 0 ? round2((Math.min(certified, contractValue) / contractValue) * 100) : 0;
      const earnedMargin = round2(estMargin * (progressPct / 100));
      const actualCost = round2(actualByProject.get(c.project?.id ?? '') ?? 0);
      return {
        contractId: c.id,
        code: c.code,
        customer: c.customer,
        status: c.status,
        contractValue,
        estCost,
        estMargin,
        estMarginPct,
        billed,
        progressPct,
        earnedMargin,
        actualCost,
        marginToDate: round2(billed - actualCost), // gross margin on billed vs spent
        projectCode: c.project?.code ?? null,
        costBasis: actualCost > 0 ? ('ACTUAL' as const) : ('BOM_ESTIMATE' as const),
      };
    });
  }

  // ── FIN-01 reporting: trial balance ───────────────────────────────────────

  /**
   * Every account with its opening balance (all journals before the period),
   * the period's debit/credit movement, and the closing balance. Balances are
   * signed debit-positive: Σ(debit − credit). A correct double-entry ledger
   * always yields period debits = period credits and a net closing of zero.
   */
  async trialBalance(user: AuthUser, fromStr?: string, toStr?: string) {
    const { from, to } = this.parsePeriod(fromStr, toStr);
    const organizationId = user.organizationId;

    const [accounts, opening, movement] = await Promise.all([
      this.prisma.account.findMany({ where: { organizationId }, orderBy: { code: 'asc' } }),
      this.prisma.journalLine.groupBy({
        by: ['accountId'],
        where: { journalEntry: { organizationId, postingDate: { lt: from } } },
        _sum: { debit: true, credit: true },
      }),
      this.prisma.journalLine.groupBy({
        by: ['accountId'],
        where: { journalEntry: { organizationId, postingDate: { gte: from, lte: to } } },
        _sum: { debit: true, credit: true },
      }),
    ]);

    const net = (r?: { _sum: { debit: unknown; credit: unknown } }) =>
      round2(Number(r?._sum.debit ?? 0) - Number(r?._sum.credit ?? 0));
    const openingBy = new Map(opening.map((r) => [r.accountId, net(r)]));
    const movementBy = new Map(movement.map((r) => [r.accountId, r]));

    const rows = accounts.map((a) => {
      const m = movementBy.get(a.id);
      const debit = round2(Number(m?._sum.debit ?? 0));
      const credit = round2(Number(m?._sum.credit ?? 0));
      const open = openingBy.get(a.id) ?? 0;
      const closing = round2(open + debit - credit);
      return {
        accountId: a.id,
        code: a.code,
        nameAr: a.nameAr,
        nameEn: a.nameEn,
        accountType: a.accountType,
        opening: open,
        debit,
        credit,
        closing,
        hasActivity: debit !== 0 || credit !== 0 || open !== 0,
      };
    });

    const sum = (pick: (r: (typeof rows)[number]) => number) =>
      round2(rows.reduce((s, r) => s + pick(r), 0));
    const totalDebit = sum((r) => r.debit);
    const totalCredit = sum((r) => r.credit);
    const closingDebit = sum((r) => (r.closing > 0 ? r.closing : 0));
    const closingCredit = sum((r) => (r.closing < 0 ? -r.closing : 0));

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      rows,
      totals: {
        opening: sum((r) => r.opening),
        debit: totalDebit,
        credit: totalCredit,
        closingDebit,
        closingCredit,
      },
      // Both checks must hold; either failing means a journal was written unbalanced.
      isBalanced: Math.abs(totalDebit - totalCredit) < 0.01 && Math.abs(closingDebit - closingCredit) < 0.01,
    };
  }

  // ── FIN-01 reporting: general ledger (per account) ────────────────────────

  /**
   * Journal lines of one account over a period, oldest first, with a running
   * balance that starts from the account's opening balance. Paginated with the
   * house convention (`take`/`skip`); the running balance stays correct across
   * pages because the lines preceding the page are summed first.
   */
  async generalLedger(
    user: AuthUser,
    accountId: string,
    fromStr?: string,
    toStr?: string,
    takeStr?: string,
    skipStr?: string,
  ) {
    const organizationId = user.organizationId;
    const account = await this.prisma.account.findFirst({ where: { id: accountId, organizationId } });
    if (!account) throw new NotFoundException('Account not found');

    const { from, to } = this.parsePeriod(fromStr, toStr);
    const take = Math.min(Math.max(Number(takeStr) || 100, 1), 500);
    const skip = Math.max(Number(skipStr) || 0, 0);
    const where = {
      accountId,
      journalEntry: { organizationId, postingDate: { gte: from, lte: to } },
    };
    // Stable total order: posting date, then id — so pagination never repeats or
    // drops a line when several entries share a date.
    const orderBy = [{ journalEntry: { postingDate: 'asc' as const } }, { id: 'asc' as const }];

    const [openingAgg, periodAgg, total, prior, lines] = await Promise.all([
      this.prisma.journalLine.aggregate({
        where: { accountId, journalEntry: { organizationId, postingDate: { lt: from } } },
        _sum: { debit: true, credit: true },
      }),
      this.prisma.journalLine.aggregate({ where, _sum: { debit: true, credit: true } }),
      this.prisma.journalLine.count({ where }),
      skip > 0
        ? this.prisma.journalLine.findMany({
            where,
            orderBy,
            take: skip,
            select: { debit: true, credit: true },
          })
        : Promise.resolve([]),
      this.prisma.journalLine.findMany({
        where,
        orderBy,
        take,
        skip,
        include: {
          journalEntry: {
            select: {
              id: true,
              postingDate: true,
              sourceType: true,
              sourceId: true,
              memo: true,
              isReversal: true,
              invoice: { select: { code: true } },
            },
          },
        },
      }),
    ]);

    const opening = round2(Number(openingAgg._sum.debit ?? 0) - Number(openingAgg._sum.credit ?? 0));
    let balance = round2(
      opening + prior.reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0),
    );
    const pageOpening = balance;

    const rows = lines.map((l) => {
      const debit = round2(Number(l.debit));
      const credit = round2(Number(l.credit));
      balance = round2(balance + debit - credit);
      return {
        id: l.id,
        entryId: l.journalEntry.id,
        postingDate: l.journalEntry.postingDate.toISOString(),
        sourceType: l.journalEntry.sourceType,
        sourceId: l.journalEntry.sourceId,
        memo: l.journalEntry.memo,
        isReversal: l.journalEntry.isReversal,
        invoiceCode: l.journalEntry.invoice?.code ?? null,
        debit,
        credit,
        balance,
      };
    });

    return {
      account: {
        id: account.id,
        code: account.code,
        nameAr: account.nameAr,
        nameEn: account.nameEn,
        accountType: account.accountType,
      },
      period: { from: from.toISOString(), to: to.toISOString() },
      opening, // balance carried into the period
      pageOpening, // balance carried into this page
      // Closing is the whole period's, not this page's — the header must show the
      // same number the trial balance does regardless of which page is open.
      closing: round2(
        opening +
          Number(periodAgg._sum.debit ?? 0) -
          Number(periodAgg._sum.credit ?? 0),
      ),
      periodDebit: round2(Number(periodAgg._sum.debit ?? 0)),
      periodCredit: round2(Number(periodAgg._sum.credit ?? 0)),
      rows,
      total,
    };
  }
}
