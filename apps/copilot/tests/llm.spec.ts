import Anthropic from '@anthropic-ai/sdk';
import { createLlmClient, LlmError, type LlmAuditData, type LlmContext, type LlmDb } from '../src/llm/client';
import type { ModelProvider, ModelResponse, ProviderCall, RedactedRequest } from '../src/llm/provider';
import { createAnthropicProvider, type AnthropicLike } from '../src/llm/providers/anthropic';
import { staticPrompt, type RedactedText } from '../src/privacy/pseudonymizer';

function makeRequest(overrides: Partial<RedactedRequest> = {}): RedactedRequest {
  return {
    tier: 'economy',
    purpose: 'chat',
    system: staticPrompt('system prompt'),
    messages: [{ role: 'user', content: staticPrompt('hello') }],
    ...overrides,
  };
}

function makeCtx(overrides: Partial<LlmContext> = {}): LlmContext {
  return { npiOrgId: 'org-1', npiUserId: 'user-1', ...overrides };
}

function okResponse(overrides: Partial<ModelResponse> = {}): ModelResponse {
  return {
    text: 'hello back',
    toolCalls: [],
    stopReason: 'end_turn',
    tokensIn: 10,
    tokensOut: 20,
    modelId: 'claude-haiku-4-5-20251001',
    ...overrides,
  };
}

class FakeProvider implements ModelProvider {
  readonly name = 'anthropic' as const;
  calls: ProviderCall[] = [];
  constructor(private impl: (call: ProviderCall) => Promise<ModelResponse> | ModelResponse) {}
  async complete(call: ProviderCall): Promise<ModelResponse> {
    this.calls.push(call);
    return this.impl(call);
  }
}

interface UsageRow {
  npiOrgId: string;
  npiUserId: string;
  day: Date;
  tokensIn: number;
  tokensOut: number;
  costUsdMicro: bigint;
  messageCount: number;
}

class FakeDb implements LlmDb {
  auditRows: LlmAuditData[] = [];
  usage = new Map<string, UsageRow>();
  auditShouldThrow: Error | null = null;

  private key(npiUserId: string, day: Date): string {
    return `${npiUserId}::${day.toISOString()}`;
  }

  llmAudit = {
    create: async (args: { data: LlmAuditData }) => {
      if (this.auditShouldThrow) throw this.auditShouldThrow;
      this.auditRows.push(args.data);
      return args.data;
    },
  };

  dailyUsage = {
    findUnique: async (args: { where: { npiUserId_day: { npiUserId: string; day: Date } } }) => {
      const row = this.usage.get(this.key(args.where.npiUserId_day.npiUserId, args.where.npiUserId_day.day));
      return row ? { ...row } : null;
    },
    upsert: async (args: {
      where: { npiUserId_day: { npiUserId: string; day: Date } };
      create: UsageRow;
      update: {
        tokensIn?: { increment: number };
        tokensOut?: { increment: number };
        costUsdMicro?: { increment: bigint };
      };
    }) => {
      const key = this.key(args.where.npiUserId_day.npiUserId, args.where.npiUserId_day.day);
      const existing = this.usage.get(key);
      if (existing) {
        const upd = args.update;
        if (upd.tokensIn) existing.tokensIn += upd.tokensIn.increment;
        if (upd.tokensOut) existing.tokensOut += upd.tokensOut.increment;
        if (upd.costUsdMicro) existing.costUsdMicro += upd.costUsdMicro.increment;
      } else {
        this.usage.set(key, { ...args.create });
      }
      return this.usage.get(key);
    },
  };

  seedUsage(row: UsageRow): void {
    this.usage.set(this.key(row.npiUserId, row.day), row);
  }
}

describe('createLlmClient: tier -> model id and timeout', () => {
  it('uses the default economy model and a 20s timeout', async () => {
    const provider = new FakeProvider(() => okResponse());
    const db = new FakeDb();
    const client = createLlmClient({ provider, db, env: {} as NodeJS.ProcessEnv });
    await client.complete(makeRequest({ tier: 'economy' }), makeCtx());
    expect(provider.calls[0].modelId).toBe('claude-haiku-4-5-20251001');
    expect(provider.calls[0].timeoutMs).toBe(20_000);
  });

  it('uses the default advanced model and a 60s timeout', async () => {
    const provider = new FakeProvider(() => okResponse());
    const db = new FakeDb();
    const client = createLlmClient({ provider, db, env: {} as NodeJS.ProcessEnv });
    await client.complete(makeRequest({ tier: 'advanced' }), makeCtx());
    expect(provider.calls[0].modelId).toBe('claude-sonnet-5');
    expect(provider.calls[0].timeoutMs).toBe(60_000);
  });

  it('honors COPILOT_MODEL_ECONOMY / COPILOT_MODEL_ADVANCED overrides', async () => {
    const provider = new FakeProvider(() => okResponse());
    const db = new FakeDb();
    // Overrides must still be model ids present in config/pricing.json, since
    // the resolved tier model id is also what cost accounting looks up.
    const env = {
      COPILOT_MODEL_ECONOMY: 'claude-sonnet-5',
      COPILOT_MODEL_ADVANCED: 'claude-haiku-4-5-20251001',
    } as unknown as NodeJS.ProcessEnv;
    const client = createLlmClient({ provider, db, env });
    await client.complete(makeRequest({ tier: 'economy' }), makeCtx());
    await client.complete(makeRequest({ tier: 'advanced' }), makeCtx());
    expect(provider.calls[0].modelId).toBe('claude-sonnet-5');
    expect(provider.calls[1].modelId).toBe('claude-haiku-4-5-20251001');
  });
});

describe('createLlmClient: provider allow-list', () => {
  it('rejects MADAR_PROVIDER=openai with zero provider calls', async () => {
    const provider = new FakeProvider(() => okResponse());
    const db = new FakeDb();
    const env = { MADAR_PROVIDER: 'openai' } as unknown as NodeJS.ProcessEnv;
    const client = createLlmClient({ provider, db, env });
    await expect(client.complete(makeRequest(), makeCtx())).rejects.toMatchObject({ kind: 'not_configured' });
    expect(provider.calls).toHaveLength(0);
  });

  it('accepts MADAR_PROVIDER=anthropic explicitly', async () => {
    const provider = new FakeProvider(() => okResponse());
    const db = new FakeDb();
    const env = { MADAR_PROVIDER: 'anthropic' } as unknown as NodeJS.ProcessEnv;
    const client = createLlmClient({ provider, db, env });
    await expect(client.complete(makeRequest(), makeCtx())).resolves.toBeDefined();
    expect(provider.calls).toHaveLength(1);
  });
});

describe('createLlmClient: daily cap', () => {
  const day = new Date('2026-01-01T00:00:00.000Z');

  it('blocks with zero provider calls and a cap_reached audit row when already at the cap', async () => {
    const provider = new FakeProvider(() => okResponse());
    const db = new FakeDb();
    db.seedUsage({
      npiOrgId: 'org-1',
      npiUserId: 'user-1',
      day,
      tokensIn: 600_000,
      tokensOut: 0,
      costUsdMicro: 0n,
      messageCount: 5,
    });
    const client = createLlmClient({
      provider,
      db,
      env: {} as NodeJS.ProcessEnv,
      now: () => new Date('2026-01-01T10:00:00.000Z'),
    });
    await expect(client.complete(makeRequest(), makeCtx())).rejects.toMatchObject({ kind: 'cap_reached' });
    expect(provider.calls).toHaveLength(0);
    expect(db.auditRows).toHaveLength(1);
    expect(db.auditRows[0].event).toBe('cap_reached');
    expect(db.auditRows[0].modelId).toBeNull();
    expect(db.auditRows[0].tokensIn).toBe(0);
    expect(db.auditRows[0].tokensOut).toBe(0);
  });

  it('passes when one token below the cap', async () => {
    const provider = new FakeProvider(() => okResponse());
    const db = new FakeDb();
    db.seedUsage({
      npiOrgId: 'org-1',
      npiUserId: 'user-1',
      day,
      tokensIn: 599_999,
      tokensOut: 0,
      costUsdMicro: 0n,
      messageCount: 5,
    });
    const client = createLlmClient({
      provider,
      db,
      env: {} as NodeJS.ProcessEnv,
      now: () => new Date('2026-01-01T10:00:00.000Z'),
    });
    await expect(client.complete(makeRequest(), makeCtx())).resolves.toBeDefined();
    expect(provider.calls).toHaveLength(1);
  });

  it('honors a COPILOT_DAILY_TOKEN_CAP override', async () => {
    const provider = new FakeProvider(() => okResponse());
    const db = new FakeDb();
    db.seedUsage({
      npiOrgId: 'org-1',
      npiUserId: 'user-1',
      day,
      tokensIn: 100,
      tokensOut: 0,
      costUsdMicro: 0n,
      messageCount: 1,
    });
    const env = { COPILOT_DAILY_TOKEN_CAP: '100' } as unknown as NodeJS.ProcessEnv;
    const client = createLlmClient({ provider, db, env, now: () => new Date('2026-01-01T10:00:00.000Z') });
    await expect(client.complete(makeRequest(), makeCtx())).rejects.toMatchObject({ kind: 'cap_reached' });
  });
});

describe('createLlmClient: success path', () => {
  it('writes exactly one audit row with the exact outbound JSON and updates usage', async () => {
    const provider = new FakeProvider(() => okResponse({ tokensIn: 100, tokensOut: 200 }));
    const db = new FakeDb();
    const req = makeRequest({ purpose: 'router' });
    const client = createLlmClient({
      provider,
      db,
      env: {} as NodeJS.ProcessEnv,
      now: () => new Date('2026-01-01T10:00:00.000Z'),
    });
    await client.complete(req, makeCtx());

    expect(db.auditRows).toHaveLength(1);
    const row = db.auditRows[0];
    expect(row.event).toBe('router');
    expect(row.modelId).toBe('claude-haiku-4-5-20251001');
    expect(row.tokensIn).toBe(100);
    expect(row.tokensOut).toBe(200);
    expect(row.outboundRedactedText).toBe(JSON.stringify({ system: req.system, messages: req.messages }));

    const usageKey = [...db.usage.keys()][0];
    const usageRow = db.usage.get(usageKey)!;
    expect(usageRow.tokensIn).toBe(100);
    expect(usageRow.tokensOut).toBe(200);
    expect(usageRow.messageCount).toBe(0);
  });

  it('adds to (rather than replaces) an existing daily_usage row', async () => {
    const provider = new FakeProvider(() => okResponse({ tokensIn: 50, tokensOut: 50 }));
    const db = new FakeDb();
    const day = new Date('2026-01-01T00:00:00.000Z');
    db.seedUsage({
      npiOrgId: 'org-1',
      npiUserId: 'user-1',
      day,
      tokensIn: 10,
      tokensOut: 10,
      costUsdMicro: 5n,
      messageCount: 3,
    });
    const client = createLlmClient({
      provider,
      db,
      env: {} as NodeJS.ProcessEnv,
      now: () => new Date('2026-01-01T10:00:00.000Z'),
    });
    await client.complete(makeRequest(), makeCtx());
    const row = [...db.usage.values()][0];
    expect(row.tokensIn).toBe(60);
    expect(row.tokensOut).toBe(60);
    expect(row.messageCount).toBe(3); // untouched
  });

  it('computes cost as an exact bigint (integer arithmetic, no float drift)', async () => {
    const provider = new FakeProvider(() =>
      okResponse({ tokensIn: 1500, tokensOut: 2000, modelId: 'claude-sonnet-5' }),
    );
    const db = new FakeDb();
    const client = createLlmClient({ provider, db, env: {} as NodeJS.ProcessEnv });
    await client.complete(makeRequest({ tier: 'advanced' }), makeCtx());
    // claude-sonnet-5: $2/MTok in, $10/MTok out => micro-USD per token == price.
    // 1500*2 + 2000*10 = 3000 + 20000 = 23000 micro-USD, exactly.
    expect(db.auditRows[0].costUsdMicro).toBe(23_000n);
    expect(typeof db.auditRows[0].costUsdMicro).toBe('bigint');
  });

  it('refuses a model with no configured price before anything is sent', async () => {
    const complete = jest.fn(() => okResponse({ modelId: 'not-a-real-model' }));
    const provider = new FakeProvider(complete);
    const db = new FakeDb();
    const env = { COPILOT_MODEL_ECONOMY: 'not-a-real-model' } as unknown as NodeJS.ProcessEnv;
    const client = createLlmClient({ provider, db, env });
    await expect(client.complete(makeRequest(), makeCtx())).rejects.toMatchObject({ kind: 'not_configured' });
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('createLlmClient: refusal', () => {
  it('audits and counts a refusal, then throws LlmError("refused")', async () => {
    const provider = new FakeProvider(() =>
      okResponse({ stopReason: 'refusal', tokensIn: 5, tokensOut: 1 }),
    );
    const db = new FakeDb();
    const client = createLlmClient({ provider, db, env: {} as NodeJS.ProcessEnv });
    await expect(client.complete(makeRequest(), makeCtx())).rejects.toMatchObject({
      kind: 'refused',
      messageAr: 'لا أستطيع المساعدة في هذا الطلب.',
    });
    expect(db.auditRows).toHaveLength(1);
    expect(db.auditRows[0].tokensIn).toBe(5);
    expect(db.auditRows[0].tokensOut).toBe(1);
    const usageRow = [...db.usage.values()][0];
    expect(usageRow.tokensIn).toBe(5);
  });
});

describe('createLlmClient: provider failure kinds', () => {
  const kinds: Array<[import('../src/llm/client').LlmErrorKind, string]> = [
    ['timeout', 'تأخر الرد أكثر من المهلة. حاول مرة أخرى.'],
    ['rate_limited', 'الطلبات كثيرة الآن. حاول بعد قليل.'],
    ['network', 'تعذر الوصول إلى مزوّد النماذج.'],
    ['provider_down', 'مزوّد النماذج غير متاح حالياً.'],
    ['bad_request', 'تعذر تنفيذ الطلب.'],
    ['not_configured', 'مزوّد النماذج غير مهيّأ. راجع مدير النظام.'],
  ];

  it.each(kinds)('audits and rethrows a %s provider error', async (kind, messageAr) => {
    const provider = new FakeProvider(() => {
      throw new LlmError(kind);
    });
    const db = new FakeDb();
    const client = createLlmClient({ provider, db, env: {} as NodeJS.ProcessEnv });
    await expect(client.complete(makeRequest(), makeCtx())).rejects.toMatchObject({ kind, messageAr });
    expect(db.auditRows).toHaveLength(1);
    expect(db.auditRows[0].error).toBe(kind);
    expect(db.auditRows[0].tokensIn).toBe(0);
    expect(db.auditRows[0].tokensOut).toBe(0);
    // What left the building is logged even when the provider then failed;
    // `not_configured` is raised before anything is sent.
    const req = makeRequest();
    expect(db.auditRows[0].outboundRedactedText).toBe(
      kind === 'not_configured' ? null : JSON.stringify({ system: req.system, messages: req.messages }),
    );
  });
});

describe('createLlmClient: audit failure propagates', () => {
  it('fails the call when the audit insert throws after a successful provider call', async () => {
    const provider = new FakeProvider(() => okResponse());
    const db = new FakeDb();
    db.auditShouldThrow = new Error('db is down');
    const client = createLlmClient({ provider, db, env: {} as NodeJS.ProcessEnv });
    await expect(client.complete(makeRequest(), makeCtx())).rejects.toThrow('db is down');
    // No usage should have been recorded since the audit write is the last
    // step before the usage upsert and it threw first.
    expect(db.usage.size).toBe(0);
  });
});

describe('createLlmClient: Riyadh day boundary', () => {
  it('treats 21:30 UTC as belonging to the next Riyadh calendar day', async () => {
    const provider = new FakeProvider(() => okResponse());
    const db = new FakeDb();
    const client = createLlmClient({
      provider,
      db,
      env: {} as NodeJS.ProcessEnv,
      now: () => new Date('2026-01-01T21:30:00.000Z'),
    });
    await client.complete(makeRequest(), makeCtx());
    const [usageRow] = [...db.usage.values()];
    expect(usageRow.day.toISOString()).toBe('2026-01-02T00:00:00.000Z');
  });

  it('keeps 20:59 UTC on the same Riyadh calendar day', async () => {
    const provider = new FakeProvider(() => okResponse());
    const db = new FakeDb();
    const client = createLlmClient({
      provider,
      db,
      env: {} as NodeJS.ProcessEnv,
      now: () => new Date('2026-01-01T20:59:00.000Z'),
    });
    await client.complete(makeRequest(), makeCtx());
    const [usageRow] = [...db.usage.values()];
    expect(usageRow.day.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('type-level guard: RedactedText', () => {
  it('a plain string is not assignable to RedactedText', () => {
    // @ts-expect-error a bare string must not satisfy the branded RedactedText type
    const _bad: RedactedText = 'plain string';
    void _bad;
  });
});

// ─── Anthropic provider: request/response/error mapping ───────────────────

class FakeAnthropicClient implements AnthropicLike {
  public lastParams: unknown;
  public lastOptions: { timeout?: number } | undefined;
  constructor(private impl: (params: unknown) => Promise<unknown>) {}
  messages = {
    create: async (params: unknown, options?: { timeout?: number }) => {
      this.lastParams = params;
      this.lastOptions = options;
      return this.impl(params);
    },
  };
}

describe('createAnthropicProvider: request shape', () => {
  it('never sends sampling parameters or a thinking config', async () => {
    const fake = new FakeAnthropicClient(async () => ({
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      model: 'claude-haiku-4-5-20251001',
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    const provider = createAnthropicProvider({ client: fake });
    await provider.complete({
      modelId: 'claude-haiku-4-5-20251001',
      timeoutMs: 20_000,
      request: makeRequest(),
    });
    const params = fake.lastParams as Record<string, unknown>;
    expect(params.temperature).toBeUndefined();
    expect(params.top_p).toBeUndefined();
    expect(params.top_k).toBeUndefined();
    expect(params.thinking).toBeUndefined();
  });

  it('sends output_config.effort only on the advanced tier', async () => {
    const fake = new FakeAnthropicClient(async () => ({
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      model: 'claude-sonnet-5',
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    const provider = createAnthropicProvider({ client: fake });

    await provider.complete({
      modelId: 'claude-haiku-4-5-20251001',
      timeoutMs: 20_000,
      request: makeRequest({ tier: 'economy', effort: 'high' }),
    });
    expect((fake.lastParams as Record<string, unknown>).output_config).toBeUndefined();

    await provider.complete({
      modelId: 'claude-sonnet-5',
      timeoutMs: 60_000,
      request: makeRequest({ tier: 'advanced', effort: 'high' }),
    });
    expect((fake.lastParams as { output_config?: { effort?: string } }).output_config?.effort).toBe(
      'high',
    );
  });

  it('maps tools and tool_result blocks, and sets the per-request timeout in ms', async () => {
    const fake = new FakeAnthropicClient(async () => ({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      model: 'claude-haiku-4-5-20251001',
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    const provider = createAnthropicProvider({ client: fake });
    await provider.complete({
      modelId: 'claude-haiku-4-5-20251001',
      timeoutMs: 12_345,
      request: makeRequest({
        tools: [{ name: 'get_customer', description: 'look up a customer', inputSchema: { type: 'object' } }],
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'call_1', name: 'get_customer', input: { id: 'C1' } }],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', toolUseId: 'call_1', content: staticPrompt('{"name":"X"}') },
            ],
          },
        ],
      }),
    });
    const params = fake.lastParams as {
      tools: Array<{ name: string; input_schema: unknown }>;
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(params.tools[0].name).toBe('get_customer');
    expect(params.tools[0].input_schema).toEqual({ type: 'object' });
    const toolResultBlock = (params.messages[1].content as Array<Record<string, unknown>>)[0];
    expect(toolResultBlock.type).toBe('tool_result');
    expect(toolResultBlock.tool_use_id).toBe('call_1');
    expect(fake.lastOptions).toEqual({ timeout: 12_345 });
  });

  it('requests structured JSON output via output_config.format when jsonSchema is set', async () => {
    const fake = new FakeAnthropicClient(async () => ({
      content: [{ type: 'text', text: '{}' }],
      stop_reason: 'end_turn',
      model: 'claude-haiku-4-5-20251001',
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    const provider = createAnthropicProvider({ client: fake });
    await provider.complete({
      modelId: 'claude-haiku-4-5-20251001',
      timeoutMs: 20_000,
      request: makeRequest({ jsonSchema: { type: 'object', properties: {} } }),
    });
    const params = fake.lastParams as { output_config: { format: { type: string; schema: unknown } } };
    expect(params.output_config.format).toEqual({
      type: 'json_schema',
      schema: { type: 'object', properties: {} },
    });
  });
});

describe('createAnthropicProvider: response mapping', () => {
  it('maps text, tool calls, stop reason, tokens, and model id', async () => {
    const fake = new FakeAnthropicClient(async () => ({
      content: [
        { type: 'text', text: 'part one ' },
        { type: 'text', text: 'part two' },
        { type: 'tool_use', id: 'call_1', name: 'search_items', input: { q: 'panel' } },
      ],
      stop_reason: 'tool_use',
      model: 'claude-haiku-4-5-20251001',
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 5,
      },
    }));
    const provider = createAnthropicProvider({ client: fake });
    const result = await provider.complete({
      modelId: 'claude-haiku-4-5-20251001',
      timeoutMs: 20_000,
      request: makeRequest(),
    });
    expect(result.text).toBe('part one part two');
    expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'search_items', input: { q: 'panel' } }]);
    expect(result.stopReason).toBe('tool_use');
    expect(result.tokensIn).toBe(125); // 100 + 20 + 5
    expect(result.tokensOut).toBe(50);
    expect(result.modelId).toBe('claude-haiku-4-5-20251001');
  });

  it('maps stop_reason "refusal" through unchanged', async () => {
    const fake = new FakeAnthropicClient(async () => ({
      content: [{ type: 'text', text: '' }],
      stop_reason: 'refusal',
      model: 'claude-sonnet-5',
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    const provider = createAnthropicProvider({ client: fake });
    const result = await provider.complete({
      modelId: 'claude-sonnet-5',
      timeoutMs: 60_000,
      request: makeRequest(),
    });
    expect(result.stopReason).toBe('refusal');
  });
});

describe('createAnthropicProvider: error mapping', () => {
  async function completeWithThrow(err: unknown): Promise<LlmError> {
    const fake = new FakeAnthropicClient(async () => {
      throw err;
    });
    const provider = createAnthropicProvider({ client: fake });
    try {
      await provider.complete({ modelId: 'claude-haiku-4-5-20251001', timeoutMs: 20_000, request: makeRequest() });
      throw new Error('expected provider.complete to throw');
    } catch (thrown) {
      return thrown as LlmError;
    }
  }

  it('maps AuthenticationError to not_configured', async () => {
    const err = new Anthropic.AuthenticationError(401, { type: 'authentication_error' }, 'bad key', new Headers());
    const mapped = await completeWithThrow(err);
    expect(mapped).toBeInstanceOf(LlmError);
    expect(mapped.kind).toBe('not_configured');
  });

  it('maps PermissionDeniedError to not_configured', async () => {
    const err = new Anthropic.PermissionDeniedError(403, { type: 'permission_error' }, 'forbidden', new Headers());
    const mapped = await completeWithThrow(err);
    expect(mapped.kind).toBe('not_configured');
  });

  it('maps RateLimitError to rate_limited', async () => {
    const err = new Anthropic.RateLimitError(429, { type: 'rate_limit_error' }, 'slow down', new Headers());
    const mapped = await completeWithThrow(err);
    expect(mapped.kind).toBe('rate_limited');
  });

  it('maps APIConnectionTimeoutError to timeout', async () => {
    const err = new Anthropic.APIConnectionTimeoutError({ message: 'timed out' });
    const mapped = await completeWithThrow(err);
    expect(mapped.kind).toBe('timeout');
  });

  it('maps a generic APIConnectionError to network', async () => {
    const err = new Anthropic.APIConnectionError({ message: 'network down' });
    const mapped = await completeWithThrow(err);
    expect(mapped.kind).toBe('network');
  });

  it('maps a 5xx APIError to provider_down', async () => {
    const err = new Anthropic.InternalServerError(500, { type: 'api_error' }, 'oops', new Headers());
    const mapped = await completeWithThrow(err);
    expect(mapped.kind).toBe('provider_down');
  });

  it('maps BadRequestError to bad_request', async () => {
    const err = new Anthropic.BadRequestError(400, { type: 'invalid_request_error' }, 'bad', new Headers());
    const mapped = await completeWithThrow(err);
    expect(mapped.kind).toBe('bad_request');
  });

  it('maps an unrecognized error to network', async () => {
    const mapped = await completeWithThrow(new Error('something weird'));
    expect(mapped.kind).toBe('network');
  });
});

describe('createAnthropicProvider: not_configured without a client or env key', () => {
  it('throws not_configured and never calls any client when ANTHROPIC_API_KEY is unset', async () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const provider = createAnthropicProvider();
      await expect(
        provider.complete({ modelId: 'claude-haiku-4-5-20251001', timeoutMs: 20_000, request: makeRequest() }),
      ).rejects.toMatchObject({ kind: 'not_configured' });
    } finally {
      if (originalKey !== undefined) process.env.ANTHROPIC_API_KEY = originalKey;
    }
  });
});
