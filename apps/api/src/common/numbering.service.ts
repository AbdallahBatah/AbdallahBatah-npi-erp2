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

    const seq = await client.numberingSequence.findUnique({
      where: {
        organizationId_documentType_fiscalYear: {
          organizationId,
          documentType,
          fiscalYear,
        },
      },
    });

    if (!seq) {
      throw new InternalServerErrorException(
        `No numbering sequence configured for ${documentType} (${fiscalYear}).`,
      );
    }

    const updated = await client.numberingSequence.update({
      where: { id: seq.id },
      data: { nextValue: { increment: 1 } },
    });

    const value = updated.nextValue - 1;
    return `${seq.prefix}-${String(value).padStart(seq.padding, '0')}`;
  }
}
