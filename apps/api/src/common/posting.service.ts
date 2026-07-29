import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { Prisma, PostingPurpose } from '@npi/db';

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
}
