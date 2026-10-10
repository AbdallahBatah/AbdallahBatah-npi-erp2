// T-30 (F-13, BR-07): the service behind «تعيين شاغل جديد» and the handover
// page. A reassignment is copilot-side bookkeeping — NPI stays the authority on
// who holds which role, and nothing in NPI changes here:
//
//   body (NPI reads + memory, as the administrator) → narrative (best effort)
//   → ONE transaction: create the document, end the position's open
//   assignments, end the successor's open assignments on other positions of the
//   same organization and role, open the successor's assignment
//   → trust-log row.
//
// Access rules (D-T30-4, D-T30-5): a document is readable by an administrator
// of its organization, by the successor and by the predecessor, and by nobody
// else — a miss is `null` (the route answers 404, never 403, so an id never
// confirms existence). A predecessor's conversations stay theirs and the
// administrator's only.
import { z } from 'zod';
import { writeAuditEvent } from '../audit/log';
import type { PrismaClient } from '../generated/prisma';
import { t } from '../i18n/ar';
import type { LlmContext } from '../llm/client';
import type { ModelResponse, RedactedRequest } from '../llm/provider';
import { readDirectoryUsers, type NpiDirectoryUser } from '../npi/admin';
import { NpiError } from '../npi/errors';
import type { Pseudonymizer } from '../privacy/pseudonymizer';
import {
  buildHandoverBody,
  renderHandoverAr,
  writeNarrative,
  type HandoverCaller,
  type HandoverNpi,
} from './handover';
import {
  HANDOVER_ADMIN_PERMISSION,
  HANDOVER_GUIDANCE_DAYS,
  HANDOVER_PERMISSION,
  type HandoverBody,
  type HandoverCandidatesView,
  type HandoverSummary,
  type HandoverView,
  type PredecessorConversation,
  type ReassignOutcome,
} from './handover-types';

export type ReassignDb = Pick<
  PrismaClient,
  'position' | 'positionAssignment' | 'handoverDoc' | 'conversation' | 'message' | 'memoryFact' | 'llmAudit' | '$transaction'
>;

// ─── Errors ──────────────────────────────────────────────────────────────────

const STATUS_OF_CODE = {
  forbidden: 403,
  not_found: 404,
  not_candidate: 400,
  already_holder: 409,
  npi: 502,
} as const;

/** A refusal the route maps to its HTTP status; `messageAr` is what the screen shows. */
export class HandoverError extends Error {
  readonly code: keyof typeof STATUS_OF_CODE;
  readonly status: 403 | 404 | 400 | 409 | 502;
  readonly messageAr: string;

  /** `messageAr` is required for `npi` (NPI's own message) and defaulted from
   *  the strings file for every other code. */
  constructor(code: keyof typeof STATUS_OF_CODE, messageAr?: string) {
    super(`handover refused: ${code}`);
    this.name = 'HandoverError';
    this.code = code;
    this.status = STATUS_OF_CODE[code];
    this.messageAr = messageAr ?? defaultMessageAr(code);
  }
}

function defaultMessageAr(code: keyof typeof STATUS_OF_CODE): string {
  switch (code) {
    case 'forbidden':
      return t('handover.forbidden');
    case 'not_found':
      return t('handover.not_found');
    case 'not_candidate':
      return t('handover.not_candidate');
    case 'already_holder':
      return t('handover.already_holder');
    case 'npi':
      return t('handover.directory_unreadable');
  }
}

export function isHandoverAdmin(caller: { permissions: readonly string[] }): boolean {
  return caller.permissions.includes(HANDOVER_ADMIN_PERMISSION);
}

function requireAdmin(caller: HandoverCaller): void {
  if (!isHandoverAdmin(caller)) throw new HandoverError('forbidden');
}

// ─── The stored body, validated on read ──────────────────────────────────────

const SkipReasonSchema = z.enum(['no_permission', 'npi_refused', 'npi_error']);
const PersonSchema = z.object({ npiUserId: z.string(), nameAr: z.string().nullable() });
const FactSchema = z.object({ factId: z.string(), factAr: z.string(), sourceType: z.enum(['npi', 'chat']) });
const TaskSchema = z.object({
  id: z.string(),
  documentType: z.string(),
  documentCode: z.string(),
  amount: z.number(),
  currentStep: z.number(),
  stepCount: z.number(),
  waitingSince: z.string(),
  raisedByNameAr: z.string().nullable(),
  escalated: z.boolean(),
});
const NarrativeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('written'),
    summaryAr: z.string(),
    firstWeekAr: z.array(z.string()),
    cautionsAr: z.array(z.string()),
    modelId: z.string(),
    writtenAt: z.string(),
  }),
  z.object({ status: z.literal('failed'), reason: z.string(), failedAt: z.string() }),
  z.object({ status: z.literal('skipped') }),
]);
const BodySchema = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  position: z.object({
    id: z.string(),
    roleKey: z.string(),
    roleNameAr: z.string().nullable(),
    departmentId: z.string().nullable(),
    departmentNameAr: z.string().nullable(),
    titleAr: z.string(),
  }),
  predecessor: PersonSchema.extend({ since: z.string() }).nullable(),
  successor: PersonSchema,
  tasks: z.discriminatedUnion('status', [
    z.object({ status: z.literal('read'), items: z.array(TaskSchema) }),
    z.object({ status: z.literal('skipped'), reason: SkipReasonSchema }),
  ]),
  vendors: z.array(
    z.object({
      npiVendorId: z.string().nullable(),
      nameAr: z.string().nullable(),
      code: z.string().nullable(),
      factsAr: z.array(z.string()),
    }),
  ),
  routines: z.array(FactSchema),
  companyFacts: z.array(FactSchema),
  narrative: NarrativeSchema,
});

/** The stored `bodyJson` as a `HandoverBody`, or null when it is not one
 *  (another `version`, a missing field): the caller treats that as «not found». */
export function parseHandoverBody(json: unknown): HandoverBody | null {
  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) return null;
  const body: HandoverBody = parsed.data;
  return body;
}

// ─── Directory (who may be named) ────────────────────────────────────────────

/**
 * The department directory, as the administrator. NPI's endpoint needs
 * `admin.department.manage`: an administrator without it cannot be shown whom
 * to pick, which is a refusal worth naming, not an empty list. A 401 is passed
 * up as it is (the route answers 401); any other NPI failure carries NPI's own
 * Arabic message.
 */
async function readDirectoryForAdmin(npi: HandoverNpi, caller: HandoverCaller): Promise<NpiDirectoryUser[]> {
  if (!caller.permissions.includes(HANDOVER_PERMISSION.directory)) {
    throw new HandoverError('npi', t('handover.directory_unreadable'));
  }
  try {
    return readDirectoryUsers(await npi.listDepartmentDirectory());
  } catch (err) {
    if (!(err instanceof NpiError)) throw err;
    if (err.kind === 'unauthorized') throw err;
    if (err.kind === 'forbidden') throw new HandoverError('npi', t('handover.directory_unreadable'));
    throw new HandoverError('npi', err.messageAr);
  }
}

async function requirePosition(db: Pick<ReassignDb, 'position'>, caller: HandoverCaller, positionId: string) {
  const position = await db.position.findFirst({ where: { id: positionId, npiOrgId: caller.npiOrgId } });
  if (position === null) throw new HandoverError('not_found');
  return position;
}

// ─── Candidates ──────────────────────────────────────────────────────────────

/**
 * Who an administrator may name as the new holder (D-T30-1): active NPI users
 * whose role is the position's role and who do not hold it already. The
 * department is not checked. Also returns the current holders.
 */
export async function listCandidates(
  deps: { db: ReassignDb; npi: HandoverNpi },
  caller: HandoverCaller,
  positionId: string,
): Promise<HandoverCandidatesView> {
  requireAdmin(caller);
  const position = await requirePosition(deps.db, caller, positionId);
  const directory = await readDirectoryForAdmin(deps.npi, caller);

  const open = await deps.db.positionAssignment.findMany({
    where: { positionId: position.id, endedAt: null },
    orderBy: { startedAt: 'asc' },
    select: { npiUserId: true },
  });
  const holderIds = new Set(open.map((a) => a.npiUserId));

  return {
    position: { id: position.id, titleAr: position.titleAr, roleKey: position.roleKey },
    holders: open.map((a) => ({
      npiUserId: a.npiUserId,
      nameAr: directory.find((u) => u.id === a.npiUserId)?.nameAr ?? null,
    })),
    candidates: directory
      .filter((u) => u.isActive && u.roleKey === position.roleKey && !holderIds.has(u.id))
      .map((u) => ({ npiUserId: u.id, nameAr: u.nameAr }))
      .sort((a, b) => a.nameAr.localeCompare(b.nameAr, 'ar')),
  };
}

// ─── Reassignment ────────────────────────────────────────────────────────────

export interface ReassignDeps {
  db: ReassignDb;
  npi: HandoverNpi;
  llm: { complete(req: RedactedRequest, ctx: LlmContext): Promise<ModelResponse> };
  /** Builds the pseudonymizer from the firm's dictionary; called once, after the body is built. */
  pseudonymizer: () => Promise<Pseudonymizer>;
  now?: () => Date;
}

/**
 * Names `toUserId` the holder of `positionId` (administrator only) and writes
 * the handover document. The narrative is attempted once and never fails the
 * reassignment (D-T30-3); the rest is one transaction (D-T30-2).
 */
export async function reassignPosition(
  deps: ReassignDeps,
  caller: HandoverCaller,
  input: { positionId: string; toUserId: string },
): Promise<ReassignOutcome> {
  requireAdmin(caller);
  const now = (deps.now ?? (() => new Date()))();
  const { db } = deps;
  const position = await requirePosition(db, caller, input.positionId);

  const holders = await db.positionAssignment.findMany({
    where: { positionId: position.id, endedAt: null },
    orderBy: { startedAt: 'asc' },
    select: { npiUserId: true, startedAt: true },
  });
  if (holders.some((h) => h.npiUserId === input.toUserId)) throw new HandoverError('already_holder');

  const directory = await readDirectoryForAdmin(deps.npi, caller);
  const successor = directory.find((u) => u.id === input.toUserId);
  if (successor === undefined || !successor.isActive || successor.roleKey !== position.roleKey) {
    throw new HandoverError('not_candidate');
  }

  // The predecessor is the open holder with the latest start.
  const latest = holders.length === 0 ? null : holders.reduce((a, b) => (b.startedAt.getTime() >= a.startedAt.getTime() ? b : a));

  const body = await buildHandoverBody({ db, npi: deps.npi, now: () => now }, caller, {
    positionId: position.id,
    successor: { npiUserId: input.toUserId },
    predecessor: latest === null ? null : { npiUserId: latest.npiUserId, since: latest.startedAt },
  });
  body.narrative = await writeNarrative(
    { llm: deps.llm, pseudonymizer: await deps.pseudonymizer(), now: () => now },
    { npiOrgId: caller.npiOrgId, npiUserId: caller.npiUserId },
    body,
  );

  // Serializable: two reassignments racing for the same person cannot both
  // commit (the loser fails with a serialization error instead of leaving two
  // open assignments).
  const outcome = await db.$transaction(async (tx) => {
    // Re-checked inside the transaction: two administrators acting at once must
    // not both open an assignment for the same person.
    const already = await tx.positionAssignment.findFirst({
      where: { positionId: position.id, npiUserId: input.toUserId, endedAt: null },
      select: { id: true },
    });
    if (already !== null) throw new HandoverError('already_holder');

    const doc = await tx.handoverDoc.create({
      data: {
        positionId: position.id,
        fromUserId: latest?.npiUserId ?? null,
        toUserId: input.toUserId,
        bodyJson: body as never,
        bodyAr: renderHandoverAr(body),
      },
      select: { id: true },
    });

    const toEnd = await tx.positionAssignment.findMany({
      where: {
        endedAt: null,
        OR: [
          { positionId: position.id },
          {
            npiUserId: input.toUserId,
            positionId: { not: position.id },
            position: { npiOrgId: caller.npiOrgId, roleKey: position.roleKey },
          },
        ],
      },
      select: { id: true },
    });
    const endedAssignmentIds = toEnd.map((a) => a.id);
    if (endedAssignmentIds.length > 0) {
      await tx.positionAssignment.updateMany({ where: { id: { in: endedAssignmentIds } }, data: { endedAt: now } });
    }

    const assignment = await tx.positionAssignment.create({
      data: { positionId: position.id, npiUserId: input.toUserId, startedAt: now, handoverDocId: doc.id },
      select: { id: true },
    });
    // The trust-log row commits with the reassignment (D-T30-8): never a
    // reassignment without its row, never a row without its reassignment.
    await writeAuditEvent(tx, { npiOrgId: caller.npiOrgId, npiUserId: caller.npiUserId }, 'position_reassigned');
    return { handoverId: doc.id, endedAssignmentIds, assignmentId: assignment.id };
  }, { isolationLevel: 'Serializable' });

  return { ...outcome, narrativeStatus: body.narrative.status };
}

// ─── Reading documents ───────────────────────────────────────────────────────

interface DocRow {
  id: string;
  positionId: string;
  fromUserId: string | null;
  toUserId: string;
  bodyJson: unknown;
  bodyAr: string;
  createdAt: Date;
  position: { titleAr: string };
}

const DOC_SELECT = {
  id: true,
  positionId: true,
  fromUserId: true,
  toUserId: true,
  bodyJson: true,
  bodyAr: true,
  createdAt: true,
  position: { select: { titleAr: true } },
} as const;

/** Which documents of the organization the caller may see (D-T30-4). */
function visibleDocsWhere(caller: HandoverCaller) {
  const inOrg = { position: { npiOrgId: caller.npiOrgId } };
  return isHandoverAdmin(caller)
    ? inOrg
    : { ...inOrg, OR: [{ toUserId: caller.npiUserId }, { fromUserId: caller.npiUserId }] };
}

function summaryOf(doc: DocRow, body: HandoverBody): HandoverSummary {
  return {
    id: doc.id,
    positionId: doc.positionId,
    positionTitleAr: doc.position.titleAr,
    fromUserId: doc.fromUserId,
    toUserId: doc.toUserId,
    createdAt: doc.createdAt.toISOString(),
    narrativeStatus: body.narrative.status,
  };
}

/** The documents the caller may see, newest first, at most 100. A document
 *  whose stored body is not readable is left out (and logged), not shown broken. */
export async function listHandovers(deps: { db: ReassignDb }, caller: HandoverCaller): Promise<HandoverSummary[]> {
  const docs = (await deps.db.handoverDoc.findMany({
    where: visibleDocsWhere(caller),
    select: DOC_SELECT,
    orderBy: { createdAt: 'desc' },
    take: 100,
  })) as DocRow[];
  const out: HandoverSummary[] = [];
  for (const doc of docs) {
    const body = parseHandoverBody(doc.bodyJson);
    if (body === null) {
      console.warn(`[copilot] handover ${doc.id}: stored body is not a version 1 document`);
      continue;
    }
    out.push(summaryOf(doc, body));
  }
  return out;
}

async function predecessorConversations(
  db: Pick<ReassignDb, 'conversation'>,
  caller: HandoverCaller,
  doc: Pick<DocRow, 'positionId' | 'fromUserId'>,
): Promise<PredecessorConversation[]> {
  if (doc.fromUserId === null) return [];
  const rows = await db.conversation.findMany({
    where: { npiUserId: doc.fromUserId, positionId: doc.positionId, npiOrgId: caller.npiOrgId },
    orderBy: { updatedAt: 'desc' },
    take: 50,
    select: { id: true, titleAr: true, updatedAt: true, _count: { select: { messages: true } } },
  });
  return rows.map((row) => ({
    id: row.id,
    titleAr: row.titleAr,
    updatedAt: row.updatedAt.toISOString(),
    messageCount: row._count.messages,
  }));
}

async function viewOf(
  db: Pick<ReassignDb, 'conversation'>,
  caller: HandoverCaller,
  doc: DocRow,
  body: HandoverBody,
): Promise<HandoverView> {
  const view: HandoverView = { ...summaryOf(doc, body), body, bodyAr: doc.bodyAr };
  if (isHandoverAdmin(caller)) view.predecessorConversations = await predecessorConversations(db, caller, doc);
  return view;
}

/** One document, or null when it does not exist or is not the caller's (the route answers 404). */
export async function getHandover(
  deps: { db: ReassignDb },
  caller: HandoverCaller,
  id: string,
): Promise<HandoverView | null> {
  const doc = (await deps.db.handoverDoc.findFirst({
    where: { id, ...visibleDocsWhere(caller) },
    select: DOC_SELECT,
  })) as DocRow | null;
  if (doc === null) return null;
  const body = parseHandoverBody(doc.bodyJson);
  if (body === null) {
    console.warn(`[copilot] handover ${doc.id}: stored body is not a version 1 document`);
    return null;
  }
  return viewOf(deps.db, caller, doc, body);
}

/** Rewrites the narrative of an existing document from its stored body (administrator only). */
export async function narrateHandover(
  deps: Pick<ReassignDeps, 'db' | 'llm' | 'pseudonymizer' | 'now'>,
  caller: HandoverCaller,
  id: string,
): Promise<HandoverView> {
  requireAdmin(caller);
  const now = deps.now ?? (() => new Date());
  const doc = (await deps.db.handoverDoc.findFirst({
    where: { id, position: { npiOrgId: caller.npiOrgId } },
    select: DOC_SELECT,
  })) as DocRow | null;
  if (doc === null) throw new HandoverError('not_found');
  const stored = parseHandoverBody(doc.bodyJson);
  if (stored === null) {
    console.warn(`[copilot] handover ${doc.id}: stored body is not a version 1 document`);
    throw new HandoverError('not_found');
  }

  const body: HandoverBody = {
    ...stored,
    narrative: await writeNarrative(
      { llm: deps.llm, pseudonymizer: await deps.pseudonymizer(), now },
      { npiOrgId: caller.npiOrgId, npiUserId: caller.npiUserId },
      stored,
    ),
  };
  const bodyAr = renderHandoverAr(body);
  await deps.db.handoverDoc.update({ where: { id: doc.id }, data: { bodyJson: body as never, bodyAr } });
  return viewOf(deps.db, caller, { ...doc, bodyAr }, body);
}

// ─── Predecessor chats (BR-07) ───────────────────────────────────────────────

/**
 * Whether the caller may read this conversation (D-T30-5): its owner, and an
 * administrator of the same organization when the owner is a predecessor of
 * the conversation's position (a handover document exists with `fromUserId` =
 * the owner and that position). Anyone else — the successor included — gets
 * null, which the chat route answers with 404.
 */
export async function conversationReadableBy(
  db: Pick<PrismaClient, 'conversation' | 'handoverDoc'>,
  caller: HandoverCaller,
  conversationId: string,
): Promise<{ id: string } | null> {
  const conversation = await db.conversation.findFirst({
    where: { id: conversationId, npiOrgId: caller.npiOrgId },
    select: { id: true, npiUserId: true, positionId: true },
  });
  if (conversation === null) return null;
  if (conversation.npiUserId === caller.npiUserId) return { id: conversation.id };
  if (!isHandoverAdmin(caller) || conversation.positionId === null) return null;
  const handover = await db.handoverDoc.findFirst({
    where: { fromUserId: conversation.npiUserId, positionId: conversation.positionId },
    select: { id: true },
  });
  return handover === null ? null : { id: conversation.id };
}

// ─── Seven-day guidance ──────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The handover the successor's chat carries: their open assignment on the
 * position, opened by a handover document within the last seven days, and that
 * document's body. Null when there is none (or its body is not readable).
 */
export async function activeHandoverFor(
  db: Pick<PrismaClient, 'positionAssignment' | 'handoverDoc'>,
  user: { npiUserId: string; positionId: string },
  now: Date,
): Promise<HandoverBody | null> {
  const since = new Date(now.getTime() - HANDOVER_GUIDANCE_DAYS * DAY_MS);
  const assignment = await db.positionAssignment.findFirst({
    where: {
      npiUserId: user.npiUserId,
      positionId: user.positionId,
      endedAt: null,
      handoverDocId: { not: null },
      startedAt: { gte: since },
    },
    orderBy: { startedAt: 'desc' },
    select: { handoverDocId: true },
  });
  if (assignment?.handoverDocId == null) return null;
  const doc = await db.handoverDoc.findUnique({ where: { id: assignment.handoverDocId }, select: { id: true, bodyJson: true } });
  if (doc === null) return null;
  const body = parseHandoverBody(doc.bodyJson);
  if (body === null) console.warn(`[copilot] handover ${doc.id}: stored body is not a version 1 document`);
  return body;
}
