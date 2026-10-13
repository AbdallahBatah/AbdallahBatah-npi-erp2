// One chat turn, end to end.
//
//   user message ─► router ─► HR refusal                       (no model call)
//                         ├─► intake flow: permission, then a job (deps.intake runs the extraction)
//                         └─► chat: model + read-only tools
//
// Invariants this file keeps:
//  - Nothing reaches the model except through the pseudonymizer: the user's
//    text, the conversation history, the position's persona, remembered
//    facts and every tool result are redacted first (F-16). Tool inputs the
//    model writes carry placeholders and are rehydrated only on this side,
//    just before NPI is called.
//  - The assistant has read tools only. It cannot write to NPI, approve,
//    reject or delete (BR-01, BR-03).
//  - NPI is called with the user's own token, so NPI decides what this user
//    may see. A refusal from NPI is handed to the model as a failed tool
//    result and relayed; it is never worked around (BR-02).
//  - Every model call is audited by `src/llm/client.ts`.
import { riyadhDay } from '../audit/cost';
import { decrypt, encrypt } from '../crypto/aead';
import { t } from '../i18n/ar';
import { LlmError, type LlmContext } from '../llm/client';
import type { ModelResponse, RedactedBlock, RedactedMessage, RedactedRequest } from '../llm/provider';
import { extractFactsFromMessage } from '../memory/extract-chat';
import { markUsed, retrieveFacts } from '../memory/retrieve';
import { NpiError } from '../npi/errors';
import { DOCUMENT_FLOWS, FLOW_REQUIRED_PERMISSION } from '../onboarding/profile.schema';
import type { StartIntakeInput, StartIntakeOutcome } from '../intake/job';
import {
  Pseudonymizer,
  fromModelOutput,
  joinRedacted,
  staticPrompt,
  type DictionaryEntry,
  type RedactedText,
  type RedactionState,
} from '../privacy/pseudonymizer';
import { loadPrompt } from '../prompts/load';
import type { PrismaClient } from '../generated/prisma';
import { route, type ClassifierVerdict, type FlowType, type Route } from './router';
import { READ_TOOLS, ToolInputError, findReadTool, type MemoryNote, type ToolContext } from './tools/read';

export const MAX_MESSAGE_LENGTH = 4000;
const MAX_MODEL_CALLS = 6;
const HISTORY_MESSAGES = 12;
const REDACTION_TTL_MS = 24 * 60 * 60 * 1000;

export interface TurnUser {
  npiOrgId: string;
  npiUserId: string;
  nameAr: string;
  positionId: string | null;
  positionTitleAr: string | null;
  personaAr: string;
  /** NPI permission keys of the user; an intake flow needs its own (AT-15). */
  permissions: string[];
  /** The firm's Arabic name, so the model does not take it for the customer. */
  orgNameAr: string | null;
  /** T-30 (F-13): the handover excerpt carried for the first seven days after
   *  this user took over the position (`handoverGuidanceAr`), or null. */
  handoverAr?: string | null;
}

export interface TurnInput {
  conversationId?: string;
  /** May be empty only when `documentId` is set. */
  text: string;
  /** A document the user attached (uploaded earlier through /api/documents). */
  documentId?: string;
  /** The flow chip the user pressed. */
  forcedFlow?: FlowType;
}

/** `flow_pending` is no longer produced (every flow is registered); it stays
 *  in the union for rows stored by earlier versions. */
export type TurnKind = 'answer' | 'hr_refusal' | 'flow_pending' | 'intake' | 'choose_flow' | 'error';

export interface TurnReply {
  conversationId: string;
  messageId: string;
  kind: TurnKind;
  textAr: string;
  /** Arabic labels of the tools or the flow behind this reply (AssistantBadge). */
  badges: string[];
  memoryNotes: MemoryNote[];
  /** The intake job behind an `intake` reply. */
  intakeJobId?: string;
  /** The attached document, echoed on an `intake` or `choose_flow` reply. */
  documentId?: string;
}

export type TurnDb = Pick<
  PrismaClient,
  'conversation' | 'message' | 'redactionSession' | 'dailyUsage' | 'memoryFact' | 'document' | '$queryRaw'
>;

export interface TurnDeps {
  db: TurnDb;
  llm: { complete(req: RedactedRequest, ctx: LlmContext): Promise<ModelResponse> };
  npi: ToolContext['npi'];
  /** Key for the conversation's placeholder map at rest. */
  key: Buffer;
  dictionary: () => Promise<DictionaryEntry[]>;
  classify?: (text: string) => Promise<ClassifierVerdict>;
  visibleFlows?: readonly FlowType[];
  /** Starts an intake job (extraction + preview). Injected so a turn stays
   *  testable without a model, a database of jobs or NPI. */
  intake: { start(caller: { npiOrgId: string; npiUserId: string }, input: StartIntakeInput): Promise<StartIntakeOutcome> };
  now?: () => Date;
}

export class TurnInputError extends Error {
  constructor(
    readonly reason: 'empty' | 'too_long' | 'conversation_not_found' | 'document_not_found' | 'consent_required' | 'bad_flow',
  ) {
    super(reason);
  }
}

const FLOW_LABEL_KEYS = {
  customer_contract: 'flow.customer_contract',
  pr: 'flow.pr',
  po: 'flow.po',
  grn: 'flow.grn',
  vendor_bill: 'flow.vendor_bill',
  user_permissions: 'flow.user_permissions',
} as const;

async function openConversation(deps: TurnDeps, user: TurnUser, input: TurnInput, text: string): Promise<string> {
  if (input.conversationId) {
    // Looked up by owner as well as id: another user's conversation does not
    // exist as far as this user is concerned.
    const found = await deps.db.conversation.findFirst({
      where: { id: input.conversationId, npiUserId: user.npiUserId, npiOrgId: user.npiOrgId },
      select: { id: true },
    });
    if (!found) throw new TurnInputError('conversation_not_found');
    return found.id;
  }
  const created = await deps.db.conversation.create({
    data: {
      npiOrgId: user.npiOrgId,
      npiUserId: user.npiUserId,
      positionId: user.positionId,
      titleAr: text.slice(0, 60),
    },
    select: { id: true },
  });
  return created.id;
}

async function countMessage(deps: TurnDeps, user: TurnUser, now: Date): Promise<void> {
  const day = riyadhDay(now);
  await deps.db.dailyUsage.upsert({
    where: { npiUserId_day: { npiUserId: user.npiUserId, day } },
    create: { npiOrgId: user.npiOrgId, npiUserId: user.npiUserId, day, messageCount: 1 },
    update: { messageCount: { increment: 1 } },
  });
}

async function loadRedactionState(deps: TurnDeps, conversationId: string, now: Date): Promise<RedactionState | undefined> {
  const row = await deps.db.redactionSession.findFirst({
    where: { conversationId, expiresAt: { gt: now } },
    orderBy: { createdAt: 'desc' },
    select: { mapEncrypted: true },
  });
  if (!row) return undefined;
  try {
    return JSON.parse(decrypt(row.mapEncrypted, deps.key)) as RedactionState;
  } catch {
    // An unreadable map only costs placeholder continuity; start a fresh one.
    return undefined;
  }
}

async function saveRedactionState(
  deps: TurnDeps,
  user: TurnUser,
  conversationId: string,
  state: RedactionState,
  now: Date,
): Promise<void> {
  const mapEncrypted = encrypt(JSON.stringify(state), deps.key);
  const expiresAt = new Date(now.getTime() + REDACTION_TTL_MS);
  const existing = await deps.db.redactionSession.findFirst({
    where: { conversationId },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  if (existing) {
    await deps.db.redactionSession.update({ where: { id: existing.id }, data: { mapEncrypted, expiresAt } });
  } else {
    await deps.db.redactionSession.create({
      data: { npiOrgId: user.npiOrgId, npiUserId: user.npiUserId, conversationId, mapEncrypted, expiresAt },
    });
  }
}

function buildSystem(user: TurnUser, pseudo: Pseudonymizer, remembered: MemoryNote[], now: Date): RedactedText {
  const today = riyadhDay(now).toISOString().slice(0, 10);
  const position = [
    user.positionTitleAr ? `المنصب: ${user.positionTitleAr}` : null,
    `اسم المستخدم: ${user.nameAr}`,
    user.personaAr,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
  const memory =
    remembered.length > 0 ? remembered.map((note) => `- ${note.factAr}`).join('\n') : 'لا شيء مسجَّل يخص هذا السؤال.';

  // The handover section exists only while the guidance window is open
  // (src/agents/context.ts decides); names in it are redacted like the rest.
  const handover = user.handoverAr ? [staticPrompt('\n\n## Handover\n'), pseudo.redact(user.handoverAr)] : [];

  return joinRedacted([
    staticPrompt(loadPrompt('assistant.md')),
    staticPrompt(`\n\n## Today\n${today} (Asia/Riyadh)\n\n## Position\n`),
    pseudo.redact(position),
    staticPrompt('\n\n## Memory\n'),
    pseudo.redact(memory),
    ...handover,
  ]);
}

interface ChatOutcome {
  kind: TurnKind;
  textAr: string;
  badges: string[];
  memoryNotes: MemoryNote[];
  intakeJobId?: string;
  documentId?: string;
}

async function runToolCall(
  call: ModelResponse['toolCalls'][number],
  pseudo: Pseudonymizer,
  toolCtx: ToolContext,
  badges: Set<string>,
  notes: Map<string, MemoryNote>,
): Promise<RedactedBlock> {
  const fail = (message: string): RedactedBlock => ({
    type: 'tool_result',
    toolUseId: call.id,
    content: pseudo.redact(message),
    isError: true,
  });

  const tool = findReadTool(call.name);
  if (!tool) return fail('No such tool.');

  try {
    // The model wrote placeholders; NPI needs the real values.
    const outcome = await tool.run(pseudo.rehydrateJson(call.input), toolCtx);
    badges.add(tool.badgeAr);
    for (const note of outcome.memoryNotes ?? []) notes.set(note.id, note);
    return {
      type: 'tool_result',
      toolUseId: call.id,
      content: pseudo.redactJson(outcome.result, tool.sensitiveFields),
    };
  } catch (err) {
    if (err instanceof ToolInputError) return fail(`Invalid input: ${err.message}`);
    if (err instanceof NpiError) {
      badges.add(tool.badgeAr);
      return fail(err.messageAr);
    }
    throw err;
  }
}

async function chat(
  deps: TurnDeps,
  user: TurnUser,
  conversationId: string,
  userMessageId: string,
  text: string,
  now: Date,
): Promise<ChatOutcome> {
  const llmCtx: LlmContext = { npiOrgId: user.npiOrgId, npiUserId: user.npiUserId, conversationId };
  const toolCtx: ToolContext = {
    npi: deps.npi,
    db: deps.db,
    npiOrgId: user.npiOrgId,
    positionId: user.positionId,
    permissions: user.permissions,
  };

  const pseudo = new Pseudonymizer(await deps.dictionary(), await loadRedactionState(deps, conversationId, now));

  const remembered: MemoryNote[] = (
    await retrieveFacts(
      deps.db,
      { npiOrgId: user.npiOrgId, positionId: user.positionId, query: text, permissions: user.permissions, countUse: false },
      () => now,
    )
  ).map((hit) => ({ id: hit.id, factAr: hit.factAr, sourceType: hit.sourceType }));

  const history = await deps.db.message.findMany({
    where: { conversationId, id: { not: userMessageId } },
    orderBy: { createdAt: 'desc' },
    take: HISTORY_MESSAGES,
    select: { role: true, contentAr: true, kind: true },
  });

  // Oldest first. A stored error reply is not something the assistant said,
  // so it is not replayed; and the provider requires the first message to be
  // the user's, which a turn that failed half-way can otherwise break.
  const replayable = history.reverse().filter((m) => !(m.role === 'assistant' && m.kind === 'error'));
  const firstUser = replayable.findIndex((m) => m.role === 'user');
  const messages: RedactedMessage[] = (firstUser === -1 ? [] : replayable.slice(firstUser)).map((m) => ({
    role: m.role,
    content: pseudo.redact(m.contentAr),
  }));
  messages.push({ role: 'user', content: pseudo.redact(text) });

  const system = buildSystem(user, pseudo, remembered, now);
  const badges = new Set<string>();
  const toolNotes = new Map<string, MemoryNote>();

  let outcome: ChatOutcome | null = null;
  try {
    for (let step = 0; step < MAX_MODEL_CALLS && outcome === null; step += 1) {
      const response = await deps.llm.complete(
        {
          tier: 'economy',
          purpose: 'chat',
          system,
          messages,
          tools: READ_TOOLS.map((tool) => tool.def),
          maxTokens: 2048,
        },
        llmCtx,
      );

      if (response.stopReason === 'tool_use' && response.toolCalls.length > 0) {
        const echoed: RedactedBlock[] = [];
        if (response.text.length > 0) echoed.push({ type: 'text', text: fromModelOutput(response.text) });
        for (const call of response.toolCalls) {
          echoed.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
        }
        messages.push({ role: 'assistant', content: echoed });

        // All results go back together in one user message.
        const results: RedactedBlock[] = [];
        for (const call of response.toolCalls) {
          results.push(await runToolCall(call, pseudo, toolCtx, badges, toolNotes));
        }
        messages.push({ role: 'user', content: results });
        continue;
      }

      const answer = pseudo.rehydrate(response.text).trim();
      // Facts handed over in the prompt count as used when the answer says
      // it drew on memory, as the assistant is instructed to do.
      const notes = new Map(toolNotes);
      if (answer.includes('الذاكرة')) for (const note of remembered) notes.set(note.id, note);
      outcome = {
        kind: answer.length > 0 ? 'answer' : 'error',
        textAr: answer.length > 0 ? answer : t('chat.error.generic'),
        badges: [...badges],
        memoryNotes: [...notes.values()],
      };
    }
  } catch (err) {
    if (!(err instanceof LlmError)) throw err;
    outcome = { kind: 'error', textAr: err.messageAr, badges: [...badges], memoryNotes: [] };
  }

  // Placeholders minted this turn must mean the same thing next turn.
  await saveRedactionState(deps, user, conversationId, pseudo.exportState(), now);

  if (outcome === null) {
    // The model kept asking for tools; stop rather than loop on.
    return { kind: 'error', textAr: t('chat.error.generic'), badges: [...badges], memoryNotes: [] };
  }

  // A fact counts as used when it is shown with the answer, not when it was
  // merely offered to the model.
  await markUsed(
    deps.db,
    outcome.memoryNotes.map((note) => note.id),
    () => now,
  );

  if (outcome.kind === 'answer') {
    try {
      await extractFactsFromMessage(
        { db: deps.db, llm: deps.llm, pseudonymizer: pseudo },
        { ...llmCtx, positionId: user.positionId },
        text,
      );
    } catch {
      // Learning is best effort; the answer stands.
    }
  }
  return outcome;
}

function replyForRoute(decision: Extract<Route, { kind: 'hr_refusal' | 'flow_unavailable' }>): ChatOutcome {
  if (decision.kind === 'hr_refusal') {
    return { kind: 'hr_refusal', textAr: t('hr.refusal'), badges: [], memoryNotes: [] };
  }
  const flowAr = t(FLOW_LABEL_KEYS[decision.flow]);
  return { kind: 'flow_pending', textAr: t('chat.flow_unavailable', { flow: flowAr }), badges: [flowAr], memoryNotes: [] };
}

/** An entry flow: permission first (AT-15: no model call, no job for a user
 *  NPI would refuse), then the intake job — extraction and preview run inside
 *  this turn (D-T26-2). */
async function startFlow(
  deps: TurnDeps,
  user: TurnUser,
  flow: FlowType,
  conversationId: string,
  text: string,
  documentId: string | undefined,
): Promise<ChatOutcome> {
  const flowAr = t(FLOW_LABEL_KEYS[flow]);
  if (!user.permissions.includes(FLOW_REQUIRED_PERMISSION[flow])) {
    // D-26: the administrative flow has its own sentence (it is not a thing created).
    const textAr = flow === 'user_permissions' ? t('intake.forbidden.user_permissions') : t('intake.forbidden', { flow: flowAr });
    return { kind: 'error', textAr, badges: [flowAr], memoryNotes: [] };
  }
  const started = await deps.intake.start(
    { npiOrgId: user.npiOrgId, npiUserId: user.npiUserId },
    { flow, text: text.length > 0 ? text : null, documentId: documentId ?? null, conversationId, ourPartyNameAr: user.orgNameAr },
  );
  if (!started.ok) return { kind: 'error', textAr: started.messageAr, badges: [], memoryNotes: [] };
  return {
    kind: 'intake',
    textAr:
      started.status === 'preview'
        ? t('chat.intake_ready', { flow: flowAr })
        : t('chat.intake_failed', { flow: flowAr, reason: started.failureAr ?? t('chat.error.generic') }),
    badges: [flowAr],
    memoryNotes: [],
    intakeJobId: started.jobId,
    documentId,
  };
}

export async function runTurn(deps: TurnDeps, user: TurnUser, input: TurnInput): Promise<TurnReply> {
  const now = (deps.now ?? (() => new Date()))();
  const text = (input.text ?? '').trim();
  const documentId = input.documentId;
  if (text.length === 0 && !documentId) throw new TurnInputError('empty');
  if (text.length > MAX_MESSAGE_LENGTH) throw new TurnInputError('too_long');
  if (input.forcedFlow !== undefined && !(DOCUMENT_FLOWS as readonly string[]).includes(input.forcedFlow)) {
    throw new TurnInputError('bad_flow');
  }

  // The stored user message names the attachment, so a reload shows it.
  let storedText = text;
  if (documentId) {
    const document = await deps.db.document.findFirst({
      where: { id: documentId, npiOrgId: user.npiOrgId, npiUserId: user.npiUserId },
      select: { fileName: true },
    });
    if (!document) throw new TurnInputError('document_not_found');
    const attached = t('chat.attached', { name: document.fileName });
    storedText = text.length > 0 ? `${attached}\n${text}` : attached;
  }

  const conversationId = await openConversation(deps, user, input, storedText);
  const userMessage = await deps.db.message.create({
    data: { conversationId, role: 'user', contentAr: storedText, ...(documentId ? { documentId } : {}) },
    select: { id: true },
  });
  await countMessage(deps, user, now);

  // With nothing typed there is nothing for the classifier to read.
  const decision = await route(
    { text, hasAttachment: !!documentId, forcedFlow: input.forcedFlow, visibleFlows: deps.visibleFlows },
    { classify: text.length > 0 ? deps.classify : undefined },
  );

  let outcome: ChatOutcome;
  if (decision.kind === 'chat') {
    outcome = await chat(deps, user, conversationId, userMessage.id, text, now);
  } else if (decision.kind === 'flow') {
    outcome = await startFlow(deps, user, decision.flow, conversationId, text, documentId);
  } else if (decision.kind === 'choose_flow') {
    outcome = { kind: 'choose_flow', textAr: t('flow.unknown'), badges: [], memoryNotes: [], documentId };
  } else {
    outcome = replyForRoute(decision);
  }

  const saved = await deps.db.message.create({
    data: {
      conversationId,
      role: 'assistant',
      contentAr: outcome.textAr,
      kind: outcome.kind,
      badge: outcome.badges.length > 0 ? outcome.badges.join('، ') : null,
      memoryNoteJson: outcome.memoryNotes.length > 0 ? (outcome.memoryNotes as never) : undefined,
      ...(outcome.intakeJobId ? { intakeJobId: outcome.intakeJobId } : {}),
      ...(outcome.documentId ? { documentId: outcome.documentId } : {}),
    },
    select: { id: true },
  });
  await deps.db.conversation.update({ where: { id: conversationId }, data: { updatedAt: now } });

  return {
    conversationId,
    messageId: saved.id,
    kind: outcome.kind,
    textAr: outcome.textAr,
    badges: outcome.badges,
    memoryNotes: outcome.memoryNotes,
    ...(outcome.intakeJobId ? { intakeJobId: outcome.intakeJobId } : {}),
    ...(outcome.documentId ? { documentId: outcome.documentId } : {}),
  };
}
