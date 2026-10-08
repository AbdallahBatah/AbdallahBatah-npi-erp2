// Browser-side calls for the audit endpoint (`src/app/api/audit/route.ts`,
// built by part A of T-33 against the shared contract in `src/audit/types.ts`),
// in the exact style of `src/components/settings/api.ts`: never throws, and
// every 200 body is narrowed with a runtime guard before the caller sees it.
// Types come in as `import type` from `@/audit/types` — erased at compile
// time, never a value import of server code into this client bundle.
import type {
  AuditConsentRef,
  AuditDetailView,
  AuditDocumentRef,
  AuditFilters,
  AuditListView,
  AuditOutbound,
  AuditOutboundBlock,
  AuditOutboundMessage,
  AuditRowView,
  AuditSummary,
  AuditUserRef,
} from '@/audit/types';
import { t } from '@/i18n/ar';

/** Fixed at build time by next.config.js's `basePath` — hardcoded the same
 *  way every other `api.ts` in this folder tree hardcodes its own path. */
const AUDIT_API_PATH = '/copilot/api/audit';

/** Page size the list asks for (matches `AUDIT_PAGE_SIZE` on the server;
 *  repeated here as a plain number so no server-side value is imported). */
const DEFAULT_LIMIT = 50;

export type AuditApiResult<T> =
  | ({ ok: true } & T)
  | { ok: false; kind: 'unauthenticated' }
  | { ok: false; kind: 'forbidden'; messageAr: string }
  | { ok: false; kind: 'not_found'; messageAr: string }
  | { ok: false; kind: 'invalid'; messageAr: string }
  | { ok: false; kind: 'npi'; messageAr: string }
  | { ok: false; kind: 'server'; messageAr: string };

// ─── Guards ─────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isConsentRef(value: unknown): value is AuditConsentRef {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    (value.decision === 'approved' || value.decision === 'cancelled') &&
    typeof value.createdAt === 'string'
  );
}

function isDocumentRef(value: unknown): value is AuditDocumentRef {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.fileName === 'string' &&
    (value.kind === 'pdf_text' || value.kind === 'pdf_scanned' || value.kind === 'image')
  );
}

export function isAuditRowView(value: unknown): value is AuditRowView {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.ts === 'string' &&
    typeof value.npiUserId === 'string' &&
    isNullableString(value.userNameAr) &&
    typeof value.event === 'string' &&
    typeof value.eventLabelAr === 'string' &&
    (value.kind === 'model' || value.kind === 'system') &&
    (value.modelTier === null || value.modelTier === 'economy' || value.modelTier === 'advanced') &&
    isNullableString(value.modelId) &&
    isFiniteNumber(value.tokensIn) &&
    isFiniteNumber(value.tokensOut) &&
    typeof value.costUsdMicro === 'string' &&
    /^\d+$/.test(value.costUsdMicro) &&
    (value.latencyMs === null || isFiniteNumber(value.latencyMs)) &&
    typeof value.imageSent === 'boolean' &&
    (value.consent === null || isConsentRef(value.consent)) &&
    (value.document === null || isDocumentRef(value.document)) &&
    isNullableString(value.conversationId) &&
    isNullableString(value.intakeJobId) &&
    isNullableString(value.error) &&
    isFiniteNumber(value.outboundChars)
  );
}

function isOutboundBlock(value: unknown): value is AuditOutboundBlock {
  if (!isRecord(value)) return false;
  if (value.type === 'text') return typeof value.text === 'string';
  if (value.type === 'image' || value.type === 'document') {
    return (
      typeof value.mediaType === 'string' &&
      isFiniteNumber(value.sizeBytes) &&
      typeof value.consentEventId === 'string'
    );
  }
  return false;
}

function isOutboundMessage(value: unknown): value is AuditOutboundMessage {
  return (
    isRecord(value) &&
    (value.role === 'user' || value.role === 'assistant') &&
    (typeof value.content === 'string' ||
      (Array.isArray(value.content) && value.content.every(isOutboundBlock)))
  );
}

function isOutbound(value: unknown): value is AuditOutbound {
  if (!isRecord(value)) return false;
  if (value.kind === 'parsed') {
    return (
      typeof value.system === 'string' &&
      Array.isArray(value.messages) &&
      value.messages.every(isOutboundMessage) &&
      isFiniteNumber(value.placeholderCount)
    );
  }
  if (value.kind === 'raw') {
    return typeof value.text === 'string' && isFiniteNumber(value.placeholderCount);
  }
  return false;
}

export function isAuditDetailView(value: unknown): value is AuditDetailView {
  return isAuditRowView(value) && isRecord(value) && (value.outbound === null || isOutbound(value.outbound));
}

function isAuditSummary(value: unknown): value is AuditSummary {
  return (
    isRecord(value) &&
    isFiniteNumber(value.total) &&
    isFiniteNumber(value.imageSent) &&
    isFiniteNumber(value.imageSentWithoutConsent) &&
    isFiniteNumber(value.errors)
  );
}

function isAuditUserRef(value: unknown): value is AuditUserRef {
  return isRecord(value) && typeof value.npiUserId === 'string' && isNullableString(value.nameAr);
}

export function isAuditListView(value: unknown): value is AuditListView {
  return (
    isRecord(value) &&
    Array.isArray(value.rows) &&
    value.rows.every(isAuditRowView) &&
    isNullableString(value.nextCursor) &&
    isAuditSummary(value.summary) &&
    Array.isArray(value.users) &&
    value.users.every(isAuditUserRef)
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

/** Shared status mapping for both calls below: 401 → unauthenticated, 403 →
 *  forbidden, 404 → not_found, 400 → invalid, 502/503 → npi (each with the
 *  body's `messageAr` or a fallback), everything else → generic server
 *  error. `onOk` narrows the 200 body; a 200 that fails the guard falls
 *  back to the generic server error, same as a malformed body anywhere
 *  else. */
async function call<T extends object>(
  query: string,
  onOk: (body: unknown) => T | undefined,
): Promise<AuditApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(`${AUDIT_API_PATH}?${query}`, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
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
    return { ok: false, kind: 'forbidden', messageAr: bodyMessage(body, t('trust.forbidden')) };
  }
  if (res.status === 404) {
    return { ok: false, kind: 'not_found', messageAr: bodyMessage(body, t('trust.not_found')) };
  }
  if (res.status === 400) {
    return { ok: false, kind: 'invalid', messageAr: bodyMessage(body, t('state.error')) };
  }
  if (res.status === 502 || res.status === 503) {
    return { ok: false, kind: 'npi', messageAr: bodyMessage(body, t('home.error.npi')) };
  }
  return serverError();
}

// ─── Entry points ───────────────────────────────────────────────────────────

/** The list query string, in a fixed key order (limit, cursor, event,
 *  imageSent, userId) so the URL is deterministic; absent values are
 *  omitted. */
export function auditQueryString(opts: { filters: AuditFilters; cursor: string | null; limit?: number }): string {
  const params = new URLSearchParams();
  params.set('limit', String(opts.limit ?? DEFAULT_LIMIT));
  if (opts.cursor !== null) params.set('cursor', opts.cursor);
  if (opts.filters.event !== undefined) params.set('event', opts.filters.event);
  if (opts.filters.imageSent !== undefined) params.set('imageSent', opts.filters.imageSent ? 'true' : 'false');
  if (opts.filters.npiUserId !== undefined) params.set('userId', opts.filters.npiUserId);
  return params.toString();
}

export async function loadAudit(opts: {
  filters: AuditFilters;
  cursor: string | null;
}): Promise<AuditApiResult<{ view: AuditListView }>> {
  return call(auditQueryString(opts), (body) => (isAuditListView(body) ? { view: body } : undefined));
}

export async function loadAuditRow(id: string): Promise<AuditApiResult<{ row: AuditDetailView }>> {
  return call(new URLSearchParams({ id }).toString(), (body) =>
    isRecord(body) && isAuditDetailView(body.row) ? { row: body.row } : undefined,
  );
}
