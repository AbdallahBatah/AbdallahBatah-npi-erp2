// T-47b — keeping Madar's departments, positions and holders in step with NPI:
// the reconciliation (`syncFromNpi`), the administrator-login trigger in
// `createSession`, the /settings card and home banner data, and the two
// endpoints. Fakes only: an in-memory copilot database and a scripted NPI.
import path from 'node:path';

process.env.COPILOT_CATALOG_DIR = path.join(__dirname, '..', 'catalog');

jest.mock('../src/auth/session', () => ({
  ...jest.requireActual('../src/auth/session'),
  getServerSession: jest.fn(),
}));
jest.mock('../src/settings/deps', () => ({
  ...jest.requireActual('../src/settings/deps'),
  buildSyncActionDeps: jest.fn(),
}));
jest.mock('../src/db', () => ({ getDb: jest.fn() }));

import { NextRequest } from 'next/server';
import { createSession, getServerSession, LOGIN_SYNC_TIMEOUT_MS, type SessionDb, type SessionDeps } from '../src/auth/session';
import { parseKey } from '../src/crypto/aead';
import { getDb } from '../src/db';
import { formatAgo } from '../src/i18n/format';
import { t } from '../src/i18n/ar';
import { loadProfilePack } from '../src/onboarding/catalog';
import {
  isEmptyDiff,
  SYNC_PERMISSION,
  SYNC_THROTTLE_MS,
  syncFromNpi,
  type StoredSyncDiff,
  type SyncDb,
  type SyncNpi,
  type SyncOutcome,
  type SyncReason,
} from '../src/onboarding/sync';
import { NpiError } from '../src/npi/errors';
import type { NpiLogin, NpiMe } from '../src/npi/responses';
import { buildSettingsDeps, buildSyncActionDeps } from '../src/settings/deps';
import { getSettingsView, type SettingsDb } from '../src/settings/service';
import { buildSyncBanner, buildSyncView, markSyncSeen, runManualSync, type SyncActionDb } from '../src/settings/sync';
import { POST as syncPost } from '../src/app/api/settings/sync/route';
import { POST as seenPost } from '../src/app/api/settings/sync/seen/route';
import { PERMISSION_CATALOG } from '../../../packages/shared/src/permissions';

const ORG = 'org-1';
const ALL_PERMISSIONS: string[] = PERMISSION_CATALOG.map((p) => p.key as string);
const ADMIN_ME = { id: 'u_admin', roleKey: 'admin', permissions: ALL_PERMISSIONS };

// ─── NPI, scripted ──────────────────────────────────────────────────────────

interface FakeUser {
  id: string;
  nameAr: string;
  roleKey: string;
  isActive: boolean;
  departmentId: string | null;
}

function buildNpi() {
  const epc = loadProfilePack('epc');
  const state = {
    roles: Object.entries(epc.rolePermissionSets).map(([key, set], i) => ({
      id: `role_${i}`,
      key,
      nameAr: set.nameAr,
      permissions: [...set.permissions],
    })),
    departments: [
      { id: 'dept_SALES', code: 'SALES', nameAr: 'المبيعات', isActive: true },
      { id: 'dept_PROJ', code: 'PROJ', nameAr: 'المشاريع', isActive: true },
      { id: 'dept_FIN', code: 'FIN', nameAr: 'المالية', isActive: true },
    ],
    users: [
      { id: 'u_admin', nameAr: 'المدير', roleKey: 'admin', isActive: true, departmentId: null },
      { id: 'u_sales', nameAr: 'سعد', roleKey: 'sales', isActive: true, departmentId: 'dept_SALES' },
      { id: 'u_pm', nameAr: 'ماجد', roleKey: 'pm', isActive: true, departmentId: 'dept_PROJ' },
      { id: 'u_acc', nameAr: 'نورة', roleKey: 'accountant', isActive: true, departmentId: 'dept_FIN' },
    ] as FakeUser[],
  };
  const calls: string[] = [];
  const npi: SyncNpi = {
    listRoles: async () => (calls.push('listRoles'), state.roles.map((r) => ({ ...r }))),
    listDepartments: async () => (calls.push('listDepartments'), state.departments.map((d) => ({ ...d, manager: null, parent: null }))),
    listDepartmentDirectory: async () =>
      (calls.push('listDepartmentDirectory'),
      state.users.map((u) => ({ id: u.id, nameAr: u.nameAr, isActive: u.isActive, departmentId: u.departmentId, role: { key: u.roleKey } }))),
  };
  return { npi, state, calls };
}

// ─── The copilot database, in memory ────────────────────────────────────────

interface PositionRow {
  id: string;
  npiOrgId: string;
  roleKey: string;
  departmentId: string | null;
  titleAr: string;
  personaAr: string;
}
interface AssignmentRow {
  id: string;
  positionId: string;
  npiUserId: string;
  startedAt: Date;
  endedAt: Date | null;
}
interface RunRow {
  npiOrgId: string;
  at: Date;
  byNpiUserId: string;
  reason: SyncReason;
  diffJson: unknown;
  namesJson: unknown;
  skipped: string | null;
}
interface FirmRow {
  npiOrgId: string;
  profileKey: string | null;
  setupCompletedAt: Date | null;
  lastSyncAt: Date | null;
  lastSyncDiffJson: StoredSyncDiff | null;
  lastSyncSeenAt: Date | null;
}

function buildDb(firm: Partial<FirmRow> | null = {}) {
  const firms = new Map<string, FirmRow>();
  if (firm !== null) {
    firms.set(ORG, { npiOrgId: ORG, profileKey: 'epc', setupCompletedAt: new Date('2026-10-01T00:00:00Z'), lastSyncAt: null, lastSyncDiffJson: null, lastSyncSeenAt: null, ...firm });
  }
  const positions: PositionRow[] = [];
  const assignments: AssignmentRow[] = [];
  const runs: RunRow[] = [];
  let seq = 0;
  const db = {
    firmConfig: {
      async findUnique({ where }: { where: { npiOrgId: string } }) {
        const row = firms.get(where.npiOrgId);
        return row ? { ...row } : null;
      },
      async updateMany({ where, data }: { where: { npiOrgId: string; OR: ({ lastSyncAt: null } | { lastSyncAt: { lte: Date } })[] }; data: { lastSyncAt?: Date; lastSyncSeenAt?: Date } }) {
        const row = firms.get(where.npiOrgId);
        if (!row) return { count: 0 };
        if (where.OR) {
          const ok = where.OR.some((c) => (c.lastSyncAt === null ? row.lastSyncAt === null : row.lastSyncAt !== null && row.lastSyncAt <= c.lastSyncAt.lte));
          if (row.setupCompletedAt === null || !ok) return { count: 0 };
        }
        Object.assign(row, data);
        return { count: 1 };
      },
      async update({ where, data }: { where: { npiOrgId: string }; data: Partial<FirmRow> }) {
        Object.assign(firms.get(where.npiOrgId)!, data);
        return firms.get(where.npiOrgId);
      },
    },
    position: {
      async findMany({ where }: { where: { npiOrgId: string } }) {
        return positions.filter((p) => p.npiOrgId === where.npiOrgId).map((p) => ({ ...p }));
      },
      async create({ data }: { data: Omit<PositionRow, 'id'> }) {
        const row = { id: `pos_${++seq}`, ...data };
        positions.push(row);
        return { id: row.id };
      },
      async update({ where, data }: { where: { id: string }; data: { titleAr: string } }) {
        Object.assign(positions.find((p) => p.id === where.id)!, data);
        return {};
      },
    },
    positionAssignment: {
      async findMany({ where }: { where: { endedAt: null; position: { npiOrgId: string } } }) {
        const inOrg = new Set(positions.filter((p) => p.npiOrgId === where.position.npiOrgId).map((p) => p.id));
        return assignments.filter((a) => a.endedAt === null && inOrg.has(a.positionId)).map((a) => ({ id: a.id, positionId: a.positionId, npiUserId: a.npiUserId }));
      },
      async create({ data }: { data: { positionId: string; npiUserId: string } }) {
        assignments.push({ id: `as_${++seq}`, startedAt: new Date(), endedAt: null, ...data });
        return {};
      },
      async updateMany({ where, data }: { where: { id: { in: string[] }; endedAt: null }; data: { endedAt: Date } }) {
        for (const a of assignments) if (where.id.in.includes(a.id) && a.endedAt === null) a.endedAt = data.endedAt;
        return {};
      },
    },
    syncRun: {
      async create({ data }: { data: RunRow }) {
        runs.push({ ...data });
        return {};
      },
      async findFirst({ where }: { where: { npiOrgId: string; skipped: null } }) {
        const ok = runs.filter((r) => r.npiOrgId === where.npiOrgId && r.skipped === null).sort((a, b) => b.at.getTime() - a.at.getTime());
        return ok[0] ? { namesJson: ok[0].namesJson } : null;
      },
    },
    /** All or nothing: a throw inside restores every table (in place, so the
     *  helpers' references keep working) and rethrows. */
    async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      const snapshot = {
        positions: positions.map((p) => ({ ...p })),
        assignments: assignments.map((a) => ({ ...a })),
        runs: runs.map((r) => ({ ...r })),
        firms: [...firms].map(([key, row]) => [key, { ...row }] as const),
      };
      try {
        return await fn(db);
      } catch (e) {
        positions.splice(0, positions.length, ...snapshot.positions);
        assignments.splice(0, assignments.length, ...snapshot.assignments);
        runs.splice(0, runs.length, ...snapshot.runs);
        firms.clear();
        for (const [key, row] of snapshot.firms) firms.set(key, row);
        throw e;
      }
    },
  };
  return { db: db as unknown as SyncDb & SyncActionDb, firms, positions, assignments, runs };
}

const PERSONA_TEXT = 'تتولى هذه الوظيفة متابعة أعمالها اليومية في NPI وفق صلاحيات دورها، وتعاون زملاءها في القسم على إنجاز المستندات.';
const PERSONA = () => PERSONA_TEXT;
let clock = new Date('2026-10-10T08:00:00Z');
const now = () => clock;
const minutes = (n: number) => new Date(clock.getTime() + n * 60_000);

async function sync(
  h: ReturnType<typeof buildDb>,
  n: ReturnType<typeof buildNpi>,
  reason: SyncReason = 'manual',
  me: { id: string; roleKey: string; permissions: string[] } = ADMIN_ME,
): Promise<SyncOutcome> {
  return syncFromNpi({ orgId: ORG, npi: n.npi, me, reason, db: h.db, now, personaFor: PERSONA });
}

function done(outcome: SyncOutcome) {
  if (outcome.skipped !== null) throw new Error(`skipped: ${outcome.skipped}`);
  return outcome;
}

const openOf = (h: ReturnType<typeof buildDb>, userId: string) => h.assignments.filter((a) => a.npiUserId === userId && a.endedAt === null);
const positionOf = (h: ReturnType<typeof buildDb>, assignment: AssignmentRow) => h.positions.find((p) => p.id === assignment.positionId)!;

beforeEach(() => {
  clock = new Date('2026-10-10T08:00:00Z');
  jest.restoreAllMocks();
});

// ─── The reconciliation ─────────────────────────────────────────────────────

describe('syncFromNpi: reconciliation', () => {
  it('reads only roles, departments and the directory, as the caller, and creates the positions and holders NPI shows', async () => {
    const h = buildDb();
    const n = buildNpi();
    const out = done(await sync(h, n));

    expect(new Set(n.calls)).toEqual(new Set(['listRoles', 'listDepartments', 'listDepartmentDirectory']));
    expect(out.diff.addedPositions.map((p) => p.roleKey).sort()).toEqual(['accountant', 'admin', 'pm', 'sales']);
    expect(out.diff.addedAssignments).toHaveLength(4);
    expect(out.changed).toBe(true);
    expect(h.positions).toHaveLength(4);
    expect(openOf(h, 'u_sales')).toHaveLength(1);
    const salesPosition = positionOf(h, openOf(h, 'u_sales')[0]);
    expect(salesPosition).toMatchObject({ roleKey: 'sales', departmentId: 'dept_SALES', titleAr: 'مندوب مبيعات — المبيعات', personaAr: PERSONA_TEXT });
    expect(out.diff.summaryAr).toContain(t('sync.item.added_position', { title: 'مندوب مبيعات — المبيعات' }));
    expect(out.diff.summaryAr).toContain(t('sync.item.added_assignment', { name: 'سعد', title: 'مندوب مبيعات — المبيعات' }));
    expect(h.firms.get(ORG)!.lastSyncAt).toEqual(clock);
    expect(h.firms.get(ORG)!.lastSyncDiffJson).toMatchObject({ at: clock.toISOString(), summaryAr: out.diff.summaryAr });
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]).toMatchObject({ reason: 'manual', byNpiUserId: 'u_admin', skipped: null });
  });

  it('a second run with nothing new has an empty diff, keeps the previous diff, and bumps only lastSyncAt', async () => {
    const h = buildDb();
    const n = buildNpi();
    const first = done(await sync(h, n));
    const storedBefore = h.firms.get(ORG)!.lastSyncDiffJson;

    clock = minutes(30);
    const second = done(await sync(h, n));

    expect(second.changed).toBe(false);
    expect(isEmptyDiff(second.diff)).toBe(true);
    expect(second.diff.summaryAr).toEqual([]);
    expect(second.diff.unchanged).toBe(4);
    expect(h.positions).toHaveLength(4);
    expect(h.assignments).toHaveLength(4);
    expect(h.firms.get(ORG)!.lastSyncAt).toEqual(clock);
    expect(h.firms.get(ORG)!.lastSyncDiffJson).toBe(storedBefore);
    expect(first.at).not.toBe(second.at);
    expect(h.runs).toHaveLength(2);
  });

  it('a new user in NPI gets an assignment on the existing position', async () => {
    const h = buildDb();
    const n = buildNpi();
    done(await sync(h, n));
    n.state.users.push({ id: 'u_sales2', nameAr: 'خالد', roleKey: 'sales', isActive: true, departmentId: 'dept_SALES' });

    clock = minutes(15);
    const out = done(await sync(h, n));

    expect(out.diff.addedPositions).toEqual([]);
    expect(out.diff.addedAssignments).toEqual([{ npiUserId: 'u_sales2', nameAr: 'خالد', titleAr: 'مندوب مبيعات — المبيعات' }]);
    expect(openOf(h, 'u_sales2')).toHaveLength(1);
    expect(openOf(h, 'u_sales2')[0].positionId).toBe(openOf(h, 'u_sales')[0].positionId);
    expect(openOf(h, 'u_sales')).toHaveLength(1);
    expect(h.firms.get(ORG)!.lastSyncDiffJson!.summaryAr).toEqual([t('sync.item.added_assignment', { name: 'خالد', title: 'مندوب مبيعات — المبيعات' })]);
  });

  it('a deactivated user has the assignment ended, not deleted; a position that lost its last holder stays and is flagged', async () => {
    const h = buildDb();
    const n = buildNpi();
    done(await sync(h, n));
    const rowsBefore = h.assignments.length;
    const pmAssignment = openOf(h, 'u_pm')[0];
    n.state.users.find((u) => u.id === 'u_pm')!.isActive = false;

    clock = minutes(15);
    const out = done(await sync(h, n));

    expect(out.diff.endedAssignments).toEqual([{ npiUserId: 'u_pm', nameAr: 'ماجد', titleAr: 'مدير المشاريع — المشاريع', reason: 'inactive' }]);
    expect(out.diff.emptiedPositions).toEqual([{ roleKey: 'pm', departmentCode: 'PROJ', titleAr: 'مدير المشاريع — المشاريع' }]);
    expect(h.assignments).toHaveLength(rowsBefore); // nothing deleted
    expect(h.assignments.find((a) => a.id === pmAssignment.id)!.endedAt).toEqual(clock);
    expect(h.positions.some((p) => p.id === pmAssignment.positionId)).toBe(true);
    expect(out.diff.summaryAr).toEqual([
      t('sync.item.ended_inactive', { name: 'ماجد', title: 'مدير المشاريع — المشاريع' }),
      t('sync.item.emptied_position', { title: 'مدير المشاريع — المشاريع' }),
    ]);

    // The empty position is not reported again on the next run.
    clock = minutes(45);
    expect(done(await sync(h, n)).diff.emptiedPositions).toEqual([]);
  });

  it('a user gone from the directory is ended as removed', async () => {
    const h = buildDb();
    const n = buildNpi();
    done(await sync(h, n));
    n.state.users = n.state.users.filter((u) => u.id !== 'u_acc');

    clock = minutes(15);
    const out = done(await sync(h, n));

    expect(out.diff.endedAssignments).toMatchObject([{ npiUserId: 'u_acc', nameAr: null, reason: 'removed' }]);
    expect(out.diff.summaryAr[0]).toBe(t('sync.item.ended_removed', { name: t('sync.user.unknown'), title: 'محاسب — المالية' }));
  });

  it('a renamed role updates the title of positions Madar built from the old name, and only those', async () => {
    const h = buildDb();
    const n = buildNpi();
    done(await sync(h, n)); // records the names it saw
    h.positions.find((p) => p.roleKey === 'accountant')!.titleAr = 'رئيس الحسابات'; // an administrator's own title
    n.state.roles.find((r) => r.key === 'sales')!.nameAr = 'مسؤول مبيعات';
    n.state.roles.find((r) => r.key === 'accountant')!.nameAr = 'محاسب أول';

    clock = minutes(15);
    const out = done(await sync(h, n));

    expect(out.diff.renamedPositions).toEqual([
      { roleKey: 'sales', departmentCode: 'SALES', fromAr: 'مندوب مبيعات — المبيعات', toAr: 'مسؤول مبيعات — المبيعات' },
    ]);
    expect(h.positions.find((p) => p.roleKey === 'sales')!.titleAr).toBe('مسؤول مبيعات — المبيعات');
    expect(h.positions.find((p) => p.roleKey === 'accountant')!.titleAr).toBe('رئيس الحسابات');
    expect(out.diff.summaryAr).toEqual([t('sync.item.renamed_position', { from: 'مندوب مبيعات — المبيعات', to: 'مسؤول مبيعات — المبيعات' })]);
    expect(h.positions).toHaveLength(4);
  });

  it('a renamed department updates the title the same way', async () => {
    const h = buildDb();
    const n = buildNpi();
    done(await sync(h, n));
    n.state.departments.find((d) => d.code === 'PROJ')!.nameAr = 'إدارة المشاريع';

    clock = minutes(15);
    const out = done(await sync(h, n));

    expect(out.diff.renamedPositions).toMatchObject([{ roleKey: 'pm', toAr: 'مدير المشاريع — إدارة المشاريع' }]);
  });

  it('a user who moved department has the old assignment ended and a new one added (the position is created when new)', async () => {
    const h = buildDb();
    const n = buildNpi();
    done(await sync(h, n));
    const oldAssignment = openOf(h, 'u_sales')[0];
    n.state.users.find((u) => u.id === 'u_sales')!.departmentId = 'dept_PROJ';

    clock = minutes(15);
    const out = done(await sync(h, n));

    expect(out.diff.addedPositions).toMatchObject([{ roleKey: 'sales', departmentCode: 'PROJ', titleAr: 'مندوب مبيعات — المشاريع' }]);
    expect(out.diff.endedAssignments).toMatchObject([{ npiUserId: 'u_sales', reason: 'moved' }]);
    expect(out.diff.addedAssignments).toMatchObject([{ npiUserId: 'u_sales', titleAr: 'مندوب مبيعات — المشاريع' }]);
    expect(out.diff.emptiedPositions).toMatchObject([{ roleKey: 'sales', departmentCode: 'SALES' }]);
    expect(h.assignments.find((a) => a.id === oldAssignment.id)!.endedAt).toEqual(clock);
    expect(openOf(h, 'u_sales')).toHaveLength(1);
    expect(positionOf(h, openOf(h, 'u_sales')[0]).departmentId).toBe('dept_PROJ');
  });

  it('an active user whose role cannot be read keeps their assignment, and an organization with no setup is left alone', async () => {
    const h = buildDb();
    const n = buildNpi();
    done(await sync(h, n));
    // The role loses every permission: the reader leaves its users out.
    n.state.roles.find((r) => r.key === 'accountant')!.permissions = [];

    clock = minutes(15);
    const out = done(await sync(h, n));
    expect(out.diff.endedAssignments).toEqual([]);
    expect(openOf(h, 'u_acc')).toHaveLength(1);

    const fresh = buildDb({ setupCompletedAt: null });
    expect(await sync(fresh, n)).toEqual({ skipped: 'not_set_up' });
    expect(await sync(buildDb(null), n)).toEqual({ skipped: 'not_set_up' });
    expect(fresh.positions).toEqual([]);
  });

  it('an organization too thin to read is skipped as unreadable and nothing is written', async () => {
    const h = buildDb();
    const n = buildNpi();
    n.state.users = [];

    const out = await sync(h, n);

    expect(out).toEqual({ skipped: 'unreadable' });
    expect(h.positions).toEqual([]);
    expect(h.runs).toMatchObject([{ skipped: 'unreadable', diffJson: null }]);
    expect(h.firms.get(ORG)!.lastSyncAt).toBeNull();
  });

  it('a holder whose department NPI deactivated keeps the assignment; no department-less position is invented', async () => {
    const h = buildDb();
    const n = buildNpi();
    done(await sync(h, n));
    const salesAssignment = openOf(h, 'u_sales')[0];
    const positionsBefore = h.positions.map((p) => ({ ...p }));
    n.state.departments.find((d) => d.code === 'SALES')!.isActive = false;

    clock = minutes(15);
    const out = done(await sync(h, n));

    expect(isEmptyDiff(out.diff)).toBe(true);
    expect(out.changed).toBe(false);
    expect(out.diff.unchanged).toBe(3); // the other three holders; the stranded one is neither agreed nor moved
    expect(h.assignments.find((a) => a.id === salesAssignment.id)!.endedAt).toBeNull();
    expect(openOf(h, 'u_sales')).toHaveLength(1);
    expect(h.positions).toEqual(positionsBefore);
    expect(h.positions.some((p) => p.roleKey === 'sales' && p.departmentId === null)).toBe(false);
  });
});

describe('syncFromNpi: throttle, permissions, failures', () => {
  it('a login within 10 minutes of the last sync is skipped without reading NPI; a manual run is not', async () => {
    const h = buildDb();
    const n = buildNpi();
    done(await sync(h, n, 'login'));
    n.calls.length = 0;

    clock = minutes(SYNC_THROTTLE_MS / 60_000 - 1);
    expect(await sync(h, n, 'login')).toEqual({ skipped: 'throttled' });
    expect(n.calls).toEqual([]);
    expect(h.runs).toHaveLength(1);

    expect(done(await sync(h, n, 'manual')).skipped).toBeNull();
    expect(n.calls.length).toBeGreaterThan(0);
    expect(h.runs).toHaveLength(2);
  });

  it('a login after the window syncs again', async () => {
    const h = buildDb();
    const n = buildNpi();
    done(await sync(h, n, 'login'));
    clock = minutes(10);
    expect(done(await sync(h, n, 'login')).skipped).toBeNull();
  });

  it('two administrators logging in together sync once', async () => {
    const h = buildDb();
    const n = buildNpi();
    const [a, b] = await Promise.all([sync(h, n, 'login'), sync(h, n, 'login')]);
    expect([a.skipped, b.skipped].sort()).toEqual([null, 'throttled']);
    expect(h.positions).toHaveLength(4);
    expect(h.assignments).toHaveLength(4);
  });

  it('a caller without the read permissions is skipped without throwing, and the throttle slot is kept, so the next login within the window is throttled; a manual run still reads', async () => {
    const h = buildDb();
    const n = buildNpi();
    const me = { id: 'u_sales', roleKey: 'sales', permissions: ALL_PERMISSIONS.filter((p) => p !== SYNC_PERMISSION) };

    const out = await sync(h, n, 'login', me);

    expect(out).toEqual({ skipped: 'permission', missing: [SYNC_PERMISSION] });
    expect(n.calls).toEqual(['listRoles']); // the one read this caller's permissions cover
    expect(h.firms.get(ORG)!.lastSyncAt).toEqual(clock);
    expect(h.runs).toMatchObject([{ skipped: 'permission' }]);
    expect(h.positions).toEqual([]);

    // NPI was read once: the next login inside the window does not read it again…
    n.calls.length = 0;
    clock = minutes(5);
    expect(await sync(h, n, 'login')).toEqual({ skipped: 'throttled' });
    expect(n.calls).toEqual([]);
    expect(h.runs).toHaveLength(1);
    // …but the button always runs, so an administrator who just got the permission can use it
    expect(done(await sync(h, n, 'manual')).skipped).toBeNull();
    expect(h.positions).toHaveLength(4);
  });

  it('an organization too thin to read keeps the throttle slot the same way', async () => {
    const h = buildDb();
    const n = buildNpi();
    n.state.users = [];

    expect(await sync(h, n, 'login')).toEqual({ skipped: 'unreadable' });
    expect(h.firms.get(ORG)!.lastSyncAt).toEqual(clock);
    expect(h.runs).toMatchObject([{ skipped: 'unreadable', diffJson: null }]);

    n.calls.length = 0;
    clock = minutes(5);
    expect(await sync(h, n, 'login')).toEqual({ skipped: 'throttled' });
    expect(n.calls).toEqual([]);
    expect(h.runs).toHaveLength(1);
  });

  it('NPI answering 403 on a read is a skipped permission too', async () => {
    const h = buildDb();
    const n = buildNpi();
    n.npi.listDepartments = async () => {
      throw new NpiError({ kind: 'forbidden', status: 403, npiMessage: null });
    };
    const out = await sync(h, n);
    expect(out).toEqual({ skipped: 'permission', missing: [SYNC_PERMISSION] });
  });

  it('a failing read rejects, and a login that claimed the slot gives it back', async () => {
    const h = buildDb({ lastSyncAt: new Date('2026-10-10T07:00:00Z') });
    const n = buildNpi();
    n.npi.listRoles = async () => {
      throw new NpiError({ kind: 'network', status: 0, npiMessage: null });
    };
    await expect(sync(h, n, 'login')).rejects.toBeInstanceOf(NpiError);
    expect(h.firms.get(ORG)!.lastSyncAt).toEqual(new Date('2026-10-10T07:00:00Z'));
  });

  it('a write failing inside the transaction leaves the organization exactly as it was, and a login gives its slot back', async () => {
    const h = buildDb();
    const n = buildNpi();
    done(await sync(h, n)); // a synced organization at 08:00
    const state = () => JSON.parse(JSON.stringify({ positions: h.positions, assignments: h.assignments, runs: h.runs, firm: h.firms.get(ORG) }));
    const before = state();
    // a new sales holder in the project department: a new position AND a new assignment
    n.state.users.push({ id: 'u_sales2', nameAr: 'خالد', roleKey: 'sales', isActive: true, departmentId: 'dept_PROJ' });
    jest.spyOn(h.db.positionAssignment, 'create').mockRejectedValueOnce(new Error('connection lost'));

    clock = minutes(15);
    await expect(sync(h, n, 'login')).rejects.toThrow('connection lost');

    expect(state()).toEqual(before); // the position created before the failure is gone too; lastSyncAt and lastSyncDiffJson untouched
    expect(h.firms.get(ORG)!.lastSyncAt).toEqual(new Date('2026-10-10T08:00:00Z'));

    // the slot was given back, so the very next login runs and writes everything
    clock = minutes(16);
    const out = done(await sync(h, n, 'login'));
    expect(out.diff.addedPositions).toMatchObject([{ roleKey: 'sales', departmentCode: 'PROJ' }]);
    expect(out.diff.addedAssignments).toMatchObject([{ npiUserId: 'u_sales2' }]);
    expect(openOf(h, 'u_sales2')).toHaveLength(1);
  });
});

// ─── The login trigger ──────────────────────────────────────────────────────

describe('createSession: the NPI sync at an administrator login', () => {
  const KEY = parseKey('11'.repeat(32));

  function login(permissions: string[]): NpiLogin {
    const me: NpiMe = { id: 'u_admin', organizationId: ORG, nameAr: 'المدير', roleKey: 'admin', roleNameAr: 'مدير النظام', permissions, orgNameAr: null };
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
    return { accessToken: `h.${payload}.s`, user: me };
  }
  function deps(sync: SessionDeps['sync']): SessionDeps {
    const rows = new Map<string, unknown>();
    const db = {
      copilotSession: {
        create: async ({ data }: { data: { id: string } }) => (rows.set(data.id, data), data),
        findUnique: async () => null,
        updateMany: async () => ({}),
        deleteMany: async () => ({}),
      },
    } as unknown as SessionDb;
    return {
      db,
      key: KEY,
      npiFor: () => ({ me: async () => ({}), listDepartments: async () => [], listDepartmentDirectory: async () => [] }),
      positions: async () => ({ positionId: 'p', roleKey: 'admin', departmentId: null, departmentNameAr: null, titleAr: 'مدير', personaAr: 'x', source: 'role_only' as const }),
      sync,
    };
  }

  it('runs the sync with reason login for a holder of admin.department.manage', async () => {
    const sync = jest.fn(async (_args: unknown) => ({ skipped: 'throttled' as const }));
    const { user } = await createSession(deps(sync), login(ALL_PERMISSIONS));
    expect(user.nameAr).toBe('المدير');
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync.mock.calls[0][0]).toMatchObject({ orgId: ORG, reason: 'login', me: { id: 'u_admin' } });
  });

  it('does not sync for a user without the permission', async () => {
    const sync = jest.fn(async (_args: unknown) => ({ skipped: 'throttled' as const }));
    await createSession(deps(sync), login(['crm.lead.read']));
    expect(sync).not.toHaveBeenCalled();
  });

  it('never fails the login when the sync throws, and logs it', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const sync = jest.fn(async () => {
      throw new Error('boom');
    });
    const out = await createSession(deps(sync), login(ALL_PERMISSIONS));
    expect(out.cookieValue.length).toBeGreaterThan(10);
    expect(error).toHaveBeenCalledWith('[copilot] NPI sync at login failed', 'boom');
  });

  it('never fails the login when the sync throws synchronously', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const sync = jest.fn(() => {
      throw new Error('sync boom');
    }) as unknown as SessionDeps['sync'];
    await expect(createSession(deps(sync), login(ALL_PERMISSIONS))).resolves.toMatchObject({ user: { nameAr: 'المدير' } });
  });

  it('gives up on a sync still running after 10 seconds', async () => {
    jest.useFakeTimers();
    try {
      const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const sync = jest.fn(() => new Promise<never>(() => undefined));
      let finished = false;
      const pending = createSession(deps(sync), login(ALL_PERMISSIONS)).then((r) => {
        finished = true;
        return r;
      });
      await jest.advanceTimersByTimeAsync(LOGIN_SYNC_TIMEOUT_MS - 1);
      expect(finished).toBe(false);
      await jest.advanceTimersByTimeAsync(2);
      await expect(pending).resolves.toMatchObject({ user: { nameAr: 'المدير' } });
      expect(error).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});

// ─── Card, banner and the manual sync ───────────────────────────────────────

describe('settings: the sync card, the banner and the manual sync', () => {
  const diff = (at: string, lines: string[]): StoredSyncDiff => ({
    addedPositions: [],
    renamedPositions: [],
    addedAssignments: [],
    endedAssignments: [],
    emptiedPositions: [],
    unchanged: 0,
    summaryAr: lines,
    at,
  });

  it('formatAgo uses the Arabic number agreement', () => {
    const base = new Date('2026-10-10T12:00:00Z');
    const ago = (ms: number) => formatAgo(new Date(base.getTime() - ms), base);
    expect(ago(20_000)).toBe('الآن');
    expect(ago(60_000)).toBe('منذ دقيقة');
    expect(ago(120_000)).toBe('منذ دقيقتين');
    expect(ago(5 * 60_000)).toBe('منذ 5 دقائق');
    expect(ago(12 * 60_000)).toBe('منذ 12 دقيقة');
    expect(ago(3 * 3_600_000)).toBe('منذ 3 ساعات');
    expect(ago(2 * 86_400_000)).toBe('منذ يومين');
    expect(ago(60 * 86_400_000)).toMatch(/^في /);
  });

  it('buildSyncView: canSync needs the permission and a setup; the times are ready text', () => {
    const at = new Date('2026-10-10T11:50:00Z');
    const nowAt = new Date('2026-10-10T12:00:00Z');
    const row = { lastSyncAt: at, lastSyncDiffJson: diff('2026-10-10T11:00:00Z', ['أ', 'ب']) };
    expect(buildSyncView(row, [SYNC_PERMISSION], nowAt)).toEqual({
      canSync: true,
      lastSyncAt: at.toISOString(),
      lastSyncAgoAr: 'منذ 10 دقائق',
      lastDiff: { at: '2026-10-10T11:00:00.000Z'.replace('.000Z', 'Z'), agoAr: 'منذ ساعة', summaryAr: ['أ', 'ب'] },
    });
    expect(buildSyncView(row, ['admin.user.manage'], nowAt).canSync).toBe(false);
    expect(buildSyncView(null, [SYNC_PERMISSION], nowAt)).toEqual({ canSync: false, lastSyncAt: null, lastSyncAgoAr: null, lastDiff: null });
    expect(buildSyncView({ lastSyncAt: at, lastSyncDiffJson: { junk: true } }, [SYNC_PERMISSION], nowAt).lastDiff).toBeNull();
  });

  it('buildSyncBanner: first three lines, only for the permission, hidden once seen, and a later empty sync does not bring it back', () => {
    const lines = ['1', '2', '3', '4', '5'];
    const stored = diff('2026-10-10T09:00:00.000Z', lines);
    expect(buildSyncBanner({ lastSyncDiffJson: stored, lastSyncSeenAt: null, lastSyncAt: new Date('2026-10-10T09:00:00Z') }, [SYNC_PERMISSION])).toEqual({
      lines: ['1', '2', '3'],
      more: 2,
    });
    expect(buildSyncBanner({ lastSyncDiffJson: stored, lastSyncSeenAt: null }, ['admin.user.manage'])).toBeNull();
    expect(buildSyncBanner({ lastSyncDiffJson: null, lastSyncSeenAt: null }, [SYNC_PERMISSION])).toBeNull();
    expect(buildSyncBanner({ lastSyncDiffJson: diff('2026-10-10T09:00:00.000Z', []), lastSyncSeenAt: null }, [SYNC_PERMISSION])).toBeNull();
    // seen after the change was found: hidden, even though lastSyncAt moved on afterwards
    expect(
      buildSyncBanner(
        { lastSyncDiffJson: stored, lastSyncSeenAt: new Date('2026-10-10T09:30:00Z'), lastSyncAt: new Date('2026-10-10T11:00:00Z') },
        [SYNC_PERMISSION],
      ),
    ).toBeNull();
    // seen BEFORE a newer change: shown again
    expect(
      buildSyncBanner({ lastSyncDiffJson: diff('2026-10-10T10:00:00.000Z', ['x']), lastSyncSeenAt: new Date('2026-10-10T09:30:00Z') }, [SYNC_PERMISSION]),
    ).toEqual({ lines: ['x'], more: 0 });
  });

  it('runManualSync: runs without the throttle as the caller, returns the message and the refreshed card', async () => {
    const h = buildDb();
    const n = buildNpi();
    const caller = { npiOrgId: ORG, npiUserId: 'u_admin', roleKey: 'admin', permissions: ALL_PERMISSIONS };

    const first = await runManualSync({ db: h.db, npi: n.npi, now }, caller);
    expect(first).toMatchObject({ outcome: 'synced', changed: true, messageAr: t('sync.done') });
    expect(first.sync).toMatchObject({ canSync: true, lastSyncAgoAr: 'الآن' });
    expect(first.sync.lastDiff!.summaryAr.length).toBeGreaterThan(0);

    const again = await runManualSync({ db: h.db, npi: n.npi, now }, caller);
    expect(again).toMatchObject({ outcome: 'synced', changed: false, messageAr: t('sync.no_change'), summaryAr: [] });

    await expect(runManualSync({ db: h.db, npi: n.npi, now }, { ...caller, permissions: ['admin.user.manage'] })).rejects.toThrow('admin.department.manage');
  });

  it('runManualSync reports a refused read as a skipped result, not an error', async () => {
    const h = buildDb({ setupCompletedAt: null });
    const n = buildNpi();
    const out = await runManualSync({ db: h.db, npi: n.npi, now }, { npiOrgId: ORG, npiUserId: 'u_admin', roleKey: 'admin', permissions: ALL_PERMISSIONS });
    expect(out).toMatchObject({ outcome: 'skipped', skipped: 'not_set_up', messageAr: t('sync.skipped.not_set_up') });
  });

  it('markSyncSeen stamps lastSyncSeenAt and needs the permission', async () => {
    const h = buildDb();
    const caller = { npiOrgId: ORG, npiUserId: 'u_admin', roleKey: 'admin', permissions: [SYNC_PERMISSION] };
    await markSyncSeen({ db: h.db as unknown as Parameters<typeof markSyncSeen>[0]['db'], now }, caller);
    expect(h.firms.get(ORG)!.lastSyncSeenAt).toEqual(clock);
    await expect(markSyncSeen({ db: h.db as unknown as Parameters<typeof markSyncSeen>[0]['db'], now }, { ...caller, permissions: [] })).rejects.toThrow();
  });

  it('getSettingsView carries the sync card', async () => {
    const row = {
      profileKey: 'epc',
      visibleModulesJson: ['finance'],
      acceptedDocTypesJson: [],
      terminologyJson: {},
      npiApiGapsJson: null,
      setupCompletedAt: new Date('2026-10-01T00:00:00Z'),
      lastSyncAt: new Date('2026-10-10T07:30:00Z'),
      lastSyncDiffJson: diff('2026-10-10T07:30:00.000Z', ['س']),
    };
    const db = {
      firmConfig: { findUnique: async () => row, update: async () => ({}) },
      position: { findMany: async () => [] },
      manualBaseline: { findMany: async () => [], upsert: async () => ({}) },
      onboardingSession: { findFirst: async () => null },
    } as unknown as SettingsDb;
    const npi = { listDepartments: async () => [], listDepartmentDirectory: async () => [], listRoles: async () => [] };
    const view = await getSettingsView(
      { db, npi, now },
      { npiOrgId: ORG, npiUserId: 'u_admin', roleKey: 'admin', permissions: ['admin.user.manage', SYNC_PERMISSION] },
    );
    expect(view.sync).toMatchObject({ canSync: true, lastSyncAgoAr: 'منذ 30 دقيقة', lastDiff: { summaryAr: ['س'] } });
  });
});

// ─── The two endpoints ──────────────────────────────────────────────────────

describe('POST /api/settings/sync and /api/settings/sync/seen', () => {
  const mockedSession = getServerSession as jest.MockedFunction<typeof getServerSession>;
  const mockedDeps = buildSyncActionDeps as jest.MockedFunction<typeof buildSyncActionDeps>;
  const mockedDb = getDb as jest.MockedFunction<typeof getDb>;
  void buildSettingsDeps;

  function session(permissions: string[]) {
    return {
      user: { npiUserId: 'u_admin', npiOrgId: ORG, nameAr: 'المدير', roleKey: 'admin', roleNameAr: 'مدير', permissions, orgNameAr: null, isAdmin: true, departmentId: null, positionId: null, positionTitleAr: null },
      npiToken: 'token',
      expiresAt: new Date(Date.now() + 3600_000),
    };
  }
  const request = (url: string, headers: Record<string, string> = {}) =>
    new NextRequest(`http://localhost:3110${url}`, { method: 'POST', headers: { host: 'localhost:3110', ...headers } });

  afterEach(() => {
    mockedSession.mockReset();
    mockedDeps.mockReset();
    mockedDb.mockReset();
  });

  it('sync: 200 with the result for an administrator, as the caller, no-store', async () => {
    const h = buildDb();
    const n = buildNpi();
    mockedSession.mockResolvedValue(session(ALL_PERMISSIONS));
    mockedDeps.mockReturnValue({ db: h.db, npi: n.npi });

    const res = await syncPost(request('/copilot/api/settings/sync'));

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body).toMatchObject({ outcome: 'synced', changed: true, sync: { canSync: true } });
    expect(mockedDeps).toHaveBeenCalledWith('token');
    expect(h.runs).toMatchObject([{ reason: 'manual', byNpiUserId: 'u_admin' }]);
  });

  it('sync: 401 without a session, 403 without admin.department.manage (nothing read), 403 cross-site, 503 when NPI is down', async () => {
    mockedSession.mockResolvedValue(null);
    expect((await syncPost(request('/copilot/api/settings/sync'))).status).toBe(401);

    mockedSession.mockResolvedValue(session(['admin.user.manage']));
    const forbidden = await syncPost(request('/copilot/api/settings/sync'));
    expect(forbidden.status).toBe(403);
    expect(mockedDeps).toHaveBeenCalledTimes(1); // built, but the service refused before any read
    mockedDeps.mockReset();

    mockedSession.mockResolvedValue(session(ALL_PERMISSIONS));
    expect((await syncPost(request('/copilot/api/settings/sync', { origin: 'https://evil.example' }))).status).toBe(403);

    mockedSession.mockRejectedValue(new NpiError({ kind: 'network', status: 0, npiMessage: null }));
    expect((await syncPost(request('/copilot/api/settings/sync'))).status).toBe(503);
  });

  it('sync: an NPI failure during the run is a 502 with the Arabic message, never a stack', async () => {
    const h = buildDb();
    const n = buildNpi();
    n.npi.listRoles = async () => {
      throw new NpiError({ kind: 'network', status: 0, npiMessage: null });
    };
    mockedSession.mockResolvedValue(session(ALL_PERMISSIONS));
    mockedDeps.mockReturnValue({ db: h.db, npi: n.npi });
    const res = await syncPost(request('/copilot/api/settings/sync'));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'npi_error', messageAr: 'تعذر الوصول إلى NPI.' });
  });

  it('seen: stamps lastSyncSeenAt for an administrator; 401 / 403 otherwise', async () => {
    const h = buildDb();
    mockedDb.mockReturnValue(h.db as unknown as ReturnType<typeof getDb>);

    mockedSession.mockResolvedValue(session([SYNC_PERMISSION]));
    const ok = await seenPost(request('/copilot/api/settings/sync/seen'));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect(h.firms.get(ORG)!.lastSyncSeenAt).toBeInstanceOf(Date);

    h.firms.get(ORG)!.lastSyncSeenAt = null;
    mockedSession.mockResolvedValue(session(['admin.user.manage']));
    expect((await seenPost(request('/copilot/api/settings/sync/seen'))).status).toBe(403);
    expect(h.firms.get(ORG)!.lastSyncSeenAt).toBeNull();

    mockedSession.mockResolvedValue(null);
    expect((await seenPost(request('/copilot/api/settings/sync/seen'))).status).toBe(401);
    mockedSession.mockResolvedValue(session([SYNC_PERMISSION]));
    expect((await seenPost(request('/copilot/api/settings/sync/seen', { origin: 'https://evil.example' }))).status).toBe(403);
  });
});
