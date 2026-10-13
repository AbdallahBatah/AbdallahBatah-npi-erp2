/**
 * The shape of PERMISSION_CATALOG, which GET /admin/permissions serves as is
 * (admin.controller.ts). Madar reads `key`, `groupAr` and `labelAr` from every
 * element (apps/copilot/src/npi/permissions.ts) and its catalogue test pins the
 * count, so fields may be added but never renamed or removed. `packages/shared`
 * has no jest setup of its own, so this spec lives with the API.
 */
import { ALL_PERMISSIONS, PERMISSION_CATALOG } from '@npi/shared';

describe('PERMISSION_CATALOG', () => {
  // 40 at P1-4; P1-6 added crm.task.read, scm.requisition.read,
  // finance.report.read and finance.statement.read.
  it('is a flat array of 44 entries, one per permission key', () => {
    expect(Array.isArray(PERMISSION_CATALOG)).toBe(true);
    expect(PERMISSION_CATALOG).toHaveLength(44);
    expect(PERMISSION_CATALOG.map((p) => p.key).sort()).toEqual([...ALL_PERMISSIONS].sort());
  });

  it.each(PERMISSION_CATALOG.map((p) => [p.key, p] as const))(
    '%s carries the fields Madar reads, plus screen and action',
    (_key, p) => {
      expect(typeof p.key).toBe('string');
      expect(p.key.length).toBeGreaterThan(0);
      expect(typeof p.groupAr).toBe('string');
      expect(typeof p.labelAr).toBe('string');
      expect(p).toHaveProperty('screen');
      expect(p.screen === null || typeof p.screen === 'string').toBe(true);
      expect(['view', 'write', 'approve', 'special']).toContain(p.action);
    },
  );
});
