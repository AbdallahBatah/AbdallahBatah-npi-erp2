'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '@/i18n/ar';
import { ErrorState, LoadingState } from '@/components/ui/States';
import type { SetupStep as SetupStepNumber, StepAnswer, StepDefaultsNpiUser } from '@/onboarding/machine';
import type { ProfileKey } from '@/onboarding/profile.schema';
import type { SetupPreviewResult, SetupApplyResult, SetupStateView } from '@/onboarding/service';
import {
  answerStructured,
  answerText,
  applySetup,
  chooseManual,
  gotoStep,
  loadSetup,
  previewSetup,
  type AnswerOutcome,
  type SetupApiResult,
  type SetupIssue,
} from './api';
import { SetupStep } from './SetupStep';
import { ProfileCard } from './ProfileCard';
import { PositionsStep } from './PositionsStep';
import { ApprovalRulesEditor, DocTypesEditor, ItemsEditor, TerminologyEditor } from './StepEditors';
import { DiffCard } from './DiffCard';
import { SummaryScreen } from './SummaryScreen';

const LOGIN_PATH = '/copilot/login';

// ─── Shapes derived from the server's own types (type-only, erased) ────────
// `StepAnswer` is already a concrete discriminated union (every field schema
// in `machine.ts`/`plan.ts` is turned into a real TypeScript shape by
// `z.infer`), so the per-step field types below are extracted from it rather
// than hand-duplicated.
export type Step1Answer = Extract<StepAnswer, { step: 1 }>;
export type Step2Answer = Extract<StepAnswer, { step: 2 }>;
export type Step3Answer = Extract<StepAnswer, { step: 3 }>;
export type Step4Answer = Extract<StepAnswer, { step: 4 }>;
export type Step5Answer = Extract<StepAnswer, { step: 5 }>;
export type Step6Answer = Extract<StepAnswer, { step: 6 }>;

export type Department = Step2Answer['departments'][number];
export type Position = Step2Answer['positions'][number];
export type PositionHolderDraft = NonNullable<Step2Answer['holders']>[number];
export type ApprovalRule = Step3Answer['approvalRules'][number];
export type ItemTemplate = Step5Answer['items'][number];

type Draft =
  | ({ step: 1; profileKey: ProfileKey | null })
  | Step2Answer
  | Step3Answer
  | Step4Answer
  | Step5Answer
  | Step6Answer
  | null;

type Phase = 'loading' | 'ready' | 'parsing' | 'previewing' | 'applying' | 'error';

function nextOpenStep(completedSteps: readonly number[]): SetupStepNumber {
  for (let s = 1; s <= 7; s += 1) {
    if (!completedSteps.includes(s)) return s as SetupStepNumber;
  }
  return 7;
}

/** Index-aligned with `positions`: `holders[i]` always names `positions[i]`.
 *  Reconciles a previously-saved `holders` list (matched by `roleKey` +
 *  `departmentCode`, since that pair is stable even when the position list
 *  itself has been filtered down to fewer entries than the pack default) onto
 *  the current `positions` array, synthesising an empty entry for any
 *  position that never had one. */
function fillHolders(positions: Position[], existing: PositionHolderDraft[] | undefined): PositionHolderDraft[] {
  const byKey = new Map((existing ?? []).map((h) => [`${h.roleKey}\u0000${h.departmentCode ?? ''}`, h]));
  return positions.map((p) => {
    const key = `${p.roleKey}\u0000${p.departmentCode ?? ''}`;
    return byKey.get(key) ?? { roleKey: p.roleKey, departmentCode: p.departmentCode, npiUserIds: [] };
  });
}

function buildInitialDraft(view: SetupStateView): Draft {
  const { state, defaults } = view;
  const answers = state.answers;

  switch (state.step) {
    case 1:
      return { step: 1, profileKey: answers.profileKey ?? null };
    case 2: {
      if (!defaults || defaults.step !== 2) return null;
      const positions: Position[] =
        answers.positions ?? defaults.positions.map(({ npiUsers: _npiUsers, ...rest }) => rest);
      const departments: Department[] = answers.departments ?? defaults.departments;
      return { step: 2, departments, positions, holders: fillHolders(positions, answers.holders) };
    }
    case 3: {
      if (!defaults || defaults.step !== 3) return null;
      return { step: 3, approvalRules: answers.approvalRules ?? defaults.approvalRules };
    }
    case 4: {
      if (!defaults || defaults.step !== 4) return null;
      return {
        step: 4,
        acceptedDocTypeKeys: answers.acceptedDocTypeKeys ?? defaults.acceptedDocTypes.map((d) => d.key),
      };
    }
    case 5: {
      if (!defaults || defaults.step !== 5) return null;
      return { step: 5, items: answers.items ?? defaults.items };
    }
    case 6: {
      if (!defaults || defaults.step !== 6) return null;
      return { step: 6, terminology: { ...defaults.terminology, ...(answers.terminology ?? {}) } };
    }
    default:
      return null;
  }
}

/** Trims the draft to exactly what the server's `StepAnswer` schema wants —
 *  today this only matters for step 6, where an empty input means "keep the
 *  usual term" and must be left out rather than sent as `""`. */
function finalizeAnswer(draft: Draft): StepAnswer | null {
  if (!draft) return null;
  if (draft.step === 1) {
    if (!draft.profileKey) return null;
    return { step: 1, profileKey: draft.profileKey };
  }
  if (draft.step === 6) {
    const terminology: Step6Answer['terminology'] = {};
    for (const [key, value] of Object.entries(draft.terminology)) {
      if (value && value.trim().length > 0) (terminology as Record<string, string>)[key] = value;
    }
    return { step: 6, terminology };
  }
  return draft;
}

/** What the wizard shows first: the server-provided step (T-39b, D-23) with
 *  its draft, or nothing yet when the page could not read it. */
function initialWizardState(
  initialData: SetupStateView | undefined,
  initialPreview: SetupPreviewResult | null,
): { phase: Phase; view: SetupStateView | null; draft: Draft; preview: SetupPreviewResult | null } {
  if (!initialData) return { phase: 'loading', view: null, draft: null, preview: null };
  return { phase: 'ready', view: initialData, draft: buildInitialDraft(initialData), preview: initialPreview };
}

/** Per role key, the NPI users who could hold that position. */
function usersByRoleOf(view: SetupStateView | null): Record<string, StepDefaultsNpiUser[]> {
  const byRole: Record<string, StepDefaultsNpiUser[]> = {};
  if (view?.defaults?.step === 2) {
    for (const position of view.defaults.positions) byRole[position.roleKey] = position.npiUsers;
    // A discovered session's positions are NPI's roles, not the pack's.
    for (const [roleKey, users] of Object.entries(view.defaults.usersByRole ?? {})) byRole[roleKey] = users;
  }
  return byRole;
}

// ─── Failure routing shared by every call the wizard makes ─────────────────

type SetupFailure = Extract<SetupApiResult<Record<string, never>>, { ok: false }>;
type InvalidFailure = Extract<SetupFailure, { kind: 'invalid' }>;

interface FailureSinks {
  setErrorMessage: (message: string) => void;
  setPhase: (phase: Phase) => void;
}

/** The sentence for a failed call. `specific` lets a permission or NPI failure
 *  speak with its own words; every other failure (and every failure of
 *  `handleGoto`/`handleManual`) is the generic one. */
function failureMessageAr(failure: SetupFailure, specific: boolean): string {
  return specific && (failure.kind === 'forbidden' || failure.kind === 'npi') ? failure.messageAr : t('state.error');
}

/** A lost session goes to the login page; anything else is the error phase. */
function routeFailure(failure: SetupFailure, specific: boolean, sinks: FailureSinks): void {
  if (failure.kind === 'unauthenticated') {
    window.location.assign(LOGIN_PATH);
    return;
  }
  sinks.setErrorMessage(failureMessageAr(failure, specific));
  sinks.setPhase('error');
}

/** The error phase with the generic sentence, unless the call is stale. */
function failGenerically(sinks: FailureSinks, isCurrent: () => boolean): void {
  if (!isCurrent()) return;
  sinks.setErrorMessage(t('state.error'));
  sinks.setPhase('error');
}

interface SettleOptions<T> {
  sinks: FailureSinks;
  specific: boolean;
  onOk: (body: T) => void;
  /** Handles the 422 «invalid» answer inline; without it that failure is an error like any other. */
  onInvalid?: (failure: InvalidFailure) => void;
  /** A superseded call (a newer load, an unmounted effect) applies nothing. */
  isCurrent?: () => boolean;
}

/** Awaits one setup call and routes its result: the success body to `onOk`,
 *  an `invalid` answer to `onInvalid`, every other failure to `routeFailure`. */
async function settle<T extends object>(call: Promise<SetupApiResult<T>>, options: SettleOptions<T>): Promise<void> {
  const result = await call;
  if (options.isCurrent && !options.isCurrent()) return;
  if (result.ok) {
    options.onOk(result);
    return;
  }
  if (result.kind === 'invalid' && options.onInvalid) {
    options.onInvalid(result);
    return;
  }
  routeFailure(result, options.specific, options.sinks);
}

/** Step 7 is a lazy fetch: only while the wizard stands on it with no diff yet. */
function needsPreview(step: SetupStepNumber | undefined, preview: SetupPreviewResult | null): boolean {
  return step === 7 && preview === null;
}

/**
 * Owns every piece of mutable state the setup screens need: the current view
 * from the server, the editable draft for whichever step is showing, the
 * preview/apply results, and the inline `unclear`/`invalid` notices. Child
 * components (`SetupStep`, the step editors, `DiffCard`) are controlled —
 * they report edits up through a callback rather than holding their own copy
 * of the answer.
 *
 * T-39b (D-23): the page reads the current step on the server and passes it
 * as `initialData`, so the step is in the first HTML; the wizard then starts
 * `ready` with that step's draft and makes no GET on mount. Without it (the
 * server read failed) it loads itself as before.
 */
function useSetupWizard(initialData: SetupStateView | undefined, initialPreview: SetupPreviewResult | null) {
  const [initial] = useState(() => initialWizardState(initialData, initialPreview));
  const [phase, setPhase] = useState<Phase>(initial.phase);
  const [errorMessage, setErrorMessage] = useState('');
  const [view, setView] = useState<SetupStateView | null>(initial.view);
  const [draft, setDraft] = useState<Draft>(initial.draft);
  const [freeText, setFreeText] = useState('');
  const [unclear, setUnclear] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<{ messageAr: string; issues: SetupIssue[] } | null>(null);
  const [preview, setPreview] = useState<SetupPreviewResult | null>(initial.preview);
  const [applyResult, setApplyResult] = useState<SetupApplyResult | null>(null);
  // T-47a: the administrator pressed «اعتمد وأسّس» on the summary; the diff
  // card takes its place. Any new view from the server (an edit, a goto)
  // brings the summary back.
  const [confirmed, setConfirmed] = useState(false);

  const sinks: FailureSinks = { setErrorMessage, setPhase };

  // Never clears `freeText`: a view that arrives while the administrator is
  // typing (the mount's second load under React StrictMode, a retry) must
  // not wipe their sentence. The three navigations that do leave the step
  // (send, save, goto) clear it themselves.
  const applyView = useCallback((next: SetupStateView) => {
    setView(next);
    setDraft(buildInitialDraft(next));
    setUnclear(null);
    setInvalid(null);
    setPreview(null);
    setApplyResult(null);
    setConfirmed(false);
    setPhase('ready');
  }, []);

  // Only the latest load applies its result: StrictMode mounts twice in
  // development, and a retry can overlap a slow first request.
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setPhase('loading');
    await settle(loadSetup(), {
      sinks: { setErrorMessage, setPhase },
      specific: true,
      onOk: (body) => applyView(body.view),
      isCurrent: () => seq === loadSeq.current,
    });
  }, [applyView]);

  // With server-provided first data (T-39b, D-23) the mount needs no GET;
  // `load` stays for the error state's retry. Same pattern as `IntakePanel`.
  useEffect(() => {
    if (initialData === undefined) void load();
  }, [load, initialData]);

  // Step 7 is never answered; its content comes from a live `preview`,
  // fetched automatically the moment the wizard lands there.
  useEffect(() => {
    if (!needsPreview(view?.state.step, preview)) return;
    let cancelled = false;
    const isCurrent = () => !cancelled;
    const effectSinks: FailureSinks = { setErrorMessage, setPhase };
    setPhase('previewing');
    settle(previewSetup(), {
      sinks: effectSinks,
      specific: true,
      onOk: (body) => {
        setPreview(body.preview);
        setPhase('ready');
      },
      isCurrent,
    }).catch(() => {
      // `previewSetup` never rejects; this only guards a throw inside the handler above.
      failGenerically(effectSinks, isCurrent);
    });
    return () => {
      cancelled = true;
    };
  }, [view?.state.step, preview]);

  async function handleGoto(step: SetupStepNumber) {
    setPhase('ready');
    setFreeText('');
    await settle(gotoStep(step), { sinks, specific: false, onOk: (body) => applyView(body.view) });
  }

  async function handleManual() {
    setPhase('parsing');
    await settle(chooseManual(), { sinks, specific: false, onOk: (body) => applyView(body.view) });
  }

  function showInvalid(failure: InvalidFailure) {
    setInvalid({ messageAr: failure.messageAr, issues: failure.issues });
    setPhase('ready');
  }

  function applyOutcome(outcome: AnswerOutcome) {
    if (outcome.kind === 'unclear') {
      // Cannot happen for a structured answer in practice, but handled for
      // completeness/type-safety.
      setUnclear(outcome.messageAr);
      setPhase('ready');
      return;
    }
    setFreeText('');
    applyView(outcome.view);
  }

  /** Sends one answer for the showing step — the sentence or the draft. */
  async function submitAnswer(send: (step: SetupStepNumber) => Promise<SetupApiResult<{ outcome: AnswerOutcome }>>) {
    if (!view) return;
    setPhase('parsing');
    setUnclear(null);
    setInvalid(null);
    await settle(send(view.state.step), {
      sinks,
      specific: true,
      onInvalid: showInvalid,
      onOk: (body) => applyOutcome(body.outcome),
    });
  }

  async function handleSendFreeText() {
    const text = freeText.trim();
    if (text.length === 0) return;
    await submitAnswer((step) => answerText(step, text));
  }

  async function handleSave() {
    const answer = finalizeAnswer(draft);
    if (!answer) return;
    await submitAnswer((step) => answerStructured(step, answer));
  }

  async function handleApply() {
    setPhase('applying');
    await settle(applySetup(), {
      sinks,
      specific: true,
      onOk: (body) => {
        setApplyResult(body.apply);
        setPhase('ready');
      },
    });
  }

  return {
    phase,
    errorMessage,
    view,
    draft,
    setDraft,
    freeText,
    setFreeText,
    unclear,
    invalid,
    preview,
    applyResult,
    confirmed,
    setConfirmed,
    load,
    handleGoto,
    handleManual,
    handleSendFreeText,
    handleSave,
    handleApply,
  };
}

/** Step 7 is read-only: the same shell as the other steps with the question
 *  and the step strip, but no free-text box, no save and no back button. */
function Step7Stage({
  view,
  phase,
  preview,
  applyResult,
  confirmed,
  onGotoStep,
  onConfirm,
  onManual,
  onApprove,
}: {
  view: SetupStateView;
  phase: Phase;
  preview: SetupPreviewResult | null;
  applyResult: SetupApplyResult | null;
  confirmed: boolean;
  onGotoStep: (step: SetupStepNumber) => void;
  onConfirm: () => void;
  onManual: () => void;
  onApprove: () => void;
}) {
  let content: ReactNode;
  if (view.summary && !confirmed) {
    content = (
      <SummaryScreen
        summary={view.summary}
        busy={phase === 'parsing'}
        onChangeStep={onGotoStep}
        onConfirm={onConfirm}
        onManual={onManual}
      />
    );
  } else if (phase === 'previewing' || !preview) {
    content = <LoadingState />;
  } else {
    content = (
      <DiffCard
        preview={preview}
        applyResult={applyResult}
        applying={phase === 'applying'}
        onApprove={onApprove}
        onChooseStep={onGotoStep}
      />
    );
  }
  return (
    <SetupStep
      step={7}
      completedSteps={view.state.completedSteps}
      questionTextAr={view.question.textAr}
      onGotoStep={onGotoStep}
      isSummary
      freeTextValue=""
      onFreeTextChange={() => undefined}
      onSendFreeText={() => undefined}
      parsing={false}
      unclear={null}
      invalid={null}
      onSave={() => undefined}
      onBack={() => undefined}
      canBack={false}
    >
      {content}
    </SetupStep>
  );
}

/** The editor for steps 1–6, picked by the showing step; each one renders
 *  only when the draft and the server's defaults are for that same step. */
function StepEditor({
  step,
  view,
  draft,
  setDraft,
}: {
  step: SetupStepNumber;
  view: SetupStateView;
  draft: Draft;
  setDraft: (draft: Draft) => void;
}) {
  return (
    <>
      {view.discoveryNoteAr ? (
        <p data-testid="setup-discovery-note" className="mb-3 whitespace-pre-line rounded-lg border border-info-200 bg-info-50 px-3 py-2 text-sm text-info-800">
          {view.discoveryNoteAr}
        </p>
      ) : null}
      {step === 1 && draft?.step === 1 && view.defaults?.step === 1 && (
        <ProfileCard
          profiles={view.defaults.profiles}
          selectedKey={draft.profileKey}
          onSelectKey={(key) => setDraft({ step: 1, profileKey: key })}
          showChangeWarning={view.state.answers.profileKey !== undefined}
        />
      )}
      {step === 2 && draft?.step === 2 && (
        <PositionsStep
          departments={draft.departments}
          positions={draft.positions}
          holders={draft.holders ?? []}
          npiUsersByRole={usersByRoleOf(view)}
          onChange={(next) => setDraft({ step: 2, ...next })}
        />
      )}
      {step === 3 && draft?.step === 3 && view.defaults?.step === 3 && (
        <ApprovalRulesEditor
          approvalRules={draft.approvalRules}
          roleNamesAr={view.defaults.roleNamesAr}
          onChange={(approvalRules) => setDraft({ step: 3, approvalRules })}
        />
      )}
      {step === 4 && draft?.step === 4 && view.defaults?.step === 4 && (
        <DocTypesEditor
          candidates={view.defaults.acceptedDocTypes}
          selectedKeys={draft.acceptedDocTypeKeys}
          onChange={(acceptedDocTypeKeys) => setDraft({ step: 4, acceptedDocTypeKeys })}
        />
      )}
      {step === 5 && draft?.step === 5 && (
        <ItemsEditor items={draft.items} onChange={(items) => setDraft({ step: 5, items })} />
      )}
      {step === 6 && draft?.step === 6 && (
        <TerminologyEditor
          terminology={draft.terminology}
          onChange={(terminology) => setDraft({ step: 6, terminology })}
        />
      )}
    </>
  );
}

/** Whether «السابق» is offered: only toward a finished step or the next open one. */
function canGoBack(view: SetupStateView): boolean {
  const { step, completedSteps } = view.state;
  return step > 1 && (completedSteps.includes((step - 1) as SetupStepNumber) || step - 1 === nextOpenStep(completedSteps));
}

export function SetupWizard({
  initialData,
  initialPreview = null,
}: {
  initialData?: SetupStateView;
  /** Step 7's diff, when the page already ran the dry run on the server
   *  (T-39b): the card is then in the first HTML and the step-7 effect
   *  has nothing to fetch. Null means «fetch it as before». */
  initialPreview?: SetupPreviewResult | null;
} = {}) {
  const wizard = useSetupWizard(initialData, initialPreview);
  const { phase, view } = wizard;

  if (phase === 'loading' || !view) {
    return <LoadingState />;
  }
  if (phase === 'error') {
    return <ErrorState message={wizard.errorMessage} onRetry={wizard.load} />;
  }

  const step = view.state.step;
  if (step === 7) {
    return (
      <Step7Stage
        view={view}
        phase={phase}
        preview={wizard.preview}
        applyResult={wizard.applyResult}
        confirmed={wizard.confirmed}
        onGotoStep={wizard.handleGoto}
        onConfirm={() => wizard.setConfirmed(true)}
        onManual={wizard.handleManual}
        onApprove={wizard.handleApply}
      />
    );
  }

  return (
    <SetupStep
      step={step}
      completedSteps={view.state.completedSteps}
      questionTextAr={view.question.textAr}
      onGotoStep={wizard.handleGoto}
      freeTextValue={wizard.freeText}
      onFreeTextChange={wizard.setFreeText}
      onSendFreeText={wizard.handleSendFreeText}
      parsing={phase === 'parsing'}
      unclear={wizard.unclear}
      invalid={wizard.invalid}
      onSave={wizard.handleSave}
      onBack={() => wizard.handleGoto((step - 1) as SetupStepNumber)}
      canBack={canGoBack(view)}
    >
      <StepEditor step={step} view={view} draft={wizard.draft} setDraft={wizard.setDraft} />
    </SetupStep>
  );
}
