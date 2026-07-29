import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { Prisma } from '@npi/db';

/**
 * Gapless statutory document numbering, scoped per organization + fiscal year.
 * Uses an atomic UPDATE ... RETURNING inside the caller's transaction so two
 * concurrent requests can never receive the same number.
 */
@Injectable()
export class NumberingService {
  constructor(private readonly prisma: PrismaService) {}

  async next(
    organizationId: string,
    documentType: string,
    tx?: Prisma.TransactionClient,
  ): Promise<string> {
    const client = tx ?? this.prisma;
    const fiscalYear = new Date().getUTCFullYear();

    // Single atomic UPDATE ... RETURNING on the composite key: two concurrent
    // callers each get their own increment — no read-then-write window.
    let updated;
    try {
      updated = await client.numberingSequence.update({
        where: {
          organizationId_documentType_fiscalYear: {
            organizationId,
            documentType,
            fiscalYear,
          },
        },
        data: { nextValue: { increment: 1 } },
      });
    } catch {
      throw new InternalServerErrorException(
        `No numbering sequence configured for ${documentType} (${fiscalYear}).`,
      );
    }

    const value = updated.nextValue - 1;
    return `${updated.prefix}-${String(value).padStart(updated.padding, '0')}`;
  }
}
