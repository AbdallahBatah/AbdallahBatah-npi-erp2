// D-26 (T-48b): the administrative flow's extraction — schema, assessment,
// prompt and the registered flow spec.
import path from 'node:path';
import { FLOWS, flattenFields, runExtraction, type ExtractFailure, type ExtractionResult } from '../src/extract/run';
import {
  assessUserPermissions,
  REASON_MAX,
  UserPermissionsOutputSchema,
  type UserPermissionsOutput,
} from '../src/extract/schemas/user_permissions';
import { Pseudonymizer } from '../src/privacy/pseudonymizer';
import { loadPrompt } from '../src/prompts/load';
import type { LlmContext } from '../src/llm/client';
import type { ModelResponse, RedactedRequest } from '../src/llm/provider';

process.env.COPILOT_PROMPTS_DIR = path.resolve(__dirname, '../prompts');

type W = { value: string; confidence: number; evidence: string; page: number };
const f = (value: string | null, confidence = 1, evidence = 'q'): W => ({ value: value ?? '', confidence, evidence, page: 0 });
const none = (): W => ({ value: '', confidence: 0, evidence: '', page: 0 });

function output(overrides: Partial<UserPermissionsOutput> = {}): UserPermissionsOutput {
  return {
    userName: f('أحمد'),
    action: f('revoke'),
    permissions: [{ name: f('التقارير المالية') }],
    reason: none(),
    ...overrides,
  };
}

const FLAGS = { ligatureSuspect: false, referenceDate: '2026-10-13' };

describe('UserPermissionsOutputSchema', () => {
  it('accepts a complete output and rejects one missing a member', () => {
    expect(UserPermissionsOutputSchema.safeParse(output()).success).toBe(true);
    const missing = { ...output() } as Record<string, unknown>;
    delete missing.reason;
    expect(UserPermissionsOutputSchema.safeParse(missing).success).toBe(false);
  });
});

describe('FLOWS.user_permissions', () => {
  const spec = FLOWS.user_permissions;

  it('is registered with its prompt file and audit purpose', () => {
    expect(spec.flow).toBe('user_permissions');
    expect(spec.promptFile).toBe('extract/user_permissions.md');
    expect(spec.purpose).toBe('extract_user_permissions');
  });

  it('has a model-facing schema with no keyword structured output rejects and strict objects', () => {
    const text = JSON.stringify(spec.jsonSchema);
    for (const keyword of ['"minimum"', '"maxLength"', '"pattern"', '"anyOf"', '"oneOf"', '"null"']) expect(text).not.toContain(keyword);
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (typeof node !== 'object' || node === null) return;
      const obj = node as Record<string, unknown>;
      if (obj.type === 'object') {
        expect(obj.additionalProperties).toBe(false);
        expect(Object.keys(obj.properties as object).sort()).toEqual([...(obj.required as string[])].sort());
      }
      Object.values(obj).forEach(walk);
    };
    walk(spec.jsonSchema);
  });

  it('parses and reports a mismatch with the failing path', () => {
    expect(spec.parse(output()).success).toBe(true);
    const bad = spec.parse({ userName: f('أحمد') });
    expect(bad.success).toBe(false);
  });
});

describe('the prompt', () => {
  const prompt = loadPrompt('extract/user_permissions.md');

  it('names both actions, the dialect verbs and the safety section', () => {
    expect(prompt).toContain('grant');
    expect(prompt).toContain('revoke');
    for (const verb of ['شيل', 'اسحب', 'احجب', 'أعطِ', 'امنح']) expect(prompt).toContain(verb);
    expect(prompt).toContain('## الأمان');
    expect(prompt).toContain('بيانات');
  });

  it('carries {{today}} exactly once and asks for placeholders to be copied verbatim', () => {
    expect(prompt.split('{{today}}').length - 1).toBe(1);
    expect(prompt).toContain('⟦موظف_1⟧');
  });
});

describe('assessUserPermissions', () => {
  it('a clean revoke sentence: confirmed fields and plain values', () => {
    const { assessed, values } = assessUserPermissions(output(), FLAGS);
    expect(assessed.userName.status).toBe('confirmed');
    expect(assessed.action).toMatchObject({ value: 'revoke', status: 'confirmed' });
    expect(assessed.permissions[0].name.status).toBe('confirmed');
    expect(values).toEqual({ userName: 'أحمد', action: 'revoke', permissions: [{ name: 'التقارير المالية' }], reason: null });
  });

  it('a grant of two permissions keeps both, in order, with the reason', () => {
    const { values } = assessUserPermissions(
      output({
        action: f('grant'),
        permissions: [{ name: f('التقارير المالية') }, { name: f('الفواتير') }],
        reason: f('انتقل إلى المالية'),
      }),
      FLAGS,
    );
    expect(values).toEqual({
      userName: 'أحمد',
      action: 'grant',
      permissions: [{ name: 'التقارير المالية' }, { name: 'الفواتير' }],
      reason: 'انتقل إلى المالية',
    });
  });

  it('accepts the action in any case and flags a word that is neither grant nor revoke', () => {
    expect(assessUserPermissions(output({ action: f('Revoke') }), FLAGS).values?.action).toBe('revoke');
    const odd = assessUserPermissions(output({ action: f('delete') }), FLAGS);
    expect(odd.assessed.action).toMatchObject({ value: null, status: 'unconfirmed', warnings: ['extract.warn.enum'] });
    expect(odd.values).toBeNull();
  });

  it('values are null without a user, without an action, or without any named permission', () => {
    expect(assessUserPermissions(output({ userName: none() }), FLAGS).values).toBeNull();
    expect(assessUserPermissions(output({ action: none() }), FLAGS).values).toBeNull();
    expect(assessUserPermissions(output({ permissions: [] }), FLAGS).values).toBeNull();
    expect(assessUserPermissions(output({ permissions: [{ name: none() }] }), FLAGS).values).toBeNull();
  });

  it('values keep only the permissions with a name; the assessed tree keeps all of them', () => {
    const { assessed, values } = assessUserPermissions(output({ permissions: [{ name: none() }, { name: f('الفواتير') }] }), FLAGS);
    expect(assessed.permissions).toHaveLength(2);
    expect(assessed.permissions[0].name.warnings).toEqual(['extract.warn.missing']);
    expect(values?.permissions).toEqual([{ name: 'الفواتير' }]);
  });

  it('a placeholder the pseudonymizer could not restore stays verbatim and is flagged', () => {
    const { assessed, values } = assessUserPermissions(output({ userName: f('⟦موظف_1⟧') }), FLAGS);
    expect(assessed.userName.value).toBe('⟦موظف_1⟧');
    expect(assessed.userName.status).toBe('unconfirmed');
    expect(assessed.userName.warnings).toContain('extract.warn.placeholder');
    expect(values?.userName).toBe('⟦موظف_1⟧');
  });

  it('a low-confidence action is unconfirmed (the administrator vouches for it on the card)', () => {
    const { assessed } = assessUserPermissions(output({ action: f('revoke', 0.6) }), FLAGS);
    expect(assessed.action).toMatchObject({ value: 'revoke', status: 'unconfirmed', warnings: ['extract.warn.low_confidence'] });
  });

  it('caps the reason at the 500 characters NPI accepts', () => {
    const long = 'س'.repeat(REASON_MAX + 80);
    const { assessed, values } = assessUserPermissions(output({ reason: f(long) }), FLAGS);
    expect(assessed.reason.value).toHaveLength(REASON_MAX);
    expect(values?.reason).toHaveLength(REASON_MAX);
  });

  it('flattens to dotted leaves the card can address', () => {
    const { assessed } = assessUserPermissions(output({ permissions: [{ name: f('أ') }, { name: f('ب') }] }), FLAGS);
    expect(Object.keys(flattenFields(assessed)).sort()).toEqual(['action', 'permissions.0.name', 'permissions.1.name', 'reason', 'userName']);
  });
});

describe('runExtraction (user_permissions)', () => {
  const ctx: LlmContext = { npiOrgId: 'org-1', npiUserId: 'user-1' };
  const SENTENCE = 'شيل صلاحية التقارير المالية من أحمد';

  async function run(response: UserPermissionsOutput): Promise<{ result: ExtractionResult | ExtractFailure; requests: RedactedRequest[] }> {
    const requests: RedactedRequest[] = [];
    const llm = {
      async complete(req: RedactedRequest): Promise<ModelResponse> {
        requests.push(req);
        return { text: JSON.stringify(response), toolCalls: [], stopReason: 'end_turn', tokensIn: 10, tokensOut: 5, modelId: 'm' };
      },
    };
    const result = await runExtraction(
      { llm, pseudonymizer: new Pseudonymizer([]) },
      { flow: 'user_permissions', source: { kind: 'text', pages: [] }, userHint: SENTENCE, referenceDate: '2026-10-13' },
      ctx,
    );
    return { result, requests };
  }

  it('sends the sentence on the advanced tier with its own purpose and returns the plain values', async () => {
    const { result, requests } = await run(output());
    expect(requests).toHaveLength(1);
    expect(requests[0].tier).toBe('advanced');
    expect(requests[0].purpose).toBe('extract_user_permissions');
    expect(requests[0].jsonSchema).toBe(FLOWS.user_permissions.jsonSchema);
    expect(requests[0].system).toContain('2026-10-13');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values).toEqual({ userName: 'أحمد', action: 'revoke', permissions: [{ name: 'التقارير المالية' }], reason: null });
  });
});
