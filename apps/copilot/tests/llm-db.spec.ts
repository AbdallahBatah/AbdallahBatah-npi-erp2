// These tests run against the real local `npi_copilot` database (not a
// mock). They must FAIL — not silently skip — if the database is
// unreachable, so no try/catch swallows a connection error here. Same env
// loading and cleanup pattern as tests/fts.spec.ts.
import './helpers/load-env';
import { getDb } from '../src/db';
import { createLlmClient, type LlmDb } from '../src/llm/client';
import type { ModelProvider, ModelResponse, ProviderCall } from '../src/llm/provider';
import { staticPrompt } from '../src/privacy/pseudonymizer';

const db = getDb();
// PrismaClient's generated method signatures are far more specific than the
// minimal structural LlmDb interface (required-field create/update inputs
// vs. LlmDb's permissive Record<string, unknown>), so TS won't accept the
// assignment directly even though every call this test makes is valid at
// runtime. Narrow to the DI surface explicitly, once, here.
// No cast: the real Prisma client must satisfy LlmDb as it is.
const llmDb: LlmDb = db;

const runId = Math.random().toString(36).slice(2, 10);
const orgId = `test-llm-${runId}`;
const userId = `test-llm-user-${runId}`;

const createdAuditIds: string[] = [];
let createdUsageId: string | null = null;

class FakeProvider implements ModelProvider {
  readonly name = 'anthropic' as const;
  constructor(private response: ModelResponse) {}
  async complete(_call: ProviderCall): Promise<ModelResponse> {
    return this.response;
  }
}

function makeRequest() {
  return {
    tier: 'economy' as const,
    purpose: 'test.llm_db',
    system: staticPrompt('system prompt'),
    messages: [{ role: 'user' as const, content: staticPrompt('hello') }],
  };
}

afterAll(async () => {
  if (createdAuditIds.length > 0) {
    await db.llmAudit.deleteMany({ where: { id: { in: createdAuditIds } } });
  }
  if (createdUsageId) {
    await db.dailyUsage.deleteMany({ where: { id: createdUsageId } });
  }
  await db.$disconnect();
});

describe('createLlmClient against the real npi_copilot database', () => {
  it('leaves one llm_audit row and one daily_usage row with the right totals after a successful call', async () => {
    const provider = new FakeProvider({
      text: 'ok',
      toolCalls: [],
      stopReason: 'end_turn',
      tokensIn: 100,
      tokensOut: 50,
      modelId: 'claude-haiku-4-5-20251001',
    });
    const client = createLlmClient({ provider, db: llmDb });

    await client.complete(makeRequest(), { npiOrgId: orgId, npiUserId: userId });

    const auditRows = await db.llmAudit.findMany({ where: { npiOrgId: orgId, npiUserId: userId } });
    expect(auditRows).toHaveLength(1);
    createdAuditIds.push(...auditRows.map((r) => r.id));
    expect(auditRows[0].event).toBe('test.llm_db');
    expect(auditRows[0].tokensIn).toBe(100);
    expect(auditRows[0].tokensOut).toBe(50);
    expect(auditRows[0].costUsdMicro).toBe(100n * 1n + 50n * 5n); // haiku 4.5: $1 in / $5 out per MTok

    const usageRows = await db.dailyUsage.findMany({ where: { npiOrgId: orgId, npiUserId: userId } });
    expect(usageRows).toHaveLength(1);
    createdUsageId = usageRows[0].id;
    expect(usageRows[0].tokensIn).toBe(100);
    expect(usageRows[0].tokensOut).toBe(50);
  });

  it('adds to the same daily_usage row on a second call the same day', async () => {
    const provider = new FakeProvider({
      text: 'ok again',
      toolCalls: [],
      stopReason: 'end_turn',
      tokensIn: 30,
      tokensOut: 10,
      modelId: 'claude-haiku-4-5-20251001',
    });
    const client = createLlmClient({ provider, db: llmDb });

    await client.complete(makeRequest(), { npiOrgId: orgId, npiUserId: userId });

    const auditRows = await db.llmAudit.findMany({ where: { npiOrgId: orgId, npiUserId: userId } });
    expect(auditRows).toHaveLength(2);
    createdAuditIds.length = 0;
    createdAuditIds.push(...auditRows.map((r) => r.id));

    const usageRows = await db.dailyUsage.findMany({ where: { npiOrgId: orgId, npiUserId: userId } });
    expect(usageRows).toHaveLength(1); // still one row for the day, added to
    expect(usageRows[0].tokensIn).toBe(130);
    expect(usageRows[0].tokensOut).toBe(60);
  });
});
