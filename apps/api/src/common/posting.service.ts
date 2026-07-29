import { BadRequestException, Injectable, InternalServerErrorException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { Prisma, PostingPurpose } from '@npi/db';

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export interface JournalLineInput {
  accountId: string;
  debit: number;
  credit: number;
  currency?: string;
}

export interface JournalInput {
  organizationId: string;
  sourceType: string;
  sourceId: string;
  memo?: string;
  invoiceId?: string | null;
  projectId?: string | null;
  postingDate?: Date;
  lines: JournalLineInput[];
}

/**
 * Resolves a posting *purpose* to the GL account that purpose is mapped to.
 *
 * Automatic journals used to name accounts by hardcoded code strings ('1100',
 * '2000', ...), which pinned every organization to the seeded chart of
 * accounts. Posting code now asks for AR / AP / REVENUE / ... and the
 * AccountMapping table answers, so a customer can repoint any purpose at its
 * own COA without a code change.
 *
 * Fail-closed: a missing mapping is a configuration fault, not a user error —
 * it throws rather than silently skipping a journal line and leaving the ledger
 * unbalanced.
 */
@Injectable()
export class PostingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * @returns purpose → accountId for every requested purpose.
   * @throws if any requested purpose has no mapping in this organization.
   */
  async accounts<P extends PostingPurpose>(
    organizationId: string,
    purposes: readonly P[],
    tx?: Prisma.TransactionClient,
  ): Promise<Record<P, string>> {
    const client = tx ?? this.prisma;
    const rows = await client.accountMapping.findMany({
      where: { organizationId, purpose: { in: purposes as unknown as PostingPurpose[] } },
      select: { purpose: true, accountId: true },
    });

    const map = {} as Record<P, string>;
    for (const row of rows) map[row.purpose as P] = row.accountId;

    const missing = purposes.filter((p) => !map[p]);
    if (missing.length > 0) {
      throw new InternalServerErrorException(
        `Missing posting rule for ${missing.join(', ')} — configure the account mapping`,
      );
    }
    return map;
  }

  /** Single-purpose convenience wrapper. */
  async account(
    organizationId: string,
    purpose: PostingPurpose,
    tx?: Prisma.TransactionClient,
  ): Promise<string> {
    const map = await this.accounts(organizationId, [purpose], tx);
    return map[purpose];
  }

  // ── The one door into the general ledger ──────────────────────────────────

  /**
   * Writes a journal entry. Every automatic posting goes through here rather
   * than calling `journalEntry.create` directly, so the two invariants that
   * matter are checked in one place instead of nine: the entry balances, and
   * its period is still open.
   */
  async journal(tx: Prisma.TransactionClient, input: JournalInput) {
    if (input.lines.length === 0) {
      throw new InternalServerErrorException('Journal has no lines');
    }
    const postingDate = input.postingDate ?? new Date();
    await this.assertPeriodOpen(input.organizationId, postingDate, tx);

    const dr = round2(input.lines.reduce((s, l) => s + l.debit, 0));
    const cr = round2(input.lines.reduce((s, l) => s + l.credit, 0));
    if (dr !== cr) {
      throw new BadRequestException(`Journal not balanced: Dr ${dr} != Cr ${cr}`);
    }

    return tx.journalEntry.create({
      data: {
        organizationId: input.organizationId,
        postingDate,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        memo: input.memo,
        invoiceId: input.invoiceId ?? null,
        projectId: input.projectId ?? null,
        lines: {
          create: input.lines.map((l) => ({
            accountId: l.accountId,
            debit: l.debit,
            credit: l.credit,
            currency: l.currency ?? 'SAR',
          })),
        },
      },
      include: { lines: { include: { account: true } } },
    });
  }

  /**
   * Refuses a posting whose date falls in a closed period or a closed year.
   *
   * Permissive when no period covers the date: an organization that has not
   * set up a fiscal calendar keeps posting exactly as before. Closing is
   * opt-in, and only what has been explicitly closed is locked.
   */
  async assertPeriodOpen(organizationId: string, date: Date, tx?: Prisma.TransactionClient) {
    const client = tx ?? this.prisma;
    const period = await client.fiscalPeriod.findFirst({
      where: { organizationId, startDate: { lte: date }, endDate: { gte: date } },
      include: { fiscalYear: { select: { year: true, status: true } } },
    });
    if (!period) return;
    if (period.status === 'CLOSED' || period.fiscalYear.status === 'CLOSED') {
      const label = `${period.fiscalYear.year}-${String(period.month).padStart(2, '0')}`;
      throw new BadRequestException(`Accounting period ${label} is closed`);
    }
  }
}
