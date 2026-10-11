// Keeping Madar in step with NPI (T-47b, owner decision 2026-10-10).
//
// After the setup, the organization's departments, positions and holders are
// not frozen: at every administrator login (at most once per 10 minutes per
// organization — a reading NPI refused, or one too thin to use, counts too:
// reading again changes nothing until NPI does) and on the «حدّث من NPI»
// button in /settings (never throttled), Madar re-reads NPI with the CALLER's
// own token and reconciles its `positions` and `position_assignments` with
// what it finds; the writes of one reconciliation are one transaction. Users'
// own roles and permissions are not touched here — they are already live
// (`/auth/me`, 60 s, see `src/auth/session.ts`).
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
//  - an active user the sync cannot place — whose role it cannot read (a role
//    without permissions, say), or whose department NPI deactivated or the
//    profile schema refuses (the discovery leaves such a user out rather than
//    treating them as department-less) — keeps whatever assignment they have;
//  - a position that lost its last holder in this run stays and is listed in
//    the diff (`emptiedPositions`);
//  - everything else is left exactly as it is.
import type { PositionHolder } from './profile.schema';
import { t } from '../i18n/ar';
import { getDb } from '../db';
import type { NpiMe } from '../npi/responses';
import { buildTitleAr } from '../positions/persona';
import { loadProfilePack } from './catalog';
import { discoverFromNpi, discoveryBlockers, type DiscoveredAnswers } from './discover';
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
  /** The last time Madar read NPI for this organization — a login claims it
   *  before reading and keeps it when the reading was refused or too thin; a
   *  successful run writes it with the diff. Only a run that throws gives it back. */
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
  /** The reconciliation's writes run in one of these: all of them or none. */
  $transaction<T>(fn: (tx: SyncWriteDb) => Promise<T>): Promise<T>;
}

/** What the writes of a reconciliation touch (the transaction's client). */
export type SyncWriteDb = Pick<SyncDb, 'position' | 'positionAssignment' | 'syncRun' | 'firmConfig'>;

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
//
// Four stages, each a function of its own: `readNpi` (NPI, no writes),
// `loadHeld` (Madar's database, no writes), `planSync` (pure: what has to
// change) and `applySync` (every write, inside ONE transaction — a failure
// halfway leaves nothing of the reconciliation behind).

export async function syncFromNpi(args: SyncArgs): Promise<SyncOutcome> {
  const db = args.db ?? (getDb() as unknown as SyncDb);
  const now = (args.now ?? (() => new Date()))();
  const { orgId, reason } = args;

  const firm = await db.firmConfig.findUnique({ where: { npiOrgId: orgId } });
  if (firm === null || firm.setupCompletedAt === null || !packIsKnown(firm.profileKey)) return { skipped: 'not_set_up' };

  // A login claims the throttle slot atomically (two administrators logging in
  // together sync once); a manual run is always allowed. The slot is kept once
  // NPI has been read — even when the reading was refused or too thin, because
  // reading again on the next login changes nothing until NPI changes (the
  // button is how an administrator who just got the permission tries again).
  // Only a run that THROWS gives the slot back.
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

  let failed = true;
  try {
    const outcome = await reconcile(db, args, firm.profileKey, now);
    failed = false;
    return outcome;
  } finally {
    if (claimed && failed) await db.firmConfig.update({ where: { npiOrgId: orgId }, data: { lastSyncAt: firm.lastSyncAt } });
  }
}

async function reconcile(db: SyncDb, args: SyncArgs, profileKey: string, now: Date): Promise<SyncOutcome> {
  const { orgId, me, reason } = args;
  const read = await readNpi(args, profileKey);
  if (read.skipped !== null) {
    // A single write: no transaction needed.
    await db.syncRun.create({ data: { npiOrgId: orgId, at: now, byNpiUserId: me.id, reason, diffJson: null, namesJson: null, skipped: read.skipped } });
    return read.skipped === 'permission' ? { skipped: 'permission', missing: read.missing } : { skipped: 'unreadable' };
  }
  const held = await loadHeld(db, orgId);
  const plan = planSync(read, held);
  await db.$transaction((tx) => applySync(tx, plan, { orgId, byNpiUserId: me.id, reason, now }));
  return { skipped: null, diff: plan.diff, changed: plan.changed, at: now.toISOString() };
}

// ─── Stage 1: what NPI says ─────────────────────────────────────────────────

type Step2 = DiscoveredAnswers['answers'][2];
type RoleSets = NonNullable<DiscoveredAnswers['roleSets']>;
type NpiDepartmentRow = NonNullable<NpiSnapshot['departments']>[number];
type NpiUserRow = NonNullable<NpiSnapshot['users']>[number];

/** One (role, department) NPI has an active, placeable holder for. */
interface Expected {
  roleKey: string;
  departmentId: string | null;
  departmentCode: string | null;
  titleAr: string;
  personaAr: string;
  userIds: string[];
}

interface NpiRead {
  skipped: null;
  expected: Expected[];
  names: SyncNames;
  users: Map<string, NpiUserRow>;
  /** Every department NPI lists, inactive ones included. */
  deptById: Map<string, NpiDepartmentRow>;
  roleSets: RoleSets;
}

type ReadResult = { skipped: 'permission'; missing: string[] } | { skipped: 'unreadable' } | NpiRead;

function expectedPositions(step2: Step2, departmentIdByCode: Map<string, string>): Expected[] {
  const holders = step2.holders ?? [];
  return step2.positions.map((p) => {
    const holder = holders.find((h: PositionHolder) => h.roleKey === p.roleKey && h.departmentCode === p.departmentCode);
    return {
      roleKey: p.roleKey,
      departmentId: p.departmentCode === null ? null : (departmentIdByCode.get(p.departmentCode) ?? null),
      departmentCode: p.departmentCode,
      titleAr: p.titleAr,
      personaAr: p.personaAr,
      userIds: holder?.npiUserIds ?? [],
    };
  });
}

async function readNpi(args: SyncArgs, profileKey: string): Promise<ReadResult> {
  const { me } = args;
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
  if (missing.length > 0) return { skipped: 'permission', missing };

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
  if (discovered.sources['2'] !== 'npi' || step2.holders === undefined || discovered.roleSets === undefined) return { skipped: 'unreadable' };

  const roleSets = discovered.roleSets;
  const departments = snapshot.departments ?? [];
  return {
    skipped: null,
    expected: expectedPositions(step2, new Map(departments.map((d) => [d.code, d.id]))),
    names: {
      roles: Object.fromEntries(Object.entries(roleSets).map(([key, set]) => [key, set.nameAr])),
      departments: Object.fromEntries(departments.filter((d) => d.isActive).map((d) => [d.id, d.nameAr])),
    },
    users: new Map((snapshot.users ?? []).map((u) => [u.id, u])),
    deptById: new Map(departments.map((d) => [d.id, d])),
    roleSets,
  };
}

// ─── Stage 2: what Madar holds ──────────────────────────────────────────────

interface Held {
  positions: SyncPositionRow[];
  /** Every open assignment of the organization's positions. */
  openBefore: SyncAssignmentRow[];
  /** The names the last run that read NPI saw (null on the first sync). */
  previousNames: SyncNames | null;
}

async function loadHeld(db: Pick<SyncDb, 'position' | 'positionAssignment' | 'syncRun'>, orgId: string): Promise<Held> {
  const previousRun = await db.syncRun.findFirst({ where: { npiOrgId: orgId, skipped: null }, orderBy: { at: 'desc' } });
  const positions = await db.position.findMany({ where: { npiOrgId: orgId } });
  const openBefore = await db.positionAssignment.findMany({ where: { endedAt: null, position: { npiOrgId: orgId } } });
  return { positions, openBefore, previousNames: namesFromJson(previousRun?.namesJson) };
}

// ─── Stage 3: the plan (pure) ───────────────────────────────────────────────

/** What a reconciliation will write, and the diff it will report. */
interface SyncPlan {
  createPositions: Expected[];
  renamePositions: { id: string; toAr: string; entry: SyncDiff['renamedPositions'][number] }[];
  endAssignments: { ids: string[]; entries: SyncDiff['endedAssignments'] };
  /** `positionRef` is a position's id, or `pendingRef(...)` for one this run creates. */
  createAssignments: { positionRef: string; entry: SyncDiff['addedAssignments'][number] }[];
  diff: SyncDiff;
  changed: boolean;
  names: SyncNames;
}

/** Stands in for the id of a position the run has yet to create. */
function pendingRef(e: Pick<Expected, 'roleKey' | 'departmentId'>): string {
  return `new:${pairKey(e.roleKey, e.departmentId)}`;
}

function departmentCodeOf(read: NpiRead, id: string | null): string | null {
  return id === null ? null : (read.deptById.get(id)?.code ?? null);
}

function departmentNameOf(read: NpiRead, id: string | null): string | null {
  return id === null ? null : (read.deptById.get(id)?.nameAr ?? null);
}

function countOpen(openBefore: SyncAssignmentRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const a of openBefore) counts.set(a.positionId, (counts.get(a.positionId) ?? 0) + 1);
  return counts;
}

/** Which (role, department) pairs have a row, which need one, and the title of each. */
function planPositions(read: NpiRead, held: Held) {
  const byKey = new Map(held.positions.map((p) => [pairKey(p.roleKey, p.departmentId), p]));
  const refFor = new Map<string, string>(); // pairKey → position id, or the pending ref
  const titleOf = new Map<string, string>(held.positions.map((p) => [p.id, p.titleAr])); // id or ref → title
  const createPositions: Expected[] = [];
  for (const e of read.expected) {
    const key = pairKey(e.roleKey, e.departmentId);
    if (refFor.has(key)) continue;
    const existing = byKey.get(key);
    if (existing) {
      refFor.set(key, existing.id);
      continue;
    }
    const ref = pendingRef(e);
    refFor.set(key, ref);
    titleOf.set(ref, e.titleAr);
    createPositions.push(e);
  }
  return { createPositions, refFor, titleOf };
}

/** The title Madar would now build for `p`, when `p` still carries the title it built last time. */
function renamedTitle(read: NpiRead, p: SyncPositionRow, previous: SyncNames): string | null {
  const role = read.roleSets[p.roleKey];
  if (!role || (p.departmentId !== null && !read.deptById.has(p.departmentId))) return null;
  const deptNow = departmentNameOf(read, p.departmentId);
  const deptBefore = p.departmentId === null ? null : (previous.departments[p.departmentId] ?? deptNow);
  const before = buildTitleAr(previous.roles[p.roleKey] ?? role.nameAr, deptBefore);
  const after = buildTitleAr(role.nameAr, deptNow);
  return p.titleAr === before && before !== after ? after : null;
}

function planRenames(read: NpiRead, held: Held): SyncPlan['renamePositions'] {
  const out: SyncPlan['renamePositions'] = [];
  if (held.previousNames === null) return out;
  for (const p of held.positions) {
    const toAr = renamedTitle(read, p, held.previousNames);
    if (toAr === null) continue;
    out.push({ id: p.id, toAr, entry: { roleKey: p.roleKey, departmentCode: departmentCodeOf(read, p.departmentId), fromAr: p.titleAr, toAr } });
  }
  return out;
}

/** Why an open assignment ends, or null when it stays. An active user the
 *  sync cannot place (`wanted` undefined) keeps what they have. */
function endReasonOf(user: NpiUserRow | undefined, wanted: string | undefined, positionId: string): EndedReason | null {
  if (!user) return 'removed';
  if (!user.isActive) return 'inactive';
  return wanted !== undefined && wanted !== positionId ? 'moved' : null;
}

function planAssignments(read: NpiRead, held: Held, refFor: Map<string, string>, titleOf: Map<string, string>, holdersBefore: Map<string, number>) {
  const nameOf = (id: string): string | null => read.users.get(id)?.nameAr ?? null;
  const wantedOf = new Map<string, string>(); // npiUserId → the position (or ref) NPI puts them in
  for (const e of read.expected) for (const userId of e.userIds) wantedOf.set(userId, refFor.get(pairKey(e.roleKey, e.departmentId))!);

  const endIds: string[] = [];
  const entries: SyncDiff['endedAssignments'] = [];
  const stillOpen = new Map<string, number>(holdersBefore);
  const satisfied = new Set<string>(); // `${positionId}\u0000${userId}` already open and right
  for (const a of held.openBefore) {
    const wanted = wantedOf.get(a.npiUserId);
    const reason = endReasonOf(read.users.get(a.npiUserId), wanted, a.positionId);
    const key = `${a.positionId}\u0000${a.npiUserId}`;
    // A second open row for the same user on the same position is not a change
    // NPI made, but a duplicate that should not outlive the sync.
    const duplicate = reason === null && wanted === a.positionId && satisfied.has(key);
    if (reason === null && !duplicate) {
      if (wanted === a.positionId) satisfied.add(key);
      continue;
    }
    endIds.push(a.id);
    stillOpen.set(a.positionId, (stillOpen.get(a.positionId) ?? 1) - 1);
    if (reason !== null) entries.push({ npiUserId: a.npiUserId, nameAr: nameOf(a.npiUserId), titleAr: titleOf.get(a.positionId) ?? '', reason });
  }

  const creates: SyncPlan['createAssignments'] = [];
  for (const [userId, positionRef] of wantedOf) {
    if (satisfied.has(`${positionRef}\u0000${userId}`)) continue;
    stillOpen.set(positionRef, (stillOpen.get(positionRef) ?? 0) + 1);
    creates.push({ positionRef, entry: { npiUserId: userId, nameAr: nameOf(userId), titleAr: titleOf.get(positionRef) ?? '' } });
  }
  return { endIds, entries, creates, unchanged: satisfied.size, stillOpen };
}

function planEmptied(read: NpiRead, held: Held, holdersBefore: Map<string, number>, stillOpen: Map<string, number>, titleOf: Map<string, string>): SyncDiff['emptiedPositions'] {
  const out: SyncDiff['emptiedPositions'] = [];
  for (const p of held.positions) {
    if ((holdersBefore.get(p.id) ?? 0) > 0 && (stillOpen.get(p.id) ?? 0) === 0) {
      out.push({ roleKey: p.roleKey, departmentCode: departmentCodeOf(read, p.departmentId), titleAr: titleOf.get(p.id) ?? p.titleAr });
    }
  }
  return out;
}

function planSync(read: NpiRead, held: Held): SyncPlan {
  const { createPositions, refFor, titleOf } = planPositions(read, held);
  const renamePositions = planRenames(read, held);
  for (const r of renamePositions) titleOf.set(r.id, r.toAr);

  const holdersBefore = countOpen(held.openBefore);
  const assignments = planAssignments(read, held, refFor, titleOf, holdersBefore);
  const diff: Omit<SyncDiff, 'unchanged' | 'summaryAr'> = {
    addedPositions: createPositions.map((e) => ({ roleKey: e.roleKey, departmentCode: e.departmentCode, titleAr: e.titleAr })),
    renamedPositions: renamePositions.map((r) => r.entry),
    addedAssignments: assignments.creates.map((c) => c.entry),
    endedAssignments: assignments.entries,
    emptiedPositions: planEmptied(read, held, holdersBefore, assignments.stillOpen, titleOf),
  };
  return {
    createPositions,
    renamePositions,
    endAssignments: { ids: assignments.endIds, entries: assignments.entries },
    createAssignments: assignments.creates,
    diff: { ...diff, unchanged: assignments.unchanged, summaryAr: summarize(diff) },
    changed: !isEmptyDiff(diff),
    names: read.names,
  };
}

// ─── Stage 4: the writes (one transaction) ──────────────────────────────────

interface ApplyContext {
  orgId: string;
  byNpiUserId: string;
  reason: SyncReason;
  now: Date;
}

/** Runs inside `db.$transaction`: all of it or none of it. */
async function applySync(tx: SyncWriteDb, plan: SyncPlan, ctx: ApplyContext): Promise<void> {
  const { orgId, now } = ctx;
  const createdId = new Map<string, string>(); // pending ref → the new position's id
  for (const e of plan.createPositions) {
    const created = await tx.position.create({
      data: { npiOrgId: orgId, roleKey: e.roleKey, departmentId: e.departmentId, titleAr: e.titleAr, personaAr: e.personaAr },
    });
    createdId.set(pendingRef(e), created.id);
  }
  for (const r of plan.renamePositions) await tx.position.update({ where: { id: r.id }, data: { titleAr: r.toAr } });
  if (plan.endAssignments.ids.length > 0) {
    await tx.positionAssignment.updateMany({ where: { id: { in: plan.endAssignments.ids }, endedAt: null }, data: { endedAt: now } });
  }
  for (const a of plan.createAssignments) {
    await tx.positionAssignment.create({ data: { positionId: createdId.get(a.positionRef) ?? a.positionRef, npiUserId: a.entry.npiUserId } });
  }
  await tx.syncRun.create({
    data: { npiOrgId: orgId, at: now, byNpiUserId: ctx.byNpiUserId, reason: ctx.reason, diffJson: plan.diff, namesJson: plan.names, skipped: null },
  });
  await tx.firmConfig.update({
    where: { npiOrgId: orgId },
    data: { lastSyncAt: now, ...(plan.changed ? { lastSyncDiffJson: { ...plan.diff, at: now.toISOString() } } : {}) },
  });
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
