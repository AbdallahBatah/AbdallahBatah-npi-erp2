import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Prisma, PrismaClient } from '@npi/db';

/** Prisma's code for "could not serialize access" / deadlock (SQLSTATE 40001). */
const WRITE_CONFLICT = 'P2034';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * A serializable transaction that retries when PostgreSQL refuses to
   * serialize it.
   *
   * Serializable isolation does not queue conflicting transactions — it lets
   * them run and aborts the loser at commit. That abort is not a failure of the
   * operation, it is the database asking for the operation to be performed
   * again, and an application that does not ask again turns a correct database
   * into a broken feature. Measured on this codebase: two invoices issued in
   * the same instant left one CLEARED and the other DRAFT behind an opaque 500,
   * because the conflict propagated as an unhandled error.
   *
   * The retry lives here rather than at the two call sites for the same reason
   * the credit-note sign lives in the aggregator: a rule written at each call
   * site is a rule that the next call site forgets. Every serializable
   * transaction in this codebase goes through this method, so the next one to
   * be written inherits the retry instead of rediscovering the bug.
   *
   * Only `P2034` is retried. Any other error — a validation failure, a unique
   * violation, a closed period — means the work itself was wrong, and running
   * it again would only produce the same answer more slowly.
   *
   * The callback must confine its effects to `tx`, since it may run more than
   * once. Anything that must happen exactly once (notifications, external
   * calls) belongs after this method returns.
   */
  async serializable<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options: { attempts?: number; label?: string } = {},
  ): Promise<T> {
    const attempts = options.attempts ?? 4;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this.$transaction(fn, { isolationLevel: 'Serializable' });
      } catch (error) {
        const conflict =
          error instanceof Prisma.PrismaClientKnownRequestError && error.code === WRITE_CONFLICT;
        if (!conflict || attempt === attempts) throw error;

        lastError = error;
        // Backoff with jitter: two transactions that retry in lockstep would
        // collide again on the same schedule.
        const backoffMs = 10 * 2 ** (attempt - 1) + Math.floor(Math.random() * 15);
        this.logger.warn(
          `Write conflict on ${options.label ?? 'serializable transaction'} — ` +
            `retrying (${attempt}/${attempts - 1}) in ${backoffMs}ms`,
        );
        await sleep(backoffMs);
      }
    }

    // Unreachable: the final attempt either returns or throws above.
    throw lastError;
  }
}
