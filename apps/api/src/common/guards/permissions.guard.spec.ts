import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { PermissionsGuard } from './permissions.guard';
import {
  ANY_PERMISSIONS_KEY,
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

  describe('@RequireAnyPermission (any-of)', () => {
    const anyOf = ['commercial.item.read', 'scm.requisition.write'];

    it('allows when the user holds one of the listed keys', () => {
      const guard = new PermissionsGuard(reflectorWith({ [ANY_PERMISSIONS_KEY]: anyOf }));
      expect(guard.canActivate(contextWith(['scm.requisition.write']))).toBe(true);
    });

    it('allows when the user holds several of them', () => {
      const guard = new PermissionsGuard(reflectorWith({ [ANY_PERMISSIONS_KEY]: anyOf }));
      expect(guard.canActivate(contextWith([...anyOf, 'crm.lead.read']))).toBe(true);
    });

    it('denies when the user holds none of them', () => {
      const guard = new PermissionsGuard(reflectorWith({ [ANY_PERMISSIONS_KEY]: anyOf }));
      expect(() => guard.canActivate(contextWith(['crm.lead.read']))).toThrow(
        ForbiddenException,
      );
    });

    it('denies a request with no user at all', () => {
      const guard = new PermissionsGuard(reflectorWith({ [ANY_PERMISSIONS_KEY]: anyOf }));
      expect(() => guard.canActivate(contextWith(undefined))).toThrow(ForbiddenException);
    });

    it('DENIES an empty any-of list as undeclared (fail closed)', () => {
      const guard = new PermissionsGuard(reflectorWith({ [ANY_PERMISSIONS_KEY]: [] }));
      expect(() => guard.canActivate(contextWith(['crm.lead.read']))).toThrow(
        ForbiddenException,
      );
    });

    it('DENIES when both lists are declared empty', () => {
      const guard = new PermissionsGuard(
        reflectorWith({ [PERMISSIONS_KEY]: [], [ANY_PERMISSIONS_KEY]: [] }),
      );
      expect(() => guard.canActivate(contextWith(['crm.lead.read']))).toThrow(
        ForbiddenException,
      );
    });

    it('an empty any-of list next to an all-of list leaves the all-of rule alone', () => {
      const guard = new PermissionsGuard(
        reflectorWith({ [PERMISSIONS_KEY]: ['finance.ledger.read'], [ANY_PERMISSIONS_KEY]: [] }),
      );
      expect(guard.canActivate(contextWith(['finance.ledger.read']))).toBe(true);
      expect(() => guard.canActivate(contextWith(['crm.lead.read']))).toThrow(
        ForbiddenException,
      );
    });

    describe('declared together with @RequirePermissions: both must hold', () => {
      const guard = new PermissionsGuard(
        reflectorWith({
          [PERMISSIONS_KEY]: ['finance.ledger.read'],
          [ANY_PERMISSIONS_KEY]: anyOf,
        }),
      );

      it('allows when every all-of key and one any-of key are held', () => {
        expect(
          guard.canActivate(contextWith(['finance.ledger.read', 'commercial.item.read'])),
        ).toBe(true);
      });

      it('denies when the all-of key is missing', () => {
        expect(() => guard.canActivate(contextWith(anyOf))).toThrow(ForbiddenException);
      });

      it('denies when no any-of key is held', () => {
        expect(() => guard.canActivate(contextWith(['finance.ledger.read']))).toThrow(
          ForbiddenException,
        );
      });
    });

    it('keeps the generic message: the listed keys are not named', () => {
      const guard = new PermissionsGuard(reflectorWith({ [ANY_PERMISSIONS_KEY]: anyOf }));
      try {
        guard.canActivate(contextWith([]));
        fail('should have thrown');
      } catch (e) {
        const message = (e as ForbiddenException).message;
        expect(message).toBe('Insufficient permissions');
        for (const key of anyOf) expect(message).not.toContain(key);
      }
    });
  });
});
