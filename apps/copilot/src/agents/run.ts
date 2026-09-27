// One chat turn, end to end.
//
//   user message ─► router ─► HR refusal                       (no model call)
//                         ├─► intake flow (a later milestone)  (no model call here)
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
import { decrypt, encrypt } from '../crypto/aead';
import { t } from '../i18n/ar';
import { LlmError, type LlmContext } from '../llm/client';
import type { ModelResponse, RedactedBlock, RedactedMessage, RedactedRequest } from '../llm/provider';
import { extractFactsFromMessage } from '../memory/extract-chat';
import { retrieveFacts } from '../memory/retrieve';
import { NpiError } from '../npi/errors';
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
const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;

export interface TurnUser {
  npiOrgId: string;
  npiUserId: string;
  nameAr: string;
  positionId: string | null;
  positionTitleAr: string | null;
  personaAr: string;
}

export interface TurnInput {
  conversationId?: string;
  text: string;
}

export type TurnKind = 'answer' | 'hr_refusal' | 'flow_pending' | 'error';

export interface TurnReply {
  conversationId: string;
  messageId: string;
  kind: TurnKind;
  textAr: string;
  /** Arabic labels of the tools or the flow behind this reply (AssistantBadge). */
  badges: string[];
  memoryNotes: MemoryNote[];
}

export type TurnDb = Pick<
  PrismaClient,
  'conversation' | 'message' | 'redactionSession' | 'dailyUsage' | 'memoryFact' | '$queryRaw'
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
  now?: () => Date;
}

export class TurnInputError extends Error {
  constructor(readonly reason: 'empty' | 'too_long' | 'conversation_not_found') {
    super(reason);
  }
}

const FLOW_LABEL_KEYS = {
  customer_contract: 'flow.customer_contract',
  pr: 'flow.pr',
  po: 'flow.po',
  grn: 'flow.grn',
  vendor_bill: 'flow.vendor_bill',
} as const;

function riyadhDay(now: Date): Date {
  const shifted = new Date(now.getTime() + RIYADH_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
}

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

  return joinRedacted([
    staticPrompt(loadPrompt('assistant.md')),
    staticPrompt(`\n\n## Today\n${today} (Asia/Riyadh)\n\n## Position\n`),
    pseudo.redact(position),
    staticPrompt('\n\n## Memory\n'),
    pseudo.redact(memory),
  ]);
}

interface ChatOutcome {
  kind: TurnKind;
  textAr: string;
  badges: string[];
  memoryNotes: MemoryNote[];
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
    return { type: 'tool_result', toolUseId: call.id, content: pseudo.redactJson(outcome.result) };
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
  };

  const pseudo = new Pseudonymizer(await deps.dictionary(), await loadRedactionState(deps, conversationId, now));

  const remembered: MemoryNote[] = (
    await retrieveFacts(deps.db, { npiOrgId: user.npiOrgId, positionId: user.positionId, query: text }, () => now)
  ).map((hit) => ({ id: hit.id, factAr: hit.factAr, sourceType: hit.sourceType }));

  const history = await deps.db.message.findMany({
    where: { conversationId, id: { not: userMessageId } },
    orderBy: { createdAt: 'desc' },
    take: HISTORY_MESSAGES,
    select: { role: true, contentAr: true },
  });

  const messages: RedactedMessage[] = history
    .reverse()
    .map((m) => ({ role: m.role, content: pseudo.redact(m.contentAr) }));
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

function replyForRoute(decision: Exclude<Route, { kind: 'chat' }>): ChatOutcome {
  if (decision.kind === 'hr_refusal') {
    return { kind: 'hr_refusal', textAr: t('hr.refusal'), badges: [], memoryNotes: [] };
  }
  if (decision.kind === 'choose_flow') {
    return { kind: 'flow_pending', textAr: t('chat.flow_pending.unknown'), badges: [], memoryNotes: [] };
  }
  const flowAr = t(FLOW_LABEL_KEYS[decision.flow]);
  return {
    kind: 'flow_pending',
    textAr: t(decision.kind === 'flow_unavailable' ? 'chat.flow_unavailable' : 'chat.flow_pending', { flow: flowAr }),
    badges: [flowAr],
    memoryNotes: [],
  };
}

export async function runTurn(deps: TurnDeps, user: TurnUser, input: TurnInput): Promise<TurnReply> {
  const now = (deps.now ?? (() => new Date()))();
  const text = input.text.trim();
  if (text.length === 0) throw new TurnInputError('empty');
  if (text.length > MAX_MESSAGE_LENGTH) throw new TurnInputError('too_long');

  const conversationId = await openConversation(deps, user, input, text);
  const userMessage = await deps.db.message.create({
    data: { conversationId, role: 'user', contentAr: text },
    select: { id: true },
  });
  await countMessage(deps, user, now);

  const decision = await route(
    { text, hasAttachment: false, visibleFlows: deps.visibleFlows },
    { classify: deps.classify },
  );

  const outcome =
    decision.kind === 'chat'
      ? await chat(deps, user, conversationId, userMessage.id, text, now)
      : replyForRoute(decision);

  const saved = await deps.db.message.create({
    data: {
      conversationId,
      role: 'assistant',
      contentAr: outcome.textAr,
      kind: outcome.kind,
      badge: outcome.badges.length > 0 ? outcome.badges.join('، ') : null,
      memoryNoteJson: outcome.memoryNotes.length > 0 ? (outcome.memoryNotes as never) : undefined,
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
  };
}
