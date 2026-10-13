import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { AuthUser } from './auth-user';

/** Marks a route as not requiring authentication (e.g. login). */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Declares the permission keys a route requires (all must be present). */
export const PERMISSIONS_KEY = 'requiredPermissions';
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/**
 * Declares keys of which the user must hold AT LEAST ONE (ADR-02 §3-3: the
 * pick lists, where any of several screens' working keys earns the list). On
 * a route that also declares @RequirePermissions both must be satisfied. An
 * empty list counts as undeclared, so the fail-closed rule still applies.
 */
export const ANY_PERMISSIONS_KEY = 'requiredAnyPermissions';
export const RequireAnyPermission = (...permissions: string[]) =>
  SetMetadata(ANY_PERMISSIONS_KEY, permissions);

/**
 * Marks an authenticated route as intentionally permission-free (e.g. /auth/me,
 * /reference/enums). The global PermissionsGuard is fail-closed: a route with
 * none of @RequirePermissions, @RequireAnyPermission or this marker is denied.
 */
export const SKIP_PERMISSIONS_KEY = 'skipPermissions';
export const SkipPermissions = () => SetMetadata(SKIP_PERMISSIONS_KEY, true);

/** Injects the authenticated principal into a controller handler. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const request = ctx.switchToHttp().getRequest();
    return request.user as AuthUser;
  },
);
