// Error normalization for every call the copilot makes against NPI's API.
//
// NPI's `GlobalExceptionFilter` (apps/api/src/common/global-exception.filter.ts)
// is the contract this file reads: an HttpException's body passes through
// (typically `{ statusCode, message, error? }`, or `{ statusCode, message, code }`
// for the Prisma-mapped cases), and an unhandled failure becomes a bare
// `{ statusCode: 500, message: 'Internal server error' }`. Mapping here goes
// purely by HTTP status code — never by pattern-matching NPI's English
// message text, which is free-form and can change without notice.
export type NpiErrorKind =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'validation'
  | 'server'
  | 'timeout'
  | 'network'
  | 'unexpected';

const AR_MESSAGES: Record<NpiErrorKind, string> = {
  unauthorized: 'انتهت جلستك في NPI. سجّل الدخول من جديد.',
  forbidden: 'NPI رفض: ليست لك صلاحية تنفيذ هذا الإجراء.',
  not_found: 'NPI رفض: السجل غير موجود أو لا يخص منشأتك.',
  conflict: 'NPI رفض: تعارض مع حالة السجل الحالية.',
  validation: 'NPI رفض: البيانات غير مقبولة.',
  server: 'تعذر إتمام الطلب في NPI حالياً.',
  timeout: 'NPI لم يستجب خلال المهلة.',
  network: 'تعذر الوصول إلى NPI.',
  unexpected: 'استجابة غير متوقعة من NPI.',
};

/** Kinds that append NPI's own (untranslated) message when NPI supplied one. */
const APPENDS_NPI_REASON: ReadonlySet<NpiErrorKind> = new Set([
  'forbidden',
  'not_found',
  'conflict',
  'validation',
]);

export class NpiError extends Error {
  /** HTTP status NPI responded with; 0 for a network failure or a timeout
   *  (no response was ever received, so there is no status to report). */
  readonly status: number;
  readonly kind: NpiErrorKind;
  /** NPI's own message, exactly as returned — never translated or rewritten.
   *  `null` when NPI supplied no usable message (e.g. a non-JSON body, or a
   *  JSON body without a string `message`). */
  readonly npiMessage: string | null;
  /** What the UI shows. */
  readonly messageAr: string;

  constructor(params: {
    status: number;
    kind: NpiErrorKind;
    npiMessage: string | null;
    /** Extra detail for the developer-facing `.message` only (e.g. the raw
     *  fetch/abort error text for network/timeout kinds). Never affects
     *  `.npiMessage` or `.messageAr` — those describe NPI's own response. */
    devDetail?: string;
  }) {
    const { status, kind, npiMessage, devDetail } = params;
    const base = AR_MESSAGES[kind];
    const messageAr =
      APPENDS_NPI_REASON.has(kind) && npiMessage ? `${base} (NPI: ${npiMessage})` : base;

    // The Error's own `.message` is for logs/devs — keep it in English and
    // informative; `.messageAr` is the single field the UI is allowed to show.
    const detail = npiMessage ?? devDetail;
    super(`NPI request failed: ${kind} (status ${status})${detail ? ` — ${detail}` : ''}`);
    this.name = 'NpiError';
    this.status = status;
    this.kind = kind;
    this.npiMessage = npiMessage;
    this.messageAr = messageAr;
  }
}

/** Extracts NPI's own message string from a parsed error body, if there is
 *  one. NestJS's default shape is `{ statusCode, message, error? }`, where
 *  `message` is either a string (thrown HttpExceptions, the Prisma-mapped
 *  cases in GlobalExceptionFilter) or a string array (ValidationPipe's
 *  class-validator failures) — the array is joined so nothing is dropped. */
function extractNpiMessage(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  const message = (body as Record<string, unknown>).message;
  if (typeof message === 'string' && message.length > 0) return message;
  if (Array.isArray(message) && message.every((m) => typeof m === 'string') && message.length > 0) {
    return message.join('; ');
  }
  return null;
}

/** Maps an HTTP status + parsed body from NPI into a typed NpiError. Status
 *  code is authoritative; `body` only ever supplies the human-readable
 *  reason NPI gave, never the kind itself. */
export function mapNpiError(status: number, body: unknown): NpiError {
  const npiMessage = extractNpiMessage(body);
  const kind = kindForStatus(status);
  return new NpiError({ status, kind, npiMessage });
}

function kindForStatus(status: number): NpiErrorKind {
  switch (status) {
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 400:
    case 422:
      return 'validation';
    default:
      if (status >= 500 && status < 600) return 'server';
      return 'unexpected';
  }
}

/** Used directly by the client for abort/network failures, which never have
 *  a body to parse. */
export function timeoutError(): NpiError {
  return new NpiError({ status: 0, kind: 'timeout', npiMessage: null });
}

/** `cause` is logged via the Error's own `.message`, never surfaced through
 *  `.npiMessage` — there is no NPI response for a network failure, so there
 *  is nothing from NPI to (verbatim) report. */
export function networkError(cause: unknown): NpiError {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return new NpiError({ status: 0, kind: 'network', npiMessage: null, devDetail: reason });
}
