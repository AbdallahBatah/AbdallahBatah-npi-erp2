import { Injectable } from '@nestjs/common';
import type { Prisma } from '@npi/db';
import { effectivePermissions } from '@npi/shared';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Everything a user's effective permission set is made of (ADR-02 §3-1): the
 * primary role, the extra roles and the per-user GRANT / DENY overrides. One
 * include for every reader — JwtStrategy on each request, /auth/login and
 * /auth/me, the user's permission editor, the approval engine's delegation
 * check — so that none of them can leave the overrides out.
 */
export const EFFECTIVE_PERMISSIONS_INCLUDE = {
  role: true,
  extraRoles: { include: { role: true } },
  permissionOverrides: true,
} as const satisfies Prisma.UserInclude;

export type UserWithPermissionSources = Prisma.UserGetPayload<{
  include: typeof EFFECTIVE_PERMISSIONS_INCLUDE;
}>;

/**
 * The one evaluation: roles primary first, then the extra ones; `permissions`
 * is `effectivePermissions` from @npi/shared over their keys and the
 * overrides — (union ∪ GRANT) − DENY, sorted. With no override rows it is the
 * sorted union of the roles, exactly what the API answered before P1-7.
 */
export function resolveEffectivePermissions<U extends UserWithPermissionSources>(user: U) {
  const roles = [user.role, ...user.extraRoles.map((er) => er.role)];
  return {
    user,
    roles,
    overrides: user.permissionOverrides,
    permissions: effectivePermissions(
      roles.map((r) => r.permissions),
      user.permissionOverrides,
    ),
  };
}

export type EffectivePermissionSet = ReturnType<typeof resolveEffectivePermissions<UserWithPermissionSources>>;

/** Loads a user with their permission sources and evaluates them. */
@Injectable()
export class EffectivePermissionsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Null when the user does not exist; activity and organization are the caller's checks. */
  async forUser(userId: string): Promise<EffectivePermissionSet | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: EFFECTIVE_PERMISSIONS_INCLUDE,
    });
    return user ? resolveEffectivePermissions(user) : null;
  }
}
