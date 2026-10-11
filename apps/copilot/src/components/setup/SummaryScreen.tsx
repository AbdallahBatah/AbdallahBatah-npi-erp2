'use client';

import { t, type ArKey } from '@/i18n/ar';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { keyedLines } from '@/components/ui/keys';
import type { SetupStep as SetupStepNumber } from '@/onboarding/machine';
import type { SetupSource } from '@/onboarding/plan';
import type { SetupSummary } from '@/onboarding/summary';

export interface SummaryScreenProps {
  summary: SetupSummary;
  busy: boolean;
  /** «غيّر» on a card: opens that step's own editor. */
  onChangeStep: (step: SetupStepNumber) => void;
  /** «اعتمد وأسّس»: on to the dry-run diff. */
  onConfirm: () => void;
  /** «أفضّل ملء الخطوات يدوياً»: today's step-by-step wizard. */
  onManual: () => void;
}

const SOURCE_TONE: Record<SetupSource, BadgeTone> = {
  npi: 'success',
  'pack-default': 'neutral',
  heuristic: 'info',
  manual: 'brand',
};

const CONFIDENCE_TONE: Record<SetupSummary['profile']['confidence'], BadgeTone> = {
  high: 'success',
  medium: 'info',
  low: 'warning',
};

/**
 * The «هذا ما قرأته من NPI» screen (T-47a): what the wizard read from NPI,
 * one card per step with its source and a «غيّر» button, the profile card
 * (a guess, with its reasons) first, and one primary button that goes on to
 * the dry-run diff. Controlled — it holds no state of its own.
 */
export function SummaryScreen({ summary, busy, onChangeStep, onConfirm, onManual }: SummaryScreenProps) {
  const { profile, cards, skippedAr } = summary;
  return (
    <div data-testid="setup-summary" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-bold text-slate-900">{t('setup.summary.title')}</h2>
        <p className="text-sm text-slate-600">{t('setup.summary.intro')}</p>
      </div>

      <div data-testid="setup-summary-profile" className="flex flex-col gap-3 rounded-xl border-2 border-brand-200 bg-brand-50/40 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-bold text-slate-900">{t('setup.step.1')}</h3>
            <span className="text-base font-bold text-brand-800">{profile.titleAr}</span>
            <Badge tone={CONFIDENCE_TONE[profile.confidence]}>{t(`setup.summary.confidence.${profile.confidence}` as ArKey)}</Badge>
            <Badge tone={SOURCE_TONE[profile.source]}>{t(`setup.summary.source.${profile.source}` as ArKey)}</Badge>
          </div>
          <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => onChangeStep(1)}>
            {t('setup.summary.change')}
          </Button>
        </div>
        <div className="flex flex-col gap-1">
          <p className="text-xs font-semibold text-slate-600">{t('setup.summary.reasons')}</p>
          <ul className="list-inside list-disc text-sm text-slate-700">
            {keyedLines(profile.reasonsAr).map(({ key, line }) => (
              <li key={key}>{line}</li>
            ))}
          </ul>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {cards.map((card) => (
          <div key={card.step} data-testid={`setup-summary-card-${card.step}`}>
            <Card>
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-bold text-slate-900">{card.titleAr}</h3>
                    <Badge tone={SOURCE_TONE[card.source]}>{t(`setup.summary.source.${card.source}` as ArKey)}</Badge>
                  </div>
                  <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => onChangeStep(card.step)}>
                    {t('setup.summary.change')}
                  </Button>
                </div>
                <ul className="flex flex-col gap-0.5 text-sm text-slate-700">
                  {keyedLines(card.lines.filter((line) => line.length > 0)).map(({ key, line }) => (
                    <li key={key}>{line}</li>
                  ))}
                </ul>
              </div>
            </Card>
          </div>
        ))}
      </div>

      {skippedAr.length > 0 ? (
        <div data-testid="setup-summary-skipped" className="flex flex-col gap-1 rounded-lg border border-warning-200 bg-warning-50 px-3 py-2">
          <p className="text-xs font-semibold text-warning-800">{t('setup.summary.skipped')}</p>
          <ul className="list-inside list-disc text-sm text-warning-800">
            {keyedLines(skippedAr).map(({ key, line }) => (
              <li key={key}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <p className="text-sm text-slate-500">{t('setup.summary.confirm_note')}</p>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button type="button" variant="ghost" onClick={onManual} disabled={busy}>
            {t('setup.summary.manual')}
          </Button>
          <Button type="button" onClick={onConfirm} disabled={busy} loading={busy}>
            {t('setup.summary.confirm')}
          </Button>
        </div>
      </div>
    </div>
  );
}
