// Single choke point for writing `llm_audit` rows (spec/madar/02 §3, §8;
// invariant I4 in `02` §2: "any image sent to the model has a
// consent_event_id in llm_audit").
//
// I4 is enforced twice, deliberately:
//   1. Here, in code, BEFORE the row ever reaches the database — so the
//      failure is a typed `AuditInvariantError` the caller can act on, and
//      no half-written audit attempt is even sent to Postgres.
//   2. In the database itself, as the CHECK constraint
//      `llm_audit_image_requires_consent_check` added in migration `0002`
//      (`"imageSent" = false OR "consentEventId" IS NOT NULL`) — the last
//      line of defence if this module is ever bypassed or has a bug.
// tests/consent-db.spec.ts proves the second line still holds by inserting
// a violating row directly through the real Prisma client.
export interface LlmAuditData {
  npiOrgId: string;
  npiUserId: string;
  conversationId: string | null;
  intakeJobId: string | null;
  documentId: string | null;
  event: string;
  modelTier: string | null;
  modelId: string | null;
  tokensIn: number;
  tokensOut: number;
  costUsdMicro: bigint;
  outboundRedactedText: string | null;
  imageSent: boolean;
  /** The single consent event covering an image/document block sent in this
   *  request, or null when nothing was sent as vision input. Required by
   *  invariant I4 whenever `imageSent` is true (see `writeLlmAudit` below
   *  and the DB CHECK `llm_audit_image_requires_consent_check`). */
  consentEventId: string | null;
  latencyMs: number | null;
  error: string | null;
}

export class AuditInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditInvariantError';
  }
}

/**
 * The part of the Prisma client `writeLlmAudit`/`writeAuditEvent` call,
 * typed closely enough that the real client satisfies it without a cast
 * (checked in tests/consent-db.spec.ts) and a small in-memory fake does too.
 */
export interface AuditDb {
  llmAudit: {
    create(args: { data: LlmAuditData }): Promise<unknown>;
  };
}

/**
 * Writes one `llm_audit` row. Throws `AuditInvariantError` — before touching
 * the database — when `data.imageSent` is true but no `consentEventId` is
 * carried: an image must never leave the building without a recorded
 * consent event backing the audit trail for it (I4).
 */
export async function writeLlmAudit(db: AuditDb, data: LlmAuditData): Promise<void> {
  if (data.imageSent && !data.consentEventId) {
    throw new AuditInvariantError(
      'writeLlmAudit: imageSent is true but consentEventId is null (invariant I4, spec/madar/02 §2).',
    );
  }
  await db.llmAudit.create({ data });
}

/**
 * Writes a non-model `llm_audit` row for an event that never called a
 * provider (e.g. `refused_confidential`, AT-06) — every numeric/model field
 * is the "nothing happened" value, so the row still reads as "zero cost,
 * zero tokens, no model" rather than being silently absent from the trust
 * log.
 */
export async function writeAuditEvent(
  db: AuditDb,
  ctx: {
    npiOrgId: string;
    npiUserId: string;
    conversationId?: string;
    intakeJobId?: string;
    documentId?: string;
  },
  event: string,
  error: string | null = null,
): Promise<void> {
  await writeLlmAudit(db, {
    npiOrgId: ctx.npiOrgId,
    npiUserId: ctx.npiUserId,
    conversationId: ctx.conversationId ?? null,
    intakeJobId: ctx.intakeJobId ?? null,
    documentId: ctx.documentId ?? null,
    event,
    modelTier: null,
    modelId: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsdMicro: 0n,
    outboundRedactedText: null,
    imageSent: false,
    consentEventId: null,
    latencyMs: null,
    error,
  });
}
