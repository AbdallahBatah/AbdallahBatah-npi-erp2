// Orchestration behind `GET /api/settings` and `POST /api/settings` (T-19,
// spec/madar/02 §5.9 and §7 "re-runnable per step from /settings"). Same
// shape as `src/onboarding/service.ts`: pure(ish) orchestration over
// structurally-typed deps (db, npi, loadPack, now), unit testable with
// in-memory fakes; the route only wires the real ones and maps thrown errors
// to HTTP status codes.
//
// Ownership of writes (see the header comment in `src/settings/types.ts`):
// everything the setup wizard asks about is edited by RE-RUNNING that
// wizard step (`rerun`, via `reopenSetupAtStep`); only module visibility and
// the manual baselines are written directly here.
import { z } from 'zod';
import { t, type ArKey } from '../i18n/ar';
import { formatNumber } from '../i18n/format';
import { loadProfilePack } from '../onboarding/catalog';
import { SNAPSHOT_READ_PERMISSION, type NpiApiGap } from '../onboarding/gaps';
import { APPROVAL_DOCUMENT_LABEL_AR } from '../onboarding/plan';
import {
  FLOW_TYPES,
  MODULE_KEYS,
  PROFILE_KEYS,
  TERM_KEYS,
  type ApprovalDocumentType,
  type ModuleKey,
  type ProfileKey,
  type ProfilePack,
  type TermKey,
} from '../onboarding/profile.schema';
import { reopenSetupAtStep, SETUP_ADMIN_PERMISSION, SetupForbiddenError, type SetupCaller, type SetupDeps, type SetupSessionDb } from '../onboarding/service';
import { readDirectoryUsers, readRoles } from '../npi/admin';
import type { NpiClient } from '../npi/client';
import { readDepartments } from '../npi/directory';
import { NpiError } from '../npi/errors';
import {
  BASELINE_MAX_MINUTES,
  BASELINE_MIN_MINUTES,
  type RerunStep,
  type SettingsActionResult,
  type SettingsConfig,
  type SettingsDocType,
  type SettingsLastApply,
  type SettingsLeftover,
  type SettingsPosition,
  type SettingsView,
} from './types';

// ─── Dependencies ───────────────────────────────────────────────────────────

export interface SettingsFirmConfigRow {
  profileKey: string | null;
  visibleModulesJson: unknown;
  acceptedDocTypesJson: unknown;
  terminologyJson: unknown;
  npiApiGapsJson: unknown;
  setupCompletedAt: Date | null;
}

export interface SettingsPositionRow {
  id: string;
  roleKey: string;
  departmentId: string | null;
  titleAr: string;
  assignments: { npiUserId: string; startedAt: Date }[];
}

export interface SettingsBaselineRow {
  flowType: string;
  minutes: number;
  measuredAt: Date;
}

export interface SettingsDb {
  firmConfig: {
    findUnique(args: { where: { npiOrgId: string } }): Promise<SettingsFirmConfigRow | null>;
    update(args: { where: { npiOrgId: string }; data: { visibleModulesJson: string[] } }): Promise<unknown>;
  };
  position: {
    findMany(args: {
      where: { npiOrgId: string };
      orderBy: { roleKey: 'asc' };
      include: { assignments: { where: { endedAt: null }; select: { npiUserId: true; startedAt: true } } };
    }): Promise<SettingsPositionRow[]>;
  };
  manualBaseline: {
    findMany(args: { where: { npiOrgId: string } }): Promise<SettingsBaselineRow[]>;
    upsert(args: {
      where: { npiOrgId_flowType: { npiOrgId: string; flowType: string } };
      create: { npiOrgId: string; flowType: string; minutes: number; measuredAt: Date; npiUserId: string };
      update: { minutes: number; measuredAt: Date; npiUserId: string };
    }): Promise<unknown>;
  };
  onboardingSession: SetupSessionDb['onboardingSession'];
}

export type SettingsNpi = Pick<NpiClient, 'listDepartments' | 'listDepartmentDirectory' | 'listRoles'>;

export interface SettingsDeps {
  db: SettingsDb;
  npi: SettingsNpi;
  /** Overridable for tests; defaults to the real `loadProfilePack`. */
  loadPack?: (key: string) => ProfilePack;
  now?: () => Date;
}

/** Thrown by `handleSettingsAction` on a write it refuses for a reason other
 *  than malformed input (which stays a `ZodError`, mapped by the route to
 *  400). The route maps `'no_config'` to 409 and the other two to 400. */
export class SettingsError extends Error {
  readonly code: 'no_config' | 'invalid_modules' | 'invalid_baseline';
  readonly messageAr: string;
  constructor(code: SettingsError['code'], messageAr: string) {
    super(`settings action refused: ${code}`);
    this.name = 'SettingsError';
    this.code = code;
    this.messageAr = messageAr;
  }
}

function requireAdmin(caller: SetupCaller): void {
  if (!caller.permissions.includes(SETUP_ADMIN_PERMISSION)) {
    throw new SetupForbiddenError(t('settings.forbidden'));
  }
}

// ─── Request body ───────────────────────────────────────────────────────────

const RerunStepSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]);

const SettingsActionBodySchema = z.union([
  z.object({ action: z.literal('visible_modules'), modules: z.array(z.enum(MODULE_KEYS)).min(1) }),
  z.object({ action: z.literal('baseline'), flow: z.enum(FLOW_TYPES), minutes: z.number().int() }),
  z.object({ action: z.literal('rerun'), step: RerunStepSchema }),
]);

// ─── Reading back firm_config's JSON columns, defensively ──────────────────

const SettingsDocTypeRowSchema = z.object({
  key: z.string(),
  labelAr: z.string(),
  flow: z.enum(FLOW_TYPES).nullable(),
});

const NpiApiGapRowSchema = z.object({
  kind: z.literal('permission_unknown'),
  roleKey: z.string(),
  permission: z.string(),
});

const NpiApiGapsJsonRowSchema = z.object({
  gaps: z.array(NpiApiGapRowSchema),
  blocked: z.array(z.object({ stepId: z.string(), reasonAr: z.string() })),
  failed: z.array(z.object({ stepId: z.string(), reasonAr: z.string(), npiMessage: z.string().nullable() })),
  appliedAt: z.string(),
});

/** Splits a plan-step id (`department:SALES`, `role:pm`,
 *  `approval_rule:PURCHASE_ORDER:100000`, `item:MOD-600`) into the wizard
 *  step that can change it and an Arabic label — keyed by the id's KIND
 *  (and, for a rule, its document type) only, never by an embedded
 *  threshold (PROGRESS.md Suggestions, T-19). */
function describeLeftover(stepId: string, reasonAr: string, npiMessage: string | null, pack: ProfilePack | null): SettingsLeftover {
  const [kind, ...rest] = stepId.split(':');

  if (kind === 'department') {
    const code = rest[0] ?? '';
    return { stepId, kind: 'department', labelAr: t('settings.leftover.department', { code }), reasonAr, npiMessage, setupStep: 2 };
  }
  if (kind === 'role') {
    const roleKey = rest[0] ?? '';
    const name = pack?.rolePermissionSets[roleKey]?.nameAr ?? roleKey;
    return { stepId, kind: 'role', labelAr: t('settings.leftover.role', { name }), reasonAr, npiMessage, setupStep: 2 };
  }
  if (kind === 'approval_rule') {
    const docType = rest[0] ?? '';
    const minSegment = rest[1] ?? '';
    const minNumber = Number(minSegment);
    const min = Number.isFinite(minNumber) ? formatNumber(minNumber) : minSegment;
    const doc = APPROVAL_DOCUMENT_LABEL_AR[docType as ApprovalDocumentType] ?? docType;
    return {
      stepId,
      kind: 'approval_rule',
      labelAr: t('settings.leftover.approval_rule', { doc, min }),
      reasonAr,
      npiMessage,
      setupStep: 3,
    };
  }
  if (kind === 'item') {
    const sku = rest[0] ?? '';
    return { stepId, kind: 'item', labelAr: t('settings.leftover.item', { sku }), reasonAr, npiMessage, setupStep: 5 };
  }
  return { stepId, kind: 'unknown', labelAr: t('settings.leftover.unknown', { id: stepId }), reasonAr, npiMessage, setupStep: null };
}

function buildLastApply(json: unknown, pack: ProfilePack | null): SettingsLastApply | null {
  const parsed = NpiApiGapsJsonRowSchema.safeParse(json);
  if (!parsed.success) return null;
  return {
    appliedAt: parsed.data.appliedAt,
    gaps: parsed.data.gaps as NpiApiGap[],
    blocked: parsed.data.blocked.map((b) => describeLeftover(b.stepId, b.reasonAr, null, pack)),
    failed: parsed.data.failed.map((f) => describeLeftover(f.stepId, f.reasonAr, f.npiMessage, pack)),
  };
}

function loadPackSafely(loadPack: (key: string) => ProfilePack, profileKey: ProfileKey): ProfilePack | null {
  try {
    return loadPack(profileKey);
  } catch {
    return null;
  }
}

function buildConfig(row: SettingsFirmConfigRow | null, loadPack: (key: string) => ProfilePack): SettingsConfig | null {
  if (row === null) return null;
  if (row.profileKey === null || !(PROFILE_KEYS as readonly string[]).includes(row.profileKey)) return null;
  const profileKey = row.profileKey as ProfileKey;
  const pack = loadPackSafely(loadPack, profileKey);

  const modulesParsed = z.array(z.string()).safeParse(row.visibleModulesJson);
  const visibleModules: ModuleKey[] = modulesParsed.success
    ? modulesParsed.data.filter((m): m is ModuleKey => (MODULE_KEYS as readonly string[]).includes(m))
    : [];

  const docTypesParsed = z.array(z.unknown()).safeParse(row.acceptedDocTypesJson);
  const acceptedDocTypes: SettingsDocType[] = [];
  if (docTypesParsed.success) {
    for (const item of docTypesParsed.data) {
      const d = SettingsDocTypeRowSchema.safeParse(item);
      if (d.success) acceptedDocTypes.push(d.data);
    }
  }

  const termsParsed = z.record(z.string(), z.string()).safeParse(row.terminologyJson);
  const terminology: Partial<Record<TermKey, string>> = {};
  if (termsParsed.success) {
    for (const [key, value] of Object.entries(termsParsed.data)) {
      if ((TERM_KEYS as readonly string[]).includes(key)) terminology[key as TermKey] = value;
    }
  }

  return {
    profileKey,
    profileTitleAr: t(`profile.${profileKey}` as ArKey),
    setupCompletedAt: row.setupCompletedAt ? row.setupCompletedAt.toISOString() : null,
    visibleModules,
    acceptedDocTypes,
    terminology,
    lastApply: buildLastApply(row.npiApiGapsJson, pack),
  };
}

// ─── Positions ──────────────────────────────────────────────────────────────

function comparePositions(a: SettingsPosition, b: SettingsPosition): number {
  if (a.roleKey !== b.roleKey) return a.roleKey < b.roleKey ? -1 : 1;
  if (a.titleAr !== b.titleAr) return a.titleAr < b.titleAr ? -1 : 1;
  return 0;
}

async function buildPositions(
  deps: SettingsDeps,
  caller: SetupCaller,
  config: SettingsConfig | null,
  loadPack: (key: string) => ProfilePack,
): Promise<SettingsPosition[]> {
  const rows = await deps.db.position.findMany({
    where: { npiOrgId: caller.npiOrgId },
    orderBy: { roleKey: 'asc' },
    include: { assignments: { where: { endedAt: null }, select: { npiUserId: true, startedAt: true } } },
  });

  const pack = config !== null ? loadPackSafely(loadPack, config.profileKey) : null;

  let departments: { id: string; nameAr: string }[] | null = null;
  if (caller.permissions.includes(SNAPSHOT_READ_PERMISSION.departments)) {
    try {
      departments = readDepartments(await deps.npi.listDepartments());
    } catch (err) {
      if (!(err instanceof NpiError && err.kind === 'forbidden')) throw err;
    }
  }

  let directoryUsers: { id: string; nameAr: string }[] | null = null;
  if (caller.permissions.includes(SNAPSHOT_READ_PERMISSION.directory)) {
    try {
      directoryUsers = readDirectoryUsers(await deps.npi.listDepartmentDirectory());
    } catch (err) {
      if (!(err instanceof NpiError && err.kind === 'forbidden')) throw err;
    }
  }

  // Role names: the pack's Arabic name first; for a role the pack does not
  // name (or before the first apply, when there is no pack at all — the
  // role-only positions `resolvePosition` creates at login), NPI's own
  // `/admin/roles` names it, read once and only when needed. The key itself
  // is the last resort, never an error.
  const packRoleName = (key: string): string | undefined => pack?.rolePermissionSets[key]?.nameAr;
  let npiRoleNames: Map<string, string> | null = null;
  if (rows.some((row) => packRoleName(row.roleKey) === undefined) && caller.permissions.includes(SNAPSHOT_READ_PERMISSION.roles)) {
    try {
      npiRoleNames = new Map(readRoles(await deps.npi.listRoles()).map((r) => [r.key, r.nameAr]));
    } catch (err) {
      if (!(err instanceof NpiError && err.kind === 'forbidden')) throw err;
    }
  }

  const positions: SettingsPosition[] = rows.map((row) => ({
    id: row.id,
    roleKey: row.roleKey,
    roleNameAr: packRoleName(row.roleKey) ?? npiRoleNames?.get(row.roleKey) ?? row.roleKey,
    departmentId: row.departmentId,
    departmentNameAr: row.departmentId === null ? null : departments?.find((d) => d.id === row.departmentId)?.nameAr ?? null,
    titleAr: row.titleAr,
    holders: [...row.assignments]
      .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
      .map((a) => ({
        npiUserId: a.npiUserId,
        nameAr: directoryUsers?.find((u) => u.id === a.npiUserId)?.nameAr ?? null,
        since: a.startedAt.toISOString(),
      })),
  }));

  return positions.sort(comparePositions);
}

// ─── Baselines ──────────────────────────────────────────────────────────────

async function buildBaselines(deps: SettingsDeps, caller: SetupCaller): Promise<SettingsView['baselines']> {
  const rows = await deps.db.manualBaseline.findMany({ where: { npiOrgId: caller.npiOrgId } });
  const baselines = Object.fromEntries(FLOW_TYPES.map((flow) => [flow, null])) as SettingsView['baselines'];
  for (const row of rows) {
    if (!(FLOW_TYPES as readonly string[]).includes(row.flowType)) continue;
    baselines[row.flowType as (typeof FLOW_TYPES)[number]] = { minutes: row.minutes, measuredAt: row.measuredAt.toISOString() };
  }
  return baselines;
}

// ─── View ───────────────────────────────────────────────────────────────────

async function buildSettingsView(deps: SettingsDeps, caller: SetupCaller): Promise<SettingsView> {
  const loadPack = deps.loadPack ?? loadProfilePack;
  const row = await deps.db.firmConfig.findUnique({ where: { npiOrgId: caller.npiOrgId } });
  const config = buildConfig(row, loadPack);

  const [positions, baselines, openSession] = await Promise.all([
    buildPositions(deps, caller, config, loadPack),
    buildBaselines(deps, caller),
    deps.db.onboardingSession.findFirst({ where: { npiOrgId: caller.npiOrgId, completedAt: null } }),
  ]);

  return { config, positions, baselines, openSetup: openSession !== null };
}

// ─── Entry points ───────────────────────────────────────────────────────────

export async function getSettingsView(deps: SettingsDeps, caller: SetupCaller): Promise<SettingsView> {
  requireAdmin(caller);
  return buildSettingsView(deps, caller);
}

export async function handleSettingsAction(deps: SettingsDeps, caller: SetupCaller, rawBody: unknown): Promise<SettingsActionResult> {
  requireAdmin(caller);
  const body = SettingsActionBodySchema.parse(rawBody);
  const now = deps.now ?? (() => new Date());

  if (body.action === 'visible_modules') {
    const requested = new Set<string>(body.modules);
    const ordered = MODULE_KEYS.filter((key) => requested.has(key));
    if (!ordered.includes('finance')) {
      throw new SettingsError('invalid_modules', t('settings.modules.invalid'));
    }
    const existing = await deps.db.firmConfig.findUnique({ where: { npiOrgId: caller.npiOrgId } });
    const hasConfig = existing !== null && existing.profileKey !== null && (PROFILE_KEYS as readonly string[]).includes(existing.profileKey);
    if (!hasConfig) {
      throw new SettingsError('no_config', t('settings.no_config'));
    }
    await deps.db.firmConfig.update({ where: { npiOrgId: caller.npiOrgId }, data: { visibleModulesJson: ordered } });
    return buildSettingsView(deps, caller);
  }

  if (body.action === 'baseline') {
    if (body.minutes < BASELINE_MIN_MINUTES || body.minutes > BASELINE_MAX_MINUTES) {
      throw new SettingsError(
        'invalid_baseline',
        t('settings.baselines.invalid', { min: formatNumber(BASELINE_MIN_MINUTES), max: formatNumber(BASELINE_MAX_MINUTES) }),
      );
    }
    const measuredAt = now();
    await deps.db.manualBaseline.upsert({
      where: { npiOrgId_flowType: { npiOrgId: caller.npiOrgId, flowType: body.flow } },
      create: { npiOrgId: caller.npiOrgId, flowType: body.flow, minutes: body.minutes, measuredAt, npiUserId: caller.npiUserId },
      update: { minutes: body.minutes, measuredAt, npiUserId: caller.npiUserId },
    });
    return buildSettingsView(deps, caller);
  }

  // 'rerun': `reopenSetupAtStep` only ever calls `deps.db.onboardingSession`
  // (see its own signature, `Pick<SetupDeps, 'db'>`), which `SettingsDb`
  // carries verbatim (`SetupSessionDb['onboardingSession']`) — the cast
  // below only widens the *compile-time* shape to `SetupDeps['db']`, the
  // same discipline `api/setup/route.ts` uses for its own `db` cast.
  await reopenSetupAtStep({ db: deps.db as unknown as SetupDeps['db'] }, caller, body.step as RerunStep);
  return { redirect: '/setup' };
}
