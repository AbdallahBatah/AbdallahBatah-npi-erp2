// D-26 (T-48b): resolving the user and the permissions a sentence names, reading
// NPI's directory / catalog / user-permission bodies, and computing the override
// list a change writes.
import { t } from '../src/i18n/ar';
import { NpiError } from '../src/npi/errors';
import type { UserPermissionsValues } from '../src/extract/schemas/user_permissions';
import { resolutionBlockers, resolveFlow } from '../src/intake/resolution';
import {
  permissionsFromCatalog,
  resolvePermission,
  resolveUser,
  userPermissionStateFrom,
  usersFromDirectory,
  type PermissionRef,
  type UserRef,
} from '../src/extract/resolve';
import { noopReasonAr, planPermissionOverrides } from '../src/intake/permission-plan';
import type { UserPermissionState } from '../src/intake/types';

// ─── fixtures ───────────────────────────────────────────────────────────────

const user = (id: string, nameAr: string, extra: Partial<UserRef> = {}): UserRef => ({
  id,
  nameAr,
  nameEn: null,
  email: null,
  isActive: true,
  roleKey: 'accountant',
  roleAr: 'محاسب',
  ...extra,
});

const USERS: UserRef[] = [
  user('u-ahmad', 'أحمد الغامدي', { nameEn: 'Ahmed Alghamdi', email: 'ahmad@npi.sa' }),
  user('u-sara', 'سارة القحطاني', { email: 'sara@npi.sa', roleKey: 'pm', roleAr: 'مدير مشروع' }),
  user('u-khalid1', 'خالد العتيبي'),
  user('u-khalid2', 'خالد العتيبي الصغير'),
];

const perm = (key: string, labelAr: string, labelEn: string, screenAr: string, action = 'view'): PermissionRef => ({
  key,
  labelAr,
  labelEn,
  screenAr,
  groupAr: 'المالية',
  action,
});

const CATALOG: PermissionRef[] = [
  perm('finance.report.read', 'عرض التقارير المالية', 'View finance reports', 'التقارير المالية'),
  perm('finance.invoice.read', 'عرض الفواتير', 'View invoices', 'الفواتير'),
  perm('finance.invoice.write', 'إصدار الفواتير والتحصيل', 'Issue invoices & collect', 'الفواتير', 'write'),
  perm('commercial.contract.read', 'عرض العقود', 'View contracts', 'العقود'),
  perm('scm.requisition.read', 'عرض طلبات الشراء', 'View purchase requisitions', 'طلبات الشراء'),
];

// ─── resolveUser ────────────────────────────────────────────────────────────

describe('resolveUser', () => {
  it('an exact Arabic name is a match', () => {
    expect(resolveUser('أحمد الغامدي', USERS)).toMatchObject({ kind: 'matched', by: 'name', user: { id: 'u-ahmad' } });
  });

  it('the English name and the e-mail (any case) match too', () => {
    expect(resolveUser('ahmed alghamdi', USERS)).toMatchObject({ kind: 'matched', user: { id: 'u-ahmad' } });
    expect(resolveUser('SARA@npi.sa', USERS)).toMatchObject({ kind: 'matched', user: { id: 'u-sara' } });
  });

  it('a first name alone is a choice, not a match', () => {
    const found = resolveUser('أحمد', USERS);
    expect(found.kind).toBe('candidates');
    if (found.kind === 'candidates') expect(found.candidates.map((c) => c.entity.id)).toContain('u-ahmad');
  });

  it('two similar names are offered together', () => {
    const found = resolveUser('خالد العتيبي الكبير', USERS);
    expect(found.kind).toBe('candidates');
    if (found.kind === 'candidates') {
      expect(found.candidates.map((c) => c.entity.id)).toEqual(expect.arrayContaining(['u-khalid1', 'u-khalid2']));
      expect(found.candidates.length).toBeLessThanOrEqual(5);
    }
  });

  it('two users with the very same name are a choice, never a pick', () => {
    const twins = [user('a', 'محمد علي'), user('b', 'محمد علي')];
    const found = resolveUser('محمد علي', twins);
    expect(found.kind).toBe('candidates');
  });

  it('a name the directory does not hold, or an empty one, is none', () => {
    expect(resolveUser('زيزو', USERS)).toEqual({ kind: 'none' });
    expect(resolveUser('', USERS)).toEqual({ kind: 'none' });
    expect(resolveUser(null, USERS)).toEqual({ kind: 'none' });
    expect(resolveUser('أحمد', [])).toEqual({ kind: 'none' });
  });
});

// ─── resolvePermission ──────────────────────────────────────────────────────

describe('resolvePermission', () => {
  it('a screen with one permission resolves by the screen name', () => {
    expect(resolvePermission('التقارير المالية', CATALOG)).toMatchObject({ kind: 'matched', permission: { key: 'finance.report.read' } });
  });

  it('a screen with several permissions offers all of them', () => {
    const found = resolvePermission('الفواتير', CATALOG);
    expect(found.kind).toBe('candidates');
    if (found.kind === 'candidates') expect(found.candidates.map((c) => c.entity.key).sort()).toEqual(['finance.invoice.read', 'finance.invoice.write']);
  });

  it('the full label matches', () => {
    expect(resolvePermission('عرض الفواتير', CATALOG)).toMatchObject({ kind: 'matched', by: 'name', permission: { key: 'finance.invoice.read' } });
  });

  it('the key and the English label match, any case', () => {
    expect(resolvePermission('finance.report.read', CATALOG)).toMatchObject({ kind: 'matched', by: 'code', permission: { key: 'finance.report.read' } });
    expect(resolvePermission('FINANCE.REPORT.READ', CATALOG)).toMatchObject({ kind: 'matched', permission: { key: 'finance.report.read' } });
    expect(resolvePermission('view contracts', CATALOG)).toMatchObject({ kind: 'matched', permission: { key: 'commercial.contract.read' } });
  });

  it('a leading «صلاحية» (with or without the article) is not part of the name', () => {
    expect(resolvePermission('صلاحية التقارير المالية', CATALOG)).toMatchObject({ kind: 'matched', permission: { key: 'finance.report.read' } });
    expect(resolvePermission('الصلاحيات الفواتير', CATALOG).kind).toBe('candidates');
    expect(resolvePermission('صلاحيه عرض العقود', CATALOG)).toMatchObject({ kind: 'matched', permission: { key: 'commercial.contract.read' } });
  });

  it('a near name is offered for choice, at most five', () => {
    const found = resolvePermission('عرض التقارير', CATALOG);
    expect(found.kind).toBe('candidates');
    if (found.kind === 'candidates') {
      expect(found.candidates[0].entity.key).toBe('finance.report.read');
      expect(found.candidates.length).toBeLessThanOrEqual(5);
    }
  });

  it('nonsense and the empty name are none', () => {
    expect(resolvePermission('طيران فضائي', CATALOG)).toEqual({ kind: 'none' });
    expect(resolvePermission('xyzzy', CATALOG)).toEqual({ kind: 'none' });
    expect(resolvePermission('صلاحية', CATALOG)).toEqual({ kind: 'none' });
    expect(resolvePermission('', CATALOG)).toEqual({ kind: 'none' });
  });
});

// ─── readers ────────────────────────────────────────────────────────────────

describe('usersFromDirectory', () => {
  it('reads the directory projection and skips rows without an id or a name', () => {
    const rows = usersFromDirectory([
      { id: 'u1', nameAr: 'أحمد', nameEn: 'Ahmad', email: 'a@npi.sa', isActive: true, departmentId: 'd1', role: { id: 'r', key: 'pm', nameAr: 'مدير', nameEn: 'PM' } },
      { id: 'u2', nameAr: 'سارة', nameEn: null, email: null, isActive: false, role: null },
      { nameAr: 'بلا معرف' },
      { id: 'u4' },
      'junk',
    ]);
    expect(rows).toEqual([
      { id: 'u1', nameAr: 'أحمد', nameEn: 'Ahmad', email: 'a@npi.sa', isActive: true, roleKey: 'pm', roleAr: 'مدير' },
      { id: 'u2', nameAr: 'سارة', nameEn: null, email: null, isActive: false, roleKey: null, roleAr: null },
    ]);
  });

  it('a body that is not a list is an NpiError the resolution turns into an unreadable pick', () => {
    expect(() => usersFromDirectory({ nope: 1 })).toThrow();
  });
});

describe('permissionsFromCatalog', () => {
  it('reads key, labels, screen, group and action; skips rows without a key or an Arabic label', () => {
    const rows = permissionsFromCatalog([
      { key: 'a.b', labelAr: 'عرض أ', labelEn: 'View a', screenAr: 'أ', groupAr: 'ج', action: 'view' },
      { key: 'c.d', labelAr: '' },
      { labelAr: 'بلا مفتاح' },
    ]);
    expect(rows).toEqual([{ key: 'a.b', labelAr: 'عرض أ', labelEn: 'View a', screenAr: 'أ', groupAr: 'ج', action: 'view' }]);
  });
});

describe('userPermissionStateFrom', () => {
  it('reads roles, overrides and the effective set', () => {
    const state = userPermissionStateFrom({
      roles: [
        { id: 'r1', key: 'accountant', nameAr: 'محاسب', nameEn: 'Accountant', permissions: ['finance.report.read', 'finance.invoice.read'] },
        { id: 'r2', key: 'x', nameAr: 'آخر', permissions: ['finance.invoice.read', 'commercial.contract.read'] },
      ],
      overrides: [
        { permission: 'scm.requisition.read', effect: 'GRANT', reason: 'مؤقت', createdAt: '2026-10-01', createdBy: null },
        { permission: 'commercial.contract.read', effect: 'DENY', reason: '' },
        { permission: 'weird', effect: 'MAYBE' },
      ],
      effective: ['scm.requisition.read', 'finance.report.read'],
    });
    expect(state).toEqual({
      roleAr: 'محاسب',
      rolePermissions: ['commercial.contract.read', 'finance.invoice.read', 'finance.report.read'],
      overrides: [
        { permission: 'commercial.contract.read', effect: 'DENY', reason: null },
        { permission: 'scm.requisition.read', effect: 'GRANT', reason: 'مؤقت' },
      ],
      effective: ['finance.report.read', 'scm.requisition.read'],
    });
  });

  it('a body of another shape is an NpiError', () => {
    expect(() => userPermissionStateFrom({ roles: [] })).toThrow();
    expect(() => userPermissionStateFrom(null)).toThrow();
  });
});

// ─── planPermissionOverrides — the eight branches ──────────────────────────

describe('planPermissionOverrides', () => {
  const LABELS: Record<string, string> = {
    'finance.report.read': 'عرض التقارير المالية',
    'finance.invoice.read': 'عرض الفواتير',
    'commercial.contract.read': 'عرض العقود',
    'scm.requisition.read': 'عرض طلبات الشراء',
    'a.first': 'الأول',
  };
  const state = (overrides: UserPermissionState['overrides'] = [], rolePermissions = ['finance.report.read', 'finance.invoice.read']): UserPermissionState => ({
    roleAr: 'محاسب',
    rolePermissions,
    overrides,
    effective: [],
  });
  const viaRole = t('preview.permission_via_role', { role: 'محاسب' });

  it('revoke, held through the role: adds a DENY', () => {
    const plan = planPermissionOverrides(state(), 'revoke', ['finance.report.read'], null, LABELS);
    expect(plan.overrides).toEqual([{ permission: 'finance.report.read', effect: 'DENY', reason: null }]);
    expect(plan.changes).toEqual([
      { key: 'finance.report.read', labelAr: 'عرض التقارير المالية', beforeAr: viaRole, afterAr: t('preview.permission_denied'), noop: false, held: true },
    ]);
  });

  it('revoke, held through a role AND a GRANT: the GRANT is replaced by a DENY', () => {
    const plan = planPermissionOverrides(state([{ permission: 'finance.report.read', effect: 'GRANT', reason: 'قديم' }]), 'revoke', ['finance.report.read'], 'جديد', LABELS);
    expect(plan.overrides).toEqual([{ permission: 'finance.report.read', effect: 'DENY', reason: 'جديد' }]);
  });

  it('revoke, held through a GRANT only: the GRANT is removed', () => {
    const plan = planPermissionOverrides(state([{ permission: 'scm.requisition.read', effect: 'GRANT', reason: null }]), 'revoke', ['scm.requisition.read'], 'س', LABELS);
    expect(plan.overrides).toEqual([]);
    expect(plan.changes[0]).toMatchObject({ beforeAr: t('preview.permission_via_grant'), afterAr: t('preview.permission_absent'), noop: false });
  });

  it('revoke, held nowhere, or already denied: no change', () => {
    const none = planPermissionOverrides(state(), 'revoke', ['scm.requisition.read'], null, LABELS);
    expect(none.changes[0]).toMatchObject({ noop: true, held: false });
    expect(none.overrides).toEqual([]);

    const denied = planPermissionOverrides(state([{ permission: 'finance.report.read', effect: 'DENY', reason: null }]), 'revoke', ['finance.report.read'], null, LABELS);
    expect(denied.changes[0]).toMatchObject({ noop: true, held: false });
    expect(denied.overrides).toEqual([{ permission: 'finance.report.read', effect: 'DENY', reason: null }]);
  });

  it('grant, not held: adds a GRANT', () => {
    const plan = planPermissionOverrides(state(), 'grant', ['scm.requisition.read'], 'يحتاجها', LABELS);
    expect(plan.overrides).toEqual([{ permission: 'scm.requisition.read', effect: 'GRANT', reason: 'يحتاجها' }]);
    expect(plan.changes[0]).toMatchObject({ beforeAr: t('preview.permission_absent'), afterAr: t('preview.permission_via_grant'), noop: false });
  });

  it('grant, denied on a permission the role gives: the DENY is simply removed', () => {
    const plan = planPermissionOverrides(state([{ permission: 'finance.report.read', effect: 'DENY', reason: 'قديم' }]), 'grant', ['finance.report.read'], 'جديد', LABELS);
    expect(plan.overrides).toEqual([]);
    expect(plan.changes[0]).toMatchObject({ beforeAr: t('preview.permission_denied'), afterAr: viaRole, noop: false });
  });

  it('grant, denied on a permission the role does not give: the DENY becomes a GRANT', () => {
    const plan = planPermissionOverrides(state([{ permission: 'scm.requisition.read', effect: 'DENY', reason: null }]), 'grant', ['scm.requisition.read'], 'جديد', LABELS);
    expect(plan.overrides).toEqual([{ permission: 'scm.requisition.read', effect: 'GRANT', reason: 'جديد' }]);
    expect(plan.changes[0]).toMatchObject({ beforeAr: t('preview.permission_denied'), afterAr: t('preview.permission_via_grant') });
  });

  it('grant, already held (role or GRANT): no change', () => {
    expect(planPermissionOverrides(state(), 'grant', ['finance.report.read'], null, LABELS).changes[0]).toMatchObject({ noop: true, held: true });
    const granted = planPermissionOverrides(state([{ permission: 'scm.requisition.read', effect: 'GRANT', reason: null }]), 'grant', ['scm.requisition.read'], null, LABELS);
    expect(granted.changes[0]).toMatchObject({ noop: true, held: true });
    expect(granted.overrides).toHaveLength(1);
  });

  it('writes the full new list: untouched overrides kept as they are, everything sorted by key', () => {
    const plan = planPermissionOverrides(
      state([
        { permission: 'scm.requisition.read', effect: 'GRANT', reason: 'قديم' },
        { permission: 'commercial.contract.read', effect: 'DENY', reason: null },
      ]),
      'revoke',
      ['finance.report.read'],
      'السبب الجديد',
      LABELS,
    );
    expect(plan.overrides).toEqual([
      { permission: 'commercial.contract.read', effect: 'DENY', reason: null },
      { permission: 'finance.report.read', effect: 'DENY', reason: 'السبب الجديد' },
      { permission: 'scm.requisition.read', effect: 'GRANT', reason: 'قديم' },
    ]);
  });

  it('the reason goes only on the overrides this change adds, trimmed and cut to 500', () => {
    const long = ` ${'ص'.repeat(600)} `;
    const plan = planPermissionOverrides(state([{ permission: 'scm.requisition.read', effect: 'GRANT', reason: 'قديم' }]), 'revoke', ['finance.report.read', 'finance.invoice.read'], long, LABELS);
    const byKey = Object.fromEntries(plan.overrides.map((o) => [o.permission, o]));
    expect(byKey['finance.report.read'].reason).toHaveLength(500);
    expect(byKey['finance.invoice.read'].reason).toHaveLength(500);
    expect(byKey['scm.requisition.read'].reason).toBe('قديم');
    expect(planPermissionOverrides(state(), 'revoke', ['finance.report.read'], '   ', LABELS).overrides[0].reason).toBeNull();
  });

  it('several keys are planned together; a repeated key counts once; an unknown label falls back to the key', () => {
    const plan = planPermissionOverrides(state(), 'revoke', ['finance.report.read', 'finance.report.read', 'mystery.key'], null, LABELS);
    expect(plan.changes.map((c) => c.key)).toEqual(['finance.report.read', 'mystery.key']);
    expect(plan.changes[1]).toMatchObject({ labelAr: 'mystery.key', noop: true });
  });

  it('the noop wording follows what the user holds', () => {
    const held = planPermissionOverrides(state(), 'grant', ['finance.report.read'], null, LABELS).changes[0];
    expect(noopReasonAr(held)).toBe(t('preview.permission_noop', { label: 'عرض التقارير المالية', state: t('preview.permission_state.held') }));
    const notHeld = planPermissionOverrides(state(), 'revoke', ['scm.requisition.read'], null, LABELS).changes[0];
    expect(noopReasonAr(notHeld)).toBe(t('preview.permission_noop', { label: 'عرض طلبات الشراء', state: t('preview.permission_state.not_held') }));
  });
});

// ─── resolveFlow — the whole read path, with a fake NPI ─────────────────────

describe('resolveFlow — user_permissions', () => {
  const DIRECTORY = [
    { id: 'u-ahmad', nameAr: 'أحمد الغامدي', nameEn: 'Ahmed Alghamdi', email: 'ahmad@npi.sa', isActive: true, role: { id: 'r1', key: 'accountant', nameAr: 'محاسب', nameEn: 'Accountant' } },
    { id: 'u-ahmad2', nameAr: 'أحمد القحطاني', nameEn: null, email: null, isActive: true, role: { id: 'r2', key: 'pm', nameAr: 'مدير مشروع', nameEn: 'PM' } },
    { id: 'u-old', nameAr: 'سلمان الدوسري', nameEn: null, email: null, isActive: false, role: { id: 'r1', key: 'accountant', nameAr: 'محاسب', nameEn: 'Accountant' } },
  ];
  const CATALOG_BODY = CATALOG.map((p) => ({ ...p }));
  const detail = (permissions: string[]) => ({
    roles: [{ id: 'r1', key: 'accountant', nameAr: 'محاسب', nameEn: 'Accountant', permissions }],
    overrides: [],
    effective: permissions,
  });

  function fakeNpi(overrides: Record<string, jest.Mock> = {}) {
    return {
      listDepartmentDirectory: jest.fn(async () => DIRECTORY),
      permissionCatalog: jest.fn(async () => CATALOG_BODY),
      getUserPermissions: jest.fn(async (id: string) => detail(id === 'u-ahmad' ? ['finance.report.read'] : ['finance.invoice.read'])),
      ...overrides,
    } as unknown as Parameters<typeof resolveFlow>[0];
  }

  const values = (over: Partial<UserPermissionsValues> = {}): UserPermissionsValues => ({
    userName: 'أحمد الغامدي',
    action: 'revoke',
    permissions: [{ name: 'التقارير المالية' }],
    reason: null,
    ...over,
  });

  it('a matched user and a matched permission: the state is read once and the labels are carried', async () => {
    const npi = fakeNpi();
    const r = await resolveFlow(npi, 'user_permissions', values());

    expect(r.user).toEqual({ kind: 'matched', id: 'u-ahmad', labelAr: 'أحمد الغامدي', by: 'name' });
    expect(r.lines[0].permission).toEqual({ kind: 'matched', id: 'finance.report.read', labelAr: 'عرض التقارير المالية', by: 'name' });
    expect(Object.keys(r.current ?? {})).toEqual(['u-ahmad']);
    expect(r.current?.['u-ahmad'].rolePermissions).toEqual(['finance.report.read']);
    expect(r.permissionLabels?.['finance.invoice.write']).toBe('إصدار الفواتير والتحصيل');
    expect(r.notesAr).toEqual([t('preview.user_match', { name: 'أحمد الغامدي' })]);
    const reads = npi as unknown as { getUserPermissions: jest.Mock };
    expect(reads.getUserPermissions).toHaveBeenCalledTimes(1);
    expect(resolutionBlockers(r)).toEqual([]);
  });

  it('candidates: every candidate’s state is read (so before/after works for whichever is chosen)', async () => {
    const npi = fakeNpi();
    const r = await resolveFlow(npi, 'user_permissions', values({ userName: 'أحمد' }));
    expect(r.user?.kind).toBe('candidates');
    if (r.user?.kind === 'candidates') {
      expect(r.user.candidates.map((c) => c.labelAr)).toEqual(expect.arrayContaining(['أحمد الغامدي — محاسب', 'أحمد القحطاني — مدير مشروع']));
      expect(Object.keys(r.current ?? {}).sort()).toEqual(r.user.candidates.map((c) => c.id).sort());
    }
    expect(resolutionBlockers(r, { userName: 'أحمد', choices: { user: 'u-ahmad' } })).toEqual([]);
  });

  it('a user the directory lacks: a note, a blocker, no state read', async () => {
    const npi = fakeNpi();
    const r = await resolveFlow(npi, 'user_permissions', values({ userName: 'زيزو' }));
    expect(r.user).toEqual({ kind: 'none' });
    expect(r.notesAr).toContain(t('preview.user_none', { name: 'زيزو' }));
    expect(resolutionBlockers(r, { userName: 'زيزو' })).toEqual([t('preview.user_none', { name: 'زيزو' })]);
    expect((npi as unknown as { getUserPermissions: jest.Mock }).getUserPermissions).not.toHaveBeenCalled();
  });

  it('an inactive user and the caller’s own account get their notes', async () => {
    const inactive = await resolveFlow(fakeNpi(), 'user_permissions', values({ userName: 'سلمان الدوسري' }));
    expect(inactive.notesAr).toContain(t('preview.user_inactive', { name: 'سلمان الدوسري' }));

    const self = await resolveFlow(fakeNpi(), 'user_permissions', values(), { callerNpiUserId: 'u-ahmad' });
    expect(self.notesAr).toContain(t('preview.user_self'));
    const other = await resolveFlow(fakeNpi(), 'user_permissions', values(), { callerNpiUserId: 'someone' });
    expect(other.notesAr).not.toContain(t('preview.user_self'));
  });

  it('a permission name NPI’s catalog lacks is a pick of none, with a note', async () => {
    const r = await resolveFlow(fakeNpi(), 'user_permissions', values({ permissions: [{ name: 'طيران فضائي' }] }));
    expect(r.lines[0].permission).toEqual({ kind: 'none' });
    expect(r.notesAr).toContain(t('preview.permission_none', { name: 'طيران فضائي' }));
    expect(resolutionBlockers(r, { permissions: [{ name: 'طيران فضائي' }] })).toEqual([t('preview.permission_none', { name: 'طيران فضائي' })]);
  });

  it('a refused directory read is an unreadable pick (one note), not a failed job', async () => {
    const forbidden = new NpiError({ status: 403, kind: 'forbidden', npiMessage: 'Insufficient permissions' });
    const r = await resolveFlow(fakeNpi({ listDepartmentDirectory: jest.fn(async () => Promise.reject(forbidden)) }), 'user_permissions', values());
    expect(r.user?.kind).toBe('unreadable');
    expect(r.notesAr).toContain(t('preview.list_unreadable', { list: t('preview.list.directory') }));
    expect(resolutionBlockers(r)).toHaveLength(1);
  });

  it('a refused read of the user’s permissions keeps the pick but leaves the state out, and blocks approval', async () => {
    const forbidden = new NpiError({ status: 403, kind: 'forbidden', npiMessage: 'Insufficient permissions' });
    const r = await resolveFlow(fakeNpi({ getUserPermissions: jest.fn(async () => Promise.reject(forbidden)) }), 'user_permissions', values());
    expect(r.user?.kind).toBe('matched');
    expect(r.current).toEqual({});
    expect(r.notesAr).toContain(t('preview.list_unreadable', { list: t('preview.list.user_permissions') }));
    expect(resolutionBlockers(r)).toEqual([t('preview.user_permissions_unreadable')]);
  });

  it('a refused catalog read makes every permission pick unreadable', async () => {
    const forbidden = new NpiError({ status: 403, kind: 'forbidden', npiMessage: 'Insufficient permissions' });
    const r = await resolveFlow(fakeNpi({ permissionCatalog: jest.fn(async () => Promise.reject(forbidden)) }), 'user_permissions', values());
    expect(r.lines[0].permission?.kind).toBe('unreadable');
    expect(r.permissionLabels).toBeUndefined();
    expect(resolutionBlockers(r)).toHaveLength(1);
  });

  it('a defect that is not an NpiError is not swallowed', async () => {
    await expect(
      resolveFlow(fakeNpi({ listDepartmentDirectory: jest.fn(async () => Promise.reject(new Error('bug'))) }), 'user_permissions', values()),
    ).rejects.toThrow('bug');
  });
});
