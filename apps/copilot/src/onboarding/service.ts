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
  persistCopilotConfig,
  type ApplyResult,
  type OnboardingDb,
  type OnboardingNpi,
  type PersistOutcome,
} from './apply';
import { loadProfilePack } from './catalog';
import {
  applyAnswer,
  goTo,
  initialState,
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
} from './machine';
import { parseAnswer, type ParseDeps } from './parse';
import { summarizePlanAr, type OnboardingPlan, type PlanSummaryAr } from './plan';
import type { ProfilePack } from './profile.schema';
import { t } from '../i18n/ar';

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
    findFirst(args: {
      where: { npiOrgId: string; completedAt: null };
      orderBy?: { startedAt: 'desc' };
    }): Promise<OnboardingSessionRow | null>;
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

function buildView(deps: SetupDeps, state: SetupState): SetupStateView {
  const loadPack = deps.loadPack ?? loadProfilePack;
  const pack = state.answers.profileKey !== undefined ? loadPack(state.answers.profileKey) : null;
  const key = questionKey(state.step);
  return {
    state,
    question: { step: state.step, key, textAr: t(key) },
    defaults: stepDefaults(state.step, pack, {}),
    profileTitleAr: pack ? pack.titleAr : null,
  };
}

function withoutPermissionLabel(plan: OnboardingPlan): Omit<OnboardingPlan, 'permissionLabel'> {
  const { permissionLabel: _permissionLabel, ...rest } = plan;
  return rest;
}

// ─── Entry points ───────────────────────────────────────────────────────────

export async function getSetupState(deps: SetupDeps, caller: SetupCaller): Promise<SetupStateView> {
  requireAdmin(caller);
  const row = await loadOrCreateSession(deps, caller);
  const state = parseStoredState(row.stepsJson);
  return buildView(deps, state);
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
    return buildView(deps, next);
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
    return { ...buildView(deps, next), parsed: answer, source };
  }

  // 'preview' and 'apply' both need a complete-enough set of answers to
  // build a plan; `toAnswers` throws `MachineError` when step 1 was never
  // answered, which is exactly the right refusal here too.
  const answers = toAnswers(state);
  const pack = loadPack(answers.profileKey);
  const planCaller = { roleKey: caller.roleKey, permissions: caller.permissions };

  if (body.action === 'preview') {
    const plan = await dryRun({ npi: deps.npi }, pack, answers, planCaller);
    return { plan: withoutPermissionLabel(plan), summary: summarizePlanAr(plan, pack) };
  }

  // 'apply': re-reads NPI and rebuilds the plan rather than trusting a plan
  // the client may have cached from an earlier preview (spec/madar/02 §7:
  // "dry-run diff shown first" — apply never trusts a stale one).
  const plan = await dryRun({ npi: deps.npi }, pack, answers, planCaller);
  const result = await applyPlan({ npi: deps.npi }, plan);
  const persisted = await persistCopilotConfig(deps.db, { npiOrgId: caller.npiOrgId, plan, result, now: deps.now });
  if (result.completed) {
    await saveState(deps, row.id, state, { completedAt: (deps.now ?? (() => new Date()))(), profileChosen: plan.profileKey });
  }
  return { result, summary: summarizePlanAr(plan, pack), persisted };
}
