// Shared shapes of the settings screen (T-19, F-15, spec/madar/02 §5.9 and
// §7 "re-runnable per step from /settings"). This file holds TYPES ONLY —
// no imports of server code — so the client components can `import type`
// from it the same way `src/components/setup/api.ts` imports from
// `@/onboarding/*`.
//
// What the screen shows (01 §4 F-15, 09 §2.6): the firm's profile, the
// visible modules, the accepted document types, the terminology, the
// copilot positions with their holders, one manual baseline per chat flow
// («الزمن اليدوي المرجعي»), and what the last apply left blocked or refused.
//
// Ownership of writes (D-7 derivation, logged in PROGRESS.md):
//  - everything the setup wizard asks about (profile, departments and
//    positions, approval rules, doc types, items, terminology) is edited by
//    RE-RUNNING that wizard step (`rerun`), never by a second write path here,
//    so the onboarding session's answers and `firm_config` cannot diverge;
//  - the two things no wizard step asks about — module visibility and the
//    manual baselines — are written directly by this screen.
import type { FlowType } from '../agents/router';
import type { SetupStep } from '../onboarding/machine';
import type { NpiApiGap } from '../onboarding/gaps';
import type { ModuleKey, ProfileKey, TermKey } from '../onboarding/profile.schema';

/** Steps the settings screen may re-open; 7 is the summary and is never a
 *  target (the wizard reaches it on its own once a step is saved). */
export type RerunStep = Exclude<SetupStep, 7>;

export interface SettingsDocType {
  key: string;
  labelAr: string;
  /** `null` = named by the firm but entered in NPI's own screens. */
  flow: FlowType | null;
}

/** One plan step the last apply left blocked or refused (`firm_config.
 *  npiApiGapsJson.blocked|failed`), resolved to the wizard step that can
 *  change it. Keyed by the step id's KIND (and, for a rule, its document
 *  type), never by the threshold embedded in the id — a moved threshold
 *  changes the id but not where the administrator goes to fix it
 *  (PROGRESS.md Suggestions, T-19). */
export interface SettingsLeftover {
  stepId: string;
  kind: 'department' | 'role' | 'approval_rule' | 'item' | 'unknown';
  /** Arabic description built from the id: «قسم SALES», «دور المحاسب»,
   *  «سقف أمر الشراء من 100,000», «صنف MOD-600». */
  labelAr: string;
  reasonAr: string;
  /** NPI's own message for a refused step; `null` for a blocked one. */
  npiMessage: string | null;
  /** 2 for departments and roles, 3 for approval rules, 5 for items;
   *  `null` when the id's kind is not recognised. */
  setupStep: RerunStep | null;
}

export interface SettingsLastApply {
  /** ISO timestamp (`npiApiGapsJson.appliedAt`). */
  appliedAt: string;
  gaps: NpiApiGap[];
  blocked: SettingsLeftover[];
  failed: SettingsLeftover[];
}

export interface SettingsConfig {
  profileKey: ProfileKey;
  profileTitleAr: string;
  /** ISO timestamp, `null` when the last apply did not complete. */
  setupCompletedAt: string | null;
  visibleModules: ModuleKey[];
  acceptedDocTypes: SettingsDocType[];
  terminology: Partial<Record<TermKey, string>>;
  lastApply: SettingsLastApply | null;
}

export interface SettingsPositionHolder {
  npiUserId: string;
  /** From NPI's department directory; `null` when the caller may not read
   *  it, or the user is no longer listed. */
  nameAr: string | null;
  /** ISO timestamp of the open assignment. */
  since: string;
}

export interface SettingsPosition {
  id: string;
  roleKey: string;
  /** The pack's Arabic role name when the profile is known and names the
   *  role; otherwise the key itself. */
  roleNameAr: string;
  departmentId: string | null;
  /** From NPI's `/admin/departments` when readable; `null` otherwise or
   *  when the position has no department. */
  departmentNameAr: string | null;
  titleAr: string;
  holders: SettingsPositionHolder[];
}

export interface SettingsBaseline {
  /** Whole minutes the owner measured with a stopwatch on NPI's screen. */
  minutes: number;
  /** ISO timestamp of the measurement (when it was saved). */
  measuredAt: string;
}

export interface SettingsView {
  /** `null` until the setup wizard's apply has written `firm_config`. */
  config: SettingsConfig | null;
  positions: SettingsPosition[];
  /** Every one of the five flows is present; `null` = not measured yet. */
  baselines: Record<FlowType, SettingsBaseline | null>;
  /** True when an open (unfinished) onboarding session exists for the
   *  organization — a `rerun` resumes it instead of cloning the last
   *  completed one. */
  openSetup: boolean;
}

/** Bounds of a manual baseline: one minute to ten hours. */
export const BASELINE_MIN_MINUTES = 1;
export const BASELINE_MAX_MINUTES = 600;

export type SettingsActionBody =
  | { action: 'visible_modules'; modules: ModuleKey[] }
  | { action: 'baseline'; flow: FlowType; minutes: number }
  | { action: 'rerun'; step: RerunStep };

/** `visible_modules` and `baseline` answer with the refreshed view; `rerun`
 *  answers with where the browser should go next (always the wizard). */
export type SettingsActionResult = SettingsView | { redirect: '/setup' };
