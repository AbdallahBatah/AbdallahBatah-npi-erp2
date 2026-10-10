// Browser-side calls for the settings endpoint (`src/app/api/settings/
// route.ts`, built by another task against the shared contract in
// `src/settings/types.ts`), in the exact style of `src/components/setup/
// api.ts`: never throws, and every 200 body is narrowed with a runtime guard
// before the caller sees it. Types come in as `import type` from
// `@/settings/types` and `@/onboarding/profile.schema` — erased at compile
// time, never a value import of server code into this client bundle.
import type {
  RerunStep,
  SettingsBaseline,
  SettingsConfig,
  SettingsDocType,
  SettingsLastApply,
  SettingsLeftover,
  SettingsPosition,
  SettingsPositionHolder,
  SettingsView,
} from '@/settings/types';
import type { FlowType } from '@/agents/router';
import type { ModuleKey } from '@/onboarding/profile.schema';
import { FLOW_TYPES } from '@/onboarding/profile.schema';
import { t } from '@/i18n/ar';

const SETTINGS_API_PATH = '/copilot/api/settings';

export type SettingsApiErrorKind = 'unauthenticated' | 'forbidden' | 'invalid' | 'conflict' | 'npi' | 'server';

export type SettingsApiResult<T> =
  | ({ ok: true } & T)
  | { ok: false; kind: 'unauthenticated' }
  | { ok: false; kind: 'forbidden'; messageAr: string }
  | { ok: false; kind: 'invalid'; messageAr: string }
  | { ok: false; kind: 'conflict'; messageAr: string }
  | { ok: false; kind: 'npi'; messageAr: string }
  | { ok: false; kind: 'server'; messageAr: string };

// ─── Guards ─────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

const LEFTOVER_KINDS = ['department', 'role', 'approval_rule', 'item', 'unknown'];

function isRerunStep(value: unknown): value is RerunStep {
  return typeof value === 'number' && value >= 1 && value <= 6;
}

function isSettingsLeftover(value: unknown): value is SettingsLeftover {
  return (
    isRecord(value) &&
    typeof value.stepId === 'string' &&
    typeof value.kind === 'string' &&
    LEFTOVER_KINDS.includes(value.kind) &&
    typeof value.labelAr === 'string' &&
    typeof value.reasonAr === 'string' &&
    isNullableString(value.npiMessage) &&
    (value.setupStep === null || isRerunStep(value.setupStep))
  );
}

function isNpiApiGap(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === 'workflow_definitions') return true;
  return value.kind === 'permission_unknown' && typeof value.roleKey === 'string' && typeof value.permission === 'string';
}

function isSettingsLastApply(value: unknown): value is SettingsLastApply {
  return (
    isRecord(value) &&
    typeof value.appliedAt === 'string' &&
    Array.isArray(value.gaps) &&
    value.gaps.every(isNpiApiGap) &&
    Array.isArray(value.blocked) &&
    value.blocked.every(isSettingsLeftover) &&
    Array.isArray(value.failed) &&
    value.failed.every(isSettingsLeftover)
  );
}

function isSettingsDocType(value: unknown): value is SettingsDocType {
  return (
    isRecord(value) &&
    typeof value.key === 'string' &&
    typeof value.labelAr === 'string' &&
    isNullableString(value.flow)
  );
}

function isSettingsConfig(value: unknown): value is SettingsConfig {
  return (
    isRecord(value) &&
    typeof value.profileKey === 'string' &&
    typeof value.profileTitleAr === 'string' &&
    isNullableString(value.setupCompletedAt) &&
    isStringArray(value.visibleModules) &&
    Array.isArray(value.acceptedDocTypes) &&
    value.acceptedDocTypes.every(isSettingsDocType) &&
    isRecord(value.terminology) &&
    (value.lastApply === null || isSettingsLastApply(value.lastApply))
  );
}

function isSettingsPositionHolder(value: unknown): value is SettingsPositionHolder {
  return (
    isRecord(value) &&
    typeof value.npiUserId === 'string' &&
    isNullableString(value.nameAr) &&
    typeof value.since === 'string'
  );
}

function isSettingsPosition(value: unknown): value is SettingsPosition {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.roleKey === 'string' &&
    typeof value.roleNameAr === 'string' &&
    isNullableString(value.departmentId) &&
    isNullableString(value.departmentNameAr) &&
    typeof value.titleAr === 'string' &&
    Array.isArray(value.holders) &&
    value.holders.every(isSettingsPositionHolder)
  );
}

function isSettingsBaseline(value: unknown): value is SettingsBaseline | null {
  return value === null || (isRecord(value) && typeof value.minutes === 'number' && typeof value.measuredAt === 'string');
}

function isBaselinesRecord(value: unknown): value is Record<FlowType, SettingsBaseline | null> {
  if (!isRecord(value)) return false;
  return FLOW_TYPES.every((flow) => isSettingsBaseline(value[flow]));
}

function isSettingsView(value: unknown): value is SettingsView {
  return (
    isRecord(value) &&
    (value.config === null || isSettingsConfig(value.config)) &&
    Array.isArray(value.positions) &&
    value.positions.every(isSettingsPosition) &&
    isBaselinesRecord(value.baselines) &&
    typeof value.openSetup === 'boolean'
  );
}

function isRedirectResult(value: unknown): value is { redirect: '/setup' } {
  return isRecord(value) && value.redirect === '/setup';
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

/** Shared status mapping for every call below: 401 → unauthenticated, 403 →
 *  forbidden+messageAr, 400 → invalid+messageAr, 409 → conflict+messageAr,
 *  502/503 → npi+messageAr, everything else → generic server error. `onOk`
 *  narrows the 200 body; a 200 that fails the guard falls back to the
 *  generic server error, same as a malformed body anywhere else. */
async function call<T extends object>(
  init: RequestInit,
  onOk: (body: unknown) => T | undefined,
): Promise<SettingsApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(SETTINGS_API_PATH, { credentials: 'same-origin', ...init });
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
    const messageAr = isRecord(body) && typeof body.messageAr === 'string' ? body.messageAr : t('settings.forbidden');
    return { ok: false, kind: 'forbidden', messageAr };
  }
  if (res.status === 400) {
    const messageAr = isRecord(body) && typeof body.messageAr === 'string' ? body.messageAr : t('state.error');
    return { ok: false, kind: 'invalid', messageAr };
  }
  if (res.status === 409) {
    const messageAr = isRecord(body) && typeof body.messageAr === 'string' ? body.messageAr : t('settings.no_config');
    return { ok: false, kind: 'conflict', messageAr };
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

export async function loadSettings(): Promise<SettingsApiResult<{ view: SettingsView }>> {
  return call({ method: 'GET', headers: { Accept: 'application/json' } }, (body) =>
    isSettingsView(body) ? { view: body } : undefined,
  );
}

export async function saveVisibleModules(modules: ModuleKey[]): Promise<SettingsApiResult<{ view: SettingsView }>> {
  return call(postBody({ action: 'visible_modules', modules }), (body) => (isSettingsView(body) ? { view: body } : undefined));
}

export async function saveBaseline(flow: FlowType, minutes: number): Promise<SettingsApiResult<{ view: SettingsView }>> {
  return call(postBody({ action: 'baseline', flow, minutes }), (body) => (isSettingsView(body) ? { view: body } : undefined));
}

export async function rerunStep(step: RerunStep): Promise<SettingsApiResult<{ redirect: '/setup' }>> {
  return call(postBody({ action: 'rerun', step }), (body) => (isRedirectResult(body) ? { redirect: body.redirect } : undefined));
}
