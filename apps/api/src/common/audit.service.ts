import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { Prisma } from '@npi/db';

interface AuditInput {
  organizationId: string;
  actorId?: string | null;
  entityType: string;
  entityId: string;
  action: string;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
}

/**
 * Writes the append-only audit trail. Every financial/contractual mutation
 * calls this. Records are never updated or deleted — corrections are new rows.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: AuditInput, tx?: Prisma.TransactionClient): Promise<void> {
    const client = tx ?? this.prisma;
    await client.auditLog.create({
      data: {
        organizationId: input.organizationId,
        actorId: input.actorId ?? null,
        entityType: input.entityType,
        entityId: input.entityId,
        action: input.action,
        beforeJson: (input.before ?? undefined) as Prisma.InputJsonValue | undefined,
        afterJson: (input.after ?? undefined) as Prisma.InputJsonValue | undefined,
        ip: input.ip ?? null,
      },
    });
  }
}
