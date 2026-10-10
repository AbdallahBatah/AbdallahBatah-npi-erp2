// Browser-side calls for the handover endpoint (`src/app/api/handover/route.ts`)
// and, for the administrator's read-only view of a predecessor's chat, the
// existing chat endpoint (`GET /copilot/api/chat?conversationId=`).
//
// Same style as `src/components/settings/api.ts`: never throws, and every 200
// body is narrowed with a runtime guard before the caller sees it. The server
// types come in as `import type` from `@/positions/handover-types` — erased at
// compile time, never a value import of server code into this client bundle.
import type {
  HandoverBody,
  HandoverCandidate,
  HandoverCandidatesView,
  HandoverFact,
  HandoverPerson,
  HandoverSection,
  HandoverSummary,
  HandoverTask,
  HandoverVendor,
  HandoverView,
  HandoverNarrative,
  PredecessorConversation,
  ReassignOutcome,
} from '@/positions/handover-types';
import { t } from '@/i18n/ar';

/** Fixed at build time by next.config.js's `basePath` — hardcoded the same
 *  way `settings/api.ts` and `chat/api.ts` hardcode their own paths. */
const HANDOVER_API_PATH = '/copilot/api/handover';
const CHAT_API_PATH = '/copilot/api/chat';

export type HandoverApiResult<T> =
  | ({ ok: true } & T)
  | { ok: false; kind: 'unauthenticated' }
  | { ok: false; kind: 'forbidden'; messageAr: string }
  | { ok: false; kind: 'not_found'; messageAr: string }
  | { ok: false; kind: 'invalid'; messageAr: string }
  | { ok: false; kind: 'conflict'; messageAr: string }
  | { ok: false; kind: 'npi'; messageAr: string }
  | { ok: false; kind: 'server'; messageAr: string };

export type HandoverApiErrorKind = Exclude<HandoverApiResult<object>, { ok: true }>['kind'];

/** One message of a predecessor's conversation, as the chat endpoint returns
 *  it — only the fields a read-only transcript needs. */
export interface TranscriptMessage {
  id: string;
  role: 'user' | 'assistant';
  textAr: string;
  createdAt: string;
}

// ─── Guards ─────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

const NARRATIVE_STATUSES: readonly string[] = ['written', 'failed', 'skipped'];
const SKIP_REASONS: readonly string[] = ['no_permission', 'npi_refused', 'npi_error'];

function isNarrativeStatus(value: unknown): value is HandoverNarrative['status'] {
  return typeof value === 'string' && NARRATIVE_STATUSES.includes(value);
}

function isHandoverSummary(value: unknown): value is HandoverSummary {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.positionId === 'string' &&
    typeof value.positionTitleAr === 'string' &&
    isNullableString(value.fromUserId) &&
    typeof value.toUserId === 'string' &&
    typeof value.createdAt === 'string' &&
    isNarrativeStatus(value.narrativeStatus)
  );
}

function isHandoverPerson(value: unknown): value is HandoverPerson {
  return isRecord(value) && typeof value.npiUserId === 'string' && isNullableString(value.nameAr);
}

function isHandoverTask(value: unknown): value is HandoverTask {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.documentType === 'string' &&
    typeof value.documentCode === 'string' &&
    isFiniteNumber(value.amount) &&
    isFiniteNumber(value.currentStep) &&
    isFiniteNumber(value.stepCount) &&
    typeof value.waitingSince === 'string' &&
    isNullableString(value.raisedByNameAr) &&
    typeof value.escalated === 'boolean'
  );
}

function isTasksSection(value: unknown): value is HandoverSection<HandoverTask> {
  if (!isRecord(value)) return false;
  if (value.status === 'read') return Array.isArray(value.items) && value.items.every(isHandoverTask);
  if (value.status === 'skipped') return typeof value.reason === 'string' && SKIP_REASONS.includes(value.reason);
  return false;
}

function isHandoverVendor(value: unknown): value is HandoverVendor {
  return (
    isRecord(value) &&
    isNullableString(value.npiVendorId) &&
    isNullableString(value.nameAr) &&
    isNullableString(value.code) &&
    isStringArray(value.factsAr)
  );
}

function isHandoverFact(value: unknown): value is HandoverFact {
  return (
    isRecord(value) &&
    typeof value.factId === 'string' &&
    typeof value.factAr === 'string' &&
    (value.sourceType === 'npi' || value.sourceType === 'chat')
  );
}

function isNarrative(value: unknown): value is HandoverNarrative {
  if (!isRecord(value)) return false;
  if (value.status === 'written') {
    return (
      typeof value.summaryAr === 'string' &&
      isStringArray(value.firstWeekAr) &&
      isStringArray(value.cautionsAr) &&
      typeof value.modelId === 'string' &&
      typeof value.writtenAt === 'string'
    );
  }
  if (value.status === 'failed') return typeof value.reason === 'string' && typeof value.failedAt === 'string';
  return value.status === 'skipped';
}

function isHandoverBody(value: unknown): value is HandoverBody {
  if (!isRecord(value) || value.version !== 1) return false;
  const position = value.position;
  return (
    typeof value.generatedAt === 'string' &&
    isRecord(position) &&
    typeof position.id === 'string' &&
    typeof position.roleKey === 'string' &&
    isNullableString(position.roleNameAr) &&
    isNullableString(position.departmentId) &&
    isNullableString(position.departmentNameAr) &&
    typeof position.titleAr === 'string' &&
    (value.predecessor === null || (isHandoverPerson(value.predecessor) && typeof (value.predecessor as unknown as { since?: unknown }).since === 'string')) &&
    isHandoverPerson(value.successor) &&
    isTasksSection(value.tasks) &&
    Array.isArray(value.vendors) &&
    value.vendors.every(isHandoverVendor) &&
    Array.isArray(value.routines) &&
    value.routines.every(isHandoverFact) &&
    Array.isArray(value.companyFacts) &&
    value.companyFacts.every(isHandoverFact) &&
    isNarrative(value.narrative)
  );
}

function isPredecessorConversation(value: unknown): value is PredecessorConversation {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    isNullableString(value.titleAr) &&
    typeof value.updatedAt === 'string' &&
    isFiniteNumber(value.messageCount)
  );
}

function isHandoverView(value: unknown): value is HandoverView {
  return (
    isHandoverSummary(value) &&
    isRecord(value) &&
    isHandoverBody(value.body) &&
    typeof value.bodyAr === 'string' &&
    (value.predecessorConversations === undefined ||
      (Array.isArray(value.predecessorConversations) && value.predecessorConversations.every(isPredecessorConversation)))
  );
}

function isCandidate(value: unknown): value is HandoverCandidate {
  return isRecord(value) && typeof value.npiUserId === 'string' && typeof value.nameAr === 'string';
}

function isCandidatesView(value: unknown): value is HandoverCandidatesView {
  if (!isRecord(value) || !isRecord(value.position)) return false;
  return (
    typeof value.position.id === 'string' &&
    typeof value.position.titleAr === 'string' &&
    typeof value.position.roleKey === 'string' &&
    Array.isArray(value.holders) &&
    value.holders.every(isHandoverPerson) &&
    Array.isArray(value.candidates) &&
    value.candidates.every(isCandidate)
  );
}

function isReassignOutcome(value: unknown): value is ReassignOutcome {
  return (
    isRecord(value) &&
    typeof value.handoverId === 'string' &&
    isStringArray(value.endedAssignmentIds) &&
    typeof value.assignmentId === 'string' &&
    isNarrativeStatus(value.narrativeStatus)
  );
}

function isTranscriptMessage(value: unknown): value is TranscriptMessage {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    (value.role === 'user' || value.role === 'assistant') &&
    typeof value.textAr === 'string' &&
    typeof value.createdAt === 'string'
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
  return isRecord(body) && typeof body.messageAr === 'string' ? body.messageAr : fallback;
}

/** Shared status mapping for every call below: 401 → unauthenticated, 403 →
 *  forbidden, 404 → not_found, 400 → invalid, 409 → conflict, 502/503 → npi,
 *  everything else → the generic server error. `onOk` narrows the 200 body; a
 *  200 that fails the guard falls back to the generic server error. */
async function call<T extends object>(
  url: string,
  init: RequestInit,
  onOk: (body: unknown) => T | undefined,
  notFoundAr: string,
): Promise<HandoverApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'same-origin', ...init });
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
  if (res.status === 403) return { ok: false, kind: 'forbidden', messageAr: bodyMessage(body, t('handover.forbidden')) };
  if (res.status === 404) return { ok: false, kind: 'not_found', messageAr: bodyMessage(body, notFoundAr) };
  if (res.status === 400) return { ok: false, kind: 'invalid', messageAr: bodyMessage(body, t('state.error')) };
  if (res.status === 409) return { ok: false, kind: 'conflict', messageAr: bodyMessage(body, t('handover.already_holder')) };
  if (res.status === 502 || res.status === 503) {
    return { ok: false, kind: 'npi', messageAr: bodyMessage(body, t('home.error.npi')) };
  }
  return serverError();
}

function getInit(): RequestInit {
  return { method: 'GET', headers: { Accept: 'application/json' } };
}

function postInit(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

// ─── Entry points ───────────────────────────────────────────────────────────

export async function loadHandovers(): Promise<HandoverApiResult<{ handovers: HandoverSummary[] }>> {
  return call(
    HANDOVER_API_PATH,
    getInit(),
    (body) =>
      isRecord(body) && Array.isArray(body.handovers) && body.handovers.every(isHandoverSummary)
        ? { handovers: body.handovers as HandoverSummary[] }
        : undefined,
    t('handover.not_found'),
  );
}

export async function loadHandover(id: string): Promise<HandoverApiResult<{ handover: HandoverView }>> {
  return call(
    `${HANDOVER_API_PATH}?id=${encodeURIComponent(id)}`,
    getInit(),
    (body) => (isRecord(body) && isHandoverView(body.handover) ? { handover: body.handover } : undefined),
    t('handover.not_found'),
  );
}

export async function loadCandidates(positionId: string): Promise<HandoverApiResult<{ candidates: HandoverCandidatesView }>> {
  return call(
    `${HANDOVER_API_PATH}?positionId=${encodeURIComponent(positionId)}`,
    getInit(),
    (body) => (isRecord(body) && isCandidatesView(body.candidates) ? { candidates: body.candidates } : undefined),
    t('handover.not_found'),
  );
}

/** Reassigns the position; the model call inside can take up to a minute. */
export async function reassign(positionId: string, toUserId: string): Promise<HandoverApiResult<{ outcome: ReassignOutcome }>> {
  return call(
    HANDOVER_API_PATH,
    postInit({ action: 'reassign', positionId, toUserId }),
    (body) => (isRecord(body) && isReassignOutcome(body.outcome) ? { outcome: body.outcome } : undefined),
    t('handover.not_found'),
  );
}

export async function narrate(id: string): Promise<HandoverApiResult<{ handover: HandoverView }>> {
  return call(
    HANDOVER_API_PATH,
    postInit({ action: 'narrate', id }),
    (body) => (isRecord(body) && isHandoverView(body.handover) ? { handover: body.handover } : undefined),
    t('handover.not_found'),
  );
}

/** An administrator's read-only read of a predecessor's conversation: the
 *  chat endpoint answers 200 to its owner and to an administrator of the
 *  organization (BR-07) and 404 to everyone else. */
export async function loadPredecessorConversation(
  conversationId: string,
): Promise<HandoverApiResult<{ messages: TranscriptMessage[] }>> {
  return call(
    `${CHAT_API_PATH}?conversationId=${encodeURIComponent(conversationId)}`,
    getInit(),
    (body) =>
      isRecord(body) && Array.isArray(body.messages) && body.messages.every(isTranscriptMessage)
        ? {
            messages: (body.messages as TranscriptMessage[]).map((m) => ({
              id: m.id,
              role: m.role,
              textAr: m.textAr,
              createdAt: m.createdAt,
            })),
          }
        : undefined,
    t('handover.chats.not_found'),
  );
}
