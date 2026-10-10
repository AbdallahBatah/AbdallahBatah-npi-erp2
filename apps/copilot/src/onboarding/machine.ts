// Pure 7-step onboarding state machine (T-17, spec/madar/02 §7, binding
// rules in spec/madar/08 §E). No I/O and no clock of its own: the one
// unavoidable read (the profile pack a chosen `profileKey` names) is
// injected, defaulting to the real loader so production callers never have
// to pass it.
//
// The seven steps are the setup screens, in order:
//   1  النشاط وخطوط الإيراد (profile pick — must come first; everything
//      else is "relative to the pack" this step chose)
//   2  الأقسام والمناصب وشاغلوها
//   3  سقوف الاعتماد
//   4  المستندات المتداولة
//   5  الأصناف الشائعة
//   6  المصطلحات
//   7  الملخص («هذا ما سأضبطه في NPI») — never answered through this
//      machine; it is reached once steps 1–6 are complete and its content
//      comes from T-16's `dryRun`/`summarizePlanAr`, not from here.
//
// A step may be re-answered later (02 §7: "re-runnable per step from
// /settings"); re-answering step 1 with a *different* profile key clears
// steps 2–6, because their answers were edits relative to the old pack and
// make no promise against the new one.
import { z } from 'zod';
import { loadProfilePack } from './catalog';
import { effectivePack, PlanError, SETUP_SOURCES, SetupAnswersSchema, type SetupAnswers, type SetupSource } from './plan';
import {
  ApprovalRuleDefaultSchema,
  DepartmentSchema,
  ItemTemplateSchema,
  PositionHolderSchema,
  PositionSchema,
  PROFILE_KEYS,
  RolePermissionSetSchema,
  TERM_KEYS,
  type ProfileKey,
  type ProfilePack,
  type TermKey,
} from './profile.schema';
import { t, type ArKey } from '../i18n/ar';

// ─── Steps ──────────────────────────────────────────────────────────────────

export const SETUP_STEPS = [1, 2, 3, 4, 5, 6, 7] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

export const SetupStepSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
  z.literal(7),
]);

/**
 * What discovery (T-47a, `discover.ts`) leaves in the session next to the
 * seeded answers: which source each step came from, the guess behind step 1,
 * and the organization's own roles the answers were validated against. The
 * summary screen reads it; `toAnswers` hands the plan the roles and sources.
 */
export const DiscoveryMetaSchema = z.object({
  discovered: z.literal(true),
  /** ISO time of the discovery. */
  at: z.string(),
  sources: z.partialRecord(z.enum(['1', '2', '3', '4', '5', '6']), z.enum(SETUP_SOURCES)),
  /** NPI's own roles, absent when discovery fell back to the pack's roles. */
  roleSets: z.record(z.string(), RolePermissionSetSchema).optional(),
  evidence: z.object({
    profileKey: z.enum(PROFILE_KEYS),
    confidence: z.enum(['high', 'medium', 'low']),
    reasonsAr: z.array(z.string()),
    scores: z.record(z.string(), z.number()),
    /** Things the reading left out, in Arabic (a user without a department
     *  in a role the pack lacks, a rule NPI holds that cannot be mapped…). */
    skippedAr: z.array(z.string()),
  }),
  /** True from the seeding until the summary is confirmed or edited away. */
  needsReview: z.boolean(),
});
export type DiscoveryMeta = z.infer<typeof DiscoveryMetaSchema>;

export interface SetupState {
  step: SetupStep;
  answers: Partial<SetupAnswers>;
  completedSteps: SetupStep[];
  /** T-47a: the wizard must not try to discover again (the administrator
   *  chose to type the steps, or discovery was impossible). */
  manual?: boolean;
  /** T-47a: set when the answers were read from NPI. */
  discovery?: DiscoveryMeta;
  /** T-47a: NPI read permissions discovery lacked (fallback to the manual wizard). */
  discoveryMissing?: string[];
}

/** What `onboarding_sessions.stepsJson` stores; reads it back from JSON. */
export const SetupStateSchema = z.object({
  step: SetupStepSchema,
  answers: SetupAnswersSchema.partial(),
  completedSteps: z.array(SetupStepSchema),
  manual: z.boolean().optional(),
  discovery: DiscoveryMetaSchema.optional(),
  discoveryMissing: z.array(z.string()).optional(),
});

export function initialState(): SetupState {
  return { step: 1, answers: {}, completedSteps: [] };
}

export type SetupQuestionKey = 'setup.q1' | 'setup.q2' | 'setup.q3' | 'setup.q4' | 'setup.q5' | 'setup.q6' | 'setup.diff';

const QUESTION_KEY_BY_STEP: Record<SetupStep, SetupQuestionKey> = {
  1: 'setup.q1',
  2: 'setup.q2',
  3: 'setup.q3',
  4: 'setup.q4',
  5: 'setup.q5',
  6: 'setup.q6',
  7: 'setup.diff',
};

export function questionKey(step: SetupStep): SetupQuestionKey {
  return QUESTION_KEY_BY_STEP[step];
}

// ─── Defaults the screen shows for a step ──────────────────────────────────

export interface StepDefaultsNpiUser {
  id: string;
  nameAr: string;
  roleKey: string;
  isActive: boolean;
}

export interface StepDefaultsContext {
  npiUsers?: StepDefaultsNpiUser[];
  /** Discovered sessions: NPI's own roles, named instead of the pack's (step 3). */
  roleSets?: Record<string, { nameAr: string }>;
}

export interface Step1Defaults {
  step: 1;
  profiles: { key: ProfileKey; titleAr: string }[];
}
export type Step2Position = ProfilePack['positions'][number] & {
  /** NPI users whose role matches and are active — information only; this
   *  machine never assigns a user to a position (that is a T-18 picker). */
  npiUsers: StepDefaultsNpiUser[];
};
export interface Step2Defaults {
  step: 2;
  departments: ProfilePack['defaultDepartments'];
  positions: Step2Position[];
  /** Active NPI users by role key — set for discovered sessions, whose
   *  positions are NPI's roles rather than the pack's. */
  usersByRole?: Record<string, StepDefaultsNpiUser[]>;
}
export interface Step3Defaults {
  step: 3;
  approvalRules: ProfilePack['approvalRuleDefaults'];
  /** Arabic display name of every role the pack declares, so the screen can
   *  name a chain's roles instead of showing their keys (T-18). */
  roleNamesAr: Record<string, string>;
}
export interface Step4Defaults {
  step: 4;
  acceptedDocTypes: ProfilePack['acceptedDocTypes'];
}
export interface Step5Defaults {
  step: 5;
  items: ProfilePack['itemTemplates'];
}
export interface Step6Defaults {
  step: 6;
  terminology: Partial<Record<TermKey, string>>;
}
export interface Step7Defaults {
  step: 7;
  /** The plan comes from T-16's `dryRun`, never from this machine. */
  plan: null;
}

export type StepDefaults =
  | Step1Defaults
  | Step2Defaults
  | Step3Defaults
  | Step4Defaults
  | Step5Defaults
  | Step6Defaults
  | Step7Defaults;

/**
 * The proposal the screen shows for `step`. `null` only when `pack` is
 * `null` and `step > 1` — step 1 always has its six profile choices, whether
 * or not a pack has been chosen yet.
 */
export function stepDefaults(step: SetupStep, pack: ProfilePack | null, context: StepDefaultsContext = {}): StepDefaults | null {
  if (step === 1) {
    return {
      step: 1,
      profiles: PROFILE_KEYS.map((key) => ({ key, titleAr: t(`profile.${key}` as ArKey) })),
    };
  }
  if (pack === null) return null;

  switch (step) {
    case 2: {
      const npiUsers = context.npiUsers ?? [];
      const positions: Step2Position[] = pack.positions.map((position) => ({
        ...position,
        npiUsers: npiUsers.filter((u) => u.isActive && u.roleKey === position.roleKey),
      }));
      return { step: 2, departments: pack.defaultDepartments, positions };
    }
    case 3: {
      const roleNamesAr: Record<string, string> = {};
      for (const [roleKey, roleSet] of Object.entries(context.roleSets ?? pack.rolePermissionSets)) roleNamesAr[roleKey] = roleSet.nameAr;
      return { step: 3, approvalRules: pack.approvalRuleDefaults, roleNamesAr };
    }
    case 4:
      return { step: 4, acceptedDocTypes: pack.acceptedDocTypes };
    case 5:
      return { step: 5, items: pack.itemTemplates };
    case 6:
      return { step: 6, terminology: pack.terminology };
    case 7:
      return { step: 7, plan: null };
    default:
      return null;
  }
}

// ─── Answers ────────────────────────────────────────────────────────────────

/**
 * One step's answer, as T-17's `parse.ts` produces it and T-18's screens
 * edit it. Mirrors `SetupAnswersSchema`'s own field schemas (`plan.ts`),
 * made required since answering a step means supplying that step's value —
 * the two are kept in lockstep by hand because zod 4's `.optional()` wrapper
 * cannot be unwrapped generically without losing field-level inference.
 * Step 7 is the summary, never an answer — it has no member here.
 */
export const StepAnswerSchema = z.discriminatedUnion('step', [
  z.object({
    step: z.literal(1),
    profileKey: z.enum(PROFILE_KEYS),
    revenueLines: z.array(z.string().min(2)).min(1).optional(),
  }),
  z.object({
    step: z.literal(2),
    departments: z.array(DepartmentSchema).min(1),
    positions: z.array(PositionSchema).min(1),
    holders: z.array(PositionHolderSchema).optional(),
  }),
  z.object({
    step: z.literal(3),
    approvalRules: z.array(ApprovalRuleDefaultSchema),
  }),
  z.object({
    step: z.literal(4),
    acceptedDocTypeKeys: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    step: z.literal(5),
    items: z.array(ItemTemplateSchema),
  }),
  z.object({
    step: z.literal(6),
    terminology: z.partialRecord(z.enum(TERM_KEYS), z.string().min(1)),
  }),
]);
export type StepAnswer = z.infer<typeof StepAnswerSchema>;

export type MachineErrorCode = 'step_out_of_order' | 'invalid_answer';

/** Thrown by `applyAnswer`/`goTo` on a move the machine refuses. Carries
 *  zod-shaped issues so the screen can point at the offending field, the
 *  same shape `PlanError` uses. */
export class MachineError extends Error {
  readonly code: MachineErrorCode;
  readonly issues: { path: string; message: string }[];

  constructor(code: MachineErrorCode, message: string, issues: { path: string; message: string }[] = []) {
    super(message);
    this.name = 'MachineError';
    this.code = code;
    this.issues = issues;
  }
}

function nextOpenStep(completedSteps: readonly SetupStep[]): SetupStep {
  for (const step of SETUP_STEPS) {
    if (!completedSteps.includes(step)) return step;
  }
  return 7;
}

export interface ApplyAnswerDeps {
  /** Overridable for tests; defaults to the real `loadProfilePack`. The one
   *  non-pure call this file makes. */
  loadPack?: (key: string) => ProfilePack;
}

/**
 * Validates `answer` against the pack it would apply to (via T-16's
 * `effectivePack`, never re-implemented here), merges it into `state`, marks
 * `step` completed, and moves `state.step` to the next unanswered step
 * (capped at 7). Rules (spec/madar/02 §7):
 *  - step 1 must be answered before any other step (`step_out_of_order`);
 *  - answering step 1 with a *different* `profileKey` than before clears the
 *    answers (and completion) of steps 2–6;
 *  - an answer that, laid over the pack, breaks a cross-check T-14 wrote
 *    (e.g. a position naming a department just removed) is refused at the
 *    step where it was made (`invalid_answer`, carrying `PlanError`'s
 *    issues);
 *  - a step may be answered again later; re-answering does not move
 *    `completedSteps` backwards.
 */
export function applyAnswer(state: SetupState, step: SetupStep, answer: StepAnswer, deps: ApplyAnswerDeps = {}): SetupState {
  const loadPack = deps.loadPack ?? loadProfilePack;

  if (answer.step !== step) {
    throw new MachineError('invalid_answer', `answer.step (${answer.step}) does not match the requested step (${step})`, [
      { path: 'step', message: `expected ${step}, got ${answer.step}` },
    ]);
  }
  if (step !== 1 && state.answers.profileKey === undefined) {
    throw new MachineError('step_out_of_order', 'step 1 (the profile) must be answered before any other step', [
      { path: 'profileKey', message: 'not answered yet' },
    ]);
  }

  let answers: Partial<SetupAnswers> = { ...state.answers };
  let completedSteps = [...state.completedSteps];
  // Discovered answers survive an edit (the edited step becomes the
  // administrator's own); a different profile makes them meaningless, so the
  // session turns into today's manual wizard.
  let discovery: DiscoveryMeta | undefined = state.discovery;
  let manual = state.manual;

  if (answer.step === 1) {
    const changedProfile = answers.profileKey !== undefined && answers.profileKey !== answer.profileKey;
    if (changedProfile) {
      answers = { profileKey: answer.profileKey, revenueLines: answer.revenueLines };
      completedSteps = [];
      discovery = undefined;
      manual = true;
    } else {
      answers.profileKey = answer.profileKey;
      if (answer.revenueLines !== undefined) answers.revenueLines = answer.revenueLines;
    }
  } else if (answer.step === 2) {
    answers.departments = answer.departments;
    answers.positions = answer.positions;
    // A free-text re-answer (parsed by the model) never carries `holders`
    // and must not wipe a choice already made in the picker; a structured
    // answer that *does* carry `holders` (even `[]`) replaces it outright.
    if (answer.holders !== undefined) answers.holders = answer.holders;
    // Holders are a convenience over positions, not a contract of their own:
    // prune any entry whose (roleKey, departmentCode) no longer names a
    // position in the list just answered, dropping the rest silently.
    if (answers.holders !== undefined) {
      const positionKeys = new Set(answer.positions.map((p) => `${p.roleKey}\u0000${p.departmentCode ?? ''}`));
      answers.holders = answers.holders.filter((h) => positionKeys.has(`${h.roleKey}\u0000${h.departmentCode ?? ''}`));
    }
  } else if (answer.step === 3) {
    answers.approvalRules = answer.approvalRules;
  } else if (answer.step === 4) {
    answers.acceptedDocTypeKeys = answer.acceptedDocTypeKeys;
  } else if (answer.step === 5) {
    answers.items = answer.items;
  } else {
    answers.terminology = answer.terminology;
  }

  // profileKey is always set by now: either this call just set it (step 1),
  // or the step-order check above already refused the call.
  const profileKey = answers.profileKey as ProfileKey;
  let pack: ProfilePack;
  try {
    pack = loadPack(profileKey);
  } catch (err) {
    throw new MachineError('invalid_answer', err instanceof Error ? err.message : String(err), [
      { path: 'profileKey', message: `could not load profile "${profileKey}"` },
    ]);
  }
  try {
    effectivePack(pack, withDiscovery(answers as SetupAnswers, discovery));
  } catch (err) {
    if (err instanceof PlanError) {
      throw new MachineError('invalid_answer', err.message, err.issues);
    }
    throw err;
  }

  if (!completedSteps.includes(step)) completedSteps = [...completedSteps, step].sort((a, b) => a - b);

  if (discovery !== undefined) {
    discovery = { ...discovery, sources: { ...discovery.sources, [String(step)]: 'manual' as SetupSource } };
  }

  const next: SetupState = { step: nextOpenStep(completedSteps), answers, completedSteps };
  if (manual !== undefined) next.manual = manual;
  if (discovery !== undefined) next.discovery = discovery;
  return next;
}

/** The answers with what discovery knows about NPI laid on (its roles and the
 *  per-step sources) — what `effectivePack` and the plan read. */
function withDiscovery(answers: SetupAnswers, discovery: DiscoveryMeta | undefined): SetupAnswers {
  if (discovery === undefined) return answers;
  return { ...answers, npiRoleSets: discovery.roleSets, sources: discovery.sources };
}

/**
 * Moves to an already-completed step (back) or the next open one (forward
 * by exactly one); any other target is refused — there is nothing to show
 * for a step that was never reached and is not next.
 */
export function goTo(state: SetupState, step: SetupStep): SetupState {
  const open = nextOpenStep(state.completedSteps);
  if (state.completedSteps.includes(step) || step === open) {
    return { ...state, step };
  }
  throw new MachineError('step_out_of_order', `step ${step} is neither completed nor the next open step (${open})`, [
    { path: 'step', message: `step ${step} is not reachable yet` },
  ]);
}

/** Requires step 1 to have been answered; the `SetupAnswers` object T-16's
 *  `buildPlan`/`dryRun` take. */
export function toAnswers(state: SetupState): SetupAnswers {
  if (state.answers.profileKey === undefined) {
    throw new MachineError('step_out_of_order', 'step 1 (the profile) has not been answered yet', [
      { path: 'profileKey', message: 'not answered yet' },
    ]);
  }
  return withDiscovery(state.answers as SetupAnswers, state.discovery);
}

export function isReadyForPlan(state: SetupState): boolean {
  return state.answers.profileKey !== undefined;
}
