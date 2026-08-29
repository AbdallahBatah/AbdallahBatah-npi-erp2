import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../common/audit.service';
import type { AuthUser } from '../../common/auth-user';
import { DIRECTORY_SELECT } from './departments.service';
import type { CreateDelegationDto } from './structure.dto';

const DELEGATION_INCLUDE = {
  fromUser: {
    select: {
      id: true,
      nameAr: true,
      nameEn: true,
      isActive: true,
      role: { select: { id: true, nameAr: true, nameEn: true } },
    },
  },
  toUser: { select: { id: true, nameAr: true, nameEn: true, isActive: true } },
  createdBy: { select: { id: true, nameAr: true, nameEn: true } },
} as const;

/**
 * What the list shows in the status column. Derived, never stored: a window
 * that has passed is expired whatever the flag says, and storing it would mean
 * a nightly job whose failure silently keeps authority alive.
 */
export type DelegationState = 'ACTIVE' | 'SCHEDULED' | 'EXPIRED' | 'REVOKED';

export const delegationState = (
  row: { isActive: boolean; startsAt: Date; endsAt: Date },
  at: Date = new Date(),
): DelegationState => {
  if (!row.isActive) return 'REVOKED';
  if (row.endsAt < at) return 'EXPIRED';
  if (row.startsAt > at) return 'SCHEDULED';
  return 'ACTIVE';
};

/**
 * Administration of temporary delegations. The *use* of a delegation lives in
 * the kernel (common/delegation.service.ts) and is untouched here — this class
 * only creates and revokes the rows it reads.
 *
 * The rules it enforces, and why each one is not a formality:
 *
 *  - **No self-delegation.** Lending yourself your own role is a no-op that
 *    reads, in the audit trail, exactly like a real transfer of authority.
 *  - **A real window.** `endsAt > startsAt`, and a window already in the past
 *    is refused: a delegation that can never be used is either a typo or an
 *    attempt to paper over a signature that already happened.
 *  - **No overlap for the same pair.** Two overlapping rows lend the same role
 *    twice; revoking one then leaves the authority quietly standing, which is
 *    the failure mode an administrator is least likely to check for.
 *  - **Both parties active.** A departed employee's authority must not outlive
 *    them, and a deactivated delegate cannot sign anyway.
 *
 * Two things it deliberately does *not* do. It does not refuse a delegation
 * from someone who is already a delegate: delegation does not chain, so B→C
 * lends C nothing but B's own role, and refusing it would be theatre. And it
 * does not check who raised which document — the self-approval and
 * delegated-self-approval guards live at the moment of signing, in
 * ApprovalService.decide, where the document is known.
 */
@Injectable()
export class DelegationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(user: AuthUser) {
    const rows = await this.prisma.approvalDelegation.findMany({
      where: { organizationId: user.organizationId },
      include: DELEGATION_INCLUDE,
      orderBy: [{ startsAt: 'desc' }],
    });
    const now = new Date();
    return rows.map((r) => ({ ...r, state: delegationState(r, now) }));
  }

  /** People picker for both ends of a delegation. */
  directory(user: AuthUser) {
    return this.prisma.user.findMany({
      where: { organizationId: user.organizationId },
      select: DIRECTORY_SELECT,
      orderBy: [{ isActive: 'desc' }, { nameAr: 'asc' }],
    });
  }

  async create(user: AuthUser, dto: CreateDelegationDto) {
    if (dto.fromUserId === dto.toUserId) {
      throw new BadRequestException('A user cannot delegate to themselves');
    }

    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    if (isNaN(+startsAt) || isNaN(+endsAt)) {
      throw new BadRequestException('Invalid startsAt/endsAt date');
    }
    if (endsAt <= startsAt) {
      throw new BadRequestException('endsAt must be after startsAt');
    }
    if (endsAt <= new Date()) {
      throw new BadRequestException('This delegation window has already passed');
    }

    const [from, to] = await Promise.all([
      this.assertOwnedActiveUser(user, dto.fromUserId),
      this.assertOwnedActiveUser(user, dto.toUserId),
    ]);

    await this.assertNoOverlap(user.organizationId, dto.fromUserId, dto.toUserId, startsAt, endsAt);

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.approvalDelegation.create({
        data: {
          organizationId: user.organizationId,
          fromUserId: from.id,
          toUserId: to.id,
          startsAt,
          endsAt,
          reason: dto.reason?.trim() || null,
          createdById: user.userId,
        },
        include: DELEGATION_INCLUDE,
      });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'ApprovalDelegation',
          entityId: created.id,
          action: 'CREATE',
          after: {
            fromUserId: from.id,
            toUserId: to.id,
            startsAt: startsAt.toISOString(),
            endsAt: endsAt.toISOString(),
            reason: created.reason,
          },
        },
        tx,
      );
      return { ...created, state: delegationState(created) };
    });
  }

  /**
   * End a delegation early. The window is left exactly as it was granted and
   * only the flag moves: the row is evidence of what was handed over and for
   * how long, and rewriting `endsAt` would edit that evidence after the fact.
   */
  async revoke(user: AuthUser, id: string) {
    const row = await this.prisma.approvalDelegation.findFirst({
      where: { id, organizationId: user.organizationId },
      include: DELEGATION_INCLUDE,
    });
    if (!row) throw new NotFoundException('Delegation not found');
    if (!row.isActive) throw new BadRequestException('This delegation is already revoked');

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.approvalDelegation.update({
        where: { id },
        data: { isActive: false },
        include: DELEGATION_INCLUDE,
      });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'ApprovalDelegation',
          entityId: id,
          action: 'REVOKE',
          before: { isActive: true, endsAt: row.endsAt.toISOString() },
          after: { isActive: false, revokedAt: new Date().toISOString() },
        },
        tx,
      );
      return { ...updated, state: delegationState(updated) };
    });
  }

  // ── guards ────────────────────────────────────────────────────────────────

  private async assertOwnedActiveUser(user: AuthUser, userId: string) {
    const target = await this.prisma.user.findFirst({
      where: { id: userId, organizationId: user.organizationId },
      select: { id: true, isActive: true, nameAr: true },
    });
    if (!target) throw new NotFoundException('User not found');
    if (!target.isActive) {
      throw new BadRequestException('A deactivated user cannot give or receive a delegation');
    }
    return target;
  }

  /**
   * Half-open windows: two delegations touching end-to-start do not overlap,
   * so a holiday ending the day the next one begins is expressible.
   */
  private async assertNoOverlap(
    organizationId: string,
    fromUserId: string,
    toUserId: string,
    startsAt: Date,
    endsAt: Date,
  ) {
    const clash = await this.prisma.approvalDelegation.findFirst({
      where: {
        organizationId,
        fromUserId,
        toUserId,
        isActive: true,
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
      },
    });
    if (clash) {
      throw new BadRequestException(
        'An active delegation between these two users already covers part of this period',
      );
    }
  }
}
