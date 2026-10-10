// Keeping Madar in step with NPI (T-47b, owner decision 2026-10-10).
//
// After the setup, the organization's departments, positions and holders are
// not frozen: at every administrator login (at most once per 10 minutes per
// organization) and on the «حدّث من NPI» button in /settings, Madar re-reads
// NPI with the CALLER's own token and reconciles its `positions` and
// `position_assignments` with what it finds. Users' own roles and permissions
// are not touched here — they are already live (`/auth/me`, 60 s, see
// `src/auth/session.ts`).
//
// Deterministic, no model, no I/O of its own beyond the injected NPI client
// and database. The reading is `discoverFromNpi` (T-47a) — the same reader the
// setup uses — so the wizard and the sync can never disagree about what
// «NPI's positions» means.
//
// Reconciliation rules (keyed by (roleKey, department), a department being NPI's
// department id, as `Position.departmentId` is everywhere in the copilot):
//
//  - a (role, department) with an active holder in NPI and no `positions` row
//    → the row is created (`titleAr` = role name — department name, persona
//    from the role's prompt file);
//  - an existing position whose role or department NPI renamed → `titleAr` is
//    rebuilt, but ONLY when the stored title is exactly what Madar would have
//    built from the names the last sync saw (`sync_runs.namesJson`). A title an
//    administrator typed is never overwritten. The first sync has no earlier
//    names to compare with and only records them;
//  - an active NPI user with no open assignment on the position NPI puts them
//    in → one is created;
//  - an open assignment whose user is deactivated or gone from NPI's directory,
//    or whose user NPI now puts in another (role, department) → ENDED
//    (`endedAt`); never deleted, so the handover history survives;
//  - an active user whose role the sync cannot read (a role without
//    permissions, say) keeps whatever assignment they have;
//  - a position that lost its last holder in this run stays and is listed in
//    the diff (`emptiedPositions`);
//  - everything else is left exactly as it is.
import type { PositionHolder } from './profile.schema';
import { t } from '../i18n/ar';
import { getDb } from '../db';
import type { NpiMe } from '../npi/responses';
import { buildTitleAr } from '../positions/persona';
import { loadProfilePack } from './catalog';
import { discoverFromNpi, discoveryBlockers } from './discover';
import { loadNpiSnapshot, type OnboardingNpi } from './apply';
import { SNAPSHOT_READ_PERMISSION } from './gaps';
import type { NpiSnapshot } from './plan';
import { PROFILE_KEYS, type ProfilePack } from './profile.schema';

/** A login within this long of the last sync does not sync again. */
export const SYNC_THROTTLE_MS = 10 * 60 * 1000;
/** The administrator permission the sync (and the button, and the banner) needs. */
export const SYNC_PERMISSION = 'admin.department.manage';

// ─── Shapes ─────────────────────────────────────────────────────────────────

export type SyncReason = 'login' | 'manual';
export type SyncSkipReason = 'throttled' | 'not_set_up' | 'permission' | 'unreadable';
export type EndedReason = 'inactive' | 'removed' | 'moved';

export interface SyncDiff {
  addedPositions: { roleKey: string; departmentCode: string | null; titleAr: string }[];
  renamedPositions: { roleKey: string; departmentCode: string | null; fromAr: string; toAr: string }[];
  addedAssignments: { npiUserId: string; nameAr: string | null; titleAr: string }[];
  endedAssignments: { npiUserId: string; nameAr: string | null; titleAr: string; reason: EndedReason }[];
  emptiedPositions: { roleKey: string; departmentCode: string | null; titleAr: string }[];
  /** Assignments NPI and Madar already agreed on. */
  unchanged: number;
  /** One Arabic line per item above, in that order. */
  summaryAr: string[];
}

/** What `firm_config.lastSyncDiffJson` keeps: the diff and when it was found. */
export type StoredSyncDiff = SyncDiff & { at: string };

export type SyncOutcome =
  | { skipped: 'throttled' | 'not_set_up' | 'unreadable' }
  | { skipped: 'permission'; missing: string[] }
  | { skipped: null; diff: SyncDiff; changed: boolean; at: string };

export function isEmptyDiff(diff: Omit<SyncDiff, 'unchanged' | 'summaryAr'>): boolean {
  return (
    diff.addedPositions.length === 0 &&
    diff.renamedPositions.length === 0 &&
    diff.addedAssignments.length === 0 &&
    diff.endedAssignments.length === 0 &&
    diff.emptiedPositions.length === 0
  );
}

/** Role and department display names a sync saw (the next sync's baseline). */
interface SyncNames {
  roles: Record<string, string>;
  departments: Record<string, string>;
}

// ─── Database (structural, like OnboardingDb) ───────────────────────────────

export interface SyncFirmConfigRow {
  profileKey: string | null;
  setupCompletedAt: Date | null;
  lastSyncAt: Date | null;
}

export interface SyncPositionRow {
  id: string;
  roleKey: string;
  departmentId: string | null;
  titleAr: string;
}

export interface SyncAssignmentRow {
  id: string;
  positionId: string;
  npiUserId: string;
}

export interface SyncDb {
  firmConfig: {
    findUnique(args: { where: { npiOrgId: string } }): Promise<SyncFirmConfigRow | null>;
    /** The login throttle's claim: succeeds (count 1) for exactly one caller
     *  when two administrators log in together. */
    updateMany(args: {
      where: { npiOrgId: string; setupCompletedAt: { not: null }; OR: ({ lastSyncAt: null } | { lastSyncAt: { lte: Date } })[] };
      data: { lastSyncAt: Date };
    }): Promise<{ count: number }>;
    update(args: {
      where: { npiOrgId: string };
      data: { lastSyncAt: Date | null; lastSyncDiffJson?: StoredSyncDiff };
    }): Promise<unknown>;
  };
  position: {
    findMany(args: { where: { npiOrgId: string } }): Promise<SyncPositionRow[]>;
    create(args: {
      data: { npiOrgId: string; roleKey: string; departmentId: string | null; titleAr: string; personaAr: string };
    }): Promise<{ id: string }>;
    update(args: { where: { id: string }; data: { titleAr: string } }): Promise<unknown>;
  };
  positionAssignment: {
    findMany(args: { where: { endedAt: null; position: { npiOrgId: string } } }): Promise<SyncAssignmentRow[]>;
    create(args: { data: { positionId: string; npiUserId: string } }): Promise<unknown>;
    updateMany(args: { where: { id: { in: string[] }; endedAt: null }; data: { endedAt: Date } }): Promise<unknown>;
  };
  syncRun: {
    create(args: {
      data: {
        npiOrgId: string;
        at: Date;
        byNpiUserId: string;
        reason: SyncReason;
        diffJson: SyncDiff | null;
        namesJson: SyncNames | null;
        skipped: SyncSkipReason | null;
      };
    }): Promise<unknown>;
    /** The newest run that read NPI (its names are the baseline). */
    findFirst(args: { where: { npiOrgId: string; skipped: null }; orderBy: { at: 'desc' } }): Promise<{ namesJson: unknown } | null>;
  };
}

/** The three NPI reads the sync makes. */
export type SyncNpi = Pick<OnboardingNpi, 'listRoles' | 'listDepartments' | 'listDepartmentDirectory'>;

export interface SyncArgs {
  orgId: string;
  /** The caller's own NPI client (their token). */
  npi: SyncNpi;
  /** The caller, as `/auth/me` reports them. */
  me: Pick<NpiMe, 'id' | 'roleKey' | 'permissions'>;
  reason: SyncReason;
  /** Defaults to the copilot's own database. */
  db?: SyncDb;
  now?: () => Date;
  /** Overridable for tests; defaults to the real catalog. */
  loadPack?: (key: string) => ProfilePack;
  personaFor?: (roleKey: string) => string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** The two reads the sync needs; the other four snapshot slots stay `null`
 *  without a call (`loadNpiSnapshot` skips a slot the caller's permissions do
 *  not cover). */
const READ_PERMISSIONS: readonly string[] = [SNAPSHOT_READ_PERMISSION.roles, SNAPSHOT_READ_PERMISSION.departments];

function namesFromJson(json: unknown): SyncNames | null {
  if (typeof json !== 'object' || json === null) return null;
  const { roles, departments } = json as Record<string, unknown>;
  const isNames = (v: unknown): v is Record<string, string> =>
    typeof v === 'object' && v !== null && Object.values(v).every((x) => typeof x === 'string');
  return isNames(roles) && isNames(departments) ? { roles, departments } : null;
}

function packIsKnown(key: string | null): key is (typeof PROFILE_KEYS)[number] {
  return key !== null && (PROFILE_KEYS as readonly string[]).includes(key);
}

function pairKey(roleKey: string, departmentId: string | null): string {
  return `${roleKey}\u0000${departmentId ?? ''}`;
}

// ─── The sync ───────────────────────────────────────────────────────────────

export async function syncFromNpi(args: SyncArgs): Promise<SyncOutcome> {
  const db = args.db ?? (getDb() as unknown as SyncDb);
  const now = (args.now ?? (() => new Date()))();
  const { orgId, reason } = args;

  const firm = await db.firmConfig.findUnique({ where: { npiOrgId: orgId } });
  if (firm === null || firm.setupCompletedAt === null || !packIsKnown(firm.profileKey)) return { skipped: 'not_set_up' };

  // A login claims the throttle slot atomically (two administrators logging in
  // together sync once); a manual run is always allowed. A run that ends up
  // reading nothing gives the slot back.
  let claimed = false;
  if (reason === 'login') {
    const threshold = new Date(now.getTime() - SYNC_THROTTLE_MS);
    const claim = await db.firmConfig.updateMany({
      where: { npiOrgId: orgId, setupCompletedAt: { not: null }, OR: [{ lastSyncAt: null }, { lastSyncAt: { lte: threshold } }] },
      data: { lastSyncAt: now },
    });
    if (claim.count === 0) return { skipped: 'throttled' };
    claimed = true;
  }

  let synced = false;
  try {
    const outcome = await reconcile(db, args, firm.profileKey, now);
    synced = outcome.skipped === null;
    return outcome;
  } finally {
    if (claimed && !synced) await db.firmConfig.update({ where: { npiOrgId: orgId }, data: { lastSyncAt: firm.lastSyncAt } });
  }
}

async function reconcile(db: SyncDb, args: SyncArgs, profileKey: string, now: Date): Promise<SyncOutcome> {
  const { orgId, me, reason } = args;
  const record = (skipped: SyncSkipReason) =>
    db.syncRun.create({ data: { npiOrgId: orgId, at: now, byNpiUserId: me.id, reason, diffJson: null, namesJson: null, skipped } });

  // ── Read NPI as the caller ────────────────────────────────────────────────
  // `admin.user.manage` also opens the permission catalog slot, which the sync
  // does not need: it gets an empty answer instead of a request.
  const reader: OnboardingNpi = {
    listRoles: () => args.npi.listRoles(),
    listDepartments: () => args.npi.listDepartments(),
    listDepartmentDirectory: () => args.npi.listDepartmentDirectory(),
    listPermissions: async () => [],
    listApprovalRules: async () => [],
    listItems: async () => [],
  } as unknown as OnboardingNpi;
  const snapshot: NpiSnapshot = await loadNpiSnapshot(reader, {
    roleKey: me.roleKey,
    permissions: me.permissions.filter((p) => READ_PERMISSIONS.includes(p)),
  });
  const missing = discoveryBlockers(snapshot);
  if (missing.length > 0) {
    await record('permission');
    return { skipped: 'permission', missing };
  }

  // The firm's own profile pack validates the reading (not a fresh guess): every
  // key maps to it, so the tie-break inside `discoverFromNpi` picks a profile
  // whose pack is the firm's. The profile itself is not used here.
  const loadReal = args.loadPack ?? loadProfilePack;
  const firmPack = loadReal(profileKey);
  const discovered = discoverFromNpi(snapshot, {
    counts: { projects: null, customers: null, vendors: null },
    loadPack: (key) => ({ ...firmPack, key: key as ProfilePack['key'] }),
    ...(args.personaFor ? { personaFor: args.personaFor } : {}),
  });
  const step2 = discovered.answers[2];
  if (discovered.sources['2'] !== 'npi' || step2.holders === undefined || discovered.roleSets === undefined) {
    await record('unreadable');
    return { skipped: 'unreadable' };
  }
  const roleSets = discovered.roleSets;

  // ── What NPI says ─────────────────────────────────────────────────────────
  const departments = snapshot.departments ?? [];
  const deptByCode = new Map(departments.map((d) => [d.code, d]));
  const deptById = new Map(departments.map((d) => [d.id, d]));
  const users = new Map((snapshot.users ?? []).map((u) => [u.id, u]));
  const nameOf = (id: string): string | null => users.get(id)?.nameAr ?? null;

  const idOfCode = (code: string | null): string | null => (code === null ? null : (deptByCode.get(code)?.id ?? null));
  const codeOfId = (id: string | null): string | null => (id === null ? null : (deptById.get(id)?.code ?? null));
  const deptNameAr = (id: string | null): string | null => (id === null ? null : (deptById.get(id)?.nameAr ?? null));

  interface Expected {
    roleKey: string;
    departmentId: string | null;
    departmentCode: string | null;
    titleAr: string;
    personaAr: string;
    userIds: string[];
  }
  const expected: Expected[] = step2.positions.map((p) => {
    const holder = step2.holders!.find((h: PositionHolder) => h.roleKey === p.roleKey && h.departmentCode === p.departmentCode);
    return {
      roleKey: p.roleKey,
      departmentId: idOfCode(p.departmentCode),
      departmentCode: p.departmentCode,
      titleAr: p.titleAr,
      personaAr: p.personaAr,
      userIds: holder?.npiUserIds ?? [],
    };
  });

  const names: SyncNames = {
    roles: Object.fromEntries(Object.entries(roleSets).map(([key, set]) => [key, set.nameAr])),
    departments: Object.fromEntries(departments.filter((d) => d.isActive).map((d) => [d.id, d.nameAr])),
  };
  const previousNames = namesFromJson((await db.syncRun.findFirst({ where: { npiOrgId: orgId, skipped: null }, orderBy: { at: 'desc' } }))?.namesJson);

  // ── What Madar holds ──────────────────────────────────────────────────────
  const positions = await db.position.findMany({ where: { npiOrgId: orgId } });
  const positionByKey = new Map(positions.map((p) => [pairKey(p.roleKey, p.departmentId), p]));
  const openBefore = await db.positionAssignment.findMany({ where: { endedAt: null, position: { npiOrgId: orgId } } });
  const holdersBefore = new Map<string, number>();
  for (const a of openBefore) holdersBefore.set(a.positionId, (holdersBefore.get(a.positionId) ?? 0) + 1);

  const diff: Omit<SyncDiff, 'unchanged' | 'summaryAr'> = {
    addedPositions: [],
    renamedPositions: [],
    addedAssignments: [],
    endedAssignments: [],
    emptiedPositions: [],
  };
  const titleOf = new Map<string, string>(positions.map((p) => [p.id, p.titleAr]));

  // ── Positions: create the missing ─────────────────────────────────────────
  const positionIdFor = new Map<string, string>();
  for (const e of expected) {
    const key = pairKey(e.roleKey, e.departmentId);
    const existing = positionByKey.get(key);
    if (existing) {
      positionIdFor.set(key, existing.id);
      continue;
    }
    const created = await db.position.create({
      data: { npiOrgId: orgId, roleKey: e.roleKey, departmentId: e.departmentId, titleAr: e.titleAr, personaAr: e.personaAr },
    });
    positionIdFor.set(key, created.id);
    titleOf.set(created.id, e.titleAr);
    diff.addedPositions.push({ roleKey: e.roleKey, departmentCode: e.departmentCode, titleAr: e.titleAr });
  }

  // ── Positions: follow NPI's renames (only titles Madar itself built) ──────
  if (previousNames !== null) {
    for (const p of positions) {
      const role = roleSets[p.roleKey];
      if (!role || (p.departmentId !== null && !deptById.has(p.departmentId))) continue;
      const before = buildTitleAr(previousNames.roles[p.roleKey] ?? role.nameAr, p.departmentId === null ? null : (previousNames.departments[p.departmentId] ?? deptNameAr(p.departmentId)));
      const after = buildTitleAr(role.nameAr, deptNameAr(p.departmentId));
      if (p.titleAr !== before || before === after) continue;
      await db.position.update({ where: { id: p.id }, data: { titleAr: after } });
      titleOf.set(p.id, after);
      diff.renamedPositions.push({ roleKey: p.roleKey, departmentCode: codeOfId(p.departmentId), fromAr: p.titleAr, toAr: after });
    }
  }

  // ── Assignments ───────────────────────────────────────────────────────────
  const expectedPositionOfUser = new Map<string, string>();
  for (const e of expected) for (const userId of e.userIds) expectedPositionOfUser.set(userId, positionIdFor.get(pairKey(e.roleKey, e.departmentId))!);

  const toEnd: string[] = [];
  const stillOpen = new Map<string, number>(holdersBefore);
  const satisfied = new Set<string>(); // `${positionId}\u0000${userId}` already open and right
  for (const a of openBefore) {
    const user = users.get(a.npiUserId);
    const wanted = expectedPositionOfUser.get(a.npiUserId);
    let endReason: EndedReason | null = null;
    if (!user) endReason = 'removed';
    else if (!user.isActive) endReason = 'inactive';
    else if (wanted !== undefined && wanted !== a.positionId) endReason = 'moved';
    else if (wanted === a.positionId) {
      const dedupe = `${a.positionId}\u0000${a.npiUserId}`;
      if (satisfied.has(dedupe)) {
        // A second open row for the same user on the same position: not a
        // change NPI made, but a duplicate that should not outlive the sync.
        toEnd.push(a.id);
        stillOpen.set(a.positionId, (stillOpen.get(a.positionId) ?? 1) - 1);
        continue;
      }
      satisfied.add(dedupe);
    }
    if (endReason !== null) {
      toEnd.push(a.id);
      stillOpen.set(a.positionId, (stillOpen.get(a.positionId) ?? 1) - 1);
      diff.endedAssignments.push({ npiUserId: a.npiUserId, nameAr: nameOf(a.npiUserId), titleAr: titleOf.get(a.positionId) ?? '', reason: endReason });
    }
  }
  if (toEnd.length > 0) await db.positionAssignment.updateMany({ where: { id: { in: toEnd }, endedAt: null }, data: { endedAt: now } });

  for (const [userId, positionId] of expectedPositionOfUser) {
    if (satisfied.has(`${positionId}\u0000${userId}`)) continue;
    await db.positionAssignment.create({ data: { positionId, npiUserId: userId } });
    stillOpen.set(positionId, (stillOpen.get(positionId) ?? 0) + 1);
    diff.addedAssignments.push({ npiUserId: userId, nameAr: nameOf(userId), titleAr: titleOf.get(positionId) ?? '' });
  }

  for (const p of positions) {
    if ((holdersBefore.get(p.id) ?? 0) > 0 && (stillOpen.get(p.id) ?? 0) === 0) {
      diff.emptiedPositions.push({ roleKey: p.roleKey, departmentCode: codeOfId(p.departmentId), titleAr: titleOf.get(p.id) ?? p.titleAr });
    }
  }

  const full: SyncDiff = { ...diff, unchanged: satisfied.size, summaryAr: summarize(diff) };
  const changed = !isEmptyDiff(diff);

  // ── Record ────────────────────────────────────────────────────────────────
  await db.syncRun.create({
    data: { npiOrgId: orgId, at: now, byNpiUserId: me.id, reason, diffJson: full, namesJson: names, skipped: null },
  });
  await db.firmConfig.update({
    where: { npiOrgId: orgId },
    data: { lastSyncAt: now, ...(changed ? { lastSyncDiffJson: { ...full, at: now.toISOString() } } : {}) },
  });
  return { skipped: null, diff: full, changed, at: now.toISOString() };
}

// ─── Arabic one-liners ──────────────────────────────────────────────────────

function summarize(diff: Omit<SyncDiff, 'unchanged' | 'summaryAr'>): string[] {
  const lines: string[] = [];
  for (const p of diff.addedPositions) lines.push(t('sync.item.added_position', { title: p.titleAr }));
  for (const p of diff.renamedPositions) lines.push(t('sync.item.renamed_position', { from: p.fromAr, to: p.toAr }));
  for (const a of diff.addedAssignments) lines.push(t('sync.item.added_assignment', { name: a.nameAr ?? t('sync.user.unknown'), title: a.titleAr }));
  for (const a of diff.endedAssignments) {
    const key = a.reason === 'inactive' ? 'sync.item.ended_inactive' : a.reason === 'removed' ? 'sync.item.ended_removed' : 'sync.item.ended_moved';
    lines.push(t(key, { name: a.nameAr ?? t('sync.user.unknown'), title: a.titleAr }));
  }
  for (const p of diff.emptiedPositions) lines.push(t('sync.item.emptied_position', { title: p.titleAr }));
  return lines;
}
