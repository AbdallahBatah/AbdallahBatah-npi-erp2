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
import { SNAPSHOT_READ_PERMISSION } from './gaps';
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
import { t } from '../i18n/ar';
import { readDirectoryUsers } from '../npi/admin';
import { NpiError } from '../npi/errors';

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

export interface SetupDeps {
  db: SetupSessionDb & OnboardingDb;
  npi: OnboardingNpi;
  llm: ParseDeps['llm'];
  pseudonymizer: ParseDeps['pseudonymizer'];
  /** Overridable for tests; defaults to the real `loadProfilePack`. */
  loadPack?: (key: string) => ProfilePack;
  now?: () => Date;
}

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
]);
export type SetupActionBody = z.infer<typeof SetupActionBodySchema>;

// ─── Views ──────────────────────────────────────────────────────────────────

export interface SetupStateView {
  state: SetupState;
  question: { step: SetupStep; key: ReturnType<typeof questionKey>; textAr: string };
  defaults: StepDefaults | null;
  profileTitleAr: string | null;
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

async function loadOrCreateSession(deps: SetupDeps, caller: SetupCaller): Promise<OnboardingSessionRow> {
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
  deps: SetupDeps,
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
async function buildView(deps: SetupDeps, caller: SetupCaller, state: SetupState): Promise<SetupStateView> {
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

  return {
    state,
    question: { step: state.step, key, textAr: t(key) },
    defaults: stepDefaults(state.step, pack, { npiUsers }),
    profileTitleAr: pack ? pack.titleAr : null,
  };
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

// ─── Entry points ───────────────────────────────────────────────────────────

export async function getSetupState(deps: SetupDeps, caller: SetupCaller): Promise<SetupStateView> {
  requireAdmin(caller);
  const row = await loadOrCreateSession(deps, caller);
  const state = parseStoredState(row.stepsJson);
  return buildView(deps, caller, state);
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

  if (body.action === 'preview') {
    const plan = await dryRun({ npi: deps.npi }, pack, answers, planCaller);
    const roleNameAr = (key: string) => pack.rolePermissionSets[key]?.nameAr ?? key;
    const stepTitlesAr: Record<string, string> = {};
    for (const step of plan.steps) stepTitlesAr[step.id] = describeStepAr(step, roleNameAr);
    return {
      plan: withoutPermissionLabel(plan),
      summary: summarizePlanAr(plan, pack),
      permissionLabels: buildPermissionLabels(plan),
      stepTitlesAr,
    };
  }

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
  });
  const mergedPersisted: PersistOutcome = { ...persisted, holdersSkipped: [...persisted.holdersSkipped, ...holderValidationSkips] };
  if (result.completed) {
    await saveState(deps, row.id, state, { completedAt: (deps.now ?? (() => new Date()))(), profileChosen: plan.profileKey });
  }
  return { result, summary: summarizePlanAr(plan, pack), persisted: mergedPersisted };
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
      stepsJson: { step, answers: parsed.data.answers, completedSteps: [1, 2, 3, 4, 5, 6] },
    },
  });
  return 'cloned';
}
