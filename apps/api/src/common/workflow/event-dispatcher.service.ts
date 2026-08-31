import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { nextRetryDelayMinutes } from '@npi/shared';
import type { Prisma } from '@npi/db';

export interface DomainEventPayload {
  documentType: string;
  documentId: string;
  documentCode: string;
  fromState: string;
  toState: string;
  actorId: string | null;
  [key: string]: unknown;
}

export interface DomainEventEnvelope {
  id: string;
  organizationId: string;
  eventCode: string;
  payload: DomainEventPayload;
  attempts: number;
}

/**
 * A subscriber. Handlers must be idempotent: the dispatcher's guarantee is
 * at-least-once, not exactly-once, and a handler that crashes after doing half
 * its work will be called again with the same event.
 */
export type DomainEventHandler = (event: DomainEventEnvelope) => Promise<void>;

/**
 * Drains the outbox — §6 of the architecture.
 *
 * Runs on a timer rather than in-process after commit, on purpose: an
 * in-process dispatch dies with the request that scheduled it, so a restart
 * between commit and dispatch would lose the consequence. Reading the table is
 * the only way the promise "يستحيل ضياع أثر" survives a crash.
 *
 * Failure handling has one rule worth stating: an event that exhausts its
 * retries is marked FAILED and *kept*, with its error. It is never silently
 * dropped, because the whole point of the outbox is that a missing journal
 * entry or an unbooked commitment must be visible to somebody.
 */
@Injectable()
export class EventDispatcher implements OnApplicationBootstrap {
  private readonly logger = new Logger(EventDispatcher.name);
  private readonly handlers = new Map<string, Array<{ name: string; run: DomainEventHandler }>>();
  /** One drain at a time. Two overlapping runs would double-deliver. */
  private draining = false;

  constructor(private readonly prisma: PrismaService) {}

  /** Called from each owning module's onModuleInit. */
  on(eventCode: string, name: string, run: DomainEventHandler): void {
    const list = this.handlers.get(eventCode) ?? [];
    list.push({ name, run });
    this.handlers.set(eventCode, list);
  }

  onApplicationBootstrap(): void {
    const registered = [...this.handlers.entries()]
      .map(([code, hs]) => `${code}×${hs.length}`)
      .join(', ');
    this.logger.log(`Outbox dispatcher ready — subscribers: ${registered || 'none'}`);
  }

  @Cron(CronExpression.EVERY_30_SECONDS, { name: 'drain-domain-events' })
  async scheduledDrain(): Promise<void> {
    try {
      await this.drain();
    } catch (err) {
      // A cron handler that rejects becomes an unhandledRejection — nothing up
      // the stack catches it. Survive; the next tick tries again.
      this.logger.error(
        'Outbox drain failed',
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /**
   * Process everything currently due. Returns what happened, so a test — and
   * the admin screen — can assert on it rather than on log lines.
   */
  async drain(batchSize = 50): Promise<{ processed: number; failed: number; retried: number }> {
    if (this.draining) return { processed: 0, failed: 0, retried: 0 };
    this.draining = true;
    try {
      const due = await this.prisma.domainEvent.findMany({
        where: { status: 'PENDING', nextAttemptAt: { lte: new Date() } },
        orderBy: { createdAt: 'asc' },
        take: batchSize,
      });

      let processed = 0;
      let failed = 0;
      let retried = 0;
      for (const row of due) {
        const outcome = await this.deliver(row);
        if (outcome === 'processed') processed += 1;
        else if (outcome === 'failed') failed += 1;
        else retried += 1;
      }
      return { processed, failed, retried };
    } finally {
      this.draining = false;
    }
  }

  private async deliver(row: {
    id: string;
    organizationId: string;
    eventCode: string;
    payloadJson: Prisma.JsonValue;
    attempts: number;
  }): Promise<'processed' | 'retried' | 'failed'> {
    const subscribers = this.handlers.get(row.eventCode) ?? [];
    const envelope: DomainEventEnvelope = {
      id: row.id,
      organizationId: row.organizationId,
      eventCode: row.eventCode,
      payload: row.payloadJson as unknown as DomainEventPayload,
      attempts: row.attempts,
    };

    try {
      // An event nobody subscribes to is not an error — flows emit what
      // happened, and a consumer may simply not exist yet. It is recorded as
      // processed so it stops being retried, and the count above still shows it.
      for (const s of subscribers) {
        await s.run(envelope);
      }
      await this.prisma.domainEvent.update({
        where: { id: row.id },
        data: {
          status: 'PROCESSED',
          attempts: row.attempts + 1,
          processedAt: new Date(),
          lastError: null,
        },
      });
      return 'processed';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = row.attempts + 1;
      const delay = nextRetryDelayMinutes(attempts);

      if (delay === null) {
        await this.prisma.domainEvent.update({
          where: { id: row.id },
          data: { status: 'FAILED', attempts, lastError: message.slice(0, 1000) },
        });
        this.logger.error(
          `Domain event ${row.eventCode} (${row.id}) failed permanently after ${attempts} attempts: ${message}`,
        );
        return 'failed';
      }

      await this.prisma.domainEvent.update({
        where: { id: row.id },
        data: {
          attempts,
          lastError: message.slice(0, 1000),
          nextAttemptAt: new Date(Date.now() + delay * 60_000),
        },
      });
      this.logger.warn(
        `Domain event ${row.eventCode} (${row.id}) attempt ${attempts} failed, retrying in ${delay}m: ${message}`,
      );
      return 'retried';
    }
  }
}
