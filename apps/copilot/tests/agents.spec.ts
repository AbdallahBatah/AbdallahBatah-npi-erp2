import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { TurnInputError, runTurn, type TurnDb, type TurnDeps, type TurnUser } from '../src/agents/run';
import type { StartIntakeOutcome } from '../src/intake/job';
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
  permissions: ['scm.requisition.write', 'commercial.contract.write'],
  orgNameAr: 'شركة الطاقة الوطنية والصناعية',
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
  const documents: Row[] = [];
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
    document: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        documents.find((d) => Object.entries(where).every(([k, v]) => d[k] === v)) ?? null,
    },
    $queryRaw: queryRaw,
  };

  return { db: db as unknown as TurnDb, conversations, messages, redactions, usage, memory, documents, queryRaw };
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
    listContracts: jest.fn(async () => []),
    getContract: jest.fn(async () => ({})),
    financeSummary: jest.fn(async () => ({})),
    crmDashboard: jest.fn(async () => ({})),
    permissionCatalog: jest.fn(async () => []),
    getUserPermissions: jest.fn(async () => ({})),
    listDepartmentDirectory: jest.fn(async () => []),
    ...overrides,
  };
}

const INTAKE_READY: StartIntakeOutcome = { ok: true, jobId: 'job-1', status: 'preview', failureAr: null };

function setup(
  script: Script,
  options: { facts?: unknown[]; npi?: ReturnType<typeof createFakeNpi>; intake?: StartIntakeOutcome } = {},
) {
  const fake = createFakeDb(options.facts);
  const llm = createFakeLlm(script);
  const npi = options.npi ?? createFakeNpi();
  const intakeStart = jest.fn(async (..._args: Parameters<TurnDeps['intake']['start']>) => options.intake ?? INTAKE_READY);
  const deps: TurnDeps = {
    db: fake.db,
    llm,
    npi: npi as unknown as TurnDeps['npi'],
    key: randomBytes(32),
    dictionary: async () => DICTIONARY,
    intake: { start: intakeStart },
    now: () => new Date('2026-09-27T09:00:00.000Z'),
  };
  return { deps, llm, npi, intakeStart, ...fake };
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
    // The kind is stored, so the refusal still reads as one after a reload.
    expect(messages.map((m) => m.kind)).toEqual([undefined, 'hr_refusal']);
    expect(usage[0].messageCount).toBe(1);
  });

  it('a flow switched off for the firm says so', async () => {
    const { deps } = setup(() => answer('x'));
    const reply = await runTurn({ ...deps, visibleFlows: ['customer_contract'] }, USER, {
      text: 'طلب شراء 10 عواكس',
    });
    expect(reply.textAr).toBe(t('chat.flow_unavailable', { flow: t('flow.pr') }));
  });
});

// ─── Intake flows (T-26) ────────────────────────────────────────────────────

describe('runTurn — intake flows', () => {
  const PR_SENTENCE = 'طلب شراء: 40 لوح 550 واط للمشروع PRJ-00012';
  const CALLER = { npiOrgId: 'org-1', npiUserId: 'user-1' };
  const DOC = { id: 'doc-1', npiOrgId: 'org-1', npiUserId: 'user-1', fileName: 'اشعار-تسليم.jpg' };

  it('a flow sentence from a user who may write requisitions starts an intake; the turn itself calls no model', async () => {
    const { deps, llm, intakeStart, messages, usage } = setup(() => answer('x'));
    const reply = await runTurn(deps, USER, { text: PR_SENTENCE });

    expect(llm.complete).not.toHaveBeenCalled();
    expect(intakeStart).toHaveBeenCalledTimes(1);
    expect(intakeStart).toHaveBeenCalledWith(
      expect.objectContaining(CALLER),
      expect.objectContaining({ flow: 'pr', text: PR_SENTENCE, documentId: null, conversationId: reply.conversationId }),
    );
    expect(intakeStart.mock.calls[0][1].ourPartyNameAr).toBe('شركة الطاقة الوطنية والصناعية');

    expect(reply).toMatchObject({
      kind: 'intake',
      intakeJobId: 'job-1',
      textAr: t('chat.intake_ready', { flow: t('flow.pr') }),
      badges: [t('flow.pr')],
    });
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[1]).toMatchObject({ kind: 'intake', intakeJobId: 'job-1', contentAr: reply.textAr });
    expect(messages[0].contentAr).toBe(PR_SENTENCE);
    expect(usage[0].messageCount).toBe(1);
  });

  it('a question that only mentions a requisition is still chat, not an intake', async () => {
    const { deps, intakeStart, llm } = setup(() => answer('تم'));
    const reply = await runTurn(deps, USER, { text: 'وش حالة طلب الشراء PR-00012؟' });
    expect(intakeStart).not.toHaveBeenCalled();
    expect(llm.complete).toHaveBeenCalled();
    expect(reply.kind).toBe('answer');
  });

  it('without the permission of the flow: an Arabic refusal, no intake, no model call, no job', async () => {
    const { deps, llm, intakeStart, messages } = setup(() => answer('x'));
    const reply = await runTurn(deps, { ...USER, permissions: ['inbox.read'] }, { text: PR_SENTENCE });

    expect(reply.kind).toBe('error');
    expect(reply.textAr).toBe(t('intake.forbidden', { flow: 'طلب شراء' }));
    expect(reply.intakeJobId).toBeUndefined();
    expect(intakeStart).not.toHaveBeenCalled();
    expect(llm.complete).not.toHaveBeenCalled();
    expect(messages[1]).toMatchObject({ kind: 'error', contentAr: reply.textAr });
    expect(messages[1].intakeJobId).toBeUndefined();
  });

  it('each flow asks for its own permission', async () => {
    // A requisition writer may not enter a vendor bill.
    const { deps, intakeStart } = setup(() => answer('x'));
    const reply = await runTurn(deps, { ...USER, permissions: ['scm.requisition.write'] }, {
      text: 'سجّل فاتورة المورد INV-2026-0912 بمبلغ 24,679',
    });
    expect(reply.textAr).toBe(t('intake.forbidden', { flow: t('flow.vendor_bill') }));
    expect(intakeStart).not.toHaveBeenCalled();
  });

  it('an attachment with no text asks which kind of document it is, and remembers the document', async () => {
    const { deps, llm, intakeStart, messages, documents } = setup(() => answer('x'));
    documents.push(DOC);
    const reply = await runTurn(deps, USER, { text: '', documentId: 'doc-1' });

    expect(reply.kind).toBe('choose_flow');
    expect(reply.documentId).toBe('doc-1');
    expect(reply.textAr).toBe(t('flow.unknown'));
    expect(intakeStart).not.toHaveBeenCalled();
    expect(llm.complete).not.toHaveBeenCalled();

    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[0]).toMatchObject({ contentAr: t('chat.attached', { name: 'اشعار-تسليم.jpg' }), documentId: 'doc-1' });
    expect(messages[1]).toMatchObject({ kind: 'choose_flow', documentId: 'doc-1' });
  });

  it('the text typed with the attachment is stored after the attachment line', async () => {
    const { deps, messages, documents } = setup(() => answer('x'));
    documents.push(DOC);
    await runTurn(deps, USER, { text: 'ملاحظة عن الشحنة', documentId: 'doc-1' });
    expect(messages[0].contentAr).toBe(`${t('chat.attached', { name: 'اشعار-تسليم.jpg' })}\nملاحظة عن الشحنة`);
  });

  it('a chip press starts the intake of that flow on the document', async () => {
    const { deps, intakeStart, messages, documents, llm } = setup(() => answer('x'));
    documents.push(DOC);
    const reply = await runTurn(deps, USER, { text: '', documentId: 'doc-1', forcedFlow: 'customer_contract' });

    expect(intakeStart).toHaveBeenCalledWith(
      expect.objectContaining(CALLER),
      expect.objectContaining({ flow: 'customer_contract', text: null, documentId: 'doc-1', conversationId: reply.conversationId }),
    );
    expect(reply).toMatchObject({ kind: 'intake', intakeJobId: 'job-1', badges: [t('flow.customer_contract')] });
    expect(messages[0].documentId).toBe('doc-1');
    expect(messages[1]).toMatchObject({ kind: 'intake', intakeJobId: 'job-1', documentId: 'doc-1' });
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('the permission check applies to a chip press too', async () => {
    const { deps, intakeStart, documents } = setup(() => answer('x'));
    documents.push(DOC);
    const reply = await runTurn(deps, { ...USER, permissions: ['scm.requisition.write'] }, { text: '', documentId: 'doc-1', forcedFlow: 'customer_contract' });
    expect(reply.kind).toBe('error');
    expect(reply.textAr).toBe(t('intake.forbidden', { flow: t('flow.customer_contract') }));
    expect(intakeStart).not.toHaveBeenCalled();
  });

  it('a document that is not the user’s does not exist: nothing is stored, nothing starts', async () => {
    const { deps, intakeStart, messages, documents, llm } = setup(() => answer('x'));
    documents.push({ ...DOC, npiUserId: 'someone-else' });
    await expect(runTurn(deps, USER, { text: '', documentId: 'doc-1' })).rejects.toMatchObject({ reason: 'document_not_found' });
    await expect(runTurn(deps, USER, { text: '', documentId: 'doc-404' })).rejects.toBeInstanceOf(TurnInputError);
    expect(messages).toHaveLength(0);
    expect(intakeStart).not.toHaveBeenCalled();
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('a firm that switched the module off gets the unavailable message, not an intake', async () => {
    const { deps, intakeStart } = setup(() => answer('x'));
    const reply = await runTurn({ ...deps, visibleFlows: ['pr'] }, USER, { text: 'عقد جديد مع شركة النخيل للمقاولات بقيمة 850,000' });
    expect(reply.textAr).toBe(t('chat.flow_unavailable', { flow: t('flow.customer_contract') }));
    expect(reply.intakeJobId).toBeUndefined();
    expect(intakeStart).not.toHaveBeenCalled();
  });

  it('shows the intake’s own refusal (consent) as an error reply with no job', async () => {
    const { deps, messages, documents } = setup(() => answer('x'), {
      intake: { ok: false, reason: 'consent_required', messageAr: t('intake.consent_required') },
    });
    documents.push(DOC);
    const reply = await runTurn(deps, USER, { text: '', documentId: 'doc-1', forcedFlow: 'pr' });

    expect(reply.kind).toBe('error');
    expect(reply.textAr).toBe(t('intake.consent_required'));
    expect(reply.intakeJobId).toBeUndefined();
    expect(messages[1]).toMatchObject({ kind: 'error', contentAr: t('intake.consent_required') });
    expect(messages[1].intakeJobId).toBeUndefined();
  });

  it('a read that failed is still an intake reply, carrying the reason, so the card can show it', async () => {
    const { deps, messages } = setup(() => answer('x'), {
      intake: { ok: true, jobId: 'job-9', status: 'failed', failureAr: t('extract.failed.model_error') },
    });
    const reply = await runTurn(deps, USER, { text: PR_SENTENCE });
    expect(reply).toMatchObject({
      kind: 'intake',
      intakeJobId: 'job-9',
      textAr: t('chat.intake_failed', { flow: t('flow.pr'), reason: t('extract.failed.model_error') }),
    });
    expect(messages[1]).toMatchObject({ kind: 'intake', intakeJobId: 'job-9' });
  });

  it('an HR question is refused before any intake is considered', async () => {
    const { deps, intakeStart } = setup(() => answer('x'));
    const reply = await runTurn(deps, USER, { text: 'مين أكفأ مهندس عندنا؟' });
    expect(reply.kind).toBe('hr_refusal');
    expect(intakeStart).not.toHaveBeenCalled();
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

  it('offers the nine read tools and nothing else', async () => {
    const { deps, llm } = setup(() => answer('تم'));
    await runTurn(deps, USER, { text: 'مرحبا، كيف الحال' });
    expect(llm.requests[0].tools?.map((tool) => tool.name).sort()).toEqual(
      [
        'finance_summary',
        'get_contract',
        'get_customer',
        'get_po',
        'get_user_permissions',
        'list_open_tasks',
        'list_projects',
        'memory_search',
        'search_items',
      ].sort(),
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

  it('carries the handover excerpt, redacted, when the guidance window is open (T-30)', async () => {
    const { deps, llm } = setup(() => answer('تم'));
    const handoverAr = `استلم هذا الموظف منصب المبيعات في 2026-09-27 خلفاً لـ سارة القحطاني.\nالموردون: ${CUSTOMER}`;
    await runTurn(deps, { ...USER, handoverAr }, { text: 'مرحبا' });
    const system = llm.requests[0].system;
    // assistant.md describes the section under the same heading; the data
    // section is the second occurrence.
    expect(system.split('## Handover')).toHaveLength(3);
    expect(system).toContain('استلم هذا الموظف منصب المبيعات في 2026-09-27');
    expect(system).not.toContain('سارة القحطاني');
    expect(system).not.toContain(CUSTOMER);
  });

  it('has no handover section when the user has no recent handover', async () => {
    const { deps, llm } = setup(() => answer('تم'));
    await runTurn(deps, { ...USER, handoverAr: null }, { text: 'مرحبا' });
    expect(llm.requests[0].system.split('## Handover')).toHaveLength(2);
    expect(llm.requests[0].system).not.toContain('استلم هذا الموظف');
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

// Added in review.
describe('runTurn — history that a failed turn left uneven', () => {
  it('never starts the history with an assistant message and never replays an error reply', async () => {
    const { deps, llm, conversations, messages } = setup(() => answer('تم'));
    conversations.push({ id: 'conv-h', npiUserId: 'user-1', npiOrgId: 'org-1' });
    const at = (n: number) => new Date(Date.UTC(2026, 8, 27, 8, 0, n));
    messages.push(
      { id: 'h1', conversationId: 'conv-h', role: 'assistant', contentAr: 'رد بلا سؤال قبله', kind: 'answer', createdAt: at(1) },
      { id: 'h2', conversationId: 'conv-h', role: 'user', contentAr: 'سؤال قديم', createdAt: at(2) },
      { id: 'h3', conversationId: 'conv-h', role: 'assistant', contentAr: 'مزوّد النماذج غير مهيّأ. راجع مدير النظام.', kind: 'error', createdAt: at(3) },
      { id: 'h4', conversationId: 'conv-h', role: 'user', contentAr: 'سؤال ثانٍ', createdAt: at(4) },
      { id: 'h5', conversationId: 'conv-h', role: 'assistant', contentAr: 'جواب ثانٍ', kind: 'answer', createdAt: at(5) },
    );

    await runTurn(deps, USER, { text: 'مرحبا، كيف الحال', conversationId: 'conv-h' });

    const sent = llm.requests[0].messages;
    expect(sent[0].role).toBe('user');
    expect(sent.map((m) => m.content)).toEqual(['سؤال قديم', 'سؤال ثانٍ', 'جواب ثانٍ', 'مرحبا، كيف الحال']);
  });
});

describe('runTurn — a name that reached the user through a tool', () => {
  it('is masked again when the stored answer is sent as history on the next turn', async () => {
    const npi = createFakeNpi({
      listPurchaseOrders: jest.fn(async () => [{ id: 'po-1', code: 'PO-00042' }]),
      getPurchaseOrder: jest.fn(async () => ({
        id: 'po-1',
        code: 'PO-00042',
        status: 'SENT',
        vendor: { nameAr: 'الفجر للتوريدات' },
        lines: [],
        goodsReceipts: [],
        vendorBills: [],
      })),
    });
    const fake = createFakeDb();
    const llm = createFakeLlm((req, call) => {
      if (call === 1) return toolUse('get_po', { code: 'PO-00042' });
      if (call === 2) return answer(`المورد ${lastUserText(req).match(TOKEN)?.[0]} لم يسلّم بعد`);
      return answer('تم');
    });
    const deps: TurnDeps = {
      db: fake.db,
      llm,
      npi: npi as unknown as TurnDeps['npi'],
      key: randomBytes(32),
      // Nobody could read the vendor list: the dictionary does not know it.
      dictionary: async () => [],
      intake: { start: async () => INTAKE_READY },
      now: () => new Date('2026-09-27T09:00:00.000Z'),
    };

    const first = await runTurn(deps, USER, { text: 'وش حالة أمر الشراء PO-00042' });
    expect(first.textAr).toBe('المورد الفجر للتوريدات لم يسلّم بعد');

    await runTurn(deps, USER, { text: 'وهل اتصلتوا على الفجر للتوريدات', conversationId: first.conversationId });

    for (const req of llm.requests) expect(outbound(req)).not.toContain('الفجر');
  });
});
