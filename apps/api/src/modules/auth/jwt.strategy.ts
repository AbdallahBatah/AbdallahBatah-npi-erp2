import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../prisma/prisma.service';
import { JWT_SECRET } from './jwt.constants';
import type { AuthUser } from '../../common/auth-user';

interface JwtPayload {
  sub: string;
  org: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: JWT_SECRET(),
    });
  }

  /**
   * Re-loads the user (and its role's live permissions) on every request, so a
   * revoked user or a changed role takes effect immediately rather than living
   * on in a stale token.
   */
  async validate(payload: JwtPayload): Promise<AuthUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: { role: true, extraRoles: { include: { role: true } } },
    });

    if (!user || !user.isActive || user.organizationId !== payload.org) {
      throw new UnauthorizedException();
    }

    // Primary role first, then the extra ones; permissions are the union.
    const roles = [user.role, ...user.extraRoles.map((er) => er.role)];
    return {
      userId: user.id,
      organizationId: user.organizationId,
      email: user.email,
      roleId: user.roleId,
      roleKey: user.role.key,
      roleIds: roles.map((r) => r.id),
      permissions: [...new Set(roles.flatMap((r) => r.permissions))].sort((a, b) => a.localeCompare(b, 'en')),
      locale: user.locale,
    };
  }
}
