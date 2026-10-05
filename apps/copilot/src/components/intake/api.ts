// Browser-side calls for the intake endpoint (`src/app/api/intake/route.ts`,
// T-26), in the style of `setup/api.ts` and `chat/api.ts`: never throws, and
// every 200 body is narrowed with a runtime guard before a component sees it.
//
// The shapes come in as `import type` from `@/intake/types` (erased at
// compile time — no server code reaches the client bundle). The guard checks
// every field the components actually read; the nested field/section
// objects are first-party server output and are checked one level deep
// rather than re-implemented in full.
import type { IntakeAction, IntakeView, PreviewField, PreviewModel } from '@/intake/types';
import { t } from '@/i18n/ar';

const INTAKE_API_PATH = '/copilot/api/intake';

export type IntakeErrorKind =
  | 'unauthenticated'
  | 'not_found'
  | 'state'
  | 'npi_down'
  | 'edit_failed'
  | 'npi'
  | 'server'
  | 'network';

export type IntakeResult<T> = ({ ok: true } & T) | { ok: false; kind: IntakeErrorKind; messageAr: string };

// ─── Guards ─────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || typeof value === 'number';
}

const FIELD_KINDS = ['text', 'number', 'amount', 'date', 'code', 'serials', 'enum'];

function isFieldValue(value: unknown): boolean {
  return value === null || typeof value === 'string' || typeof value === 'number' || isStringArray(value);
}

function isPreviewField(value: unknown): value is PreviewField {
  return (
    isRecord(value) &&
    typeof value.path === 'string' &&
    typeof value.labelAr === 'string' &&
    isFieldValue(value.value) &&
    typeof value.displayAr === 'string' &&
    (value.status === 'confirmed' || value.status === 'unconfirmed') &&
    typeof value.confidence === 'number' &&
    isNullableString(value.evidence) &&
    isNullableNumber(value.page) &&
    isStringArray(value.warningsAr) &&
    typeof value.required === 'boolean' &&
    typeof value.confirmable === 'boolean' &&
    typeof value.editable === 'boolean' &&
    typeof value.kind === 'string' &&
    FIELD_KINDS.includes(value.kind)
  );
}

function isFieldList(value: unknown): boolean {
  return Array.isArray(value) && value.every(isPreviewField);
}

function isPreviewModel(value: unknown): value is PreviewModel {
  if (!isRecord(value)) return false;
  const lines = value.lines;
  return (
    typeof value.flow === 'string' &&
    typeof value.flowLabelAr === 'string' &&
    Array.isArray(value.sections) &&
    value.sections.every(
      (s) => isRecord(s) && typeof s.key === 'string' && typeof s.titleAr === 'string' && isFieldList(s.fields),
    ) &&
    (lines === null ||
      (isRecord(lines) &&
        typeof lines.titleAr === 'string' &&
        Array.isArray(lines.rows) &&
        lines.rows.every(
          (r) => isRecord(r) && typeof r.index === 'number' && typeof r.titleAr === 'string' && isFieldList(r.fields),
        ))) &&
    Array.isArray(value.choices) &&
    value.choices.every(
      (c) =>
        isRecord(c) &&
        typeof c.target === 'string' &&
        typeof c.promptAr === 'string' &&
        isNullableString(c.chosen) &&
        Array.isArray(c.options) &&
        c.options.every((o) => isRecord(o) && typeof o.id === 'string' && typeof o.labelAr === 'string'),
    ) &&
    isStringArray(value.notesAr) &&
    Array.isArray(value.steps) &&
    value.steps.every((s) => isRecord(s) && typeof s.n === 'number' && typeof s.labelAr === 'string') &&
    isNullableString(value.incompleteAr) &&
    isStringArray(value.blockersAr) &&
    typeof value.canApprove === 'boolean' &&
    isRecord(value.summary) &&
    typeof value.summary.total === 'number' &&
    typeof value.summary.confirmed === 'number' &&
    typeof value.summary.unconfirmed === 'number'
  );
}

const STEP_STATES = ['pending', 'running', 'done', 'failed'];

function isExecutionLog(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.status === 'string' &&
    STEP_STATES.includes(value.status) &&
    Array.isArray(value.steps) &&
    value.steps.every(
      (s) =>
        isRecord(s) &&
        typeof s.n === 'number' &&
        typeof s.labelAr === 'string' &&
        typeof s.state === 'string' &&
        STEP_STATES.includes(s.state) &&
        (s.errorAr === undefined || typeof s.errorAr === 'string') &&
        (s.entity === undefined ||
          (isRecord(s.entity) &&
            typeof s.entity.kindAr === 'string' &&
            typeof s.entity.id === 'string' &&
            isNullableString(s.entity.code) &&
            isNullableString(s.entity.npiPath))),
    ) &&
    (value.failedAt === undefined || typeof value.failedAt === 'number')
  );
}

const DOCUMENT_KINDS = ['pdf_text', 'pdf_scanned', 'image'];

function isIntakeView(value: unknown): value is IntakeView {
  if (!isRecord(value)) return false;
  const doc = value.document;
  return (
    typeof value.id === 'string' &&
    typeof value.flow === 'string' &&
    typeof value.flowLabelAr === 'string' &&
    typeof value.status === 'string' &&
    isNullableString(value.conversationId) &&
    (doc === null ||
      (isRecord(doc) &&
        typeof doc.id === 'string' &&
        typeof doc.fileName === 'string' &&
        typeof doc.kind === 'string' &&
        DOCUMENT_KINDS.includes(doc.kind) &&
        typeof doc.pageCount === 'number')) &&
    (value.preview === null || isPreviewModel(value.preview)) &&
    isNullableString(value.failureAr) &&
    (value.execution === null || isExecutionLog(value.execution)) &&
    typeof value.createdAt === 'string' &&
    isNullableString(value.approvedAt)
  );
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

function bodyMessage(body: unknown, fallback: string): string {
  return isRecord(body) && typeof body.messageAr === 'string' && body.messageAr.length > 0 ? body.messageAr : fallback;
}

async function call(path: string, init: RequestInit): Promise<IntakeResult<{ job: IntakeView }>> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin', ...init });
  } catch {
    return { ok: false, kind: 'network', messageAr: t('state.error') };
  }

  const body = await readJson(res);

  if (res.status === 200) {
    if (!isRecord(body) || !isIntakeView(body.job)) return serverError();
    return { ok: true, job: body.job };
  }
  if (res.status === 401) return { ok: false, kind: 'unauthenticated', messageAr: t('state.error') };
  if (res.status === 404) return { ok: false, kind: 'not_found', messageAr: bodyMessage(body, t('intake.not_found')) };
  if (res.status === 409) return { ok: false, kind: 'state', messageAr: bodyMessage(body, t('intake.state_conflict')) };
  if (res.status === 422) return { ok: false, kind: 'edit_failed', messageAr: bodyMessage(body, t('state.error')) };
  if (res.status === 502) return { ok: false, kind: 'npi', messageAr: bodyMessage(body, t('home.error.npi')) };
  if (res.status === 503) return { ok: false, kind: 'npi_down', messageAr: bodyMessage(body, t('home.error.npi')) };
  return serverError();
}

// ─── Entry points ───────────────────────────────────────────────────────────

/** `GET /copilot/api/intake?id=` — one intake job as the card renders it. */
export function loadIntake(id: string): Promise<IntakeResult<{ job: IntakeView }>> {
  return call(`${INTAKE_API_PATH}?id=${encodeURIComponent(id)}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
}

/** `POST /copilot/api/intake` — one user action on the card (confirm, set,
 *  choose, edit, approve, cancel); the answer is the rebuilt view. */
export function actOnIntake(action: IntakeAction): Promise<IntakeResult<{ job: IntakeView }>> {
  return call(INTAKE_API_PATH, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(action),
  });
}
