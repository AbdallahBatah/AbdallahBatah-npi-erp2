import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { PermissionsGuard } from './permissions.guard';
import {
  IS_PUBLIC_KEY,
  PERMISSIONS_KEY,
  SKIP_PERMISSIONS_KEY,
} from '../decorators';

/** Fake reflector: serves metadata from a plain map. */
const reflectorWith = (meta: Record<string, unknown>) =>
  ({
    getAllAndOverride: (key: string) => meta[key],
  }) as never;

const contextWith = (permissions: string[] | undefined): ExecutionContext =>
  ({
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({ user: permissions ? { permissions } : undefined }),
    }),
  }) as unknown as ExecutionContext;

describe('PermissionsGuard (global, fail-closed)', () => {
  it('allows @Public routes', () => {
    const guard = new PermissionsGuard(reflectorWith({ [IS_PUBLIC_KEY]: true }));
    expect(guard.canActivate(contextWith(undefined))).toBe(true);
  });

  it('allows @SkipPermissions routes', () => {
    const guard = new PermissionsGuard(
      reflectorWith({ [SKIP_PERMISSIONS_KEY]: true }),
    );
    expect(guard.canActivate(contextWith([]))).toBe(true);
  });

  it('DENIES a route with no declared permissions (fail closed)', () => {
    const guard = new PermissionsGuard(reflectorWith({}));
    expect(() => guard.canActivate(contextWith(['crm.lead.read']))).toThrow(
      ForbiddenException,
    );
  });

  it('DENIES a route declaring an empty permission list', () => {
    const guard = new PermissionsGuard(reflectorWith({ [PERMISSIONS_KEY]: [] }));
    expect(() => guard.canActivate(contextWith(['crm.lead.read']))).toThrow(
      ForbiddenException,
    );
  });

  it('denies when any required permission is missing', () => {
    const guard = new PermissionsGuard(
      reflectorWith({ [PERMISSIONS_KEY]: ['finance.invoice.write', 'finance.ledger.read'] }),
    );
    expect(() =>
      guard.canActivate(contextWith(['finance.invoice.write'])),
    ).toThrow(ForbiddenException);
  });

  it('allows when every required permission is held', () => {
    const guard = new PermissionsGuard(
      reflectorWith({ [PERMISSIONS_KEY]: ['finance.invoice.write'] }),
    );
    expect(
      guard.canActivate(contextWith(['finance.invoice.write', 'crm.lead.read'])),
    ).toBe(true);
  });

  it('does not leak the permission model in the error message', () => {
    const guard = new PermissionsGuard(
      reflectorWith({ [PERMISSIONS_KEY]: ['admin.org.manage'] }),
    );
    try {
      guard.canActivate(contextWith([]));
      fail('should have thrown');
    } catch (e) {
      expect((e as ForbiddenException).message).not.toContain('admin.org.manage');
    }
  });
});
