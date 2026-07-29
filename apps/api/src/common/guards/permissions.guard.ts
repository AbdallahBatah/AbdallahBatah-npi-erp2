import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  IS_PUBLIC_KEY,
  PERMISSIONS_KEY,
  SKIP_PERMISSIONS_KEY,
} from '../decorators';
import type { AuthUser } from '../auth-user';

/**
 * Global, fail-closed authorization. Every authenticated route must either
 * declare @RequirePermissions(...) (the user must hold every listed key) or be
 * explicitly marked @SkipPermissions(). A route with neither is denied — a new
 * controller can no longer ship unprotected by omission.
 * Runs after JwtAuthGuard, so req.user is already populated.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      return true;
    }
    if (this.reflector.getAllAndOverride<boolean>(SKIP_PERMISSIONS_KEY, targets)) {
      return true;
    }

    const required = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      targets,
    );
    if (!required || required.length === 0) {
      // Fail closed: an undeclared route is a bug, not an open door.
      throw new ForbiddenException('Insufficient permissions');
    }

    const user = context.switchToHttp().getRequest().user as AuthUser | undefined;
    const held = new Set(user?.permissions ?? []);
    if (required.some((p) => !held.has(p))) {
      // Deliberately generic: do not enumerate the permission model to callers.
      throw new ForbiddenException('Insufficient permissions');
    }
    return true;
  }
}
