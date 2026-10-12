/**
 * ADR-02 task 2 (P1-4) — the screen registry of @npi/shared: which screens
 * exist, which key opens each, and the functions that turn a permission set
 * into the screens a user sees. `packages/shared` has no jest setup of its own,
 * so this spec lives with the API (the arrangement of arabic.spec.ts) and
 * imports through the package entry point exactly as the services do.
 */
import {
  ALL_PERMISSIONS,
  PERMISSION_CATALOG,
  SCREEN_GROUPS,
  SCREENS,
  SHARED_VIEW_KEYS_UNTIL_P1_6,
  screenForPath,
  visibleGroups,
  visibleScreens,
} from '@npi/shared';

const GENERAL = ['/dashboard', '/inbox', '/approvals', '/copilot'];
const hrefsOf = (screens: readonly { href: string }[]) => screens.map((s) => s.href);

describe('screen registry', () => {
  it('has 24 screens in six groups, in sidebar order', () => {
    expect(SCREENS).toHaveLength(24);
    expect(SCREEN_GROUPS.map((g) => g.key)).toEqual([
      'general',
      'sales',
      'delivery',
      'operations',
      'finance',
      'admin',
    ]);
    expect(SCREEN_GROUPS[0]).toEqual({ key: 'general', labelAr: 'عام', labelEn: 'General' });
  });

  it('lists the screens group by group, in SCREEN_GROUPS order, each href once', () => {
    const groupIndex = SCREENS.map((s) => SCREEN_GROUPS.findIndex((g) => g.key === s.group));
    expect(groupIndex).not.toContain(-1);
    expect(groupIndex).toEqual([...groupIndex].sort((a, b) => a - b));
    expect(new Set(hrefsOf(SCREENS)).size).toBe(SCREENS.length);
  });

  it('opens General first with the four screens every user may open, none behind a key', () => {
    const general = SCREENS.filter((s) => s.group === 'general');
    expect(hrefsOf(SCREENS.slice(0, 4))).toEqual(GENERAL);
    expect(hrefsOf(general)).toEqual(GENERAL);
    expect(general.filter((s) => s.view !== undefined)).toEqual([]);
    // ...and every other screen has its key.
    expect(SCREENS.filter((s) => s.group !== 'general' && s.view === undefined)).toEqual([]);
  });

  it('names only view keys that exist', () => {
    for (const s of SCREENS) {
      if (s.view !== undefined) expect(ALL_PERMISSIONS).toContain(s.view);
    }
  });

  it('gives no view key to two screens, with no exception since P1-6', () => {
    const screensByKey = new Map<string, string[]>();
    for (const s of SCREENS) {
      if (s.view !== undefined)
        screensByKey.set(s.view, [...(screensByKey.get(s.view) ?? []), s.href]);
    }
    const shared = Object.fromEntries(
      [...screensByKey].filter(([, hrefs]) => hrefs.length > 1),
    );
    expect(shared).toEqual({});
    // The allow-list P1-4 introduced is empty and must stay so (ADR-02 hard rule 5).
    expect(SHARED_VIEW_KEYS_UNTIL_P1_6).toEqual({});
  });
});

describe('visibleScreens', () => {
  it('shows every screen, in registry order, to a holder of every key', () => {
    expect(visibleScreens(ALL_PERMISSIONS)).toEqual([...SCREENS]);
  });

  it('shows only the four General screens to a user with no keys', () => {
    expect(hrefsOf(visibleScreens([]))).toEqual(GENERAL);
  });

  it('keeps registry order whatever the order of the keys, and ignores unknown keys', () => {
    const keys = Object.freeze([
      'admin.user.manage',
      'no.such.key',
      'finance.ledger.read',
      'crm.lead.read',
      'finance.statement.read',
    ]);
    expect(hrefsOf(visibleScreens(keys))).toEqual([
      ...GENERAL,
      '/leads',
      '/statements',
      '/ledger',
      '/admin',
    ]);
  });

  it('follows the key, not its module: write and approve keys open nothing', () => {
    expect(
      hrefsOf(visibleScreens(['scm.procurement.write', 'scm.procurement.approve'])),
    ).toEqual(GENERAL);
  });
});

// ADR-02 task 4 (P1-6): the three keys that opened several screens were split.
// Migration 0030 grants each new key to every role holding its old key, so the
// "old + granted" sets below are what every such role holds after deploy.
describe('the split of the three shared view keys (P1-6)', () => {
  const SPLIT: ReadonlyArray<{ old: string; granted: string[]; before: string[] }> = [
    { old: 'crm.customer.read', granted: ['crm.task.read'], before: ['/customers', '/tasks'] },
    {
      old: 'scm.procurement.read',
      granted: ['scm.requisition.read'],
      before: ['/requisitions', '/procurement'],
    },
    {
      old: 'finance.ledger.read',
      granted: ['finance.report.read', 'finance.statement.read'],
      before: ['/finance', '/statements', '/ledger'],
    },
  ];

  it.each([
    ['crm.customer.read', '/customers'],
    ['crm.task.read', '/tasks'],
    ['scm.procurement.read', '/procurement'],
    ['scm.requisition.read', '/requisitions'],
    ['finance.ledger.read', '/ledger'],
    ['finance.report.read', '/finance'],
    ['finance.statement.read', '/statements'],
  ])('%s alone opens %s and nothing else', (key, href) => {
    expect(hrefsOf(visibleScreens([key]))).toEqual([...GENERAL, href]);
  });

  it.each(SPLIT)(
    'a role holding $old and what the migration grants sees exactly what $old opened before',
    ({ old, granted, before }) => {
      expect(hrefsOf(visibleScreens([old, ...granted]))).toEqual([...GENERAL, ...before]);
    },
  );

  it('keeps the old keys and adds the four new ones as view keys of their screens', () => {
    for (const { old, granted } of SPLIT) {
      expect(ALL_PERMISSIONS).toContain(old);
      for (const k of granted) expect(ALL_PERMISSIONS).toContain(k);
    }
    const viewRow = (key: string) => PERMISSION_CATALOG.find((p) => p.key === key);
    expect(viewRow('crm.task.read')).toMatchObject({ action: 'view', screen: '/tasks' });
    expect(viewRow('scm.requisition.read')).toMatchObject({ action: 'view', screen: '/requisitions' });
    expect(viewRow('finance.report.read')).toMatchObject({ action: 'view', screen: '/finance' });
    expect(viewRow('finance.statement.read')).toMatchObject({ action: 'view', screen: '/statements' });
    expect(viewRow('finance.ledger.read')).toMatchObject({
      action: 'view',
      screen: '/ledger',
      labelAr: 'عرض دفتر الأستاذ',
      labelEn: 'View general ledger',
      screenAr: 'دفتر الأستاذ',
      screenEn: 'General ledger',
    });
  });
});

describe('visibleGroups', () => {
  it('drops the groups left empty', () => {
    const groups = visibleGroups(['crm.lead.read', 'admin.user.manage']);
    expect(groups.map((g) => g.group.key)).toEqual(['general', 'sales', 'admin']);
    expect(groups.map((g) => hrefsOf(g.screens))).toEqual([GENERAL, ['/leads'], ['/admin']]);
  });

  it('is General alone for a user with no keys, and every group for a holder of all', () => {
    expect(visibleGroups([]).map((g) => g.group.key)).toEqual(['general']);
    const all = visibleGroups(ALL_PERMISSIONS);
    expect(all.map((g) => g.group)).toEqual([...SCREEN_GROUPS]);
    expect(all.flatMap((g) => g.screens)).toEqual([...SCREENS]);
  });
});

describe('screenForPath', () => {
  it.each([
    ['/customers', '/customers'],
    ['/customers/abc', '/customers'],
    ['/customers/abc/edit', '/customers'],
    ['/admin', '/admin'],
    ['/admin/anything', '/admin'],
    ['/copilot/chat', '/copilot'],
    ['/statements', '/statements'],
  ])('%s belongs to %s', (path, href) => {
    expect(screenForPath(path)?.href).toBe(href);
  });

  it.each(['/', '', '/administration', '/customersx', '/login', '/settings'])(
    '%p belongs to no screen',
    (path) => {
      expect(screenForPath(path)).toBeUndefined();
    },
  );

  it('finds every registry screen from its own path and from a page below it', () => {
    for (const s of SCREENS) {
      expect(screenForPath(s.href)).toBe(s);
      expect(screenForPath(`${s.href}/new`)).toBe(s);
    }
  });
});

describe('PERMISSION_CATALOG against the registry', () => {
  const registryHrefs = new Set<string>(hrefsOf(SCREENS));

  it('names a registry screen or none on every row', () => {
    for (const p of PERMISSION_CATALOG) {
      if (p.screen !== null) expect(registryHrefs).toContain(p.screen);
    }
  });

  it("puts each screen's view key on that screen's row, in the view column", () => {
    for (const s of SCREENS) {
      if (s.view === undefined) continue;
      const row = PERMISSION_CATALOG.find((p) => p.key === s.view);
      expect(row?.action).toBe('view');
      expect(row?.screen).toBe(s.href);
    }
  });

  it('has a view-column key only where it is the key that opens that screen', () => {
    for (const p of PERMISSION_CATALOG.filter((r) => r.action === 'view')) {
      expect(p.screen).not.toBeNull();
      expect(SCREENS.find((s) => s.href === p.screen)?.view).toBe(p.key);
    }
  });

  it('fills each grid cell (screen x view / write / approve) with at most one key', () => {
    const cells = PERMISSION_CATALOG.filter((p) => p.action !== 'special').map(
      (p) => `${p.screen} ${p.action}`,
    );
    expect(new Set(cells).size).toBe(cells.length);
  });

  it('lists a key with no screen among the special permissions', () => {
    for (const p of PERMISSION_CATALOG.filter((r) => r.screen === null)) {
      expect(p.action).toBe('special');
    }
  });
});
