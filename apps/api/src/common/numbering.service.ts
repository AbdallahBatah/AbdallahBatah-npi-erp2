import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@npi/db';

/** Prisma's code for "the WHERE of an update/delete matched no row". */
const RECORD_NOT_FOUND = 'P2025';

type Client = Prisma.TransactionClient | PrismaService;

/**
 * Gapless statutory document numbering, scoped per organization + fiscal year.
 * Uses an atomic UPDATE ... RETURNING inside the caller's transaction so two
 * concurrent requests can never receive the same number.
 *
 * Numbering is continuous across years, not reset per year: the produced code
 * carries no year component and every business table's uniqueness is keyed on
 * the code alone, so a new year must pick up where the previous one left off
 * rather than restart from 1 (which would regenerate an already-issued code).
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

    const notConfigured = () =>
      new InternalServerErrorException(
        `No numbering sequence configured for ${documentType} (${fiscalYear}).`,
      );

    // Single atomic UPDATE ... RETURNING on the composite key: two concurrent
    // callers each get their own increment — no read-then-write window.
    let updated;
    try {
      updated = await this.increment(client, organizationId, documentType, fiscalYear);
    } catch (error) {
      // A missing row for THIS year only means the type has never been used
      // in this year yet — it does not mean it was never configured. Any
      // other failure keeps today's behaviour unchanged.
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== RECORD_NOT_FOUND
      ) {
        throw notConfigured();
      }

      await this.openFiscalYear(client, organizationId, documentType, fiscalYear);

      try {
        updated = await this.increment(client, organizationId, documentType, fiscalYear);
      } catch {
        // Still no row after trying to open the year: no earlier year exists
        // either, so the type was genuinely never configured.
        throw notConfigured();
      }
    }

    const value = updated.nextValue - 1;
    return `${updated.prefix}-${String(value).padStart(updated.padding, '0')}`;
  }

  private increment(
    client: Client,
    organizationId: string,
    documentType: string,
    fiscalYear: number,
  ) {
    return client.numberingSequence.update({
      where: {
        organizationId_documentType_fiscalYear: {
          organizationId,
          documentType,
          fiscalYear,
        },
      },
      data: { nextValue: { increment: 1 } },
    });
  }

  /**
   * Opens the current fiscal year's row on demand by carrying forward
   * `prefix`, `padding` and `nextValue` from the most recent earlier year of
   * the same (organizationId, documentType). Codes already issued must stay
   * untouched, so this only ever inserts a new row — it never rewrites an
   * earlier year.
   *
   * `FOR UPDATE` locks the source row, serializing against an old-year
   * increment still in flight at the boundary, so the carried-forward
   * `nextValue` is the committed one. `ON CONFLICT DO NOTHING` lets two
   * first-of-the-year callers race here without aborting each other's
   * transaction — in PostgreSQL any statement error poisons the whole
   * transaction, and whichever caller loses the race simply finds the row
   * already there when it retries the increment above.
   */
  private async openFiscalYear(
    client: Client,
    organizationId: string,
    documentType: string,
    fiscalYear: number,
  ): Promise<void> {
    await client.$executeRaw`
      WITH prev AS (
        SELECT "organizationId", "documentType", "prefix", "nextValue", "padding"
        FROM "NumberingSequence"
        WHERE "organizationId" = ${organizationId}
          AND "documentType" = ${documentType}
          AND "fiscalYear" < ${fiscalYear}
        ORDER BY "fiscalYear" DESC
        LIMIT 1
        FOR UPDATE
      )
      INSERT INTO "NumberingSequence" ("id", "organizationId", "documentType", "prefix", "nextValue", "fiscalYear", "padding")
      SELECT ${randomUUID()}, "organizationId", "documentType", "prefix", "nextValue", ${fiscalYear}, "padding" FROM prev
      ON CONFLICT ("organizationId", "documentType", "fiscalYear") DO NOTHING
    `;
  }
}
