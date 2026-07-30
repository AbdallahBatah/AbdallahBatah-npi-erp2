import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { Prisma } from '@npi/db';

interface NotifyInput {
  organizationId: string;
  /** Recipients = active users whose role holds this permission. */
  permission: string;
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
  constructor(private readonly prisma: PrismaService) {}

  async notify(input: NotifyInput, tx?: Prisma.TransactionClient): Promise<number> {
    const client = tx ?? this.prisma;
    const recipients = await client.user.findMany({
      where: {
        organizationId: input.organizationId,
        isActive: true,
        ...(input.excludeUserId ? { id: { not: input.excludeUserId } } : {}),
        role: { permissions: { has: input.permission } },
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
