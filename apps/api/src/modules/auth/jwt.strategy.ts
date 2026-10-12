import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { EffectivePermissionsService } from '../../common/effective-permissions.service';
import { JWT_SECRET } from './jwt.constants';
import type { AuthUser } from '../../common/auth-user';

interface JwtPayload {
  sub: string;
  org: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly effective: EffectivePermissionsService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: JWT_SECRET(),
    });
  }

  /**
   * Re-loads the user (their roles' live permissions and their overrides) on
   * every request, so a revoked user, a changed role or a new GRANT / DENY
   * takes effect immediately rather than living on in a stale token.
   */
  async validate(payload: JwtPayload): Promise<AuthUser> {
    const found = await this.effective.forUser(payload.sub);
    if (!found || !found.user.isActive || found.user.organizationId !== payload.org) {
      throw new UnauthorizedException();
    }

    // Primary role first, then the extra ones; permissions are the effective
    // set (ADR-02): the union of the roles, plus GRANT, minus DENY.
    const { user, roles, permissions } = found;
    return {
      userId: user.id,
      organizationId: user.organizationId,
      email: user.email,
      roleId: user.roleId,
      roleKey: user.role.key,
      roleIds: roles.map((r) => r.id),
      permissions,
      locale: user.locale,
    };
  }
}
