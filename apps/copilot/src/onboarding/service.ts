// Orchestration behind `POST /api/setup` and `GET /api/setup` (T-17,
// spec/madar/02 §7). Kept apart from the route handler so it is unit
// testable with fakes (db, npi, llm, pseudonymizer, loadPack, now) — the
// route only wires the real ones and maps thrown errors to HTTP status
// codes (`MachineError`/`PlanError` -> 400, `NpiError` -> 401/502).
//
// Admin-only enforcement (the NPI permission `admin.user.manage`) is the
// route's job, same as `crossSite`/session checks on the chat route: by the
// time a call reaches here, the caller is already known to be an
// administrator.
import { z } from 'zod';
import {
  applyPlan,
  dryRun,
  loadNpiSnapshot,
  persistCopilotConfig,
  validateHolders,
  type ApplyResult,
  type OnboardingDb,
  type OnboardingNpi,
  type PersistOutcome,
} from './apply';
import { loadProfilePack } from './catalog';
import { discoveryBlockers, discoverFromNpi, seedStateFromDiscovery } from './discover';
import { describeBlockedAr, SNAPSHOT_READ_PERMISSION } from './gaps';
import {
  applyAnswer,
  goTo,
  initialState,
  MachineError,
  questionKey,
  SetupStateSchema,
  SetupStepSchema,
  StepAnswerSchema,
  stepDefaults,
  toAnswers,
  type SetupState,
  type SetupStep,
  type StepAnswer,
  type StepDefaults,
  type StepDefaultsNpiUser,
} from './machine';
import type { RerunStep } from '../settings/types';
import { parseAnswer, type ParseDeps } from './parse';
import { buildPlan, describeStepAr, summarizePlanAr, type OnboardingPlan, type PlanSummaryAr } from './plan';
import type { ProfilePack } from './profile.schema';
import { buildSummary, type SetupSummary } from './summary';
import { t } from '../i18n/ar';
import type { NpiClient } from '../npi/client';
import { readDirectoryUsers } from '../npi/admin';
import { NpiError } from '../npi/errors';
import { readList } from '../npi/responses';

// ─── Dependencies ───────────────────────────────────────────────────────────

export interface OnboardingSessionRow {
  id: string;
  npiOrgId: string;
  npiUserId: string;
  stepsJson: unknown;
  completedAt: Date | null;
  profileChosen: string | null;
}

/** The subset of `OnboardingSession`'s Prisma delegate this file calls,
 *  typed structurally like `OnboardingDb`/`SessionDb` elsewhere so a small
 *  in-memory fake satisfies it in tests and the real client does too. */
export interface SetupSessionDb {
  onboardingSession: {
    /** The real Prisma delegate accepts both shapes below (and more); this
     *  file only ever asks for the one OPEN session (T-17) or, for
     *  `reopenSetupAtStep` (T-19), the latest COMPLETED one. */
    findFirst(
      args:
        | { where: { npiOrgId: string; completedAt: null }; orderBy?: { startedAt: 'desc' } }
        | { where: { npiOrgId: string; completedAt: { not: null } }; orderBy: { completedAt: 'desc' } },
    ): Promise<OnboardingSessionRow | null>;
    create(args: { data: { npiOrgId: string; npiUserId: string; stepsJson: unknown } }): Promise<OnboardingSessionRow>;
    update(args: {
      where: { id: string };
      data: { stepsJson?: unknown; completedAt?: Date | null; profileChosen?: string | null };
    }): Promise<OnboardingSessionRow>;
  };
}

/** The three lists discovery counts (T-47a). Optional, so a caller or a fake
 *  that does not offer one simply gives the guess less to go on. */
export type DiscoveryNpi = Partial<Pick<NpiClient, 'listCustomers' | 'listProjects' | 'listVendors'>>;

export interface SetupDeps {
  db: SetupSessionDb & OnboardingDb;
  npi: OnboardingNpi & DiscoveryNpi;
  llm: ParseDeps['llm'];
  pseudonymizer: ParseDeps['pseudonymizer'];
  /** Overridable for tests; defaults to the real `loadProfilePack`. */
  loadPack?: (key: string) => ProfilePack;
  now?: () => Date;
}

/**
 * What reading the current step needs (`getSetupState`, and the `buildView` /
 * `loadOrCreateSession` it runs): the database, NPI and the pack loader — no
 * model and no pseudonymizer, which only the answer, preview and apply
 * actions use. The setup page (T-39b, D-23) reads with exactly these so it
 * never constructs an LLM client or a pseudonymizer just to show the state:
 * `tests/no-bypass-llm.spec.ts` R4d keeps an exact allowlist of the files that
 * may construct a provider, and that list must not grow for a page.
 * `SetupDeps` is assignable to this, so the route keeps passing its own.
 */
export type SetupReadDeps = Pick<SetupDeps, 'db' | 'npi' | 'loadPack' | 'now'>;

export interface SetupCaller {
  npiOrgId: string;
  npiUserId: string;
  roleKey: string;
  permissions: readonly string[];
}

/** The NPI permission the setup screens require — the same one T-16's plan
 *  treats as "configure NPI" (`STEP_WRITE_PERMISSION.role` in `gaps.ts`). */
export const SETUP_ADMIN_PERMISSION = 'admin.user.manage';

/** Thrown by every entry point below when the caller lacks
 *  `SETUP_ADMIN_PERMISSION`. The route maps this to HTTP 403; tests that
 *  call `getSetupState`/`handleSetupAction` directly can assert on
 *  `.status` without going through the route at all. */
export class SetupForbiddenError extends Error {
  readonly status = 403;
  readonly messageAr: string;
  constructor(messageAr: string) {
    super('caller lacks admin.user.manage');
    this.name = 'SetupForbiddenError';
    this.messageAr = messageAr;
  }
}

function requireAdmin(caller: SetupCaller): void {
  if (!caller.permissions.includes(SETUP_ADMIN_PERMISSION)) {
    throw new SetupForbiddenError(t('setup.forbidden'));
  }
}

// ─── Request body ───────────────────────────────────────────────────────────

const SetupActionBodySchema = z.union([
  z.object({ action: z.literal('answer'), step: SetupStepSchema, text: z.string().min(1).max(2000) }),
  z.object({ action: z.literal('answer'), step: SetupStepSchema, answer: StepAnswerSchema }),
  z.object({ action: z.literal('goto'), step: SetupStepSchema }),
  z.object({ action: z.literal('preview') }),
  z.object({ action: z.literal('apply') }),
  /** T-47a: drop the discovered answers and type the steps by hand. */
  z.object({ action: z.literal('manual') }),
]);
export type SetupActionBody = z.infer<typeof SetupActionBodySchema>;

// ─── Views ──────────────────────────────────────────────────────────────────

export interface SetupStateView {
  state: SetupState;
  question: { step: SetupStep; key: ReturnType<typeof questionKey>; textAr: string };
  defaults: StepDefaults | null;
  profileTitleAr: string | null;
  /** T-47a: the «هذا ما قرأته من NPI» screen — set only for a discovered
   *  session standing on the summary, which then replaces the step editors. */
  summary: SetupSummary | null;
  /** T-47a: why the setup is manual when discovery was not possible (the NPI
   *  read permission missing), in Arabic. */
  discoveryNoteAr: string | null;
}

export interface SetupAnswerResult extends SetupStateView {
  parsed: StepAnswer;
  source: 'deterministic' | 'model' | 'structured';
}

export interface SetupUnclearResult {
  unclear: string;
}

export interface SetupPreviewResult {
  plan: Omit<OnboardingPlan, 'permissionLabel'>;
  summary: PlanSummaryAr;
  /** NPI's Arabic label (from its own permission catalog) for every
   *  permission key that appears in a role step's `permissions`,
   *  `permissionsAdded` or `permissionsRemoved` — falls back to the key
   *  itself when the catalog could not be read. The screens render this
   *  instead of raw keys. */
  permissionLabels: Record<string, string>;
  /** Arabic name of every plan step by its stable id (`describeStepAr`), so
   *  the apply result — which reports outcomes per step id — can be shown in
   *  Arabic without the screen rebuilding the plan's wording. */
  stepTitlesAr: Record<string, string>;
}

export interface SetupApplyResult {
  result: ApplyResult;
  summary: PlanSummaryAr;
  persisted: PersistOutcome;
}

export type SetupActionResult = SetupStateView | SetupAnswerResult | SetupUnclearResult | SetupPreviewResult | SetupApplyResult;

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseStoredState(json: unknown): SetupState {
  const parsed = SetupStateSchema.safeParse(json);
  return parsed.success ? parsed.data : initialState();
}

async function loadOrCreateSession(deps: SetupReadDeps, caller: SetupCaller): Promise<OnboardingSessionRow> {
  const existing = await deps.db.onboardingSession.findFirst({
    where: { npiOrgId: caller.npiOrgId, completedAt: null },
    orderBy: { startedAt: 'desc' },
  });
  if (existing) return existing;
  return deps.db.onboardingSession.create({
    data: { npiOrgId: caller.npiOrgId, npiUserId: caller.npiUserId, stepsJson: initialState() },
  });
}

async function saveState(
  deps: Pick<SetupDeps, 'db'>,
  id: string,
  state: SetupState,
  extra: Partial<{ completedAt: Date | null; profileChosen: string | null }> = {},
): Promise<void> {
  await deps.db.onboardingSession.update({ where: { id }, data: { stepsJson: state, ...extra } });
}

/**
 * Step 2's defaults need NPI's directory (for the position-holder picker),
 * which only `admin.department.manage` can read — the same guard the plan
 * itself uses for that slot (`SNAPSHOT_READ_PERMISSION.directory`). A 403
 * from NPI (`NpiError` with `kind === 'forbidden'`) is treated as "no users
 * to show", same discipline as `loadNpiSnapshot`; any other `NpiError`
 * propagates to the route, which maps it to an HTTP response.
 */
async function buildView(deps: SetupReadDeps, caller: SetupCaller, state: SetupState): Promise<SetupStateView> {
  const loadPack = deps.loadPack ?? loadProfilePack;
  const pack = state.answers.profileKey !== undefined ? loadPack(state.answers.profileKey) : null;
  const key = questionKey(state.step);

  let npiUsers: StepDefaultsNpiUser[] = [];
  if (state.step === 2 && caller.permissions.includes(SNAPSHOT_READ_PERMISSION.directory)) {
    try {
      const users = readDirectoryUsers(await deps.npi.listDepartmentDirectory());
      npiUsers = users.map((u) => ({ id: u.id, nameAr: u.nameAr, roleKey: u.roleKey, isActive: u.isActive }));
    } catch (err) {
      if (!(err instanceof NpiError && err.kind === 'forbidden')) throw err;
    }
  }

  const defaults = stepDefaults(state.step, pack, { npiUsers, roleSets: state.discovery?.roleSets });
  if (defaults?.step === 2 && state.discovery !== undefined) {
    // A discovered session's positions are NPI's roles, not the pack's, so the
    // holder picker needs the active users of every role.
    const usersByRole: Record<string, StepDefaultsNpiUser[]> = {};
    for (const user of npiUsers) if (user.isActive) (usersByRole[user.roleKey] ??= []).push(user);
    defaults.usersByRole = usersByRole;
  }

  return {
    state,
    question: { step: state.step, key, textAr: t(key) },
    defaults,
    profileTitleAr: pack ? pack.titleAr : null,
    summary: buildSummary(state, pack),
    discoveryNoteAr: discoveryNoteAr(state),
  };
}

function discoveryNoteAr(state: SetupState): string | null {
  if (!state.discoveryMissing || state.discoveryMissing.length === 0) return null;
  const lines = state.discoveryMissing.map((permission) => describeBlockedAr({ code: 'npi_state_unreadable', permission }));
  return [t('setup.discover.unavailable'), ...lines].join('\n');
}

// ─── Discovery (T-47a) ──────────────────────────────────────────────────────

/** How many rows NPI lists, one page; null when the list is not offered or
 *  NPI refuses it (the guess then simply has less evidence). */
async function countOf(read: (() => Promise<unknown>) | undefined): Promise<number | null> {
  if (read === undefined) return null;
  try {
    return readList(await read()).length;
  } catch (err) {
    if (err instanceof NpiError) return null;
    throw err;
  }
}

/**
 * A session with no answers yet and no instruction to type them by hand is
 * seeded from NPI: the answers are read (as the administrator, with their
 * token), stored with `discovery` metadata, and the view shows the summary.
 * When the roles, departments or user directory cannot be read, the session
 * becomes today's manual wizard and records which permission was missing.
 * Nothing is written to NPI here.
 */
async function ensureDiscovery(deps: SetupReadDeps, caller: SetupCaller, id: string, state: SetupState): Promise<SetupState> {
  if (state.manual || state.discovery || state.completedSteps.length > 0 || state.answers.profileKey !== undefined) return state;

  const snapshot = await loadNpiSnapshot(deps.npi, { roleKey: caller.roleKey, permissions: caller.permissions });
  const missing = discoveryBlockers(snapshot);
  if (missing.length > 0) {
    const next: SetupState = { ...state, manual: true, discoveryMissing: missing };
    await saveState(deps, id, next);
    return next;
  }

  const counts = {
    projects: await countOf(deps.npi.listProjects ? () => deps.npi.listProjects!() : undefined),
    customers: await countOf(deps.npi.listCustomers ? () => deps.npi.listCustomers!() : undefined),
    vendors: await countOf(deps.npi.listVendors ? () => deps.npi.listVendors!() : undefined),
  };
  const discovered = discoverFromNpi(snapshot, { counts, loadPack: deps.loadPack });
  const next = seedStateFromDiscovery(discovered, (deps.now ?? (() => new Date()))());
  await saveState(deps, id, next);
  return next;
}

function withoutPermissionLabel(plan: OnboardingPlan): Omit<OnboardingPlan, 'permissionLabel'> {
  const { permissionLabel: _permissionLabel, ...rest } = plan;
  return rest;
}

/** Every permission key named in a role step, mapped to NPI's Arabic label. */
function buildPermissionLabels(plan: OnboardingPlan): Record<string, string> {
  const keys = new Set<string>();
  for (const step of plan.steps) {
    if (step.kind !== 'role') continue;
    for (const key of step.permissions) keys.add(key);
    for (const key of step.permissionsAdded) keys.add(key);
    for (const key of step.permissionsRemoved) keys.add(key);
  }
  const labels: Record<string, string> = {};
  for (const key of keys) labels[key] = plan.permissionLabel(key);
  return labels;
}

/** Step 7's content: the dry run of the plan against NPI, as the route's
 *  `preview` action answers it (a read — nothing is written). */
async function buildPreview(
  deps: SetupReadDeps,
  pack: ProfilePack,
  answers: ReturnType<typeof toAnswers>,
  planCaller: { roleKey: string; permissions: readonly string[] },
): Promise<SetupPreviewResult> {
  const plan = await dryRun({ npi: deps.npi }, pack, answers, planCaller);
  const roleNameAr = (key: string) => plan.roleNamesAr[key] ?? pack.rolePermissionSets[key]?.nameAr ?? key;
  const stepTitlesAr: Record<string, string> = {};
  for (const step of plan.steps) stepTitlesAr[step.id] = describeStepAr(step, roleNameAr);
  return {
    plan: withoutPermissionLabel(plan),
    summary: summarizePlanAr(plan, pack),
    permissionLabels: buildPermissionLabels(plan),
    stepTitlesAr,
  };
}

// ─── Entry points ───────────────────────────────────────────────────────────

export async function getSetupState(deps: SetupReadDeps, caller: SetupCaller): Promise<SetupStateView> {
  requireAdmin(caller);
  const row = await loadOrCreateSession(deps, caller);
  const state = await ensureDiscovery(deps, caller, row.id, parseStoredState(row.stepsJson));
  return buildView(deps, caller, state);
}

/**
 * Step 7's diff for the setup page's server render (T-39b): the same dry run
 * the wizard otherwise requests after hydration (`action: 'preview'`), so the
 * card is in the first HTML. Null when the open session is not on step 7.
 * Read-only, like `getSetupState`; the `MachineError` of an incomplete
 * session propagates like the route's.
 */
export async function previewSetupState(deps: SetupReadDeps, caller: SetupCaller): Promise<SetupPreviewResult | null> {
  requireAdmin(caller);
  const loadPack = deps.loadPack ?? loadProfilePack;
  const row = await loadOrCreateSession(deps, caller);
  const state = parseStoredState(row.stepsJson);
  if (state.step !== 7) return null;
  const answers = toAnswers(state);
  return buildPreview(deps, loadPack(answers.profileKey), answers, { roleKey: caller.roleKey, permissions: caller.permissions });
}

/**
 * Validates the body, loads (or creates) the org's one open onboarding
 * session, and runs the requested action. Throws `MachineError`/`PlanError`
 * on a refused edit or stale plan, and lets any `NpiError` from `dryRun`/
 * `applyPlan` propagate — the route maps all three to HTTP responses.
 */
export async function handleSetupAction(deps: SetupDeps, caller: SetupCaller, rawBody: unknown): Promise<SetupActionResult> {
  requireAdmin(caller);
  const body = SetupActionBodySchema.parse(rawBody);
  const loadPack = deps.loadPack ?? loadProfilePack;
  const row = await loadOrCreateSession(deps, caller);
  const state = parseStoredState(row.stepsJson);

  if (body.action === 'manual') {
    const next: SetupState = { ...initialState(), manual: true };
    await saveState(deps, row.id, next);
    return buildView(deps, caller, next);
  }

  if (body.action === 'goto') {
    const next = goTo(state, body.step);
    await saveState(deps, row.id, next);
    return buildView(deps, caller, next);
  }

  if (body.action === 'answer') {
    const pack = state.answers.profileKey !== undefined ? loadPack(state.answers.profileKey) : null;
    let answer: StepAnswer;
    let source: SetupAnswerResult['source'];

    if ('answer' in body) {
      answer = body.answer;
      source = 'structured';
    } else {
      const outcome = await parseAnswer(
        { llm: deps.llm, pseudonymizer: deps.pseudonymizer },
        { step: body.step, text: body.text, pack, current: state },
        { npiOrgId: caller.npiOrgId, npiUserId: caller.npiUserId },
      );
      if (outcome.kind === 'unclear') return { unclear: outcome.messageAr };
      answer = outcome.answer;
      source = outcome.source;
    }

    const next = applyAnswer(state, body.step, answer, { loadPack });
    await saveState(deps, row.id, next);
    return { ...(await buildView(deps, caller, next)), parsed: answer, source };
  }

  // 'preview' and 'apply' both need a complete-enough set of answers to
  // build a plan; `toAnswers` throws `MachineError` when step 1 was never
  // answered, which is exactly the right refusal here too.
  const answers = toAnswers(state);
  const pack = loadPack(answers.profileKey);
  const planCaller = { roleKey: caller.roleKey, permissions: caller.permissions };

  if (body.action === 'preview') return buildPreview(deps, pack, answers, planCaller);

  // 'apply': re-reads NPI and rebuilds the plan rather than trusting a plan
  // the client may have cached from an earlier preview (spec/madar/02 §7:
  // "dry-run diff shown first" — apply never trusts a stale one).
  const snapshot = await loadNpiSnapshot(deps.npi, planCaller);
  const plan = buildPlan(pack, answers, snapshot, planCaller);
  const result = await applyPlan({ npi: deps.npi }, plan);
  const { valid: validHolders, skipped: holderValidationSkips } = validateHolders(plan.copilot.holders, plan.copilot.positions, snapshot.users);
  const persisted = await persistCopilotConfig(deps.db, {
    npiOrgId: caller.npiOrgId,
    plan,
    result,
    holders: validHolders,
    now: deps.now,
    setup: setupRecord(state, (deps.now ?? (() => new Date()))()),
  });
  const mergedPersisted: PersistOutcome = { ...persisted, holdersSkipped: [...persisted.holdersSkipped, ...holderValidationSkips] };
  if (result.completed) {
    await saveState(deps, row.id, state, { completedAt: (deps.now ?? (() => new Date()))(), profileChosen: plan.profileKey });
  }
  return { result, summary: summarizePlanAr(plan, pack), persisted: mergedPersisted };
}

/** What `firm_config.setupSource`/`discoveryJson` keep of how this setup was reached. */
function setupRecord(state: SetupState, now: Date): { source: 'discovered' | 'manual'; discoveryJson: Record<string, unknown> } {
  const discovery = state.discovery;
  if (discovery === undefined) return { source: 'manual', discoveryJson: { manual: true, at: now.toISOString() } };
  return {
    source: 'discovered',
    discoveryJson: {
      at: discovery.at,
      confirmedAt: now.toISOString(),
      sources: discovery.sources,
      evidence: discovery.evidence,
      roleKeys: Object.keys(discovery.roleSets ?? {}),
    },
  };
}

// ─── /settings: re-opening a step (T-19) ───────────────────────────────────

export type RerunOutcome = 'open' | 'cloned' | 'fresh';

/**
 * Re-opens the organization's setup wizard at `step` (spec/madar/02 §7:
 * "re-runnable per step from /settings"). Three outcomes:
 *
 *  - `'open'`    an unfinished session already exists; `goTo` is tried on it
 *                (moving to an already-completed step, or back to the next
 *                open one). A `goTo` the machine refuses (`MachineError`)
 *                leaves the session exactly as it was — never cloned over,
 *                since the administrator may be mid-setup right now.
 *  - `'cloned'`  no open session, but the latest COMPLETED one has usable
 *                answers (parses against `SetupStateSchema` and has chosen a
 *                profile): a new open session is created at `step`, carrying
 *                that session's answers verbatim and every other step
 *                (1–6) marked complete, so saving the re-answered step alone
 *                moves the wizard straight to step 7, the diff card.
 *  - `'fresh'`   nothing to clone (no completed session, a stored state that
 *                fails to parse, or one that never reached step 1). Nothing
 *                is written; the wizard's own `GET /api/setup` creates a
 *                fresh session on its own.
 */
export async function reopenSetupAtStep(deps: Pick<SetupDeps, 'db'>, caller: SetupCaller, step: RerunStep): Promise<RerunOutcome> {
  requireAdmin(caller);

  const open = await deps.db.onboardingSession.findFirst({
    where: { npiOrgId: caller.npiOrgId, completedAt: null },
    orderBy: { startedAt: 'desc' },
  });
  if (open) {
    const state = parseStoredState(open.stepsJson);
    try {
      const next = goTo(state, step);
      await deps.db.onboardingSession.update({ where: { id: open.id }, data: { stepsJson: next } });
    } catch (err) {
      if (!(err instanceof MachineError)) throw err;
      // The move was refused — leave the open session untouched.
    }
    return 'open';
  }

  const completed = await deps.db.onboardingSession.findFirst({
    where: { npiOrgId: caller.npiOrgId, completedAt: { not: null } },
    orderBy: { completedAt: 'desc' },
  });
  if (!completed) return 'fresh';

  const parsed = SetupStateSchema.safeParse(completed.stepsJson);
  if (!parsed.success) return 'fresh';
  if (parsed.data.answers.profileKey === undefined) return 'fresh';

  await deps.db.onboardingSession.create({
    data: {
      npiOrgId: caller.npiOrgId,
      npiUserId: caller.npiUserId,
      stepsJson: {
        step,
        answers: parsed.data.answers,
        completedSteps: [1, 2, 3, 4, 5, 6],
        // A re-run of one step goes straight to the diff, as before — the
        // discovered session's roles and sources still apply to it.
        ...(parsed.data.discovery ? { discovery: { ...parsed.data.discovery, needsReview: false } } : {}),
      },
    },
  });
  return 'cloned';
}
