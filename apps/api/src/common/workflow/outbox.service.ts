import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { Prisma } from '@npi/db';

export interface OutboxWrite {
  organizationId: string;
  eventCode: string;
  payload: Record<string, unknown>;
}

/**
 * The Outbox — §6 of the architecture.
 *
 * The one rule that gives it its value: an event is written *inside the same
 * transaction* as the state change it describes. Not after it, not by a
 * listener, not best-effort. That is why "PO approved but no commitment
 * booked" cannot happen: either both rows commit or neither does, and a
 * dispatcher that crashes mid-handler leaves a PENDING row it will pick up
 * again rather than a consequence that silently never happened.
 *
 * `emit` therefore *requires* a transaction client. There is no convenience
 * overload that writes outside one, because that overload is precisely the
 * mistake this pattern exists to prevent.
 */
@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(private readonly prisma: PrismaService) {}

  async emit(tx: Prisma.TransactionClient, write: OutboxWrite): Promise<string> {
    const row = await tx.domainEvent.create({
      data: {
        organizationId: write.organizationId,
        eventCode: write.eventCode,
        payloadJson: write.payload as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return row.id;
  }

  /** Operational read for the admin screen: what is stuck, and why. */
  failed(organizationId: string, take = 50) {
    return this.prisma.domainEvent.findMany({
      where: { organizationId, status: 'FAILED' },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  /**
   * Put a FAILED event back in the queue. Deliberately manual: an event that
   * exhausted its retries failed for a reason, and re-queueing it before that
   * reason is fixed just burns the retry budget again.
   */
  async requeue(organizationId: string, eventId: string): Promise<boolean> {
    const { count } = await this.prisma.domainEvent.updateMany({
      where: { id: eventId, organizationId, status: 'FAILED' },
      data: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), lastError: null },
    });
    if (count > 0) this.logger.log(`Requeued domain event ${eventId}`);
    return count > 0;
  }
}
