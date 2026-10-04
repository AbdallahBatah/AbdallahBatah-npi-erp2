// Browser-side calls for the chat endpoint (`src/app/api/chat/route.ts`).
//
// Both functions are careful never to throw: a network failure, a malformed
// body, or an HTTP status this app doesn't specifically expect all come back
// as an `{ ok: false, ... }` result the caller can render directly. Every
// `messageAr` in that result is the server's own text when it sent one
// (contract: 413/500/503 bodies carry `messageAr`); everything else falls
// back to `t('chat.error.generic')` here, never a hardcoded string.
import { t } from '@/i18n/ar';

/** Fixed at build time by next.config.js's `basePath` — hardcoded here the
 *  same way `LoginForm.tsx` hardcodes its own API path. */
const CHAT_API_PATH = '/copilot/api/chat';

/** The document-intake endpoints (T-21's `api/documents/route.ts` and the
 *  backend-owned consent route), same `basePath` convention as `CHAT_API_PATH`. */
export const DOCUMENTS_API_PATH = '/copilot/api/documents';
export const CONSENT_API_PATH = '/copilot/api/documents/consent';

/** Mirrors `src/agents/run.ts`'s `MAX_MESSAGE_LENGTH` (the server re-checks
 *  this regardless — this is only so the composer can warn before sending). */
export const MAX_MESSAGE_LENGTH = 4000;
/** The composer's character counter appears once a message reaches this
 *  length, well before the hard limit above. */
export const COUNTER_THRESHOLD = 3600;

export interface MemoryNoteData {
  id: string;
  factAr: string;
  sourceType: 'npi' | 'chat';
}

export type MessageRole = 'user' | 'assistant';
export type TurnKind = 'answer' | 'hr_refusal' | 'flow_pending' | 'error';

export interface ChatMessage {
  id: string;
  role: MessageRole;
  textAr: string;
  badges: string[];
  memoryNotes: MemoryNoteData[];
  createdAt: string;
  /** Only ever set on the message this browser just sent/received this
   *  session, and on history rows written since the `kind` column exists. */
  kind?: TurnKind;
}

export interface LoadConversationData {
  conversationId: string | null;
  messages: ChatMessage[];
}

export interface SendMessageData {
  conversationId: string;
  messageId: string;
  kind: TurnKind;
  textAr: string;
  badges: string[];
  memoryNotes: MemoryNoteData[];
}

export type ChatErrorKind = 'unauthenticated' | 'npi_down' | 'too_long' | 'server' | 'network';

export type ChatResult<T> = ({ ok: true } & T) | { ok: false; kind: ChatErrorKind; messageAr: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isMemoryNote(value: unknown): value is MemoryNoteData {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.factAr === 'string' &&
    (value.sourceType === 'npi' || value.sourceType === 'chat')
  );
}

function isMessage(value: unknown): value is ChatMessage {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    (value.role === 'user' || value.role === 'assistant') &&
    typeof value.textAr === 'string' &&
    Array.isArray(value.badges) &&
    value.badges.every((b) => typeof b === 'string') &&
    Array.isArray(value.memoryNotes) &&
    value.memoryNotes.every(isMemoryNote) &&
    typeof value.createdAt === 'string' &&
    (value.kind === undefined || (typeof value.kind === 'string' && VALID_KINDS.has(value.kind as TurnKind)))
  );
}

function isLoadConversationBody(value: unknown): value is LoadConversationData {
  return (
    isRecord(value) &&
    (value.conversationId === null || typeof value.conversationId === 'string') &&
    Array.isArray(value.messages) &&
    value.messages.every(isMessage)
  );
}

const VALID_KINDS: ReadonlySet<TurnKind> = new Set(['answer', 'hr_refusal', 'flow_pending', 'error']);

function isSendMessageBody(value: unknown): value is SendMessageData {
  return (
    isRecord(value) &&
    typeof value.conversationId === 'string' &&
    typeof value.messageId === 'string' &&
    typeof value.kind === 'string' &&
    VALID_KINDS.has(value.kind as TurnKind) &&
    typeof value.textAr === 'string' &&
    Array.isArray(value.badges) &&
    value.badges.every((b) => typeof b === 'string') &&
    Array.isArray(value.memoryNotes) &&
    value.memoryNotes.every(isMemoryNote)
  );
}

function genericError(): { ok: false; kind: 'server'; messageAr: string } {
  return { ok: false, kind: 'server', messageAr: t('chat.error.generic') };
}

function networkError(): { ok: false; kind: 'network'; messageAr: string } {
  return { ok: false, kind: 'network', messageAr: t('chat.error.generic') };
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

/** Loads the signed-in user's latest conversation (or a specific one, per the
 *  route's optional `conversationId` query param — not used by `Chat` today,
 *  but kept general so this module stays the single place that shapes the
 *  request). */
export async function loadConversation(): Promise<ChatResult<LoadConversationData>> {
  let res: Response;
  try {
    res = await fetch(CHAT_API_PATH, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
  } catch {
    return networkError();
  }

  const body = await readJson(res);

  if (res.status === 200) {
    if (!isLoadConversationBody(body)) return genericError();
    return { ok: true, conversationId: body.conversationId, messages: body.messages };
  }
  if (res.status === 401) return { ok: false, kind: 'unauthenticated', messageAr: t('chat.error.generic') };
  if (res.status === 503) {
    const messageAr = isRecord(body) && typeof body.messageAr === 'string' ? body.messageAr : t('chat.error.generic');
    return { ok: false, kind: 'npi_down', messageAr };
  }
  return genericError();
}

/** Sends one chat turn. `text` and `conversationId` are passed through as-is
 *  (the server re-validates length and ownership). */
export async function sendMessage(text: string, conversationId?: string): Promise<ChatResult<SendMessageData>> {
  let res: Response;
  try {
    res = await fetch(CHAT_API_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(conversationId === undefined ? { text } : { text, conversationId }),
    });
  } catch {
    return networkError();
  }

  const body = await readJson(res);

  if (res.status === 200) {
    if (!isSendMessageBody(body)) return genericError();
    return {
      ok: true,
      conversationId: body.conversationId,
      messageId: body.messageId,
      kind: body.kind,
      textAr: body.textAr,
      badges: body.badges,
      memoryNotes: body.memoryNotes,
    };
  }
  if (res.status === 401) return { ok: false, kind: 'unauthenticated', messageAr: t('chat.error.generic') };
  if (res.status === 413) {
    const messageAr = isRecord(body) && typeof body.messageAr === 'string' ? body.messageAr : t('chat.error.too_long');
    return { ok: false, kind: 'too_long', messageAr };
  }
  if (res.status === 503) {
    const messageAr = isRecord(body) && typeof body.messageAr === 'string' ? body.messageAr : t('chat.error.generic');
    return { ok: false, kind: 'npi_down', messageAr };
  }
  if (res.status === 500) {
    const messageAr = isRecord(body) && typeof body.messageAr === 'string' ? body.messageAr : t('chat.error.generic');
    return { ok: false, kind: 'server', messageAr };
  }
  // 400 / 404 / anything else this UI doesn't special-case: a fixed generic
  // error, same as a malformed 200 body.
  return genericError();
}

// ── Document intake (T-22) ──────────────────────────────────────────────
// `uploadDocument` and `recordConsent` follow the exact same never-throw
// contract as `sendMessage` above: a network failure, a malformed body, or
// an HTTP status this UI doesn't specifically expect all come back as
// `{ ok: false, ... }`, never a thrown exception.

export type DocumentKind = 'pdf_text' | 'pdf_scanned' | 'image';

export interface DocumentSummary {
  id: string;
  fileName: string;
  mime: string;
  sizeBytes: number;
  kind: DocumentKind;
  pageCount: number;
  textChars: number | null;
  createdAt: string;
}

const VALID_DOCUMENT_KINDS: ReadonlySet<DocumentKind> = new Set(['pdf_text', 'pdf_scanned', 'image']);

export function isDocumentSummary(value: unknown): value is DocumentSummary {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.fileName === 'string' &&
    typeof value.mime === 'string' &&
    typeof value.sizeBytes === 'number' &&
    typeof value.kind === 'string' &&
    VALID_DOCUMENT_KINDS.has(value.kind as DocumentKind) &&
    typeof value.pageCount === 'number' &&
    (value.textChars === null || typeof value.textChars === 'number') &&
    typeof value.createdAt === 'string'
  );
}

/** Shared error-kind union for both document-intake calls below. A second
 *  result type (rather than widening `ChatErrorKind`/`ChatResult`) keeps
 *  `sendMessage`/`loadConversation`'s existing tests — which assert on the
 *  narrower `ChatErrorKind` — unaffected. */
export type UploadErrorKind = 'unauthenticated' | 'npi_down' | 'refused' | 'too_large' | 'unsupported' | 'server' | 'network';

export type DocumentResult<T> = ({ ok: true } & T) | { ok: false; kind: UploadErrorKind; messageAr: string };

/** Uploads one file to `POST /copilot/api/documents` as
 *  `multipart/form-data` field `file`. `Content-Type` is never set here —
 *  the browser must supply the multipart boundary itself. */
export async function uploadDocument(
  file: File,
): Promise<DocumentResult<{ document: DocumentSummary; deduplicated: boolean }>> {
  const form = new FormData();
  form.append('file', file);

  let res: Response;
  try {
    res = await fetch(DOCUMENTS_API_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      body: form,
    });
  } catch {
    return networkError();
  }

  const body = await readJson(res);

  if (res.status === 201 || res.status === 200) {
    if (!isRecord(body) || !isDocumentSummary(body.document)) return genericError();
    return { ok: true, document: body.document, deduplicated: body.deduplicated === true };
  }
  if (res.status === 401) return { ok: false, kind: 'unauthenticated', messageAr: t('chat.error.generic') };
  if (res.status === 413) {
    const messageAr = isRecord(body) && typeof body.messageAr === 'string' ? body.messageAr : t('document.error.too_large');
    return { ok: false, kind: 'too_large', messageAr };
  }
  if (res.status === 415) {
    const messageAr = isRecord(body) && typeof body.messageAr === 'string' ? body.messageAr : t('document.error.unsupported');
    return { ok: false, kind: 'unsupported', messageAr };
  }
  if (res.status === 422) {
    // Covers 'refused_confidential' | 'pdf_encrypted' | 'unreadable' — the
    // server always sends `messageAr` for all three (see
    // `api/documents/route.ts`'s `refusalResponse`), so there is no
    // per-reason branching to do here.
    const messageAr = isRecord(body) && typeof body.messageAr === 'string' ? body.messageAr : t('chat.error.generic');
    return { ok: false, kind: 'refused', messageAr };
  }
  if (res.status === 503) {
    const messageAr = isRecord(body) && typeof body.messageAr === 'string' ? body.messageAr : t('chat.error.generic');
    return { ok: false, kind: 'npi_down', messageAr };
  }
  // 400 / 500 / anything else: a fixed generic error, same as a malformed
  // 200 body or a network failure above.
  return genericError();
}

export type ConsentDecision = 'approved' | 'cancelled';

/** `kind` is `'image'` or `'pdf_scanned'` per spec/madar/02 §5 item 3 — a
 *  `pdf_text` document never needs a consent round-trip. */
export function consentNeeded(kind: DocumentKind): boolean {
  return kind === 'image' || kind === 'pdf_scanned';
}

/** Records the user's decision at `POST /copilot/api/documents/consent`
 *  (owned by the backend half of T-22; this module only shapes the call). */
export async function recordConsent(
  documentId: string,
  decision: ConsentDecision,
): Promise<DocumentResult<{ consentEventId: string }>> {
  let res: Response;
  try {
    res = await fetch(CONSENT_API_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId, decision }),
    });
  } catch {
    return networkError();
  }

  const body = await readJson(res);

  if (res.status === 200) {
    if (!isRecord(body) || typeof body.consentEventId !== 'string') return genericError();
    return { ok: true, consentEventId: body.consentEventId };
  }
  if (res.status === 401) return { ok: false, kind: 'unauthenticated', messageAr: t('chat.error.generic') };
  if (res.status === 404) {
    const messageAr = isRecord(body) && typeof body.messageAr === 'string' ? body.messageAr : t('document.error.not_found');
    return { ok: false, kind: 'refused', messageAr };
  }
  if (res.status === 409) {
    const messageAr =
      isRecord(body) && typeof body.messageAr === 'string' ? body.messageAr : t('document.error.consent_not_needed');
    return { ok: false, kind: 'refused', messageAr };
  }
  if (res.status === 422) {
    const messageAr = isRecord(body) && typeof body.messageAr === 'string' ? body.messageAr : t('intake.refused_confidential');
    return { ok: false, kind: 'refused', messageAr };
  }
  if (res.status === 503) {
    const messageAr = isRecord(body) && typeof body.messageAr === 'string' ? body.messageAr : t('chat.error.generic');
    return { ok: false, kind: 'npi_down', messageAr };
  }
  if (res.status === 500) {
    const messageAr = isRecord(body) && typeof body.messageAr === 'string' ? body.messageAr : t('chat.error.generic');
    return { ok: false, kind: 'server', messageAr };
  }
  // 400 / anything else: a fixed generic error, same as a malformed 200
  // body or a network failure above.
  return genericError();
}
