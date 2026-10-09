// A conversation's history as the chat screen shows it (T-39b, D-23): the
// read behind `GET /copilot/api/chat` and behind the home page's server
// render, in ONE module so the two can never disagree about which
// conversation is meant, who may read it, or the shape of a message.
//
// With a requested id the conversation is resolved through
// `conversationReadableBy` (its owner, or an administrator reading a
// predecessor's chat — BR-07, T-30 D-T30-5) and anything else is `null`, which
// the route answers with a 404. Without one, only the caller's own latest
// conversation is ever returned.
import type { PrismaClient } from '@/generated/prisma';
import type { ChatMessage } from '@/components/chat/api';
import { conversationReadableBy } from '@/positions/reassign';

/** How many of a conversation's newest messages the screen loads. */
export const HISTORY_LIMIT = 50;

/** What the screen renders from: the conversation (null when the caller has
 *  none yet) and its newest messages, oldest first. */
export interface ConversationHistory {
  conversationId: string | null;
  messages: ChatMessage[];
}

/** The delegates this read touches (`conversationReadableBy` needs the
 *  handover table for the administrator's predecessor case). */
export type HistoryDb = Pick<PrismaClient, 'conversation' | 'message' | 'handoverDoc'>;

/** Who is reading: the organization, the user and the permissions that decide
 *  whether a predecessor's conversation is readable. */
export type HistoryCaller = Parameters<typeof conversationReadableBy>[1];

export async function loadConversationHistory(
  db: HistoryDb,
  caller: HistoryCaller,
  requested: string | null,
): Promise<ConversationHistory | null> {
  const conversation = requested
    ? await conversationReadableBy(db, caller, requested)
    : await db.conversation.findFirst({
        where: { npiUserId: caller.npiUserId, npiOrgId: caller.npiOrgId },
        orderBy: { updatedAt: 'desc' },
        select: { id: true },
      });

  if (!conversation) {
    return requested ? null : { conversationId: null, messages: [] };
  }

  const rows = await db.message.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: 'desc' },
    take: HISTORY_LIMIT,
    select: {
      id: true,
      role: true,
      contentAr: true,
      badge: true,
      kind: true,
      memoryNoteJson: true,
      intakeJobId: true,
      documentId: true,
      createdAt: true,
    },
  });

  return {
    conversationId: conversation.id,
    messages: rows.reverse().map((row) => ({
      id: row.id,
      role: row.role,
      textAr: row.contentAr,
      ...(row.kind ? { kind: row.kind as NonNullable<ChatMessage['kind']> } : {}),
      badges: row.badge ? row.badge.split('، ') : [],
      memoryNotes: Array.isArray(row.memoryNoteJson) ? (row.memoryNoteJson as unknown as ChatMessage['memoryNotes']) : [],
      ...(row.intakeJobId ? { intakeJobId: row.intakeJobId } : {}),
      ...(row.documentId ? { documentId: row.documentId } : {}),
      createdAt: row.createdAt.toISOString(),
    })),
  };
}
