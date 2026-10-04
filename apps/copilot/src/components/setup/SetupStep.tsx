'use client';

import { type KeyboardEvent, type ReactNode, useId } from 'react';
import { t, type ArKey } from '@/i18n/ar';
import { Button, Spinner } from '@/components/ui/Button';
import type { SetupStep as SetupStepNumber } from '@/onboarding/machine';
import type { SetupIssue } from './api';

const TOTAL_STEPS = 7;

function nextOpenStep(completedSteps: readonly number[]): SetupStepNumber {
  for (let s = 1; s <= TOTAL_STEPS; s += 1) {
    if (!completedSteps.includes(s)) return s as SetupStepNumber;
  }
  return 7;
}

export interface SetupStepProps {
  step: SetupStepNumber;
  completedSteps: readonly SetupStepNumber[];
  questionTextAr: string;
  onGotoStep: (step: SetupStepNumber) => void;
  children: ReactNode;
  /** Step 7 (the summary): no free-text composer, no save/back buttons —
   *  `DiffCard` (passed as `children`) carries its own actions. */
  isSummary?: boolean;
  freeTextValue: string;
  onFreeTextChange: (value: string) => void;
  onSendFreeText: () => void;
  parsing: boolean;
  unclear: string | null;
  invalid: { messageAr: string; issues: SetupIssue[] } | null;
  onSave: () => void;
  onBack: () => void;
  canBack: boolean;
}

/**
 * The frame every setup step shares (`03` §2 `SetupStep`): a stepper of the
 * seven steps, the question heading, the step's own editor (`children`),
 * and — on steps 1–6 — a free-text composer plus save/back buttons.
 */
export function SetupStep({
  step,
  completedSteps,
  questionTextAr,
  onGotoStep,
  children,
  isSummary = false,
  freeTextValue,
  onFreeTextChange,
  onSendFreeText,
  parsing,
  unclear,
  invalid,
  onSave,
  onBack,
  canBack,
}: SetupStepProps) {
  const textareaId = useId();
  const open = nextOpenStep(completedSteps);

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!parsing && freeTextValue.trim().length > 0) onSendFreeText();
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <ol className="flex flex-wrap gap-1.5" aria-label={t('setup.step_of', { n: step, total: TOTAL_STEPS })}>
        {Array.from({ length: TOTAL_STEPS }, (_, i) => (i + 1) as SetupStepNumber).map((n) => {
          const reachable = completedSteps.includes(n) || n === open;
          const current = n === step;
          return (
            <li key={n}>
              <button
                type="button"
                disabled={!reachable}
                aria-current={current ? 'step' : undefined}
                // An explicit label (number + short title) so the accessible
                // name is the same at every viewport, even though the title
                // text is only shown visually from `sm` up.
                aria-label={`${n} ${t(`setup.step.${n}` as ArKey)}`}
                onClick={() => onGotoStep(n)}
                className={[
                  'flex h-11 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold transition sm:px-3 sm:text-sm',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
                  current
                    ? 'bg-brand-600 text-white'
                    : reachable
                      ? 'bg-white text-slate-700 shadow-card hover:bg-slate-50'
                      : 'cursor-not-allowed bg-slate-100 text-slate-400',
                ].join(' ')}
              >
                <span aria-hidden="true">{n}</span>
                <span aria-hidden="true" className="hidden sm:inline">
                  {t(`setup.step.${n}` as ArKey)}
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-slate-500">{t('setup.step_of', { n: step, total: TOTAL_STEPS })}</p>
        {/* Step 7's "question" is the diff card's own title («سأضبط في NPI»),
            which the card already shows — not repeated here. */}
        {!isSummary ? <h2 className="text-base font-bold text-slate-900">{questionTextAr}</h2> : null}
      </div>

      <div className="rounded-xl bg-white p-4 shadow-card">{children}</div>

      {!isSummary ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={textareaId} className="text-sm font-medium text-slate-700">
              {t('setup.free_text')}
            </label>
            <div className="flex items-end gap-2 rounded-2xl border border-slate-300 bg-white p-2 focus-within:ring-2 focus-within:ring-brand-500">
              <textarea
                id={textareaId}
                value={freeTextValue}
                onChange={(e) => onFreeTextChange(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={parsing}
                rows={1}
                className="max-h-40 min-h-11 flex-1 resize-none bg-transparent py-2 text-sm text-slate-900 placeholder:text-slate-500 focus:outline-none disabled:text-slate-400"
              />
              <Button
                type="button"
                onClick={onSendFreeText}
                disabled={parsing || freeTextValue.trim().length === 0}
                aria-label={t('chat.send')}
              >
                {t('chat.send')}
              </Button>
            </div>
          </div>

          {parsing ? (
            <div role="status" aria-busy="true" className="flex items-center gap-2 text-sm text-slate-600">
              <Spinner className="h-4 w-4" />
              {t('setup.loading')}
            </div>
          ) : null}

          {unclear ? (
            <p className="rounded-lg border border-warning-200 bg-warning-50 px-3 py-2 text-sm text-warning-800">
              {unclear}
            </p>
          ) : null}

          {invalid ? (
            <div className="rounded-lg border border-danger-200 bg-danger-50 px-3 py-2 text-sm text-danger-800">
              <p>{invalid.messageAr}</p>
              {invalid.issues.length > 0 ? (
                <ul className="mt-1 list-inside list-disc">
                  {invalid.issues.map((issue, i) => (
                    <li key={`${issue.path}-${i}`}>{issue.message}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          <div className="flex items-center justify-between gap-2">
            <Button type="button" variant="secondary" onClick={onBack} disabled={!canBack || parsing}>
              {t('setup.back')}
            </Button>
            <Button type="button" onClick={onSave} disabled={parsing} loading={parsing}>
              {t('setup.save_step')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
