import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface ActiveDelegation {
  id: string;
  fromUserId: string;
  fromUserName: string;
  /** The role being lent. This is the authority the delegate borrows. */
  roleId: string;
}

/**
 * Temporary delegation of signing authority — "إجازات المعتمدين" from §5.
 *
 * Three properties make this safe enough to exist:
 *
 *  1. It lends a *role*, not a permission set. A delegate can only reach steps
 *     the delegator's role could already have signed.
 *  2. It is time-boxed by the database (`endsAt > startsAt`, and every read
 *     here is bounded by `now`), so a forgotten delegation expires by itself
 *     rather than becoming a permanent second key.
 *  3. Every signature it enables records which delegation was used, so the
 *     trail never says "the finance manager approved this" when the finance
 *     manager was in another country.
 *
 * What it deliberately does *not* do: chain. If A delegates to B and B
 * delegates to C, C gets nothing from A. Transitive authority is how a
 * delegation quietly becomes an escalation of privilege nobody approved.
 */
@Injectable()
export class DelegationService {
  constructor(private readonly prisma: PrismaService) {}

  /** Roles `userId` may currently sign for, on top of their own. */
  async rolesFor(organizationId: string, userId: string, at: Date = new Date()): Promise<ActiveDelegation[]> {
    const rows = await this.prisma.approvalDelegation.findMany({
      where: {
        organizationId,
        toUserId: userId,
        isActive: true,
        startsAt: { lte: at },
        endsAt: { gte: at },
      },
      include: {
        fromUser: {
          select: { id: true, nameAr: true, nameEn: true, isActive: true, roleId: true },
        },
      },
    });
    return (
      rows
        // A delegation from a deactivated account lends nothing: the delegator
        // could not sign today either, and a departed employee's authority
        // outliving them is the exact failure this guards.
        .filter((r) => r.fromUser.isActive)
        .map((r) => ({
          id: r.id,
          fromUserId: r.fromUser.id,
          fromUserName: r.fromUser.nameAr,
          roleId: r.fromUser.roleId,
        }))
    );
  }

  /**
   * The delegation letting `userId` act as `roleId`, if any. Returns the first
   * match — two delegations granting the same role are equivalent, and picking
   * either records a true statement.
   */
  async delegationFor(
    organizationId: string,
    userId: string,
    roleId: string,
    at: Date = new Date(),
  ): Promise<ActiveDelegation | null> {
    const all = await this.rolesFor(organizationId, userId, at);
    return all.find((d) => d.roleId === roleId) ?? null;
  }

  /** Users currently holding delegated authority *from* this user. */
  delegatesOf(organizationId: string, fromUserId: string, at: Date = new Date()) {
    return this.prisma.approvalDelegation.findMany({
      where: {
        organizationId,
        fromUserId,
        isActive: true,
        startsAt: { lte: at },
        endsAt: { gte: at },
      },
      select: { id: true, toUserId: true },
    });
  }
}
