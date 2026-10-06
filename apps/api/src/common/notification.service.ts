import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { Prisma } from '@npi/db';

interface NotifyInput {
  organizationId: string;
  /** Recipients = active users whose role holds this permission. */
  permission: string;
  /**
   * Narrows the fan-out to a single role. The approval matrix needs it: "the
   * finance role must sign next" is not the same audience as "everyone who can
   * read invoices", and telling the wrong half of the company to go approve
   * something they cannot approve trains people to ignore the bell.
   */
  roleId?: string | null;
  /** The actor is never notified about their own action. */
  excludeUserId?: string | null;
  type: string;
  titleAr: string;
  titleEn: string;
  bodyAr?: string;
  bodyEn?: string;
  linkPath?: string;
}

/**
 * Writes in-app notifications. Fan-out is permission-based: "everyone who can
 * read invoices" rather than a hand-kept recipient list, so new users/roles
 * start receiving the right events with zero extra wiring.
 *
 * Callers inside a posting transaction pass `tx` so a rolled-back document
 * never leaves a ghost notification behind.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Best-effort variant for AFTER a transaction has committed: the business
   * operation already succeeded, so a notification hiccup must never turn a
   * posted invoice into a 500 (and bait the caller into retrying it).
   * Inside a transaction, use notify(input, tx) — there, failing together is
   * the point.
   */
  async notifyBestEffort(input: NotifyInput): Promise<number> {
    try {
      return await this.notify(input);
    } catch (err) {
      this.logger.error(
        `Notification fan-out failed (type=${input.type}, org=${input.organizationId})`,
        err instanceof Error ? err.stack : String(err),
      );
      return 0;
    }
  }

  async notify(input: NotifyInput, tx?: Prisma.TransactionClient): Promise<number> {
    const client = tx ?? this.prisma;
    const recipients = await client.user.findMany({
      where: {
        organizationId: input.organizationId,
        isActive: true,
        ...(input.excludeUserId ? { id: { not: input.excludeUserId } } : {}),
        // Primary role OR an extra role (UserRole) — either may carry the
        // permission, and either may be the role the notification targets.
        OR: [
          {
            ...(input.roleId ? { roleId: input.roleId } : {}),
            role: { permissions: { has: input.permission } },
          },
          {
            extraRoles: {
              some: {
                ...(input.roleId ? { roleId: input.roleId } : {}),
                role: { permissions: { has: input.permission } },
              },
            },
          },
        ],
      },
      select: { id: true },
    });
    if (recipients.length === 0) return 0;
    const { count } = await client.notification.createMany({
      data: recipients.map((r) => ({
        organizationId: input.organizationId,
        userId: r.id,
        type: input.type,
        titleAr: input.titleAr,
        titleEn: input.titleEn,
        bodyAr: input.bodyAr ?? null,
        bodyEn: input.bodyEn ?? null,
        linkPath: input.linkPath ?? null,
      })),
    });
    return count;
  }
}
