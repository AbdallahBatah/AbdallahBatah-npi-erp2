// Shared shapes of the trust screen (T-33, F-17, spec/madar/01 §4 F-17 and
// §5 «الثقة», 02 §8 «`llm_audit.imageSent` shown in `/trust` with the
// consent id», 03 §2 `AuditTable` (+ column «صورة أُرسلت»), 07 G-M4-2, 09 §4
// rows 4.1/4.2 and 3.8). This file holds TYPES ONLY — no imports of server
// code — so the client components can `import type` from it the same way
// `src/components/handover/api.ts` imports from `@/positions/handover-types`.
//
// What the screen shows: every `llm_audit` row of the administrator's own
// organization — the model calls (what left the building, redacted, with the
// tier, the tokens and the cost), the image/scan sends with the consent event
// that authorised each one (I4), and the events that never called a model
// (`refused_confidential`, `cap_reached`, `intake_executed`,
// `intake_execution_failed`, `position_reassigned`). Newest first, keyset
// pagination, three filters, one detail view per row.

/** The two tiers of `RedactedRequest.tier` (`src/llm/provider.ts`). */
export type AuditModelTier = 'economy' | 'advanced';

/** Mirrors the Prisma enums `DocumentKind` / `ConsentDecision` as plain
 *  string unions, the same pattern `src/intake/upload.ts` and
 *  `src/intake/consent.ts` use. */
export type AuditDocumentKind = 'pdf_text' | 'pdf_scanned' | 'image';
export type AuditConsentDecision = 'approved' | 'cancelled';

/**
 * The `llm_audit.event` values the copilot writes today. `src/llm/client.ts`
 * writes `req.purpose` (the model calls) and `cap_reached`;
 * `writeAuditEvent` callers write the four non-model events. A `*_edit`
 * purpose (`src/extract/run.ts` `runEdit`) is the same flow re-read after an
 * inline edit on the preview card. Anything else is shown as
 * `trust.event.other` with the raw key beside it — never hidden.
 */
export const KNOWN_AUDIT_EVENTS = [
  'chat',
  'setup_parse',
  'memory_extract',
  'handover_narrative',
  'extract_customer_contract',
  'extract_pr',
  'extract_po',
  'extract_grn',
  'extract_vendor_bill',
  'extract_customer_contract_edit',
  'extract_pr_edit',
  'extract_po_edit',
  'extract_grn_edit',
  'extract_vendor_bill_edit',
  'cap_reached',
  'refused_confidential',
  'intake_executed',
  'intake_execution_failed',
  'position_reassigned',
] as const;

export type KnownAuditEvent = (typeof KNOWN_AUDIT_EVENTS)[number];

/** Default and maximum page size of `GET /copilot/api/audit`. */
export const AUDIT_PAGE_SIZE = 50;
export const AUDIT_PAGE_SIZE_MAX = 100;

/** The consent event behind an image/scan send (I4): id, the decision it
 *  recorded and when. For an `imageSent=true` row this is never null — the
 *  DB CHECK `llm_audit_image_requires_consent_check` and `writeLlmAudit`
 *  both refuse such a row; the screen still renders the impossible case as
 *  a warning rather than hiding it (G-M4-2). */
export interface AuditConsentRef {
  id: string;
  decision: AuditConsentDecision;
  /** ISO timestamp. */
  createdAt: string;
}

/** The document a row concerns (`llm_audit.documentId` → `documents`), or
 *  `null` when the row has no document or the document row is gone. */
export interface AuditDocumentRef {
  id: string;
  fileName: string;
  kind: AuditDocumentKind;
}

/** One `llm_audit` row as the table shows it. `outboundRedactedText` is NOT
 *  carried here (a system prompt is several KB per row); the list carries
 *  its length and the detail view carries the text. */
export interface AuditRowView {
  id: string;
  /** ISO timestamp of `llm_audit.ts`. */
  ts: string;
  npiUserId: string;
  /** From NPI's department directory when the caller may read it, else `null`
   *  (the table then shows the id). */
  userNameAr: string | null;
  /** The raw `llm_audit.event` key — data, shown beside the Arabic label only
   *  when the label is `trust.event.other`. */
  event: string;
  /** `t('trust.event.<event>')`, or `t('trust.event.other')`. Built on the
   *  server so the client never needs the label map. */
  eventLabelAr: string;
  /** `model`: a provider was asked (modelId set). `system`: the copilot wrote
   *  the row without calling anything (cap, refusal, execution, reassignment). */
  kind: 'model' | 'system';
  modelTier: AuditModelTier | null;
  modelId: string | null;
  tokensIn: number;
  tokensOut: number;
  /** `llm_audit.costUsdMicro` (a bigint) as a decimal string — JSON has no
   *  bigint; the client formats it with `formatUsdMicro`. */
  costUsdMicro: string;
  latencyMs: number | null;
  imageSent: boolean;
  consent: AuditConsentRef | null;
  document: AuditDocumentRef | null;
  conversationId: string | null;
  intakeJobId: string | null;
  error: string | null;
  /** `outboundRedactedText.length`, 0 when the column is null — a row that
   *  sent nothing reads as 0 and the detail view says so. */
  outboundChars: number;
}

/** The two vision block kinds of `src/llm/provider.ts` `RedactedBlock`. Named
 *  here (not inlined on the field) so `tests/no-bypass-llm.spec.ts` R7(c),
 *  which greps `src` for an object-literal `type: 'image'`, keeps pointing
 *  only at the files that BUILD such blocks — this file only describes them. */
export type AuditVisionBlockType = 'image' | 'document';

/** A vision block as `src/llm/vision.ts` `auditView` records it — type,
 *  media type, size and the consent event; never the bytes. */
export interface AuditOutboundVisionBlock {
  type: AuditVisionBlockType;
  mediaType: string;
  sizeBytes: number;
  consentEventId: string;
}

/** A text block as recorded (`{ type: 'text', text }`). */
export interface AuditOutboundTextBlock {
  type: 'text';
  text: string;
}

export type AuditOutboundBlock = AuditOutboundTextBlock | AuditOutboundVisionBlock;

export interface AuditOutboundMessage {
  role: 'user' | 'assistant';
  content: string | AuditOutboundBlock[];
}

/**
 * `outboundRedactedText` parsed for display. `src/llm/client.ts` writes
 * `JSON.stringify({ system, messages: auditViewOfMessages(req.messages) })`;
 * a row whose text is not that shape (older rows, hand-written rows) is shown
 * verbatim under `raw` rather than dropped. `null` when the column is null.
 */
export type AuditOutbound =
  | { kind: 'parsed'; system: string; messages: AuditOutboundMessage[]; placeholderCount: number }
  | { kind: 'raw'; text: string; placeholderCount: number };

export interface AuditDetailView extends AuditRowView {
  outbound: AuditOutbound | null;
}

/** Organization-wide counts shown above the table — independent of the
 *  filters, so the integrity line (G-M4-2) is always about the whole log. */
export interface AuditSummary {
  total: number;
  imageSent: number;
  /** Rows with `imageSent=true` and no consent id. Always 0 while the DB
   *  CHECK holds; the screen shows a warning when it is not. */
  imageSentWithoutConsent: number;
  errors: number;
}

/** A person who appears in the organization's log, for the user filter. */
export interface AuditUserRef {
  npiUserId: string;
  nameAr: string | null;
}

/** Filters of the list call — every field optional; absent = no filter. */
export interface AuditFilters {
  /** Exact `llm_audit.event` key. */
  event?: string;
  imageSent?: boolean;
  npiUserId?: string;
}

/** `GET /copilot/api/audit` (list). `nextCursor` is opaque to the client
 *  (`"<ts ISO>|<id>"` on the server) and `null` on the last page. */
export interface AuditListView {
  rows: AuditRowView[];
  nextCursor: string | null;
  summary: AuditSummary;
  users: AuditUserRef[];
}

/** `GET /copilot/api/audit?id=` (detail). */
export interface AuditDetailResponse {
  row: AuditDetailView;
}
