// T-17 acceptance: scripted answers -> valid plan, plus the parser and the
// setup route's orchestration. `apps/copilot/catalog` must be on disk for
// `loadProfilePack('epc')` to resolve — set before any module that reads it
// is imported, same as `tests/onboarding-apply.spec.ts`.
import path from 'node:path';

process.env.COPILOT_CATALOG_DIR = path.join(__dirname, '..', 'catalog');

import { loadProfilePack } from '../src/onboarding/catalog';
import {
  applyAnswer,
  goTo,
  initialState,
  isReadyForPlan,
  MachineError,
  questionKey,
  SETUP_STEPS,
  SetupStateSchema,
  stepDefaults,
  toAnswers,
  type SetupState,
  type SetupStep,
  type StepAnswer,
} from '../src/onboarding/machine';
import { parseAnswer, type ParseDeps, type ParseOutcome } from '../src/onboarding/parse';
import { buildPlan, effectivePack, PlanError, type NpiSnapshot, type PlanCaller, type SetupAnswers } from '../src/onboarding/plan';
import type { OnboardingNpi } from '../src/onboarding/apply';
import {
  getSetupState,
  handleSetupAction,
  SetupForbiddenError,
  type OnboardingSessionRow,
  type SetupCaller,
  type SetupDeps,
} from '../src/onboarding/service';
import { loadPrompt } from '../src/prompts/load';
import { staticPrompt } from '../src/privacy/pseudonymizer';
import { t } from '../src/i18n/ar';
// Same relative import `tests/onboarding-apply.spec.ts` uses.
import { PERMISSION_CATALOG } from '../../../packages/shared/src/permissions';

const ALL_PERMISSION_KEYS: string[] = PERMISSION_CATALOG.map((p) => p.key as string);
const pack = () => loadProfilePack('epc');
const adminCaller: PlanCaller = { roleKey: 'admin', permissions: ALL_PERMISSION_KEYS };

// ─── A minimal fake NPI for buildPlan/dryRun-style scenarios ────────────────
// Trimmed from `tests/onboarding-apply.spec.ts`'s `FakeNpi` (T-16): no
// permission guards or NPI-side validation, since those are already covered
// there — this file only needs a happy-path NPI to prove the machine's
// scripted answers produce an unblocked plan and to drive `handleSetupAction`.

interface FakeRole {
  id: string;
  key: string;
  nameAr: string;
  nameEn: string;
  permissions: string[];
}
interface FakeDept {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  isActive: boolean;
}
interface FakeUser {
  id: string;
  isActive: boolean;
  roleKey: string;
  nameAr: string;
}
interface FakeRule {
  id: string;
  documentType: string;
  minAmount: number;
  maxAmount: number | null;
  isActive: boolean;
  steps: { roleId: string }[];
}
interface FakeItem {
  id: string;
  sku: string;
  nameAr: string;
  nameEn: string;
  itemCategory: string;
  uom: string;
  isSerialised: boolean;
}

class FakeNpi implements OnboardingNpi {
  roles: FakeRole[] = [];
  departments: FakeDept[] = [];
  users: FakeUser[] = [];
  rules: FakeRule[] = [];
  items: FakeItem[] = [];
  private seq = 0;
  private id(prefix: string) {
    return `${prefix}_${++this.seq}`;
  }

  async listPermissions() {
    return PERMISSION_CATALOG;
  }
  async listRoles() {
    return this.roles.map((r) => ({ ...r, _count: { users: 0 } }));
  }
  async listDepartments() {
    return this.departments.map((d) => ({ ...d, manager: null, parent: null }));
  }
  async listDepartmentDirectory() {
    return this.users.map((u) => {
      const role = this.roles.find((r) => r.key === u.roleKey) ?? {
        id: `missing_${u.roleKey}`,
        key: u.roleKey,
        nameAr: u.roleKey,
        nameEn: u.roleKey,
      };
      return {
        id: u.id,
        nameAr: u.nameAr,
        nameEn: 'u',
        email: `${u.id}@x`,
        isActive: u.isActive,
        departmentId: null,
        role: { id: role.id, key: role.key, nameAr: role.nameAr, nameEn: role.nameEn },
      };
    });
  }
  async listApprovalRules() {
    return this.rules.map((r) => ({
      ...r,
      minAmount: String(r.minAmount),
      maxAmount: r.maxAmount === null ? null : String(r.maxAmount),
      steps: r.steps.map((s, i) => {
        const role = this.roles.find((x) => x.id === s.roleId)!;
        return { sequence: i + 1, roleId: s.roleId, role: { id: role.id, key: role.key, nameAr: role.nameAr, nameEn: role.nameEn } };
      }),
    }));
  }
  async listItems() {
    return this.items.map((i) => ({ ...i, unitCost: '0' }));
  }

  async createDepartment(dto: { code: string; nameAr: string; nameEn?: string }) {
    const row: FakeDept = { id: this.id('dept'), code: dto.code, nameAr: dto.nameAr, nameEn: dto.nameEn ?? dto.nameAr, isActive: true };
    this.departments.push(row);
    return row;
  }
  async createRole(dto: { key: string; nameAr: string; nameEn?: string; permissions: string[] }) {
    const row: FakeRole = { id: this.id('role'), key: dto.key, nameAr: dto.nameAr, nameEn: dto.nameEn ?? dto.nameAr, permissions: [...dto.permissions] };
    this.roles.push(row);
    return row;
  }
  async updateRole(id: string, dto: { permissions?: string[] }) {
    const role = this.roles.find((r) => r.id === id)!;
    if (dto.permissions) role.permissions = [...dto.permissions];
    return role;
  }
  async createApprovalRule(dto: { documentType: string; minAmount: number; maxAmount?: number | null; steps: { roleId: string }[] }) {
    const row: FakeRule = {
      id: this.id('rule'),
      documentType: dto.documentType,
      minAmount: dto.minAmount,
      maxAmount: dto.maxAmount ?? null,
      isActive: true,
      steps: [...dto.steps],
    };
    this.rules.push(row);
    return row;
  }
  async updateApprovalRule(
    id: string,
    dto: { minAmount?: number; maxAmount?: number | null; isActive?: boolean; steps?: { roleId: string }[] },
  ) {
    const rule = this.rules.find((r) => r.id === id)!;
    Object.assign(rule, {
      minAmount: dto.minAmount ?? rule.minAmount,
      maxAmount: dto.maxAmount === undefined ? rule.maxAmount : dto.maxAmount,
      isActive: dto.isActive ?? rule.isActive,
      steps: dto.steps ?? rule.steps,
    });
    return rule;
  }
  async createItem(dto: { sku: string; nameAr: string; nameEn: string; itemCategory: string; uom?: string; isSerialised?: boolean }) {
    const row: FakeItem = {
      id: this.id('item'),
      sku: dto.sku,
      nameAr: dto.nameAr,
      nameEn: dto.nameEn,
      itemCategory: dto.itemCategory,
      uom: dto.uom ?? 'unit',
      isSerialised: dto.isSerialised ?? false,
    };
    this.items.push(row);
    return row;
  }

  addUser(roleKey: string, nameAr = 'م') {
    const row: FakeUser = { id: this.id('user'), isActive: true, roleKey, nameAr };
    this.users.push(row);
    return row;
  }
}

function emptySnapshot(npi: FakeNpi): NpiSnapshot {
  return {
    permissions: PERMISSION_CATALOG,
    roles: npi.roles.map((r) => ({ id: r.id, key: r.key, nameAr: r.nameAr, permissions: r.permissions })),
    departments: npi.departments.map((d) => ({ id: d.id, code: d.code, nameAr: d.nameAr, isActive: d.isActive })),
    users: npi.users.map((u) => ({ id: u.id, isActive: u.isActive, roleKey: u.roleKey, nameAr: u.nameAr })),
    approvalRules: npi.rules.map((r) => ({
      id: r.id,
      documentType: r.documentType,
      minAmount: r.minAmount,
      maxAmount: r.maxAmount,
      isActive: r.isActive,
      stepRoleKeys: r.steps.map((s) => npi.roles.find((x) => x.id === s.roleId)!.key),
      stepRoleIds: r.steps.map((s) => s.roleId),
    })),
    items: npi.items.map((i) => ({ id: i.id, sku: i.sku, nameAr: i.nameAr, itemCategory: i.itemCategory })),
  };
}

// ─── 1. Initial state and question keys ─────────────────────────────────────

describe('initialState / questionKey', () => {
  it('starts at step 1 with no answers and no completed steps', () => {
    expect(initialState()).toEqual({ step: 1, answers: {}, completedSteps: [] });
  });

  it('maps every step to its ar.ts question key', () => {
    expect(SETUP_STEPS.map(questionKey)).toEqual([
      'setup.q1',
      'setup.q2',
      'setup.q3',
      'setup.q4',
      'setup.q5',
      'setup.q6',
      'setup.diff',
    ]);
    for (const step of SETUP_STEPS) expect(t(questionKey(step))).not.toBe(questionKey(step));
  });

  it('stepDefaults(1, null) lists all six profiles; any other step with no pack is null', () => {
    const defaults = stepDefaults(1, null);
    expect(defaults).toMatchObject({ step: 1 });
    expect(defaults && 'profiles' in defaults ? defaults.profiles.map((p) => p.key) : []).toEqual([
      'epc',
      'om_provider',
      'ppa_operator',
      'general_contracting',
      'equipment_trading',
      'engineering_consulting',
    ]);
    for (const step of [2, 3, 4, 5, 6, 7] as SetupStep[]) expect(stepDefaults(step, null)).toBeNull();
  });

  it('stepDefaults(2, pack) attaches only active NPI users of the matching role', () => {
    const defaults = stepDefaults(2, pack(), {
      npiUsers: [
        { id: 'u1', nameAr: 'أحمد', roleKey: 'pm', isActive: true },
        { id: 'u2', nameAr: 'سالم', roleKey: 'pm', isActive: false },
        { id: 'u3', nameAr: 'خالد', roleKey: 'accountant', isActive: true },
      ],
    });
    expect(defaults?.step).toBe(2);
    const pm = defaults && 'positions' in defaults ? defaults.positions.find((p) => p.roleKey === 'pm') : undefined;
    expect(pm?.npiUsers).toEqual([{ id: 'u1', nameAr: 'أحمد', roleKey: 'pm', isActive: true }]);
  });
});

// ─── 2. applyAnswer: ordering, re-answer clearing, invalid edits ───────────

describe('applyAnswer — step ordering and re-answering', () => {
  it('refuses any step before step 1 is answered', () => {
    expect(() => applyAnswer(initialState(), 2, { step: 2, departments: pack().defaultDepartments, positions: pack().positions })).toThrow(
      MachineError,
    );
    try {
      applyAnswer(initialState(), 2, { step: 2, departments: pack().defaultDepartments, positions: pack().positions });
    } catch (err) {
      expect((err as MachineError).code).toBe('step_out_of_order');
    }
  });

  it('refuses when the answer names a different step than requested', () => {
    expect(() => applyAnswer(initialState(), 1, { step: 1, profileKey: 'epc' } as StepAnswer, {})).not.toThrow();
    const afterStep1 = applyAnswer(initialState(), 1, { step: 1, profileKey: 'epc' });
    expect(() => applyAnswer(afterStep1, 3, { step: 2, departments: pack().defaultDepartments, positions: pack().positions } as StepAnswer)).toThrow(
      MachineError,
    );
  });

  it('accepts step 1, marks it completed, and advances to step 2', () => {
    const state = applyAnswer(initialState(), 1, { step: 1, profileKey: 'epc' });
    expect(state).toEqual({ step: 2, answers: { profileKey: 'epc' }, completedSteps: [1] });
    expect(isReadyForPlan(state)).toBe(true);
  });

  it('re-answering step 1 with the SAME profile keeps steps 2-6 and their completion', () => {
    let state = applyAnswer(initialState(), 1, { step: 1, profileKey: 'epc' });
    state = applyAnswer(state, 2, { step: 2, departments: pack().defaultDepartments, positions: pack().positions });
    state = applyAnswer(state, 1, { step: 1, profileKey: 'epc', revenueLines: ['خط جديد', ...pack().revenueLines] });
    expect(state.completedSteps).toContain(2);
    expect(state.answers.departments).toEqual(pack().defaultDepartments);
  });

  it('re-answering step 1 with a DIFFERENT profile clears steps 2-6', () => {
    let state = applyAnswer(initialState(), 1, { step: 1, profileKey: 'epc' });
    state = applyAnswer(state, 2, { step: 2, departments: pack().defaultDepartments, positions: pack().positions });
    state = applyAnswer(state, 4, { step: 4, acceptedDocTypeKeys: pack().acceptedDocTypes.map((d) => d.key) });
    expect(state.completedSteps.sort()).toEqual([1, 2, 4]);

    state = applyAnswer(state, 1, { step: 1, profileKey: 'om_provider' });
    expect(state.answers).toEqual({ profileKey: 'om_provider' });
    expect(state.completedSteps).toEqual([1]);
    expect(state.step).toBe(2);
  });

  it('a step may be answered again later without moving completedSteps backwards', () => {
    let state = applyAnswer(initialState(), 1, { step: 1, profileKey: 'epc' });
    state = applyAnswer(state, 2, { step: 2, departments: pack().defaultDepartments, positions: pack().positions });
    state = applyAnswer(state, 3, { step: 3, approvalRules: pack().approvalRuleDefaults });
    expect(state.step).toBe(4);
    // Re-answer step 2 with the same content; still completed, step pointer unchanged.
    state = applyAnswer(state, 2, { step: 2, departments: pack().defaultDepartments, positions: pack().positions });
    expect(state.completedSteps.sort()).toEqual([1, 2, 3]);
    expect(state.step).toBe(4);
  });

  it('refuses an edit that breaks a pack cross-check, naming the field', () => {
    const state = applyAnswer(initialState(), 1, { step: 1, profileKey: 'epc' });
    const departmentsWithoutSite = pack().defaultDepartments.filter((d) => d.code !== 'SITE');
    try {
      applyAnswer(state, 2, { step: 2, departments: departmentsWithoutSite, positions: pack().positions });
      throw new Error('expected MachineError');
    } catch (err) {
      expect(err).toBeInstanceOf(MachineError);
      const machineErr = err as MachineError;
      expect(machineErr.code).toBe('invalid_answer');
      expect(machineErr.issues.some((i) => i.path.startsWith('positions.') && i.message.includes('"SITE"'))).toBe(true);
    }
    // The refused edit never touched the stored state.
    expect(state.completedSteps).toEqual([1]);
  });
});

// ─── T-18: position holders (step 2) ────────────────────────────────────────

describe('applyAnswer — step 2 holders', () => {
  it('a structured step-2 answer with holders is stored', () => {
    const state = applyAnswer(initialState(), 1, { step: 1, profileKey: 'epc' });
    const holders = [{ roleKey: 'pm', departmentCode: 'PROJ', npiUserIds: ['u1'] }];
    const next = applyAnswer(state, 2, { step: 2, departments: pack().defaultDepartments, positions: pack().positions, holders });
    expect(next.answers.holders).toEqual(holders);
  });

  it('a later step-2 answer without holders (as the text path produces) keeps them', () => {
    let state = applyAnswer(initialState(), 1, { step: 1, profileKey: 'epc' });
    const holders = [{ roleKey: 'pm', departmentCode: 'PROJ', npiUserIds: ['u1'] }];
    state = applyAnswer(state, 2, { step: 2, departments: pack().defaultDepartments, positions: pack().positions, holders });
    // No `holders` field at all — the shape `parseAnswer`'s free-text path produces.
    const next = applyAnswer(state, 2, { step: 2, departments: pack().defaultDepartments, positions: pack().positions });
    expect(next.answers.holders).toEqual(holders);
  });

  it('removing a position prunes its holders, silently', () => {
    let state = applyAnswer(initialState(), 1, { step: 1, profileKey: 'epc' });
    const holders = [
      { roleKey: 'pm', departmentCode: 'PROJ', npiUserIds: ['u1'] },
      { roleKey: 'accountant', departmentCode: 'FIN', npiUserIds: ['u2'] },
    ];
    state = applyAnswer(state, 2, { step: 2, departments: pack().defaultDepartments, positions: pack().positions, holders });
    const positionsWithoutPm = pack().positions.filter((p) => p.roleKey !== 'pm');
    const next = applyAnswer(state, 2, { step: 2, departments: pack().defaultDepartments, positions: positionsWithoutPm });
    expect(next.answers.holders).toEqual([holders[1]]);
  });

  it('changing the profile at step 1 clears holders along with steps 2-6', () => {
    let state = applyAnswer(initialState(), 1, { step: 1, profileKey: 'epc' });
    const holders = [{ roleKey: 'pm', departmentCode: 'PROJ', npiUserIds: ['u1'] }];
    state = applyAnswer(state, 2, { step: 2, departments: pack().defaultDepartments, positions: pack().positions, holders });
    state = applyAnswer(state, 1, { step: 1, profileKey: 'om_provider' });
    expect(state.answers.holders).toBeUndefined();
    expect(state.completedSteps).toEqual([1]);
  });
});

describe('effectivePack — dangling holder', () => {
  it('throws PlanError naming holders.0 when a holder names a position that does not exist in the profile', () => {
    const answers: SetupAnswers = {
      profileKey: 'epc',
      holders: [{ roleKey: 'pm', departmentCode: 'NOPE', npiUserIds: ['u1'] }],
    };
    try {
      effectivePack(pack(), answers);
      throw new Error('expected PlanError');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanError);
      const issues = (err as PlanError).issues;
      expect(issues.some((i) => i.path === 'holders.0')).toBe(true);
    }
  });
});

// ─── 3. goTo ────────────────────────────────────────────────────────────────

describe('goTo', () => {
  it('allows going back to a completed step and forward to the next open one', () => {
    let state = applyAnswer(initialState(), 1, { step: 1, profileKey: 'epc' });
    state = applyAnswer(state, 2, { step: 2, departments: pack().defaultDepartments, positions: pack().positions });
    // state.step is now 3 (next open).
    expect(goTo(state, 1).step).toBe(1);
    expect(goTo(state, 3).step).toBe(3);
  });

  it('refuses a step that is neither completed nor the next open one', () => {
    let state = applyAnswer(initialState(), 1, { step: 1, profileKey: 'epc' });
    state = applyAnswer(state, 2, { step: 2, departments: pack().defaultDepartments, positions: pack().positions });
    expect(() => goTo(state, 4)).toThrow(MachineError);
    try {
      goTo(state, 5);
    } catch (err) {
      expect((err as MachineError).code).toBe('step_out_of_order');
    }
  });

  it('reaches step 7 once steps 1-6 are all completed', () => {
    let state = applyAnswer(initialState(), 1, { step: 1, profileKey: 'epc' });
    state = applyAnswer(state, 2, { step: 2, departments: pack().defaultDepartments, positions: pack().positions });
    state = applyAnswer(state, 3, { step: 3, approvalRules: pack().approvalRuleDefaults });
    state = applyAnswer(state, 4, { step: 4, acceptedDocTypeKeys: pack().acceptedDocTypes.map((d) => d.key) });
    state = applyAnswer(state, 5, { step: 5, items: pack().itemTemplates });
    state = applyAnswer(state, 6, { step: 6, terminology: pack().terminology });
    expect(state.step).toBe(7);
    expect(goTo(state, 7).step).toBe(7);
  });
});

// ─── 4. SetupStateSchema round-trip ─────────────────────────────────────────

describe('SetupStateSchema', () => {
  it('round-trips a state through JSON.stringify/parse', () => {
    let state = applyAnswer(initialState(), 1, { step: 1, profileKey: 'epc' });
    state = applyAnswer(state, 3, { step: 3, approvalRules: [{ docType: 'PURCHASE_REQUISITION', minAmount: 5000, steps: ['pm'] }] });
    const roundTripped = SetupStateSchema.parse(JSON.parse(JSON.stringify(state)));
    expect(roundTripped).toEqual(state);
  });

  it('rejects a step outside 1-7 and a malformed answers object', () => {
    expect(SetupStateSchema.safeParse({ step: 8, answers: {}, completedSteps: [] }).success).toBe(false);
    expect(SetupStateSchema.safeParse({ step: 1, answers: { profileKey: 'not_a_real_profile' }, completedSteps: [] }).success).toBe(false);
  });
});

// ─── 5. Scripted full run for epc -> a valid, unblocked plan (T-17 acceptance) ──

describe('scripted full run (epc) -> buildPlan has no blocked steps', () => {
  it('walks all six questions with structured answers (defaults + custom thresholds) to a clean plan', () => {
    let state = applyAnswer(initialState(), 1, { step: 1, profileKey: 'epc' });
    state = applyAnswer(state, 2, { step: 2, departments: pack().defaultDepartments, positions: pack().positions });
    // Custom thresholds for step 3 — different numbers than the pack's own.
    const customRules: SetupAnswers['approvalRules'] = [
      { docType: 'PURCHASE_REQUISITION', minAmount: 5000, steps: ['pm'] },
      { docType: 'PURCHASE_ORDER', minAmount: 50000, steps: ['pm', 'accountant'] },
      { docType: 'PROGRESS_CLAIM', minAmount: 200000, steps: ['pm', 'accountant'] },
    ];
    state = applyAnswer(state, 3, { step: 3, approvalRules: customRules });
    state = applyAnswer(state, 4, { step: 4, acceptedDocTypeKeys: pack().acceptedDocTypes.map((d) => d.key) });
    state = applyAnswer(state, 5, { step: 5, items: pack().itemTemplates });
    state = applyAnswer(state, 6, { step: 6, terminology: pack().terminology });

    expect(state.completedSteps.sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(state.step).toBe(7);

    const answers = toAnswers(state);
    expect(answers.approvalRules).toEqual(customRules);

    const npi = new FakeNpi();
    npi.addUser('pm');
    npi.addUser('accountant');
    const plan = buildPlan(pack(), answers, emptySnapshot(npi), adminCaller);

    expect(plan.steps.every((s) => s.action !== 'blocked')).toBe(true);
    expect(plan.counts).toEqual({ create: 17, update: 0, skip: 0, blocked: 0 });
    const prRule = plan.steps.find((s) => s.kind === 'approval_rule' && s.docType === 'PURCHASE_REQUISITION');
    expect(prRule).toMatchObject({ minAmount: 5000, action: 'create' });
  });
});

// ─── 6. parseAnswer — deterministic path (zero model calls) ────────────────

function countingLlm(): { llm: ParseDeps['llm']; calls: number[] } {
  const calls: number[] = [];
  return {
    llm: {
      async complete() {
        calls.push(1);
        return { text: '{}', toolCalls: [], stopReason: 'end_turn', tokensIn: 0, tokensOut: 0, modelId: 'fake' };
      },
    },
    calls,
  };
}

const identityPseudonymizer: ParseDeps['pseudonymizer'] = { redact: (s) => staticPrompt(s) };
const ctx = { npiOrgId: 'org1', npiUserId: 'user1' };
const baseState: SetupState = { step: 1, answers: {}, completedSteps: [] };

describe('parseAnswer — deterministic path, no model call', () => {
  const cases: { step: SetupStep; text: string; check: (a: StepAnswer) => void }[] = [
    { step: 2, text: 'نعم كما هو', check: (a) => expect(a).toMatchObject({ step: 2, departments: pack().defaultDepartments }) },
    { step: 3, text: 'الافتراضي تمام', check: (a) => expect(a).toMatchObject({ step: 3, approvalRules: pack().approvalRuleDefaults }) },
    {
      step: 1,
      text: 'إحنا مقاول EPC نسوي تصميم وتوريد وتركيب',
      check: (a) => expect(a).toEqual({ step: 1, profileKey: 'epc' }),
    },
    {
      step: 1,
      text: 'نشتغل تشغيل وصيانة للمحطات الشمسية',
      check: (a) => expect(a).toEqual({ step: 1, profileKey: 'om_provider' }),
    },
    {
      step: 6,
      text: 'لا، نفس المصطلحات المعتادة عندنا',
      check: (a) => expect(a).toMatchObject({ step: 6, terminology: pack().terminology }),
    },
  ];

  it.each(cases)('«$text» (step $step) answers without calling the model', async ({ step, text, check }) => {
    const { llm, calls } = countingLlm();
    const outcome = await parseAnswer(
      { llm, pseudonymizer: identityPseudonymizer },
      { step, text, pack: pack(), current: baseState },
      ctx,
    );
    expect(outcome.kind).toBe('answer');
    if (outcome.kind === 'answer') {
      expect(outcome.source).toBe('deterministic');
      check(outcome.answer);
    }
    expect(calls).toHaveLength(0);
  });
});

// ─── 7. parseAnswer — model path ────────────────────────────────────────────

function llmReturning(text: string): ParseDeps['llm'] {
  return {
    async complete() {
      return { text, toolCalls: [], stopReason: 'end_turn', tokensIn: 0, tokensOut: 0, modelId: 'fake' };
    },
  };
}

describe('parseAnswer — model path', () => {
  it('accepts a bare JSON reply and forces the requested step onto it', async () => {
    const outcome = await parseAnswer(
      { llm: llmReturning('{"acceptedDocTypeKeys":["epc_contract","vendor_quote"]}'), pseudonymizer: identityPseudonymizer },
      { step: 4, text: 'شيل فاتورة المورد وإشعار التسليم بس خلي الباقي', pack: pack(), current: baseState },
      ctx,
    );
    expect(outcome).toEqual({
      kind: 'answer',
      source: 'model',
      answer: { step: 4, acceptedDocTypeKeys: ['epc_contract', 'vendor_quote'] },
    });
  });

  it('strips a ```json fence before parsing', async () => {
    const fenced = '```json\n{"terminology":{"vendor":"المقاول من الباطن"}}\n```';
    const outcome = await parseAnswer(
      { llm: llmReturning(fenced), pseudonymizer: identityPseudonymizer },
      { step: 6, text: 'نسمي المورّد المقاول من الباطن', pack: pack(), current: baseState },
      ctx,
    );
    expect(outcome).toEqual({ kind: 'answer', source: 'model', answer: { step: 6, terminology: { vendor: 'المقاول من الباطن' } } });
  });

  it('strips a bare ``` fence (no language tag) too', async () => {
    const fenced = '```\n{"items":[]}\n```';
    const outcome = await parseAnswer(
      { llm: llmReturning(fenced), pseudonymizer: identityPseudonymizer },
      { step: 5, text: 'ما نضيف شيء الحين', pack: pack(), current: baseState },
      ctx,
    );
    expect(outcome).toEqual({ kind: 'answer', source: 'model', answer: { step: 5, items: [] } });
  });

  it('returns unclear on invalid JSON', async () => {
    const outcome: ParseOutcome = await parseAnswer(
      { llm: llmReturning('هذا ليس JSON على الإطلاق'), pseudonymizer: identityPseudonymizer },
      { step: 5, text: 'زيدوا صنف غريب', pack: pack(), current: baseState },
      ctx,
    );
    expect(outcome).toEqual({ kind: 'unclear', messageAr: t('setup.unclear') });
  });

  it('returns unclear when the JSON is well-formed but does not fit the step schema', async () => {
    const outcome = await parseAnswer(
      { llm: llmReturning('{"approvalRules":"ليست مصفوفة"}'), pseudonymizer: identityPseudonymizer },
      { step: 3, text: 'خلوا سقف الشراء مختلف', pack: pack(), current: baseState },
      ctx,
    );
    expect(outcome).toEqual({ kind: 'unclear', messageAr: t('setup.unclear') });
  });

  it('returns unclear when step 2 proposes a department code in the wrong format', async () => {
    const body = JSON.stringify({ departments: [{ code: 'warehouse', nameAr: 'المستودع' }], positions: pack().positions });
    const outcome = await parseAnswer(
      { llm: llmReturning(body), pseudonymizer: identityPseudonymizer },
      { step: 2, text: 'زيدوا قسم المستودع', pack: pack(), current: baseState },
      ctx,
    );
    expect(outcome).toEqual({ kind: 'unclear', messageAr: t('setup.unclear') });
  });

  it('sends pseudonymizer.redact(text) with Arabic-Indic digits normalized, never the original text', async () => {
    let seenMessage: unknown;
    const spyLlm: ParseDeps['llm'] = {
      async complete(req) {
        seenMessage = (req.messages[0] as { content: unknown }).content;
        return { text: '{"approvalRules":[]}', toolCalls: [], stopReason: 'end_turn', tokensIn: 0, tokensOut: 0, modelId: 'fake' };
      },
    };
    const fakePseudonymizer: ParseDeps['pseudonymizer'] = {
      redact: (s) => staticPrompt(s.replace('شركة النخيل', '⟦عميل_1⟧')),
    };
    const text = 'خلّوا سقف شركة النخيل ١٠ آلاف ريال';
    await parseAnswer({ llm: spyLlm, pseudonymizer: fakePseudonymizer }, { step: 3, text, pack: pack(), current: baseState }, ctx);

    const expectedNormalized = 'خلّوا سقف شركة النخيل 10 آلاف ريال';
    expect(seenMessage).toBe(fakePseudonymizer.redact(expectedNormalized));
    expect(seenMessage).toBe('خلّوا سقف ⟦عميل_1⟧ 10 آلاف ريال');
  });

  it('never throws on a model/network failure; returns unclear instead', async () => {
    const throwingLlm: ParseDeps['llm'] = {
      async complete() {
        throw new Error('network down');
      },
    };
    const outcome = await parseAnswer(
      { llm: throwingLlm, pseudonymizer: identityPseudonymizer },
      { step: 3, text: 'كلام غير محسوم', pack: pack(), current: baseState },
      ctx,
    );
    expect(outcome).toEqual({ kind: 'unclear', messageAr: t('setup.unclear') });
  });
});

// ─── 8. The prompt file ──────────────────────────────────────────────────────

describe('prompts/setup-parse.md', () => {
  it('contains every placeholder and the required Arabic/English guard words', () => {
    const content = loadPrompt('setup-parse.md');
    for (const placeholder of ['{{step}}', '{{question}}', '{{defaults_json}}', '{{schema_hint}}']) {
      expect(content).toContain(placeholder);
    }
    expect(content).toContain('JSON');
    expect(content).toContain('لا تخترع');
    // T-20: keys are taken verbatim from the closed lists in the hint.
    expect(content).toContain('camelCase');
    expect(content).toContain('ppa_operator');
  });

  it('the step-1 hint lists every profile key with its Arabic title, and the step-6 hint every term key', async () => {
    const seen: string[] = [];
    const llm = {
      async complete(req: { system: unknown }) {
        seen.push(String(req.system));
        return { text: '{"profileKey":"om_provider"}', model: 'fake', inputTokens: 0, outputTokens: 0, latencyMs: 0 } as never;
      },
    };
    const deps: ParseDeps = { llm: llm as never, pseudonymizer: { redact: (x) => staticPrompt(x) } };
    await parseAnswer(deps, { step: 1, text: 'نبيع الكهرباء للعميل بعقد طويل', pack: null, current: initialState() }, { npiOrgId: 'o', npiUserId: 'u' } as never);
    for (const key of ['epc', 'om_provider', 'ppa_operator', 'general_contracting', 'equipment_trading', 'engineering_consulting']) {
      expect(seen[0]).toContain(`"${key}"`);
      expect(seen[0]).toContain(t(`profile.${key}` as never));
    }
    // The parser reads only `pack` and the step's defaults for the hint, not the step order.
    const state = applyAnswer(initialState(), 1, { step: 1, profileKey: 'epc' });
    await parseAnswer(deps, { step: 6, text: 'نسمي أمر الشراء طلبية', pack: loadProfilePack('epc'), current: state }, { npiOrgId: 'o', npiUserId: 'u' } as never);
    expect(seen[1]).toContain('"purchase_order"');
    expect(seen[1]).toContain('"vendor_bill"');
  });
});

// ─── 9. handleSetupAction / getSetupState — orchestration with fakes ───────

function buildFakeSetupDb() {
  const sessions: OnboardingSessionRow[] = [];
  const firmConfigs = new Map<string, Record<string, unknown>>();
  const positions: { id: string; npiOrgId: string; roleKey: string; departmentId: string | null; titleAr: string; personaAr: string }[] = [];
  const positionAssignments: { id: string; positionId: string; npiUserId: string; endedAt: Date | null }[] = [];
  let seq = 0;

  const db = {
    onboardingSession: {
      async findFirst({
        where,
      }: {
        where: { npiOrgId: string; completedAt: null | { not: null } };
      }) {
        if (where.completedAt === null) {
          return sessions.find((s) => s.npiOrgId === where.npiOrgId && s.completedAt === null) ?? null;
        }
        const matches = sessions
          .filter((s) => s.npiOrgId === where.npiOrgId && s.completedAt !== null)
          .sort((a, b) => (b.completedAt as Date).getTime() - (a.completedAt as Date).getTime());
        return matches[0] ?? null;
      },
      async create({ data }: { data: { npiOrgId: string; npiUserId: string; stepsJson: unknown } }) {
        const row: OnboardingSessionRow = {
          id: `sess_${++seq}`,
          npiOrgId: data.npiOrgId,
          npiUserId: data.npiUserId,
          stepsJson: data.stepsJson,
          completedAt: null,
          profileChosen: null,
        };
        sessions.push(row);
        return row;
      },
      async update({
        where,
        data,
      }: {
        where: { id: string };
        data: { stepsJson?: unknown; completedAt?: Date | null; profileChosen?: string | null };
      }) {
        const row = sessions.find((s) => s.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
    },
    firmConfig: {
      async findUnique({ where }: { where: { npiOrgId: string } }) {
        const existing = firmConfigs.get(where.npiOrgId);
        if (!existing) return null;
        return {
          profileKey: (existing.profileKey as string | null | undefined) ?? null,
          visibleModulesJson: existing.visibleModulesJson,
        };
      },
      async upsert({ where, create, update }: { where: { npiOrgId: string }; create: Record<string, unknown>; update: Record<string, unknown> }) {
        const existing = firmConfigs.get(where.npiOrgId);
        firmConfigs.set(where.npiOrgId, existing ? { ...existing, ...update } : { ...create });
        return null;
      },
    },
    position: {
      async findFirst({ where }: { where: { npiOrgId: string; roleKey: string; departmentId: string | null } }) {
        return (
          positions.find((p) => p.npiOrgId === where.npiOrgId && p.roleKey === where.roleKey && p.departmentId === where.departmentId) ?? null
        );
      },
      async create({ data }: { data: { npiOrgId: string; roleKey: string; departmentId: string | null; titleAr: string; personaAr: string } }) {
        const row = { id: `pos_${++seq}`, ...data };
        positions.push(row);
        return { id: row.id };
      },
      async update({ where, data }: { where: { id: string }; data: { titleAr: string; personaAr: string } }) {
        Object.assign(positions.find((p) => p.id === where.id)!, data);
        return null;
      },
    },
    positionAssignment: {
      async findFirst({ where }: { where: { positionId: string; npiUserId: string; endedAt: null } }) {
        return (
          positionAssignments.find((a) => a.positionId === where.positionId && a.npiUserId === where.npiUserId && a.endedAt === null) ?? null
        );
      },
      async create({ data }: { data: { positionId: string; npiUserId: string } }) {
        const row = { id: `pa_${++seq}`, positionId: data.positionId, npiUserId: data.npiUserId, endedAt: null };
        positionAssignments.push(row);
        return row;
      },
      async updateMany({
        where,
        data,
      }: {
        where: { npiUserId: string; endedAt: null; positionId: { not: string }; position: { npiOrgId: string; roleKey: string } };
        data: { endedAt: Date };
      }) {
        for (const a of positionAssignments) {
          if (a.npiUserId !== where.npiUserId || a.endedAt !== null || a.positionId === where.positionId.not) continue;
          const position = positions.find((p) => p.id === a.positionId);
          if (!position || position.npiOrgId !== where.position.npiOrgId || position.roleKey !== where.position.roleKey) continue;
          a.endedAt = data.endedAt;
        }
        return null;
      },
    },
  };
  return { db, sessions, firmConfigs, positions, positionAssignments };
}

function buildDeps(overrides: Partial<SetupDeps> = {}): { deps: SetupDeps; fake: ReturnType<typeof buildFakeSetupDb>; npi: FakeNpi } {
  const fake = buildFakeSetupDb();
  const npi = new FakeNpi();
  const deps: SetupDeps = {
    db: fake.db as unknown as SetupDeps['db'],
    npi,
    llm: countingLlm().llm,
    pseudonymizer: identityPseudonymizer,
    now: () => new Date('2026-10-04T10:00:00.000Z'),
    ...overrides,
  };
  return { deps, fake, npi };
}

const adminSetupCaller: SetupCaller = { npiOrgId: 'org1', npiUserId: 'u1', roleKey: 'admin', permissions: ALL_PERMISSION_KEYS };
const nonAdminCaller: SetupCaller = { npiOrgId: 'org1', npiUserId: 'u2', roleKey: 'sales', permissions: [] };

describe('handleSetupAction / getSetupState — non-admin refusal', () => {
  it('getSetupState throws SetupForbiddenError (status 403) for a non-admin caller', async () => {
    const { deps } = buildDeps();
    await expect(getSetupState(deps, nonAdminCaller)).rejects.toMatchObject({ status: 403 });
    await expect(getSetupState(deps, nonAdminCaller)).rejects.toBeInstanceOf(SetupForbiddenError);
  });

  it('handleSetupAction throws SetupForbiddenError (status 403) for a non-admin caller', async () => {
    const { deps } = buildDeps();
    await expect(handleSetupAction(deps, nonAdminCaller, { action: 'preview' })).rejects.toMatchObject({ status: 403 });
  });
});

describe('getSetupState — one open session per org, reused', () => {
  it('creates a session on first call and reuses it afterwards (T-47a: a manual one stays at step 1)', async () => {
    const { deps, fake } = buildDeps();
    // The wizard seeds a fresh session from NPI unless the administrator chose
    // to type the steps (`manual`); this test is about the session row itself.
    fake.sessions.push({
      id: 'sess_manual',
      npiOrgId: 'org1',
      npiUserId: 'u1',
      stepsJson: { ...initialState(), manual: true },
      completedAt: null,
      profileChosen: null,
    });
    const first = await getSetupState(deps, adminSetupCaller);
    expect(fake.sessions).toHaveLength(1);
    expect(first.state).toEqual({ ...initialState(), manual: true });
    expect(first.question).toEqual({ step: 1, key: 'setup.q1', textAr: t('setup.q1') });

    const second = await getSetupState(deps, adminSetupCaller);
    expect(fake.sessions).toHaveLength(1); // not a new row
    expect(second.state).toEqual(first.state);
  });

  it('T-47a: a fresh organization session is seeded from NPI and shows the summary, once', async () => {
    const { deps, fake } = buildDeps();
    const first = await getSetupState(deps, adminSetupCaller);
    expect(fake.sessions).toHaveLength(1);
    expect(first.state.step).toBe(7);
    expect(first.state.discovery?.discovered).toBe(true);
    expect(first.summary).not.toBeNull();

    const second = await getSetupState(deps, adminSetupCaller);
    expect(fake.sessions).toHaveLength(1);
    expect(second.state).toEqual(first.state); // not read from NPI a second time
  });
});

describe('handleSetupAction — answer', () => {
  it('saves the structured answer into stepsJson and returns the next question', async () => {
    const { deps, fake } = buildDeps();
    const result = await handleSetupAction(deps, adminSetupCaller, { action: 'answer', step: 1, answer: { step: 1, profileKey: 'epc' } });
    expect('parsed' in result && result.parsed).toEqual({ step: 1, profileKey: 'epc' });
    expect('source' in result && result.source).toBe('structured');
    expect(fake.sessions[0].stepsJson).toEqual({ step: 2, answers: { profileKey: 'epc' }, completedSteps: [1] });
  });

  it('parses free text through parseAnswer and saves the deterministic result', async () => {
    const { deps, fake } = buildDeps();
    const result = await handleSetupAction(deps, adminSetupCaller, { action: 'answer', step: 1, text: 'إحنا مقاول EPC' });
    expect('parsed' in result && result.parsed).toEqual({ step: 1, profileKey: 'epc' });
    expect('source' in result && result.source).toBe('deterministic');
    expect(fake.sessions[0].stepsJson).toMatchObject({ answers: { profileKey: 'epc' } });
  });

  it('returns { unclear } without touching the stored state when the text cannot be parsed', async () => {
    const { deps, fake } = buildDeps({
      llm: { async complete() { return { text: 'ليس JSON', toolCalls: [], stopReason: 'end_turn', tokensIn: 0, tokensOut: 0, modelId: 'fake' }; } },
    });
    await handleSetupAction(deps, adminSetupCaller, { action: 'answer', step: 1, answer: { step: 1, profileKey: 'epc' } });
    const before = fake.sessions[0].stepsJson;
    const result = await handleSetupAction(deps, adminSetupCaller, { action: 'answer', step: 2, text: 'كلام لا معنى له إطلاقاً هنا' });
    expect(result).toEqual({ unclear: t('setup.unclear') });
    expect(fake.sessions[0].stepsJson).toEqual(before);
  });

  it('rejects an answer that breaks a pack cross-check as a 400-shaped MachineError', async () => {
    const { deps } = buildDeps();
    await handleSetupAction(deps, adminSetupCaller, { action: 'answer', step: 1, answer: { step: 1, profileKey: 'epc' } });
    const departmentsWithoutSite = pack().defaultDepartments.filter((d) => d.code !== 'SITE');
    await expect(
      handleSetupAction(deps, adminSetupCaller, {
        action: 'answer',
        step: 2,
        answer: { step: 2, departments: departmentsWithoutSite, positions: pack().positions },
      }),
    ).rejects.toMatchObject({ code: 'invalid_answer' });
  });
});

describe('handleSetupAction — preview and apply', () => {
  async function answerAllSteps(deps: SetupDeps, caller: SetupCaller) {
    await handleSetupAction(deps, caller, { action: 'answer', step: 1, answer: { step: 1, profileKey: 'epc' } });
    await handleSetupAction(deps, caller, {
      action: 'answer',
      step: 2,
      answer: { step: 2, departments: pack().defaultDepartments, positions: pack().positions },
    });
    await handleSetupAction(deps, caller, { action: 'answer', step: 3, answer: { step: 3, approvalRules: pack().approvalRuleDefaults } });
    await handleSetupAction(deps, caller, {
      action: 'answer',
      step: 4,
      answer: { step: 4, acceptedDocTypeKeys: pack().acceptedDocTypes.map((d) => d.key) },
    });
    await handleSetupAction(deps, caller, { action: 'answer', step: 5, answer: { step: 5, items: pack().itemTemplates } });
    await handleSetupAction(deps, caller, { action: 'answer', step: 6, answer: { step: 6, terminology: pack().terminology } });
  }

  it('preview returns a plan (without permissionLabel) and an Arabic summary', async () => {
    const { deps, npi } = buildDeps();
    npi.addUser('pm');
    npi.addUser('accountant');
    await answerAllSteps(deps, adminSetupCaller);

    const result = await handleSetupAction(deps, adminSetupCaller, { action: 'preview' });
    expect('plan' in result).toBe(true);
    if ('plan' in result) {
      expect((result.plan as { permissionLabel?: unknown }).permissionLabel).toBeUndefined();
      expect(result.plan.counts.blocked).toBe(0);
      expect(result.summary.npi.length).toBeGreaterThan(0);
    }
  });

  it('apply persists firm_config and completes the onboarding session', async () => {
    const { deps, fake, npi } = buildDeps();
    npi.addUser('pm');
    npi.addUser('accountant');
    await answerAllSteps(deps, adminSetupCaller);

    const result = await handleSetupAction(deps, adminSetupCaller, { action: 'apply' });
    expect('result' in result).toBe(true);
    if ('result' in result) {
      expect(result.result.completed).toBe(true);
      expect(result.persisted.positionsWritten).toBeGreaterThan(0);
    }

    expect(fake.firmConfigs.get('org1')).toMatchObject({ profileKey: 'epc' });
    expect(fake.sessions[0].completedAt).toEqual(new Date('2026-10-04T10:00:00.000Z'));
    expect(fake.sessions[0].profileChosen).toBe('epc');
  });

  it('preview and apply refuse a session whose step 1 was never answered', async () => {
    const { deps } = buildDeps();
    await expect(handleSetupAction(deps, adminSetupCaller, { action: 'preview' })).rejects.toMatchObject({ code: 'step_out_of_order' });
  });

  it('preview carries a permissionLabels entry for every key named in a role step', async () => {
    const { deps, npi } = buildDeps();
    npi.addUser('pm');
    npi.addUser('accountant');
    await answerAllSteps(deps, adminSetupCaller);

    const result = await handleSetupAction(deps, adminSetupCaller, { action: 'preview' });
    expect('plan' in result && 'permissionLabels' in result).toBe(true);
    if ('plan' in result && 'permissionLabels' in result) {
      const keys = new Set<string>();
      for (const step of result.plan.steps) {
        if (step.kind !== 'role') continue;
        for (const k of [...step.permissions, ...step.permissionsAdded, ...step.permissionsRemoved]) keys.add(k);
      }
      expect(keys.size).toBeGreaterThan(0);
      expect(Object.keys(result.permissionLabels).sort()).toEqual([...keys].sort());
      for (const k of keys) {
        const expectedLabel = PERMISSION_CATALOG.find((p) => p.key === k)?.labelAr ?? k;
        expect(result.permissionLabels[k]).toBe(expectedLabel);
      }
    }
  });

  it('apply writes an assignment for each valid holder and reports the skipped ones', async () => {
    const { deps, fake, npi } = buildDeps();
    const pmUser = npi.addUser('pm');
    npi.addUser('accountant');
    await handleSetupAction(deps, adminSetupCaller, { action: 'answer', step: 1, answer: { step: 1, profileKey: 'epc' } });
    const holders = [{ roleKey: 'pm', departmentCode: 'PROJ', npiUserIds: [pmUser.id, 'unknown_user_id'] }];
    await handleSetupAction(deps, adminSetupCaller, {
      action: 'answer',
      step: 2,
      answer: { step: 2, departments: pack().defaultDepartments, positions: pack().positions, holders },
    });
    await handleSetupAction(deps, adminSetupCaller, { action: 'answer', step: 3, answer: { step: 3, approvalRules: pack().approvalRuleDefaults } });
    await handleSetupAction(deps, adminSetupCaller, {
      action: 'answer',
      step: 4,
      answer: { step: 4, acceptedDocTypeKeys: pack().acceptedDocTypes.map((d) => d.key) },
    });
    await handleSetupAction(deps, adminSetupCaller, { action: 'answer', step: 5, answer: { step: 5, items: pack().itemTemplates } });
    await handleSetupAction(deps, adminSetupCaller, { action: 'answer', step: 6, answer: { step: 6, terminology: pack().terminology } });

    const result = await handleSetupAction(deps, adminSetupCaller, { action: 'apply' });
    expect('persisted' in result).toBe(true);
    if ('persisted' in result) {
      expect(result.persisted.assignmentsWritten).toBe(1);
      expect(result.persisted.holdersSkipped).toEqual([
        { roleKey: 'pm', departmentCode: 'PROJ', npiUserId: 'unknown_user_id', reason: 'unknown_user' },
      ]);
    }
    const pmPosition = fake.positions.find((p) => p.roleKey === 'pm')!;
    expect(
      fake.positionAssignments.some((a) => a.positionId === pmPosition.id && a.npiUserId === pmUser.id && a.endedAt === null),
    ).toBe(true);
  });
});

describe('getSetupState — step 2 npiUsers', () => {
  it('lists directory users with nameAr for a caller holding admin.department.manage, empty for one without', async () => {
    const { deps, npi } = buildDeps();
    const pmUser = npi.addUser('pm', 'أحمد');
    await handleSetupAction(deps, adminSetupCaller, { action: 'answer', step: 1, answer: { step: 1, profileKey: 'epc' } });

    const view = await getSetupState(deps, adminSetupCaller);
    expect(view.state.step).toBe(2);
    const positions = view.defaults && 'positions' in view.defaults ? view.defaults.positions : [];
    expect(positions.find((p) => p.roleKey === 'pm')?.npiUsers).toEqual([{ id: pmUser.id, nameAr: 'أحمد', roleKey: 'pm', isActive: true }]);

    const noDeptCaller: SetupCaller = { ...adminSetupCaller, permissions: ALL_PERMISSION_KEYS.filter((p) => p !== 'admin.department.manage') };
    const view2 = await getSetupState(deps, noDeptCaller);
    const positions2 = view2.defaults && 'positions' in view2.defaults ? view2.defaults.positions : [];
    expect(positions2.find((p) => p.roleKey === 'pm')?.npiUsers).toEqual([]);
  });
});

// ─── Reviewer probe (T-16/T-17 review): mixed sentences must reach the model ─

describe('parseAnswer — a matching word inside a longer sentence is not enough', () => {
  function run(step: 1 | 2 | 3 | 4 | 5 | 6, text: string) {
    const { llm, calls } = countingLlm();
    const pack = loadProfilePack('epc');
    let state = initialState();
    if (step !== 1) state = applyAnswer(state, 1, { step: 1, profileKey: 'epc' });
    const deps: ParseDeps = { llm, pseudonymizer: { redact: (x) => staticPrompt(x) } };
    return parseAnswer(deps, { step, text, pack: step === 1 ? null : pack, current: state }, { npiOrgId: 'o', npiUserId: 'u' } as never).then(
      (outcome) => ({ outcome, modelCalls: calls.length }),
    );
  }

  it.each([
    [1, 'لا نسوي EPC أبداً، إحنا استشارات'],
    [1, 'إحنا بين EPC والمقاولات العامة'],
    // A bare «غير» still negates.
    [1, 'غير EPC، إحنا تشغيل وصيانة'],
    [2, 'موافق بس أضف قسم الجودة'],
    [3, 'نعمل بالافتراضي لكن ارفع سقف طلب الشراء'],
    [3, 'خلّ أمر الشراء من 50 ألف'],
    [4, 'بدون طلب الشراء'],
    [6, 'لا نسمّي العميل عميل، نسمّيه المالك'],
  ] as const)('step %i «%s» goes to the model', async (step, text) => {
    const { outcome, modelCalls } = await run(step, text);
    expect(modelCalls).toBe(1);
    expect(outcome.kind === 'answer' ? outcome.source : 'unclear').not.toBe('deterministic');
  });

  it.each([
    [1, 'إحنا مقاول EPC نسوي تصميم وتوريد وتركيب', 'epc'],
    [1, 'شركة تشغيل وصيانة لمحطات شمسية', 'om_provider'],
    [1, 'نبيع الطاقة باتفاقيات PPA ونؤجر الأنظمة', 'ppa_operator'],
    [1, 'مكتب استشارات هندسية', 'engineering_consulting'],
    // T-20 live run: «للغير» ("for third parties") is the noun with its
    // article, not the negation «غير» — the eval sample must stay deterministic.
    [1, 'نشتغل تشغيل وصيانة لمحطات الطاقة الشمسية للغير', 'om_provider'],
    [1, 'صيانة وتشغيل وصيانة محطات لصالح الغير', 'om_provider'],
  ] as const)('step 1 «%s» is read deterministically as %s', async (step, text, profileKey) => {
    const { outcome, modelCalls } = await run(step, text);
    expect(modelCalls).toBe(0);
    expect(outcome).toMatchObject({ kind: 'answer', source: 'deterministic', answer: { step: 1, profileKey } });
  });

  it.each([
    [2, 'نعم كما هو'],
    [2, 'اعتمد المقترح'],
    [3, 'الافتراضي'],
    [3, 'تمام، خلّه كما هو'],
    [4, 'نعم'],
    [5, 'تمام'],
    [6, 'ما عندنا مصطلحات خاصة'],
    [6, 'لا'],
  ] as const)('step %i «%s» accepts the default deterministically', async (step, text) => {
    const { outcome, modelCalls } = await run(step, text);
    expect(modelCalls).toBe(0);
    expect(outcome).toMatchObject({ kind: 'answer', source: 'deterministic', answer: { step } });
  });
});

// ─── T-18 reviewer probes of the parser ─────────────────────────────────────
// Real sentences from the owner's acceptance scenario (09 §2.2) and from the
// live run of the setup screen against the local NPI.
describe('parseAnswer — several profiles named, placeholders in model output (T-18 probe)', () => {
  const ctx = { npiOrgId: 'org1', npiUserId: 'u1' } as unknown as Parameters<typeof parseAnswer>[2];
  function deps(reply: string) {
    const calls: string[] = [];
    const llm: ParseDeps['llm'] = {
      async complete(req) {
        calls.push(String(req.messages[0].content));
        return { text: reply, tokensIn: 1, tokensOut: 1 } as unknown as Awaited<ReturnType<ParseDeps['llm']['complete']>>;
      },
    };
    return { calls, deps: { llm, pseudonymizer: { redact: (s: string) => staticPrompt(s) } } };
  }
  const fresh = (): SetupState => initialState();

  it('09 §2.2: «شركة طاقة شمسية تعمل EPC وتشغيل وصيانة» → EPC first, both activities as revenue lines, no model call', async () => {
    const { calls, deps: d } = deps('{}');
    const out = await parseAnswer(d, { step: 1, text: 'شركة طاقة شمسية تعمل EPC وتشغيل وصيانة', pack: null, current: fresh() }, ctx);
    expect(out).toEqual({
      kind: 'answer',
      source: 'deterministic',
      answer: { step: 1, profileKey: 'epc', revenueLines: [t('profile.epc'), t('profile.om_provider')] },
    });
    expect(calls).toHaveLength(0);
  });

  it('the first-named activity wins: «إحنا تشغيل وصيانة وأحياناً نسوي EPC» → om_provider', async () => {
    const { deps: d } = deps('{}');
    const out = await parseAnswer(d, { step: 1, text: 'إحنا تشغيل وصيانة وأحياناً نسوي EPC', pack: null, current: fresh() }, ctx);
    expect(out).toMatchObject({ kind: 'answer', source: 'deterministic', answer: { step: 1, profileKey: 'om_provider' } });
  });

  it('a negation still sends two named profiles to the model: «لا نسوي EPC، إحنا استشارات هندسية»', async () => {
    const { calls, deps: d } = deps('{"step":1,"profileKey":"engineering_consulting"}');
    const out = await parseAnswer(d, { step: 1, text: 'لا نسوي EPC، إحنا استشارات هندسية', pack: null, current: fresh() }, ctx);
    expect(calls).toHaveLength(1);
    expect(out).toMatchObject({ kind: 'answer', source: 'model', answer: { step: 1, profileKey: 'engineering_consulting' } });
  });

  it('model output that copies a redaction placeholder into a value is refused as unclear', async () => {
    const { deps: d } = deps('```json\n{"step":1,"profileKey":"om_provider","revenueLines":["⟦جهة_1⟧","تشغيل وصيانة"]}\n```');
    const out = await parseAnswer(d, { step: 1, text: 'كلام يحتاج النموذج هنا', pack: null, current: fresh() }, ctx);
    expect(out).toEqual({ kind: 'unclear', messageAr: t('setup.unclear') });
  });
});

describe('parseAnswer — hedged multi-profile sentences still reach the model (T-18 probe)', () => {
  const ctx = { npiOrgId: 'org1', npiUserId: 'u1' } as unknown as Parameters<typeof parseAnswer>[2];
  it.each(['EPC أو تشغيل وصيانة؟', 'محتارين بين تجارة المعدات والاستشارات الهندسية', 'ما أدري إذا نعتبر مقاولات عامة أو EPC'])(
    '«%s» goes to the model',
    async (text) => {
      let calls = 0;
      const llm: ParseDeps['llm'] = {
        async complete() {
          calls += 1;
          return { text: '{"step":1,"profileKey":"epc"}', tokensIn: 1, tokensOut: 1 } as unknown as Awaited<ReturnType<ParseDeps['llm']['complete']>>;
        },
      };
      const out = await parseAnswer({ llm, pseudonymizer: { redact: (s: string) => staticPrompt(s) } }, { step: 1, text, pack: null, current: initialState() }, ctx);
      expect(calls).toBe(1);
      expect(out).toMatchObject({ kind: 'answer', source: 'model' });
    },
  );
});
