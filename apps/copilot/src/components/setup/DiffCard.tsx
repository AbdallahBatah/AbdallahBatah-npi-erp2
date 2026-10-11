'use client';

import { useState } from 'react';
import { t, type ArKey } from '@/i18n/ar';
import { formatNumber } from '@/i18n/format';
import { Card } from '@/components/ui/Card';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { keyedLines } from '@/components/ui/keys';
import type { SetupStep as SetupStepNumber } from '@/onboarding/machine';
import type { StepOutcome } from '@/onboarding/apply';
import type { SetupApplyResult, SetupPreviewResult } from '@/onboarding/service';

export interface DiffCardProps {
  preview: SetupPreviewResult;
  applyResult: SetupApplyResult | null;
  applying: boolean;
  onApprove: () => void;
  onChooseStep: (step: SetupStepNumber) => void;
}

const EDIT_STEPS: SetupStepNumber[] = [1, 2, 3, 4, 5, 6];

const OUTCOME_TONE: Record<StepOutcome, BadgeTone> = {
  created: 'success',
  updated: 'success',
  skipped: 'neutral',
  blocked: 'warning',
  failed: 'danger',
};

function Section({ titleKey, lines, tone }: { titleKey: ArKey; lines: string[]; tone?: 'warning' | 'info' }) {
  if (lines.length === 0) return null;
  const toneClass = tone === 'warning' ? 'text-warning-700' : tone === 'info' ? 'text-info-700' : 'text-slate-700';
  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-sm font-bold text-slate-900">{t(titleKey)}</h4>
      <ul className={`list-inside list-disc text-sm ${toneClass}`}>
        {keyedLines(lines).map(({ key, line }) => (
          <li key={key}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Step 7's editor and the apply result (`03` §2 `DiffCard`): the one card
 * with the gold edge, per `03` §1. Renders `preview` (a live, read-only
 * dry-run against NPI) until the administrator approves, then replaces the
 * approve/edit actions with `applyResult`.
 */
export function DiffCard({ preview, applyResult, applying, onApprove, onChooseStep }: DiffCardProps) {
  const [choosingStep, setChoosingStep] = useState(false);
  const { plan, summary, permissionLabels, stepTitlesAr } = preview;

  const roleSteps = plan.steps.filter(
    (step): step is Extract<typeof step, { kind: 'role' }> =>
      step.kind === 'role' && (step.action === 'update' || step.action === 'create') &&
      (step.permissionsAdded.length > 0 || step.permissionsRemoved.length > 0),
  );

  return (
    <div data-testid="setup-diff-card">
    <Card edge="gold" title={t('setup.diff')}>
      <div className="flex flex-col gap-4">
        <Section titleKey="setup.diff.npi" lines={summary.npi} />
        <Section titleKey="setup.diff.already" lines={summary.already} />
        <Section titleKey="setup.diff.copilot" lines={summary.copilot} />
        <Section titleKey="setup.diff.blocked" lines={summary.blocked} tone="warning" />
        <Section titleKey="setup.gap" lines={summary.gaps} tone="info" />

        {roleSteps.length > 0 ? (
          <div className="flex flex-col gap-3">
            {roleSteps.map((step) => (
              <div key={step.id} className="flex flex-col gap-1.5 rounded-lg border border-slate-200 p-3">
                <p className="text-sm font-bold text-slate-900">{step.nameAr}</p>
                {step.permissionsAdded.length > 0 ? (
                  <div className="flex flex-col gap-1">
                    <p className="text-xs font-semibold text-slate-600">{t('setup.diff.added')}</p>
                    <div className="flex flex-wrap gap-1">
                      {step.permissionsAdded.map((key) => (
                        <Badge key={key} tone="success">
                          {permissionLabels[key] ?? key}
                        </Badge>
                      ))}
                    </div>
                  </div>
                ) : null}
                {step.permissionsRemoved.length > 0 ? (
                  <div className="flex flex-col gap-1">
                    <p className="text-xs font-semibold text-slate-600">{t('setup.diff.removed')}</p>
                    <div className="flex flex-wrap gap-1">
                      {step.permissionsRemoved.map((key) => (
                        <Badge key={key} tone="danger">
                          {permissionLabels[key] ?? key}
                        </Badge>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        <p className="text-sm font-semibold text-slate-700">
          {t('setup.diff.counts', {
            create: formatNumber(plan.counts.create),
            update: formatNumber(plan.counts.update),
            skip: formatNumber(plan.counts.skip),
            blocked: formatNumber(plan.counts.blocked),
          })}
        </p>

        {applyResult ? (
          <div className="flex flex-col gap-3">
            {applyResult.result.completed ? (
              <p className="text-sm font-bold text-success-700">{t('setup.apply.done')}</p>
            ) : (
              <p role="alert" className="text-sm font-bold text-danger-700">
                {t('setup.error.apply', {
                  reason: applyResult.result.steps.find((s) => s.outcome === 'failed')?.reasonAr ?? '',
                })}
              </p>
            )}

            <ul className="flex flex-col gap-2">
              {applyResult.result.steps.map((step) => (
                <li key={step.stepId} data-testid="setup-apply-step" className="flex flex-col gap-1 rounded-lg border border-slate-200 p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    {/* The preview and the apply are built from the same answers, so
                        the ids match; the raw id is the fallback for a step the
                        preview never saw (e.g. a mocked or stale response). */}
                    <p className="text-sm text-slate-800">{stepTitlesAr[step.stepId] ?? step.stepId}</p>
                    <Badge tone={OUTCOME_TONE[step.outcome]}>{t(`setup.result.${step.outcome}` as ArKey)}</Badge>
                  </div>
                  {(step.outcome === 'blocked' || step.outcome === 'failed') && step.reasonAr ? (
                    <p className="text-sm text-slate-700">{step.reasonAr}</p>
                  ) : null}
                  {step.npiMessage ? <code className="text-xs text-slate-500">{step.npiMessage}</code> : null}
                </li>
              ))}
            </ul>

            <p className="text-sm text-slate-700">
              {t('setup.positions_written', { n: formatNumber(applyResult.persisted.positionsWritten) })}
            </p>
            <p className="text-sm text-slate-700">
              {t('setup.assignments_written', { n: formatNumber(applyResult.persisted.assignmentsWritten) })}
            </p>
            {applyResult.persisted.holdersSkipped.length > 0 ? (
              <ul className="list-inside list-disc text-sm text-warning-700">
                {applyResult.persisted.holdersSkipped.map((skip) => (
                  <li key={`${skip.roleKey}-${skip.departmentCode ?? ''}-${skip.npiUserId}-${skip.reason}`}>
                    {t(`setup.holder_skipped.${skip.reason}` as ArKey)}
                  </li>
                ))}
              </ul>
            ) : null}

            <a
              href="/"
              className="text-sm font-semibold text-brand-600 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              {t('nav.home')}
            </a>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-slate-500">{t('setup.apply.note')}</p>
            {applying ? (
              <output aria-busy="true" className="text-sm text-slate-600">
                {t('setup.applying')}
              </output>
            ) : null}
            <div className="flex items-center justify-between gap-2">
              <Button type="button" variant="secondary" onClick={() => setChoosingStep((v) => !v)} disabled={applying}>
                {t('preview.edit')}
              </Button>
              <Button type="button" onClick={onApprove} disabled={applying} loading={applying}>
                {t('preview.approve')}
              </Button>
            </div>
            {choosingStep ? (
              <div className="flex flex-wrap gap-2" aria-label={t('setup.choose_step')}>
                {EDIT_STEPS.map((n) => (
                  <Button key={n} type="button" variant="secondary" size="sm" onClick={() => onChooseStep(n)}>
                    {t(`setup.step.${n}` as ArKey)}
                  </Button>
                ))}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </Card>
    </div>
  );
}
