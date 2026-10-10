import { daysOverdue, taskDueState, type TaskDueState } from '@npi/shared';
import type { Prisma } from '@npi/db';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * The shapes the communication log and the follow-up tasks are served in — by their own
 * endpoints and by the customer overview — kept in one place so the two cannot drift.
 */

const PERSON = { select: { id: true, nameAr: true, nameEn: true } } as const;

/** A log entry with its author, the person it was with and the opportunity it concerns. */
export const ACTIVITY_INCLUDE = {
  createdBy: PERSON,
  contact: { select: { id: true, name: true } },
  opportunity: { select: { id: true, code: true, name: true } },
} satisfies Prisma.ActivityInclude;

/** A task with the customer, the opportunity and the people who touched it. */
export const TASK_INCLUDE = {
  customer: { select: { id: true, code: true, nameAr: true, nameEn: true } },
  opportunity: { select: { id: true, code: true, name: true } },
  assignee: PERSON,
  createdBy: PERSON,
  completedBy: PERSON,
} satisfies Prisma.FollowUpTaskInclude;

type Db = Prisma.TransactionClient | PrismaService;

/**
 * Adds `attachmentsCount` to each entry — one grouped query for the whole page, not one
 * per entry. Files hang off an entry as `Attachment` rows of entityType ACTIVITY.
 */
export async function withAttachmentCounts<T extends { id: string }>(
  db: Db,
  organizationId: string,
  rows: T[],
): Promise<Array<T & { attachmentsCount: number }>> {
  if (rows.length === 0) return [];
  const groups = await db.attachment.groupBy({
    by: ['entityId'],
    where: { organizationId, entityType: 'ACTIVITY', entityId: { in: rows.map((r) => r.id) } },
    _count: { _all: true },
  });
  const counts = new Map(groups.map((g) => [g.entityId, g._count._all]));
  return rows.map((r) => ({ ...r, attachmentsCount: counts.get(r.id) ?? 0 }));
}

/**
 * Adds the due state and the days late. Only an OPEN task has them: a finished or a
 * cancelled one is not "late", whatever its date says.
 */
export function withDueState<T extends { status: string; dueAt: Date }>(
  row: T,
  now: Date = new Date(),
): T & { dueState: TaskDueState | null; daysOverdue: number } {
  if (row.status !== 'OPEN') return { ...row, dueState: null, daysOverdue: 0 };
  return { ...row, dueState: taskDueState(row.dueAt, now), daysOverdue: daysOverdue(row.dueAt, now) };
}
