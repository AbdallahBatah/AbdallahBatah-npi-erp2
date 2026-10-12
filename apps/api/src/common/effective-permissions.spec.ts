/**
 * ADR-02 hard rule 1 — a user's effective permission set:
 * (union of all role sets ∪ GRANT) − DENY. `packages/shared` has no jest setup
 * of its own, so this spec lives with the API (the arrangement of
 * arabic.spec.ts) and imports through the package entry point.
 */
import { effectivePermissions, type PermissionOverrideInput } from '@npi/shared';

/**
 * Today's expression, written out as it stands in jwt.strategy.ts (validate)
 * and auth.service.ts (describeRoles). With no overrides the shared function
 * must give exactly this, so that P1-7 can switch both over without changing
 * a response.
 */
function todaysUnion(roles: { permissions: string[] }[]): string[] {
  return [...new Set(roles.flatMap((r) => r.permissions))].sort((a, b) =>
    a.localeCompare(b, 'en'),
  );
}

const PRIMARY = [
  'crm.lead.read',
  'crm.customer.write',
  'crm.customer.read',
  'finance.ledger.read',
];
const EXTRA_A = ['scm.procurement.read', 'crm.customer.read', 'admin.user.manage'];
const EXTRA_B = ['projects.project.read', 'scm.procurement.read'];

const grant = (permission: string): PermissionOverrideInput => ({
  permission,
  effect: 'GRANT',
});
const deny = (permission: string): PermissionOverrideInput => ({ permission, effect: 'DENY' });

describe('effectivePermissions', () => {
  it('with no overrides equals the union jwt.strategy.ts and auth.service.ts compute today', () => {
    const roles = [
      { permissions: PRIMARY },
      { permissions: EXTRA_A },
      { permissions: EXTRA_B },
    ];
    expect(effectivePermissions([PRIMARY, EXTRA_A, EXTRA_B])).toEqual(todaysUnion(roles));
    expect(effectivePermissions([PRIMARY, EXTRA_A, EXTRA_B], [])).toEqual(todaysUnion(roles));
    expect(effectivePermissions([PRIMARY])).toEqual(todaysUnion([{ permissions: PRIMARY }]));
  });

  it('is empty for a role with no keys and no overrides', () => {
    expect(effectivePermissions([[]])).toEqual([]);
    expect(effectivePermissions([])).toEqual([]);
  });

  it('adds a GRANT', () => {
    expect(effectivePermissions([PRIMARY], [grant('fsm.workorder.read')])).toEqual(
      todaysUnion([{ permissions: [...PRIMARY, 'fsm.workorder.read'] }]),
    );
  });

  it('removes a DENY of a key held by the primary role', () => {
    const out = effectivePermissions([PRIMARY], [deny('crm.lead.read')]);
    expect(out).not.toContain('crm.lead.read');
    expect(out).toEqual(['crm.customer.read', 'crm.customer.write', 'finance.ledger.read']);
  });

  it('removes a DENY of a key held only through an extra role', () => {
    expect(effectivePermissions([PRIMARY, EXTRA_A], [deny('admin.user.manage')])).not.toContain(
      'admin.user.manage',
    );
  });

  it('removes a DENY of a key held by several roles at once', () => {
    expect(effectivePermissions([PRIMARY, EXTRA_A], [deny('crm.customer.read')])).not.toContain(
      'crm.customer.read',
    );
  });

  it('removes a DENY of a key granted by another override, whichever comes first', () => {
    expect(
      effectivePermissions(
        [PRIMARY],
        [grant('fsm.workorder.read'), deny('fsm.workorder.read')],
      ),
    ).toEqual(todaysUnion([{ permissions: PRIMARY }]));
    expect(
      effectivePermissions(
        [PRIMARY],
        [deny('fsm.workorder.read'), grant('fsm.workorder.read')],
      ),
    ).toEqual(todaysUnion([{ permissions: PRIMARY }]));
  });

  it('removes a DENY of a key held by a role and granted as well', () => {
    expect(
      effectivePermissions([PRIMARY, EXTRA_A], [grant('crm.lead.read'), deny('crm.lead.read')]),
    ).not.toContain('crm.lead.read');
  });

  it('treats a DENY of a key nobody holds as a no-op', () => {
    expect(effectivePermissions([PRIMARY], [deny('admin.org.manage')])).toEqual(
      effectivePermissions([PRIMARY]),
    );
  });

  it('implies nothing: denying a view key leaves the write key, granting a write key brings no view key', () => {
    const out = effectivePermissions(
      [PRIMARY],
      [deny('crm.customer.read'), grant('scm.procurement.write')],
    );
    expect(out).toContain('crm.customer.write');
    expect(out).toContain('scm.procurement.write');
    expect(out).not.toContain('crm.customer.read');
    expect(out).not.toContain('scm.procurement.read');
  });

  it('collapses duplicates from roles and overrides alike', () => {
    const out = effectivePermissions(
      [PRIMARY, PRIMARY, ['crm.lead.read', 'crm.lead.read']],
      [grant('crm.lead.read'), grant('fsm.workorder.read'), grant('fsm.workorder.read')],
    );
    expect(out).toEqual([...new Set(out)]);
    expect(out.filter((k) => k === 'crm.lead.read')).toHaveLength(1);
    expect(out.filter((k) => k === 'fsm.workorder.read')).toHaveLength(1);
  });

  it("returns the keys sorted with localeCompare(…, 'en')", () => {
    const out = effectivePermissions(
      [EXTRA_B, EXTRA_A, PRIMARY],
      [grant('assets.serialunit.read')],
    );
    expect(out).toEqual([...out].sort((a, b) => a.localeCompare(b, 'en')));
    expect(out[0]).toBe('admin.user.manage');
  });

  it('does not modify its inputs', () => {
    const roleSets = Object.freeze([Object.freeze([...PRIMARY]), Object.freeze([...EXTRA_A])]);
    const overrides = Object.freeze([
      Object.freeze(grant('fsm.workorder.read')),
      Object.freeze(deny('crm.lead.read')),
    ]);
    const before = JSON.stringify({ roleSets, overrides });
    // Frozen inputs: any write to them would throw here.
    effectivePermissions(roleSets, overrides);
    expect(JSON.stringify({ roleSets, overrides })).toBe(before);
  });
});
