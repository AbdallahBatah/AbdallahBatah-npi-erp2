// The trust log's readers (T-33 part A, F-17; spec/madar/01 §4 F-17 and §5
// «الثقة», 02 §8, 03 §2 `AuditTable`, 06 AT-07, 07 G-M4-2, 09 §4 rows
// 4.1/4.2 and 3.8). `GET /copilot/api/audit` is a thin wrapper over the three
// functions exported here; the shapes they return live in `src/audit/types.ts`
// (types only, shared with the client components).
//
// Rules this file enforces:
//   - Administrator only (`admin.user.manage`, the same constant the settings
//     and setup routes guard with) — checked HERE, not only in the route.
//   - Own organization only: `npiOrgId` is in the `where` of EVERY query. A
//     row of another organization is `null`/absent, never 403 — the id must
//     not confirm that a row exists (as `api/handover` does).
//   - Read only. This module never writes `llm_audit`, never calls a model and
//     never writes to NPI; the single NPI call is the department directory
//     (names of the people who appear in the log).
//   - The list view never carries `outboundRedactedText` (several KB per
//     row); it carries its length. The detail view carries the parsed text.
import { t } from '../i18n/ar';
import { readDirectoryUsers } from '../npi/admin';
import { NpiError } from '../npi/errors';
import {
  AUDIT_PAGE_SIZE,
  AUDIT_PAGE_SIZE_MAX,
  KNOWN_AUDIT_EVENTS,
  type AuditConsentDecision,
  type AuditConsentRef,
  type AuditDetailView,
  type AuditDocumentKind,
  type AuditDocumentRef,
  type AuditFilters,
  type AuditListView,
  type AuditModelTier,
  type AuditOutbound,
  type AuditOutboundBlock,
  type AuditOutboundMessage,
  type AuditRowView,
  type AuditSummary,
  type AuditUserRef,
} from './types';

/** apps/api admin controller guard — the same one `api/settings` and
 *  `api/setup` enforce. */
export const TRUST_PERMISSION = 'admin.user.manage';

export interface AuditCaller {
  npiOrgId: string;
  npiUserId: string;
  permissions: string[];
}

export class AuditError extends Error {
  readonly code: 'forbidden' | 'bad_cursor';
  readonly status: 403 | 400;
  readonly messageAr: string;

  constructor(code: 'forbidden' | 'bad_cursor') {
    const messageAr = code === 'forbidden' ? t('trust.forbidden') : t('state.error');
    super(`audit: ${code}`);
    this.name = 'AuditError';
    this.code = code;
    this.status = code === 'forbidden' ? 403 : 400;
    this.messageAr = messageAr;
  }
}

// ─── Structural db (the ConsentDb/AuditDb/ReassignDb pattern) ──────────────

/** Every column of `llm_audit`, selected explicitly. */
export interface AuditDbRow {
  id: string;
  ts: Date;
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
  consentEventId: string | null;
  latencyMs: number | null;
  error: string | null;
}

/** The `where` shapes this module builds — every one carries `npiOrgId`. */
export interface AuditWhere {
  npiOrgId: string;
  id?: string;
  event?: string;
  imageSent?: boolean;
  npiUserId?: string;
  consentEventId?: null;
  error?: { not: null };
  /** Keyset cursor: strictly older than `(ts, id)` in `ts desc, id desc` order. */
  OR?: Array<{ ts: { lt: Date } } | { ts: Date; id: { lt: string } }>;
}

const ROW_SELECT = {
  id: true,
  ts: true,
  npiOrgId: true,
  npiUserId: true,
  conversationId: true,
  intakeJobId: true,
  documentId: true,
  event: true,
  modelTier: true,
  modelId: true,
  tokensIn: true,
  tokensOut: true,
  costUsdMicro: true,
  outboundRedactedText: true,
  imageSent: true,
  consentEventId: true,
  latencyMs: true,
  error: true,
} as const;

/**
 * The part of the Prisma client the readers call, typed closely enough that
 * the real client satisfies it without a cast (checked in
 * tests/audit-db.spec.ts) and an in-memory fake does too. `llmAudit.findMany`
 * is declared as an intersection of two function types (the page query and
 * the distinct-users query): a pair of method overloads is NOT assignable from
 * Prisma's generic `findMany`, the intersection is.
 */
export interface AuditQueryDb {
  llmAudit: {
    findMany: ((args: {
      where: AuditWhere;
      orderBy: Array<{ ts: 'desc' } | { id: 'desc' }>;
      take: number;
      select: typeof ROW_SELECT;
    }) => Promise<AuditDbRow[]>) &
      ((args: {
        where: { npiOrgId: string };
        distinct: ['npiUserId'];
        select: { npiUserId: true };
      }) => Promise<Array<{ npiUserId: string }>>);
    findFirst(args: { where: AuditWhere; select: typeof ROW_SELECT }): Promise<AuditDbRow | null>;
    count(args: { where: AuditWhere }): Promise<number>;
  };
  consentEvent: {
    findMany(args: {
      where: { id: { in: string[] } };
      select: { id: true; decision: true; createdAt: true };
    }): Promise<Array<{ id: string; decision: AuditConsentDecision; createdAt: Date }>>;
  };
  document: {
    findMany(args: {
      where: { id: { in: string[] }; npiOrgId: string };
      select: { id: true; fileName: true; kind: true };
    }): Promise<Array<{ id: string; fileName: string; kind: AuditDocumentKind }>>;
  };
}

export interface AuditQueryNpi {
  listDepartmentDirectory(): Promise<unknown>;
}

export interface AuditQueryDeps {
  db: AuditQueryDb;
  npi: AuditQueryNpi;
}

// ─── Cursor ────────────────────────────────────────────────────────────────

const CURSOR_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ISO_MILLIS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** `"<ts ISO>|<id>"` — opaque to the client. */
export function encodeCursor(row: { ts: Date; id: string }): string {
  return `${row.ts.toISOString()}|${row.id}`;
}

/** `null` on any malformed input — never throws. */
export function parseCursor(raw: string): { ts: Date; id: string } | null {
  const bar = raw.indexOf('|');
  if (bar <= 0) return null;
  const iso = raw.slice(0, bar);
  const id = raw.slice(bar + 1);
  if (!ISO_MILLIS_PATTERN.test(iso)) return null;
  if (!CURSOR_ID_PATTERN.test(id)) return null;
  const ts = new Date(iso);
  if (Number.isNaN(ts.getTime())) return null;
  return { ts, id };
}

// ─── Small pure helpers ────────────────────────────────────────────────────

const KNOWN_EVENT_SET: ReadonlySet<string> = new Set(KNOWN_AUDIT_EVENTS);

/** The Arabic label of an `llm_audit.event` key; an unknown key reads «حدث آخر». */
export function eventLabelAr(event: string): string {
  if (KNOWN_EVENT_SET.has(event)) return t(`trust.event.${event}` as Parameters<typeof t>[0]);
  return t('trust.event.other');
}

/** How many `⟦…⟧` placeholders the stored text holds. */
export function countPlaceholders(text: string): number {
  return (text.match(/⟦[^⟦⟧]+⟧/g) ?? []).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBlock(value: unknown): value is AuditOutboundBlock {
  if (!isRecord(value)) return false;
  if (value.type === 'text') return typeof value.text === 'string';
  if (value.type === 'image' || value.type === 'document') {
    return (
      typeof value.mediaType === 'string' &&
      typeof value.sizeBytes === 'number' &&
      typeof value.consentEventId === 'string'
    );
  }
  return false;
}

function isMessage(value: unknown): value is AuditOutboundMessage {
  if (!isRecord(value)) return false;
  if (value.role !== 'user' && value.role !== 'assistant') return false;
  const { content } = value;
  if (typeof content === 'string') return true;
  return Array.isArray(content) && content.every(isBlock);
}

/**
 * `outboundRedactedText` parsed for display. `src/llm/client.ts` writes
 * `JSON.stringify({ system, messages })`; a text of any other shape (older
 * rows, hand-written rows, a message carrying tool blocks) is returned
 * verbatim as `raw` rather than dropped. `placeholderCount` is taken over the
 * stored text in both cases, so it is the same whichever branch renders — the
 * system prompt is part of what left the building and counts too.
 */
export function parseOutbound(text: string | null): AuditOutbound | null {
  if (text === null) return null;
  const placeholderCount = countPlaceholders(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'raw', text, placeholderCount };
  }
  if (
    isRecord(parsed) &&
    typeof parsed.system === 'string' &&
    Array.isArray(parsed.messages) &&
    parsed.messages.every(isMessage)
  ) {
    return {
      kind: 'parsed',
      system: parsed.system,
      messages: parsed.messages as AuditOutboundMessage[],
      placeholderCount,
    };
  }
  return { kind: 'raw', text, placeholderCount };
}

// ─── Guards, directory, row mapping ────────────────────────────────────────

function requireTrustPermission(caller: AuditCaller): void {
  if (!caller.permissions.includes(TRUST_PERMISSION)) throw new AuditError('forbidden');
}

/**
 * Names from NPI's department directory (needs `admin.department.manage`).
 * `forbidden` and every other NpiError except `unauthorized` leave the names
 * null: the trust log must open even when NPI's admin endpoints are down,
 * the names are the only thing lost. `unauthorized` propagates (the route
 * maps it to 401).
 */
async function loadNames(npi: AuditQueryNpi): Promise<Map<string, string> | null> {
  try {
    const users = readDirectoryUsers(await npi.listDepartmentDirectory());
    return new Map(users.map((u) => [u.id, u.nameAr]));
  } catch (err) {
    if (!(err instanceof NpiError)) throw err;
    if (err.kind === 'unauthorized') throw err;
    if (err.kind !== 'forbidden') console.warn('[copilot] trust: directory unavailable', err.kind);
    return null;
  }
}

function tierOf(value: string | null): AuditModelTier | null {
  return value === 'economy' || value === 'advanced' ? value : null;
}

async function toRowViews(
  db: AuditQueryDb,
  npiOrgId: string,
  rows: AuditDbRow[],
  names: Map<string, string> | null,
): Promise<AuditRowView[]> {
  const consentIds = [...new Set(rows.map((r) => r.consentEventId).filter((id): id is string => id !== null))];
  const documentIds = [...new Set(rows.map((r) => r.documentId).filter((id): id is string => id !== null))];

  const consents = new Map<string, AuditConsentRef>();
  if (consentIds.length > 0) {
    const found = await db.consentEvent.findMany({
      where: { id: { in: consentIds } },
      select: { id: true, decision: true, createdAt: true },
    });
    for (const c of found) consents.set(c.id, { id: c.id, decision: c.decision, createdAt: c.createdAt.toISOString() });
  }

  const documents = new Map<string, AuditDocumentRef>();
  if (documentIds.length > 0) {
    const found = await db.document.findMany({
      where: { id: { in: documentIds }, npiOrgId },
      select: { id: true, fileName: true, kind: true },
    });
    for (const d of found) documents.set(d.id, { id: d.id, fileName: d.fileName, kind: d.kind });
  }

  return rows.map((row) => ({
    id: row.id,
    ts: row.ts.toISOString(),
    npiUserId: row.npiUserId,
    userNameAr: names?.get(row.npiUserId) ?? null,
    event: row.event,
    eventLabelAr: eventLabelAr(row.event),
    kind: row.modelId !== null ? 'model' : 'system',
    modelTier: tierOf(row.modelTier),
    modelId: row.modelId,
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    costUsdMicro: String(row.costUsdMicro),
    latencyMs: row.latencyMs,
    imageSent: row.imageSent,
    consent: row.consentEventId !== null ? (consents.get(row.consentEventId) ?? null) : null,
    document: row.documentId !== null ? (documents.get(row.documentId) ?? null) : null,
    conversationId: row.conversationId,
    intakeJobId: row.intakeJobId,
    error: row.error,
    outboundChars: row.outboundRedactedText?.length ?? 0,
  }));
}

// ─── Public readers ────────────────────────────────────────────────────────

/** Organization-wide counts; independent of any filter. */
export async function auditSummary(db: AuditQueryDb, npiOrgId: string): Promise<AuditSummary> {
  const [total, imageSent, imageSentWithoutConsent, errors] = await Promise.all([
    db.llmAudit.count({ where: { npiOrgId } }),
    db.llmAudit.count({ where: { npiOrgId, imageSent: true } }),
    db.llmAudit.count({ where: { npiOrgId, imageSent: true, consentEventId: null } }),
    db.llmAudit.count({ where: { npiOrgId, error: { not: null } } }),
  ]);
  return { total, imageSent, imageSentWithoutConsent, errors };
}

async function listUsers(
  db: AuditQueryDb,
  npiOrgId: string,
  names: Map<string, string> | null,
): Promise<AuditUserRef[]> {
  const distinct = await db.llmAudit.findMany({
    where: { npiOrgId },
    distinct: ['npiUserId'],
    select: { npiUserId: true },
  });
  const users: AuditUserRef[] = distinct.map((d) => ({
    npiUserId: d.npiUserId,
    nameAr: names?.get(d.npiUserId) ?? null,
  }));
  users.sort((a, b) => {
    if (a.nameAr !== null && b.nameAr !== null) {
      const byName = a.nameAr.localeCompare(b.nameAr, 'ar');
      if (byName !== 0) return byName;
    } else if (a.nameAr !== null) {
      return -1;
    } else if (b.nameAr !== null) {
      return 1;
    }
    return a.npiUserId < b.npiUserId ? -1 : a.npiUserId > b.npiUserId ? 1 : 0;
  });
  return users;
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return AUDIT_PAGE_SIZE;
  return Math.min(Math.max(Math.trunc(limit), 1), AUDIT_PAGE_SIZE_MAX);
}

/**
 * One page of the organization's log, newest first (`ts desc, id desc`),
 * keyset pagination. `summary` and `users` are organization-wide and ignore
 * the filters.
 */
export async function listAudit(
  deps: AuditQueryDeps,
  caller: AuditCaller,
  opts: { filters: AuditFilters; cursor: string | null; limit: number },
): Promise<AuditListView> {
  requireTrustPermission(caller);
  const limit = clampLimit(opts.limit);

  let cursor: { ts: Date; id: string } | null = null;
  if (opts.cursor !== null) {
    cursor = parseCursor(opts.cursor);
    if (cursor === null) throw new AuditError('bad_cursor');
  }

  const where: AuditWhere = { npiOrgId: caller.npiOrgId };
  if (opts.filters.event !== undefined) where.event = opts.filters.event;
  if (opts.filters.imageSent !== undefined) where.imageSent = opts.filters.imageSent;
  if (opts.filters.npiUserId !== undefined) where.npiUserId = opts.filters.npiUserId;
  if (cursor !== null) where.OR = [{ ts: { lt: cursor.ts } }, { ts: cursor.ts, id: { lt: cursor.id } }];

  const names = await loadNames(deps.npi);

  const fetched = await deps.db.llmAudit.findMany({
    where,
    orderBy: [{ ts: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: ROW_SELECT,
  });
  const page = fetched.slice(0, limit);
  const nextCursor = fetched.length > limit ? encodeCursor(page[limit - 1]) : null;

  const [rows, summary, users] = await Promise.all([
    toRowViews(deps.db, caller.npiOrgId, page, names),
    auditSummary(deps.db, caller.npiOrgId),
    listUsers(deps.db, caller.npiOrgId, names),
  ]);
  return { rows, nextCursor, summary, users };
}

/** One row with its parsed outbound text; `null` when it does not exist in
 *  the caller's organization (never distinguishes "absent" from "not yours"). */
export async function getAuditRow(
  deps: AuditQueryDeps,
  caller: AuditCaller,
  id: string,
): Promise<AuditDetailView | null> {
  requireTrustPermission(caller);
  const row = await deps.db.llmAudit.findFirst({ where: { id, npiOrgId: caller.npiOrgId }, select: ROW_SELECT });
  if (row === null) return null;
  const names = await loadNames(deps.npi);
  const [view] = await toRowViews(deps.db, caller.npiOrgId, [row], names);
  return { ...view, outbound: parseOutbound(row.outboundRedactedText) };
}
