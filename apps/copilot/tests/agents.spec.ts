import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { TurnInputError, runTurn, type TurnDb, type TurnDeps, type TurnUser } from '../src/agents/run';
import { t } from '../src/i18n/ar';
import { LlmError, type LlmContext } from '../src/llm/client';
import type { ModelResponse, RedactedMessage, RedactedRequest } from '../src/llm/provider';
import { NpiError } from '../src/npi/errors';
import type { DictionaryEntry } from '../src/privacy/pseudonymizer';
import { clearPromptCache } from '../src/prompts/load';

process.env.COPILOT_PROMPTS_DIR = path.resolve(__dirname, '../prompts');

const CUSTOMER = 'شركة النخيل للمقاولات';
const VAT = '300123456700003';
const TOKEN = /⟦[^⟧]+⟧/g;

const DICTIONARY: DictionaryEntry[] = [
  { kind: 'customer', npiId: 'c1', names: [CUSTOMER] },
  { kind: 'employee', npiId: 'user-1', names: ['سارة القحطاني'] },
];

const USER: TurnUser = {
  npiOrgId: 'org-1',
  npiUserId: 'user-1',
  nameAr: 'سارة القحطاني',
  positionId: 'pos-1',
  positionTitleAr: 'المبيعات',
  personaAr: 'أنت وكيل المبيعات.',
};

// ─── Fakes ──────────────────────────────────────────────────────────────────

interface Row {
  [key: string]: unknown;
  id: string;
}

function createFakeDb(facts: unknown[] = []) {
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}-${(seq += 1)}`;
  const conversations: Row[] = [];
  const messages: Row[] = [];
  const redactions: Row[] = [];
  const usage: Row[] = [];
  const memory: Row[] = [];
  const queryRaw = jest.fn(async () => facts);

  const db = {
    conversation: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        conversations.find((c) => Object.entries(where).every(([k, v]) => c[k] === v)) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: nextId('conv'), ...data };
        conversations.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = conversations.find((c) => c.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
    },
    message: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: nextId('msg'), createdAt: new Date(Date.now() + seq), ...data };
        messages.push(row);
        return row;
      },
      findMany: async ({ where, take }: { where: { conversationId: string; id?: { not: string } }; take: number }) =>
        messages
          .filter((m) => m.conversationId === where.conversationId && m.id !== where.id?.not)
          .slice()
          .reverse()
          .slice(0, take),
    },
    redactionSession: {
      findFirst: async ({ where }: { where: { conversationId: string } }) =>
        redactions.filter((r) => r.conversationId === where.conversationId).slice(-1)[0] ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: nextId('red'), ...data };
        redactions.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = redactions.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
    },
    dailyUsage: {
      upsert: async ({ create }: { create: Record<string, unknown> }) => {
        const row = usage.find((u) => u.npiUserId === create.npiUserId);
        if (row) row.messageCount = (row.messageCount as number) + 1;
        else usage.push({ id: nextId('use'), ...create });
      },
    },
    memoryFact: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        memory.find((m) => m.searchText === where.searchText && m.npiOrgId === where.npiOrgId) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: nextId('fact'), ...data };
        memory.push(row);
        return row;
      },
      update: async () => undefined,
      updateMany: async () => ({ count: 0 }),
    },
    $queryRaw: queryRaw,
  };

  return { db: db as unknown as TurnDb, conversations, messages, redactions, usage, memory, queryRaw };
}

type Script = (req: RedactedRequest, call: number) => ModelResponse | Promise<ModelResponse>;

function answer(text: string): ModelResponse {
  return { text, toolCalls: [], stopReason: 'end_turn', tokensIn: 10, tokensOut: 10, modelId: 'fake' };
}

function toolUse(name: string, input: unknown, id = 'call-1'): ModelResponse {
  return { text: '', toolCalls: [{ id, name, input }], stopReason: 'tool_use', tokensIn: 10, tokensOut: 5, modelId: 'fake' };
}

function createFakeLlm(script: Script) {
  const requests: RedactedRequest[] = [];
  const contexts: LlmContext[] = [];
  return {
    requests,
    contexts,
    complete: jest.fn(async (req: RedactedRequest, ctx: LlmContext) => {
      // Snapshot: run.ts keeps appending to the same messages array.
      requests.push(JSON.parse(JSON.stringify(req)) as RedactedRequest);
      contexts.push(ctx);
      return script(req, requests.length);
    }),
  };
}

function createFakeNpi(overrides: Partial<Record<keyof TurnDeps['npi'], jest.Mock>> = {}) {
  return {
    listCustomers: jest.fn(async () => [
      { id: 'c1', code: 'CUS-00001', nameAr: CUSTOMER, vatNumber: VAT, creditTermsDays: 30, phone: '0551234567' },
    ]),
    listProjects: jest.fn(async () => []),
    inboxTasks: jest.fn(async () => []),
    listPurchaseOrders: jest.fn(async () => []),
    getPurchaseOrder: jest.fn(async () => ({})),
    listItems: jest.fn(async () => []),
    ...overrides,
  };
}

function setup(script: Script, options: { facts?: unknown[]; npi?: ReturnType<typeof createFakeNpi> } = {}) {
  const fake = createFakeDb(options.facts);
  const llm = createFakeLlm(script);
  const npi = options.npi ?? createFakeNpi();
  const deps: TurnDeps = {
    db: fake.db,
    llm,
    npi: npi as unknown as TurnDeps['npi'],
    key: randomBytes(32),
    dictionary: async () => DICTIONARY,
    now: () => new Date('2026-09-27T09:00:00.000Z'),
  };
  return { deps, llm, npi, ...fake };
}

/** Everything that was sent to the model in one request, as one string. */
function outbound(req: RedactedRequest): string {
  return JSON.stringify({ system: req.system, messages: req.messages });
}

function lastUserText(req: RedactedRequest): string {
  const last = [...req.messages].reverse().find((m: RedactedMessage) => m.role === 'user');
  return typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content);
}

beforeEach(() => clearPromptCache());

// ─── Input and ownership ────────────────────────────────────────────────────

describe('runTurn — input', () => {
  it.each([[''], ['   ']])('rejects an empty message %p', async (text) => {
    const { deps, llm, messages } = setup(() => answer('x'));
    await expect(runTurn(deps, USER, { text })).rejects.toMatchObject({ reason: 'empty' });
    expect(llm.complete).not.toHaveBeenCalled();
    expect(messages).toHaveLength(0);
  });

  it('rejects a message over the length limit', async () => {
    const { deps } = setup(() => answer('x'));
    await expect(runTurn(deps, USER, { text: 'ا'.repeat(4001) })).rejects.toBeInstanceOf(TurnInputError);
  });

  it("treats another user's conversation as not found and stores nothing", async () => {
    const { deps, conversations, messages, llm } = setup(() => answer('x'));
    conversations.push({ id: 'conv-x', npiUserId: 'someone-else', npiOrgId: 'org-1' });
    await expect(runTurn(deps, USER, { text: 'مرحبا', conversationId: 'conv-x' })).rejects.toMatchObject({
      reason: 'conversation_not_found',
    });
    expect(messages).toHaveLength(0);
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it("treats another organization's conversation as not found", async () => {
    const { deps, conversations } = setup(() => answer('x'));
    conversations.push({ id: 'conv-y', npiUserId: 'user-1', npiOrgId: 'org-2' });
    await expect(runTurn(deps, USER, { text: 'مرحبا', conversationId: 'conv-y' })).rejects.toMatchObject({
      reason: 'conversation_not_found',
    });
  });
});

// ─── Routes that never reach the model ──────────────────────────────────────

describe('runTurn — no model call', () => {
  it('HR guard: fixed refusal, zero model calls, both messages stored', async () => {
    const { deps, llm, messages, usage, npi } = setup(() => answer('x'));
    const reply = await runTurn(deps, USER, { text: 'مين أكفأ مهندس عندنا؟' });
    expect(reply.kind).toBe('hr_refusal');
    expect(reply.textAr).toBe(t('hr.refusal'));
    expect(llm.complete).not.toHaveBeenCalled();
    expect(npi.listCustomers).not.toHaveBeenCalled();
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(usage[0].messageCount).toBe(1);
  });

  it('an entry request gets the fixed "later milestone" reply with the flow as badge', async () => {
    const { deps, llm } = setup(() => answer('x'));
    const reply = await runTurn(deps, USER, { text: 'أبي 40 لوح 550 واط للمشروع PRJ-00012 قبل الخميس' });
    expect(reply.kind).toBe('flow_pending');
    expect(reply.badges).toEqual([t('flow.pr')]);
    expect(reply.textAr).toContain(t('flow.pr'));
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('a flow switched off for the firm says so', async () => {
    const { deps } = setup(() => answer('x'));
    const reply = await runTurn({ ...deps, visibleFlows: ['customer_contract'] }, USER, {
      text: 'طلب شراء 10 عواكس',
    });
    expect(reply.textAr).toBe(t('chat.flow_unavailable', { flow: t('flow.pr') }));
  });
});

// ─── Chat with tools ────────────────────────────────────────────────────────

describe('runTurn — chat', () => {
  const question = `وش رقم العميل ${CUSTOMER}؟`;

  it('never sends a real name or identifier to the model, and gives the user real values back', async () => {
    const { deps, llm, npi } = setup((req, call) => {
      if (call === 1) {
        const token = lastUserText(req).match(TOKEN)?.[0];
        return toolUse('get_customer', { query: token });
      }
      const result = lastUserText(req);
      const tokens = result.match(TOKEN) ?? [];
      return answer(`العميل ${tokens[0]} رقمه الضريبي ${tokens.find((x) => x.includes('ضريبي'))}`);
    });

    const reply = await runTurn(deps, USER, { text: question });

    // NPI was asked for the real name, not for the placeholder.
    expect(npi.listCustomers).toHaveBeenCalledWith(CUSTOMER);

    for (const req of llm.requests) {
      const sent = outbound(req);
      expect(sent).not.toContain('النخيل');
      expect(sent).not.toContain(VAT);
      expect(sent).not.toContain('0551234567');
      expect(sent).not.toContain('القحطاني');
    }

    expect(reply.kind).toBe('answer');
    expect(reply.textAr).toContain(CUSTOMER);
    expect(reply.textAr).toContain(VAT);
    expect(reply.textAr).not.toMatch(TOKEN);
    expect(reply.badges).toEqual(['العملاء']);
  });

  it('offers the six read tools and nothing else', async () => {
    const { deps, llm } = setup(() => answer('تم'));
    await runTurn(deps, USER, { text: 'مرحبا، كيف الحال' });
    expect(llm.requests[0].tools?.map((tool) => tool.name).sort()).toEqual(
      ['get_customer', 'get_po', 'list_open_tasks', 'list_projects', 'memory_search', 'search_items'].sort(),
    );
    expect(llm.requests[0].tier).toBe('economy');
    expect(llm.requests[0].purpose).toBe('chat');
    expect(llm.contexts[0]).toMatchObject({ npiOrgId: 'org-1', npiUserId: 'user-1' });
  });

  it("hands NPI's refusal to the model as a failed tool result and does not retry", async () => {
    const refusal = new NpiError({ status: 403, kind: 'forbidden', npiMessage: 'Forbidden resource' });
    const npi = createFakeNpi({
      listCustomers: jest.fn(async () => {
        throw refusal;
      }),
    });
    const { deps, llm } = setup(
      (_req, call) => (call === 1 ? toolUse('get_customer', { query: 'x' }) : answer('NPI رفض: ليست لك صلاحية.')),
      { npi },
    );

    const reply = await runTurn(deps, USER, { text: 'وش بيانات العميل؟' });

    const results = llm.requests[1].messages.slice(-1)[0].content as { type: string; isError?: boolean; content: string }[];
    expect(results[0]).toMatchObject({ type: 'tool_result', isError: true });
    expect(results[0].content).toContain('NPI رفض');
    expect(npi.listCustomers).toHaveBeenCalledTimes(1);
    expect(reply.kind).toBe('answer');
  });

  it('answers a call to a tool that does not exist with an error result', async () => {
    const { deps, llm, npi } = setup((_req, call) =>
      call === 1 ? toolUse('approve_requisition', { id: 'pr-1' }) : answer('لا أستطيع الاعتماد؛ الاعتماد من صندوق المهام في NPI.'),
    );
    const reply = await runTurn(deps, USER, { text: 'وش أسوي بالطلب PR-00012' });
    const results = llm.requests[1].messages.slice(-1)[0].content as { isError?: boolean }[];
    expect(results[0].isError).toBe(true);
    for (const mock of Object.values(npi)) expect(mock).not.toHaveBeenCalled();
    expect(reply.badges).toEqual([]);
  });

  it('returns malformed tool input to the model instead of calling NPI', async () => {
    const { deps, llm, npi } = setup((_req, call) => (call === 1 ? toolUse('get_customer', { q: 5 }) : answer('ما الاسم؟')));
    await runTurn(deps, USER, { text: 'وش بيانات العميل' });
    const results = llm.requests[1].messages.slice(-1)[0].content as { isError?: boolean }[];
    expect(results[0].isError).toBe(true);
    expect(npi.listCustomers).not.toHaveBeenCalled();
  });

  it('sends every result of a multi-tool step back in one user message', async () => {
    const { deps, llm } = setup((_req, call) =>
      call === 1
        ? {
            text: '',
            toolCalls: [
              { id: 'a', name: 'list_open_tasks', input: {} },
              { id: 'b', name: 'list_projects', input: {} },
            ],
            stopReason: 'tool_use',
            tokensIn: 1,
            tokensOut: 1,
            modelId: 'fake',
          }
        : answer('لا مهام.'),
    );
    const reply = await runTurn(deps, USER, { text: 'وش عندي اليوم' });
    const second = llm.requests[1].messages;
    expect(second[second.length - 2].role).toBe('assistant');
    const results = second[second.length - 1].content as { toolUseId: string }[];
    expect(results.map((r) => r.toolUseId)).toEqual(['a', 'b']);
    expect(reply.badges).toEqual(['صندوق المهام', 'المشاريع']);
  });

  it('stops after six model calls when the model keeps asking for tools', async () => {
    const { deps, llm } = setup(() => toolUse('list_open_tasks', {}));
    const reply = await runTurn(deps, USER, { text: 'وش المهام اللي تنتظرني' });
    expect(llm.complete).toHaveBeenCalledTimes(6);
    expect(reply.kind).toBe('error');
    expect(reply.textAr).toBe(t('chat.error.generic'));
  });

  it.each([
    ['cap_reached', 'بلغت حد الاستخدام اليومي. يتجدد الحد غداً.'],
    ['not_configured', 'مزوّد النماذج غير مهيّأ. راجع مدير النظام.'],
    ['timeout', 'تأخر الرد أكثر من المهلة. حاول مرة أخرى.'],
  ] as const)('shows the Arabic message of a model failure (%s) and stores it', async (kind, messageAr) => {
    const { deps, messages } = setup(() => {
      throw new LlmError(kind);
    });
    const reply = await runTurn(deps, USER, { text: 'مرحبا، كيف الحال' });
    expect(reply).toMatchObject({ kind: 'error', textAr: messageAr });
    expect(messages.slice(-1)[0]).toMatchObject({ role: 'assistant', contentAr: messageAr });
  });

  it('lets an unexpected failure surface instead of hiding it', async () => {
    const { deps } = setup(() => {
      throw new Error('boom');
    });
    await expect(runTurn(deps, USER, { text: 'مرحبا، كيف الحال' })).rejects.toThrow('boom');
  });
});

// ─── Placeholders across turns, history, memory ─────────────────────────────

describe('runTurn — continuity', () => {
  it('keeps the same placeholder for the same name on the next turn', async () => {
    const { deps, llm, redactions } = setup(() => answer('تم'));
    const first = await runTurn(deps, USER, { text: `ذكّرني بموعد ${CUSTOMER}` });
    await runTurn(deps, USER, { text: `وأيضاً عنوان ${CUSTOMER}`, conversationId: first.conversationId });

    const firstToken = lastUserText(llm.requests[0]).match(TOKEN)?.[0];
    const secondToken = lastUserText(llm.requests[1]).match(TOKEN)?.[0];
    expect(firstToken).toBeDefined();
    expect(secondToken).toBe(firstToken);

    expect(redactions).toHaveLength(1);
    expect(String(redactions[0].mapEncrypted)).not.toContain('النخيل');
    expect(String(redactions[0].mapEncrypted).startsWith('v1.')).toBe(true);
  });

  it('sends the earlier messages of the conversation, redacted, oldest first', async () => {
    const { deps, llm } = setup((_req, call) => answer(call === 1 ? 'الجواب الأول' : 'الجواب الثاني'));
    const first = await runTurn(deps, USER, { text: `السؤال الأول عن ${CUSTOMER}` });
    await runTurn(deps, USER, { text: 'السؤال الثاني', conversationId: first.conversationId });

    const sent = llm.requests[1].messages;
    expect(sent.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(String(sent[0].content)).toContain('السؤال الأول');
    expect(String(sent[0].content)).not.toContain('النخيل');
    expect(sent[2].content).toBe('السؤال الثاني');
  });

  it('puts remembered facts in the prompt, redacted, and shows them as notes when the answer draws on memory', async () => {
    const fact = {
      id: 'fact-1',
      factAr: `شروط سداد ${CUSTOMER} 30 يوماً`,
      scope: 'company',
      entityType: 'customer',
      npiEntityId: 'c1',
      valueJson: null,
      sourceType: 'npi',
      confidence: 1,
      score: 1.4,
    };
    const { deps, llm } = setup(() => answer('ملاحظة من الذاكرة: شروط السداد 30 يوماً.'), { facts: [fact] });

    const reply = await runTurn(deps, USER, { text: 'وش شروط السداد المعتادة؟' });

    expect(llm.requests[0].system).toContain('30 يوماً');
    expect(llm.requests[0].system).not.toContain('النخيل');
    expect(reply.memoryNotes).toEqual([{ id: 'fact-1', factAr: fact.factAr, sourceType: 'npi' }]);
  });

  it('does not show a memory note when the answer did not draw on memory', async () => {
    const fact = {
      id: 'fact-1',
      factAr: 'شروط السداد 30 يوماً',
      scope: 'company',
      entityType: 'customer',
      npiEntityId: null,
      valueJson: null,
      sourceType: 'chat',
      confidence: 1,
      score: 1.4,
    };
    const { deps } = setup(() => answer('لا توجد مهام مفتوحة.'), { facts: [fact] });
    const reply = await runTurn(deps, USER, { text: 'وش المهام اللي تنتظرني؟' });
    expect(reply.memoryNotes).toEqual([]);
  });

  it('includes the position and the user name only in redacted form', async () => {
    const { deps, llm } = setup(() => answer('تم'));
    await runTurn(deps, USER, { text: 'مرحبا، كيف الحال' });
    expect(llm.requests[0].system).toContain('## Position');
    expect(llm.requests[0].system).toContain('أنت وكيل المبيعات.');
    expect(llm.requests[0].system).not.toContain('سارة');
  });
});

// ─── Learning from the chat ─────────────────────────────────────────────────

describe('runTurn — learning', () => {
  const memorable = `للعلم، ${CUSTOMER} يدفعون دائماً خلال 45 يوماً من الفاتورة`;

  it('stores a fact stated in the chat with the real name, after the answer', async () => {
    const { deps, llm, memory } = setup((req) => {
      if (req.purpose === 'memory_extract') {
        const token = lastUserText(req).match(TOKEN)?.[0];
        return answer(
          JSON.stringify({
            facts: [{ factAr: `${token} يدفعون خلال 45 يوماً`, entityType: 'customer', scope: 'company', confidence: 0.95 }],
          }),
        );
      }
      return answer('سجّلت ذلك.');
    });

    const reply = await runTurn(deps, USER, { text: memorable });

    expect(reply.kind).toBe('answer');
    expect(llm.requests.map((r) => r.purpose)).toEqual(['chat', 'memory_extract']);
    expect(outbound(llm.requests[1])).not.toContain('النخيل');
    expect(memory).toHaveLength(1);
    expect(memory[0]).toMatchObject({
      factAr: `${CUSTOMER} يدفعون خلال 45 يوماً`,
      sourceType: 'chat',
      scope: 'company',
      npiOrgId: 'org-1',
    });
  });

  it('does not spend a model call on a message that states nothing lasting', async () => {
    const { deps, llm } = setup(() => answer('تم'));
    await runTurn(deps, USER, { text: 'مرحبا، كيف الحال اليوم' });
    expect(llm.requests.map((r) => r.purpose)).toEqual(['chat']);
  });

  it.each([
    ['low confidence', { facts: [{ factAr: 'يدفعون خلال 45 يوماً', entityType: 'customer', scope: 'company', confidence: 0.4 }] }],
    ['about an employee', { facts: [{ factAr: 'أفضل مهندس في الفريق هو خالد', entityType: 'position', scope: 'company', confidence: 0.99 }] }],
    ['wrong shape', { facts: 'none' }],
  ])('stores nothing for an extraction that is %s', async (_label, payload) => {
    const { deps, memory } = setup((req) =>
      req.purpose === 'memory_extract' ? answer(JSON.stringify(payload)) : answer('تم'),
    );
    const reply = await runTurn(deps, USER, { text: memorable });
    expect(reply.kind).toBe('answer');
    expect(memory).toHaveLength(0);
  });

  it('keeps the answer when learning fails', async () => {
    const { deps } = setup((req) => {
      if (req.purpose === 'memory_extract') throw new LlmError('timeout');
      return answer('تم');
    });
    await expect(runTurn(deps, USER, { text: memorable })).resolves.toMatchObject({ kind: 'answer', textAr: 'تم' });
  });
});
