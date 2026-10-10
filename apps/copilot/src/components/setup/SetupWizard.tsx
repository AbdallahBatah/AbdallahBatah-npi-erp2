'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '@/i18n/ar';
import { ErrorState, LoadingState } from '@/components/ui/States';
import type { SetupStep as SetupStepNumber, StepAnswer, StepDefaultsNpiUser } from '@/onboarding/machine';
import type { ProfileKey } from '@/onboarding/profile.schema';
import type { SetupPreviewResult, SetupApplyResult, SetupStateView } from '@/onboarding/service';
import {
  answerStructured,
  answerText,
  applySetup,
  gotoStep,
  loadSetup,
  previewSetup,
  type SetupIssue,
} from './api';
import { SetupStep } from './SetupStep';
import { ProfileCard } from './ProfileCard';
import { PositionsStep } from './PositionsStep';
import { ApprovalRulesEditor, DocTypesEditor, ItemsEditor, TerminologyEditor } from './StepEditors';
import { DiffCard } from './DiffCard';

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

/**
 * Owns every piece of mutable state the setup screens need: the current view
 * from the server, the editable draft for whichever step is showing, the
 * preview/apply results, and the inline `unclear`/`invalid` notices. Child
 * components (`SetupStep`, the step editors, `DiffCard`) are controlled —
 * they report edits up through a callback rather than holding their own copy
 * of the answer.
 *
 * T-39b (D-23): the page reads the current step on the server and passes it
 * as `initialData`, so the step is in the first HTML; the component then
 * starts `ready` with that step's draft and makes no GET on mount. Without it
 * (the server read failed) it loads itself as before.
 */
export function SetupWizard({
  initialData,
  initialPreview = null,
}: {
  initialData?: SetupStateView;
  /** Step 7's diff, when the page already ran the dry run on the server
   *  (T-39b): the card is then in the first HTML and the step-7 effect below
   *  has nothing to fetch. Null means «fetch it as before». */
  initialPreview?: SetupPreviewResult | null;
} = {}) {
  const [phase, setPhase] = useState<Phase>(initialData ? 'ready' : 'loading');
  const [errorMessage, setErrorMessage] = useState('');
  const [view, setView] = useState<SetupStateView | null>(initialData ?? null);
  const [draft, setDraft] = useState<Draft>(() => (initialData ? buildInitialDraft(initialData) : null));
  const [freeText, setFreeText] = useState('');
  const [unclear, setUnclear] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<{ messageAr: string; issues: SetupIssue[] } | null>(null);
  const [preview, setPreview] = useState<SetupPreviewResult | null>(initialData ? initialPreview : null);
  const [applyResult, setApplyResult] = useState<SetupApplyResult | null>(null);

  const npiUsersByRole: Record<string, StepDefaultsNpiUser[]> = {};
  if (view?.defaults?.step === 2) {
    for (const position of view.defaults.positions) npiUsersByRole[position.roleKey] = position.npiUsers;
  }

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
    setPhase('ready');
  }, []);

  // Only the latest load applies its result: StrictMode mounts twice in
  // development, and a retry can overlap a slow first request.
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setPhase('loading');
    const result = await loadSetup();
    if (seq !== loadSeq.current) return;
    if (!result.ok) {
      if (result.kind === 'unauthenticated') {
        window.location.assign(LOGIN_PATH);
        return;
      }
      setErrorMessage(result.kind === 'forbidden' ? result.messageAr : result.kind === 'npi' ? result.messageAr : t('state.error'));
      setPhase('error');
      return;
    }
    applyView(result.view);
  }, [applyView]);

  // With server-provided first data (T-39b, D-23) the mount needs no GET;
  // `load` stays for the error state's retry. Same pattern as `IntakePanel`.
  useEffect(() => {
    if (initialData === undefined) load();
  }, [load, initialData]);

  // Step 7 is never answered; its content comes from a live `preview`,
  // fetched automatically the moment the wizard lands there.
  useEffect(() => {
    if (view?.state.step !== 7 || preview !== null) return;
    let cancelled = false;
    setPhase('previewing');
    previewSetup().then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        if (result.kind === 'unauthenticated') {
          window.location.assign(LOGIN_PATH);
          return;
        }
        setErrorMessage(result.kind === 'forbidden' || result.kind === 'npi' ? result.messageAr : t('state.error'));
        setPhase('error');
        return;
      }
      setPreview(result.preview);
      setPhase('ready');
    });
    return () => {
      cancelled = true;
    };
  }, [view?.state.step, preview]);

  async function handleGoto(step: SetupStepNumber) {
    setPhase('ready');
    setFreeText('');
    const result = await gotoStep(step);
    if (!result.ok) {
      if (result.kind === 'unauthenticated') {
        window.location.assign(LOGIN_PATH);
        return;
      }
      setErrorMessage(t('state.error'));
      setPhase('error');
      return;
    }
    applyView(result.view);
  }

  async function handleSendFreeText() {
    const text = freeText.trim();
    if (text.length === 0 || !view) return;
    setPhase('parsing');
    setUnclear(null);
    setInvalid(null);
    const result = await answerText(view.state.step, text);
    if (!result.ok) {
      if (result.kind === 'unauthenticated') {
        window.location.assign(LOGIN_PATH);
        return;
      }
      if (result.kind === 'invalid') {
        setInvalid({ messageAr: result.messageAr, issues: result.issues });
        setPhase('ready');
        return;
      }
      setErrorMessage(result.kind === 'forbidden' || result.kind === 'npi' ? result.messageAr : t('state.error'));
      setPhase('error');
      return;
    }
    if (result.outcome.kind === 'unclear') {
      setUnclear(result.outcome.messageAr);
      setPhase('ready');
      return;
    }
    setFreeText('');
    applyView(result.outcome.view);
  }

  async function handleSave() {
    if (!view) return;
    const answer = finalizeAnswer(draft);
    if (!answer) return;
    setPhase('parsing');
    setUnclear(null);
    setInvalid(null);
    const result = await answerStructured(view.state.step, answer);
    if (!result.ok) {
      if (result.kind === 'unauthenticated') {
        window.location.assign(LOGIN_PATH);
        return;
      }
      if (result.kind === 'invalid') {
        setInvalid({ messageAr: result.messageAr, issues: result.issues });
        setPhase('ready');
        return;
      }
      setErrorMessage(result.kind === 'forbidden' || result.kind === 'npi' ? result.messageAr : t('state.error'));
      setPhase('error');
      return;
    }
    if (result.outcome.kind === 'unclear') {
      // Cannot happen for a structured answer in practice, but handled for
      // completeness/type-safety.
      setUnclear(result.outcome.messageAr);
      setPhase('ready');
      return;
    }
    setFreeText('');
    applyView(result.outcome.view);
  }

  async function handleApply() {
    setPhase('applying');
    const result = await applySetup();
    if (!result.ok) {
      if (result.kind === 'unauthenticated') {
        window.location.assign(LOGIN_PATH);
        return;
      }
      setErrorMessage(result.kind === 'forbidden' || result.kind === 'npi' ? result.messageAr : t('state.error'));
      setPhase('error');
      return;
    }
    setApplyResult(result.apply);
    setPhase('ready');
  }

  if (phase === 'loading' || !view) {
    return <LoadingState />;
  }
  if (phase === 'error') {
    return <ErrorState message={errorMessage} onRetry={load} />;
  }

  const step = view.state.step;
  const canBack = step > 1 && (view.state.completedSteps.includes((step - 1) as SetupStepNumber) || step - 1 === nextOpenStep(view.state.completedSteps));

  if (step === 7) {
    return (
      <SetupStep
        step={step}
        completedSteps={view.state.completedSteps}
        questionTextAr={view.question.textAr}
        onGotoStep={handleGoto}
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
        {phase === 'previewing' || !preview ? (
          <LoadingState />
        ) : (
          <DiffCard
            preview={preview}
            applyResult={applyResult}
            applying={phase === 'applying'}
            onApprove={handleApply}
            onChooseStep={handleGoto}
          />
        )}
      </SetupStep>
    );
  }

  return (
    <SetupStep
      step={step}
      completedSteps={view.state.completedSteps}
      questionTextAr={view.question.textAr}
      onGotoStep={handleGoto}
      freeTextValue={freeText}
      onFreeTextChange={setFreeText}
      onSendFreeText={handleSendFreeText}
      parsing={phase === 'parsing'}
      unclear={unclear}
      invalid={invalid}
      onSave={handleSave}
      onBack={() => handleGoto((step - 1) as SetupStepNumber)}
      canBack={canBack}
    >
      {step === 1 && draft?.step === 1 && view.defaults?.step === 1 ? (
        <ProfileCard
          profiles={view.defaults.profiles}
          selectedKey={draft.profileKey}
          onSelectKey={(key) => setDraft({ step: 1, profileKey: key })}
          showChangeWarning={view.state.answers.profileKey !== undefined}
        />
      ) : null}
      {step === 2 && draft?.step === 2 ? (
        <PositionsStep
          departments={draft.departments}
          positions={draft.positions}
          holders={draft.holders ?? []}
          npiUsersByRole={npiUsersByRole}
          onChange={(next) => setDraft({ step: 2, ...next })}
        />
      ) : null}
      {step === 3 && draft?.step === 3 && view.defaults?.step === 3 ? (
        <ApprovalRulesEditor
          approvalRules={draft.approvalRules}
          roleNamesAr={view.defaults.roleNamesAr}
          onChange={(approvalRules) => setDraft({ step: 3, approvalRules })}
        />
      ) : null}
      {step === 4 && draft?.step === 4 && view.defaults?.step === 4 ? (
        <DocTypesEditor
          candidates={view.defaults.acceptedDocTypes}
          selectedKeys={draft.acceptedDocTypeKeys}
          onChange={(acceptedDocTypeKeys) => setDraft({ step: 4, acceptedDocTypeKeys })}
        />
      ) : null}
      {step === 5 && draft?.step === 5 ? (
        <ItemsEditor items={draft.items} onChange={(items) => setDraft({ step: 5, items })} />
      ) : null}
      {step === 6 && draft?.step === 6 ? (
        <TerminologyEditor
          terminology={draft.terminology}
          onChange={(terminology) => setDraft({ step: 6, terminology })}
        />
      ) : null}
    </SetupStep>
  );
}
