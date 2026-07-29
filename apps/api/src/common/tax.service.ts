import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { Prisma } from '@npi/db';

/**
 * Resolves tax rates from the `TaxCode` table instead of a hardcoded constant.
 *
 * Three modules each carried their own `const VAT_RATE = 15`, so the rate
 * Saudi Arabia charges was baked into the build in three places while a
 * perfectly good TaxCode table sat unused. A rate change (or a customer on a
 * different rate) now needs a data edit, not a release.
 */
@Injectable()
export class TaxService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The organization's standard-rated VAT code.
   * Fail-closed: a missing code means tax settings were never configured, and
   * silently charging 0% would understate a statutory liability.
   */
  async standardVat(
    organizationId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<{ id: string; rate: number }> {
    const client = tx ?? this.prisma;
    const code = await client.taxCode.findFirst({
      where: { organizationId, taxType: 'VAT_STANDARD' },
      orderBy: { code: 'asc' },
    });
    if (!code) {
      throw new InternalServerErrorException(
        'Missing standard VAT tax code — configure tax settings',
      );
    }
    return { id: code.id, rate: Number(code.rate) };
  }
}
