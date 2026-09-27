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
   *  session — the GET history contract carries no `kind` for older rows. */
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
    typeof value.createdAt === 'string'
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
