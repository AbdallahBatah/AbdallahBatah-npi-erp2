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

  it('gives no view key to two screens, except exactly the allow-list P1-6 empties', () => {
    const screensByKey = new Map<string, string[]>();
    for (const s of SCREENS) {
      if (s.view !== undefined)
        screensByKey.set(s.view, [...(screensByKey.get(s.view) ?? []), s.href]);
    }
    const shared = Object.fromEntries(
      [...screensByKey].filter(([, hrefs]) => hrefs.length > 1),
    );
    // Both sides become {} together once the three keys are split.
    expect(shared).toEqual(SHARED_VIEW_KEYS_UNTIL_P1_6);
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
      'crm.lead.read',
      'finance.ledger.read',
    ]);
    expect(hrefsOf(visibleScreens(keys))).toEqual([
      ...GENERAL,
      '/leads',
      '/finance',
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
      const sharedWith = SHARED_VIEW_KEYS_UNTIL_P1_6[s.view];
      if (sharedWith) expect(sharedWith).toContain(row?.screen);
      else expect(row?.screen).toBe(s.href);
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
