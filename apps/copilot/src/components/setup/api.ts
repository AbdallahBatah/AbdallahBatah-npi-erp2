// Browser-side calls for the setup endpoint (`src/app/api/setup/route.ts`),
// in the style of `src/components/chat/api.ts`: never throws, and every 200
// body is narrowed with a runtime guard before the caller sees it (the
// shapes themselves come in as `import type` from `@/onboarding/*` — erased
// at compile time, never a value import of server code into a client
// bundle). A guard checks every field the setup screens actually read;
// per-step-kind fields inside `PlanStep`/`StepDefaults` (whose exact shape
// depends on a runtime `step`/`kind` discriminant from a trusted first-party
// server) are passed through once the common fields are confirmed, rather
// than re-implementing the server's own zod schemas here.
import type { ApplyResult, PersistOutcome, StepResult } from '@/onboarding/apply';
import type { SetupStep } from '@/onboarding/machine';
import type { OnboardingPlan, PlanSummaryAr, PlanStep, StepAction } from '@/onboarding/plan';
import type {
  SetupAnswerResult,
  SetupApplyResult,
  SetupPreviewResult,
  SetupStateView,
} from '@/onboarding/service';
import { t } from '@/i18n/ar';

const SETUP_API_PATH = '/copilot/api/setup';

export interface SetupIssue {
  path: string;
  message: string;
}

export type SetupApiErrorKind = 'unauthenticated' | 'forbidden' | 'invalid' | 'npi' | 'server';

export type SetupApiResult<T> =
  | ({ ok: true } & T)
  | { ok: false; kind: 'unauthenticated' }
  | { ok: false; kind: 'forbidden'; messageAr: string }
  | { ok: false; kind: 'invalid'; messageAr: string; issues: SetupIssue[] }
  | { ok: false; kind: 'npi'; messageAr: string }
  | { ok: false; kind: 'server'; messageAr: string };

export type AnswerOutcome = { kind: 'unclear'; messageAr: string } | { kind: 'answered'; view: SetupAnswerResult };

// ─── Guards ─────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isSetupStep(value: unknown): value is SetupStep {
  return typeof value === 'number' && value >= 1 && value <= 7;
}

function isSetupState(value: unknown): boolean {
  return (
    isRecord(value) &&
    isSetupStep(value.step) &&
    isRecord(value.answers) &&
    Array.isArray(value.completedSteps) &&
    value.completedSteps.every(isSetupStep)
  );
}

function isSetupStateView(value: unknown): value is SetupStateView {
  return (
    isRecord(value) &&
    isSetupState(value.state) &&
    isRecord(value.question) &&
    isSetupStep(value.question.step) &&
    typeof value.question.key === 'string' &&
    typeof value.question.textAr === 'string' &&
    (value.defaults === null || isRecord(value.defaults)) &&
    isNullableString(value.profileTitleAr)
  );
}

function isSetupAnswerResult(value: unknown): value is SetupAnswerResult {
  if (!isSetupStateView(value) || !isRecord(value)) return false;
  const { parsed, source } = value as Record<string, unknown>;
  return isRecord(parsed) && isSetupStep(parsed.step) && typeof source === 'string';
}

function isSetupUnclearResult(value: unknown): value is { unclear: string } {
  return isRecord(value) && typeof value.unclear === 'string';
}

function isPlanSummaryAr(value: unknown): value is PlanSummaryAr {
  return (
    isRecord(value) &&
    isStringArray(value.npi) &&
    isStringArray(value.already) &&
    isStringArray(value.copilot) &&
    isStringArray(value.blocked) &&
    isStringArray(value.gaps)
  );
}

const PLAN_STEP_KINDS = ['department', 'role', 'approval_rule', 'item'];
const STEP_ACTIONS = ['create', 'update', 'skip', 'blocked'];

function isPlanStep(value: unknown): value is PlanStep {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.kind === 'string' &&
    PLAN_STEP_KINDS.includes(value.kind) &&
    typeof value.action === 'string' &&
    STEP_ACTIONS.includes(value.action)
  );
}

function isOnboardingPlan(value: unknown): value is Omit<OnboardingPlan, 'permissionLabel'> {
  return (
    isRecord(value) &&
    typeof value.profileKey === 'string' &&
    Array.isArray(value.steps) &&
    value.steps.every(isPlanStep) &&
    isRecord(value.copilot) &&
    Array.isArray(value.gaps) &&
    isRecord(value.counts)
  );
}

function isSetupPreviewResult(value: unknown): value is SetupPreviewResult {
  return (
    isRecord(value) &&
    isOnboardingPlan(value.plan) &&
    isPlanSummaryAr(value.summary) &&
    isRecord(value.permissionLabels) &&
    Object.values(value.permissionLabels).every((v) => typeof v === 'string') &&
    isRecord(value.stepTitlesAr) &&
    Object.values(value.stepTitlesAr).every((v) => typeof v === 'string')
  );
}

const STEP_OUTCOMES = ['created', 'updated', 'skipped', 'blocked', 'failed'];

function isStepResult(value: unknown): value is StepResult {
  return (
    isRecord(value) &&
    typeof value.stepId === 'string' &&
    typeof value.kind === 'string' &&
    typeof value.outcome === 'string' &&
    STEP_OUTCOMES.includes(value.outcome) &&
    isNullableString(value.npiId) &&
    isNullableString(value.reasonAr) &&
    isNullableString(value.npiMessage)
  );
}

function isApplyResult(value: unknown): value is ApplyResult {
  return (
    isRecord(value) &&
    Array.isArray(value.steps) &&
    value.steps.every(isStepResult) &&
    Array.isArray(value.gaps) &&
    isRecord(value.counts) &&
    isRecord(value.departmentIdByCode) &&
    isRecord(value.roleIdByKey) &&
    typeof value.completed === 'boolean'
  );
}

function isHoldersSkipped(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.roleKey === 'string' &&
    isNullableString(value.departmentCode) &&
    typeof value.npiUserId === 'string' &&
    typeof value.reason === 'string'
  );
}

function isPersistOutcome(value: unknown): value is PersistOutcome {
  return (
    isRecord(value) &&
    typeof value.positionsWritten === 'number' &&
    Array.isArray(value.positionsSkipped) &&
    typeof value.assignmentsWritten === 'number' &&
    Array.isArray(value.holdersSkipped) &&
    value.holdersSkipped.every(isHoldersSkipped)
  );
}

function isSetupApplyResult(value: unknown): value is SetupApplyResult {
  return isRecord(value) && isApplyResult(value.result) && isPlanSummaryAr(value.summary) && isPersistOutcome(value.persisted);
}

// ─── Transport ──────────────────────────────────────────────────────────────

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

function serverError(): { ok: false; kind: 'server'; messageAr: string } {
  return { ok: false, kind: 'server', messageAr: t('state.error') };
}

/** Shared status mapping for every call below (brief: 401 → unauthenticated,
 *  403 → forbidden+messageAr, 400 → invalid+messageAr+issues, 502/503 →
 *  npi+messageAr, everything else → generic). `onOk` narrows the 200 body;
 *  a 200 that fails the guard falls back to the generic server error, same
 *  as a malformed body anywhere else. */
async function call<T extends object>(
  path: string,
  init: RequestInit,
  onOk: (body: unknown) => T | undefined,
): Promise<SetupApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin', ...init });
  } catch {
    return serverError();
  }

  const body = await readJson(res);

  if (res.status === 200) {
    const parsed = onOk(body);
    if (parsed === undefined) return serverError();
    return { ok: true, ...parsed };
  }
  if (res.status === 401) return { ok: false, kind: 'unauthenticated' };
  if (res.status === 403) {
    const messageAr = isRecord(body) && typeof body.messageAr === 'string' ? body.messageAr : t('setup.forbidden');
    return { ok: false, kind: 'forbidden', messageAr };
  }
  if (res.status === 400) {
    const messageAr = isRecord(body) && typeof body.messageAr === 'string' ? body.messageAr : t('state.error');
    const issues = isRecord(body) && Array.isArray(body.issues) ? (body.issues as SetupIssue[]) : [];
    return { ok: false, kind: 'invalid', messageAr, issues };
  }
  if (res.status === 502 || res.status === 503) {
    const messageAr = isRecord(body) && typeof body.messageAr === 'string' ? body.messageAr : t('home.error.npi');
    return { ok: false, kind: 'npi', messageAr };
  }
  return serverError();
}

function postBody(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

// ─── Entry points ───────────────────────────────────────────────────────────

export function loadSetup(): Promise<SetupApiResult<{ view: SetupStateView }>> {
  return call(SETUP_API_PATH, { method: 'GET', headers: { Accept: 'application/json' } }, (body) =>
    isSetupStateView(body) ? { view: body } : undefined,
  );
}

function onAnswerOk(body: unknown): { outcome: AnswerOutcome } | undefined {
  if (isSetupUnclearResult(body)) return { outcome: { kind: 'unclear', messageAr: body.unclear } };
  if (isSetupAnswerResult(body)) return { outcome: { kind: 'answered', view: body } };
  return undefined;
}

export function answerText(step: SetupStep, text: string): Promise<SetupApiResult<{ outcome: AnswerOutcome }>> {
  return call(SETUP_API_PATH, postBody({ action: 'answer', step, text }), onAnswerOk);
}

export function answerStructured(
  step: SetupStep,
  answer: unknown,
): Promise<SetupApiResult<{ outcome: AnswerOutcome }>> {
  return call(SETUP_API_PATH, postBody({ action: 'answer', step, answer }), onAnswerOk);
}

export function gotoStep(step: SetupStep): Promise<SetupApiResult<{ view: SetupStateView }>> {
  return call(SETUP_API_PATH, postBody({ action: 'goto', step }), (body) =>
    isSetupStateView(body) ? { view: body } : undefined,
  );
}

/** T-47a: drop the discovered answers and walk the steps by hand. */
export function chooseManual(): Promise<SetupApiResult<{ view: SetupStateView }>> {
  return call(SETUP_API_PATH, postBody({ action: 'manual' }), (body) => (isSetupStateView(body) ? { view: body } : undefined));
}

export function previewSetup(): Promise<SetupApiResult<{ preview: SetupPreviewResult }>> {
  return call(SETUP_API_PATH, postBody({ action: 'preview' }), (body) =>
    isSetupPreviewResult(body) ? { preview: body } : undefined,
  );
}

export function applySetup(): Promise<SetupApiResult<{ apply: SetupApplyResult }>> {
  return call(SETUP_API_PATH, postBody({ action: 'apply' }), (body) =>
    isSetupApplyResult(body) ? { apply: body } : undefined,
  );
}

// Re-exported so the components that render a plan's step actions/counts
// have the literal unions available without importing server-only modules
// for anything but types.
export type { PlanStep, StepAction };
