// T-39b (D-23): the chat history read shared by `GET /copilot/api/chat` and the
// home page's server render (`src/chat/history.ts`), against the real local
// npi_copilot database. Every row written carries one of this run's
// organization ids and is deleted in afterAll (messages first, then the intake
// jobs they point at, then the conversations).
import './helpers/load-env';
import { getDb } from '../src/db';
import { HISTORY_LIMIT, loadConversationHistory, type HistoryCaller } from '../src/chat/history';

const db = getDb();
const runId = Math.random().toString(36).slice(2, 10);
const orgIds: string[] = [];
let orgSeq = 0;

function newOrg(): string {
  orgSeq += 1;
  const id = `test-chat-history-${runId}-${orgSeq}`;
  orgIds.push(id);
  return id;
}

function caller(npiOrgId: string, npiUserId: string): HistoryCaller {
  return { npiOrgId, npiUserId, permissions: [] };
}

const T0 = new Date('2026-10-01T10:00:00.000Z').getTime();
const at = (seconds: number) => new Date(T0 + seconds * 1000);

afterAll(async () => {
  const org = { in: orgIds };
  await db.message.deleteMany({ where: { conversation: { npiOrgId: org } } });
  await db.intakeJob.deleteMany({ where: { npiOrgId: org } });
  await db.conversation.deleteMany({ where: { npiOrgId: org } });
  await db.$disconnect();
});

async function conversation(npiOrgId: string, npiUserId: string, updatedAt: Date): Promise<string> {
  return (await db.conversation.create({ data: { npiOrgId, npiUserId, updatedAt }, select: { id: true } })).id;
}

describe('loadConversationHistory without a requested id', () => {
  it('is empty with no conversation', async () => {
    const org = newOrg();
    expect(await loadConversationHistory(db, caller(org, 'u1'), null)).toEqual({ conversationId: null, messages: [] });
  });

  it("returns the caller's latest conversation by updatedAt", async () => {
    const org = newOrg();
    const older = await conversation(org, 'u1', at(0));
    const newer = await conversation(org, 'u1', at(100));
    const other = await conversation(org, 'u2', at(200));
    await db.message.create({ data: { conversationId: older, role: 'user', contentAr: 'قديمة' } });
    await db.message.create({ data: { conversationId: newer, role: 'user', contentAr: 'حديثة' } });
    await db.message.create({ data: { conversationId: other, role: 'user', contentAr: 'لمستخدم آخر' } });

    const history = await loadConversationHistory(db, caller(org, 'u1'), null);
    expect(history?.conversationId).toBe(newer);
    expect(history?.messages.map((m) => m.textAr)).toEqual(['حديثة']);
  });

  it('is empty for a conversation without messages', async () => {
    const org = newOrg();
    const id = await conversation(org, 'u1', at(0));
    expect(await loadConversationHistory(db, caller(org, 'u1'), null)).toEqual({ conversationId: id, messages: [] });
  });

  it('maps a stored row to the shape the browser renders, oldest first', async () => {
    const org = newOrg();
    const id = await conversation(org, 'u1', at(0));
    const job = await db.intakeJob.create({ data: { npiOrgId: org, npiUserId: 'u1', flowType: 'pr', status: 'preview' }, select: { id: true } });
    const note = [{ id: 'fact-1', factAr: 'ملاحظة', sourceType: 'npi' }];
    await db.message.create({ data: { conversationId: id, role: 'user', contentAr: 'سؤال', createdAt: at(1) } });
    await db.message.create({
      data: {
        conversationId: id,
        role: 'assistant',
        contentAr: 'جواب',
        badge: 'أ، ب',
        kind: 'intake',
        memoryNoteJson: note,
        intakeJobId: job.id,
        documentId: 'doc-1',
        createdAt: at(3),
      },
    });
    await db.message.create({ data: { conversationId: id, role: 'assistant', contentAr: 'بلا ملاحظات', memoryNoteJson: { not: 'an array' }, createdAt: at(2) } });

    const history = await loadConversationHistory(db, caller(org, 'u1'), null);
    expect(history?.conversationId).toBe(id);
    const [first, second, third] = history?.messages ?? [];
    expect(history?.messages).toHaveLength(3);

    // Plain row: optional keys are left out, not sent as null.
    expect(first).toEqual({
      id: first.id,
      role: 'user',
      textAr: 'سؤال',
      badges: [],
      memoryNotes: [],
      createdAt: at(1).toISOString(),
    });
    expect('kind' in first || 'intakeJobId' in first || 'documentId' in first).toBe(false);

    // A non-array `memoryNoteJson` becomes [].
    expect(second.textAr).toBe('بلا ملاحظات');
    expect(second.memoryNotes).toEqual([]);

    // Full row.
    expect(third).toEqual({
      id: third.id,
      role: 'assistant',
      textAr: 'جواب',
      kind: 'intake',
      badges: ['أ', 'ب'],
      memoryNotes: note,
      intakeJobId: job.id,
      documentId: 'doc-1',
      createdAt: at(3).toISOString(),
    });
    expect(typeof third.createdAt).toBe('string');
  });

  it('returns only the newest HISTORY_LIMIT messages, oldest first', async () => {
    const org = newOrg();
    const id = await conversation(org, 'u1', at(0));
    const total = HISTORY_LIMIT + 7;
    await db.message.createMany({
      data: Array.from({ length: total }, (_, i) => ({
        conversationId: id,
        role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
        contentAr: `رسالة ${i}`,
        createdAt: at(i),
      })),
    });

    const history = await loadConversationHistory(db, caller(org, 'u1'), null);
    expect(history?.messages).toHaveLength(HISTORY_LIMIT);
    expect(history?.messages[0].textAr).toBe(`رسالة ${total - HISTORY_LIMIT}`);
    expect(history?.messages[HISTORY_LIMIT - 1].textAr).toBe(`رسالة ${total - 1}`);
  });
});

describe('loadConversationHistory with a requested id', () => {
  it("returns the caller's own conversation, not the latest one", async () => {
    const org = newOrg();
    const mine = await conversation(org, 'u1', at(0));
    await conversation(org, 'u1', at(100));
    await db.message.create({ data: { conversationId: mine, role: 'user', contentAr: 'الأولى' } });

    const history = await loadConversationHistory(db, caller(org, 'u1'), mine);
    expect(history?.conversationId).toBe(mine);
    expect(history?.messages.map((m) => m.textAr)).toEqual(['الأولى']);
  });

  it("is null for another user's conversation in the same organization", async () => {
    const org = newOrg();
    const theirs = await conversation(org, 'u2', at(0));
    expect(await loadConversationHistory(db, caller(org, 'u1'), theirs)).toBeNull();
  });

  it('is null for a conversation of another organization, and for an unknown id', async () => {
    const orgA = newOrg();
    const orgB = newOrg();
    const inB = await conversation(orgB, 'u1', at(0));
    expect(await loadConversationHistory(db, caller(orgA, 'u1'), inB)).toBeNull();
    expect(await loadConversationHistory(db, caller(orgA, 'u1'), `missing-${runId}`)).toBeNull();
  });
});
