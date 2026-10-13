/**
 * ADR-02 task 5 (P1-7) — "holds the key effectively" as a Prisma filter: the
 * SQL twin of `effectivePermissions`, used wherever the API asks which users
 * hold a key (lockout guard, notification fan-out, the proposal's
 * other-approver check, the task assignee list).
 */
import { effectivePermissions, PERMISSIONS } from '@npi/shared';
import { holdsEffectively, holdsRole } from './permission-predicates';
import { fixtureUser, matchesWhere, type FixtureUser } from './testing/user-where';

const KEY = PERMISSIONS.USER_MANAGE;
const ADMIN = { id: 'role-admin', permissions: [KEY, 'crm.lead.read'] };
const SALES = { id: 'role-sales', permissions: ['crm.lead.read'] };

describe('holdsEffectively — the exact shape', () => {
  it('is (primary role OR an extra role OR a GRANT) AND no DENY, and nothing else', () => {
    expect(holdsEffectively(KEY)).toEqual({
      OR: [
        { role: { permissions: { has: KEY } } },
        { extraRoles: { some: { role: { permissions: { has: KEY } } } } },
        { permissionOverrides: { some: { permission: KEY, effect: 'GRANT' } } },
      ],
      permissionOverrides: { none: { permission: KEY, effect: 'DENY' } },
    });
  });

  it('says nothing about activity or the organization — the callers add both', () => {
    const json = JSON.stringify(holdsEffectively(KEY));
    expect(json).not.toContain('isActive');
    expect(json).not.toContain('organizationId');
  });

  it('holdsRole is the primary role or an extra one — a seat, never an override', () => {
    expect(holdsRole('role-exec')).toEqual({
      OR: [{ roleId: 'role-exec' }, { extraRoles: { some: { roleId: 'role-exec' } } }],
    });
  });
});

describe('holdsEffectively — who it selects', () => {
  const users: FixtureUser[] = [
    fixtureUser('primary', ADMIN),
    fixtureUser('extra', SALES, { extraRoles: [{ roleId: ADMIN.id, role: ADMIN }] }),
    fixtureUser('granted', SALES, { permissionOverrides: [{ permission: KEY, effect: 'GRANT' }] }),
    fixtureUser('denied-primary', ADMIN, { permissionOverrides: [{ permission: KEY, effect: 'DENY' }] }),
    fixtureUser('denied-extra', SALES, {
      extraRoles: [{ roleId: ADMIN.id, role: ADMIN }],
      permissionOverrides: [{ permission: KEY, effect: 'DENY' }],
    }),
    fixtureUser('plain', SALES),
    // A DENY of another key does not touch this one.
    fixtureUser('denied-other', ADMIN, {
      permissionOverrides: [{ permission: 'crm.lead.read', effect: 'DENY' }],
    }),
  ];
  const selected = (where: object) => users.filter((u) => matchesWhere(where, u)).map((u) => u.id);

  it('selects a holder through the primary role, an extra role or a GRANT, and drops every DENY', () => {
    expect(selected(holdsEffectively(KEY))).toEqual(['primary', 'extra', 'granted', 'denied-other']);
  });

  it('agrees with effectivePermissions user by user', () => {
    for (const u of users) {
      const set = effectivePermissions(
        [u.role.permissions, ...u.extraRoles.map((er) => er.role.permissions)],
        u.permissionOverrides,
      );
      expect([u.id, matchesWhere(holdsEffectively(KEY), u)]).toEqual([u.id, set.includes(KEY)]);
    }
  });

  it('composed under AND with holdsRole: holds the role AND holds the key effectively', () => {
    const where = { AND: [holdsRole(SALES.id), holdsEffectively(KEY)] };
    expect(selected(where)).toEqual(['extra', 'granted']);
  });
});
