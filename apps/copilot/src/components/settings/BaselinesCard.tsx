'use client';

import { useState } from 'react';
import { t, type ArKey } from '@/i18n/ar';
import { formatDate, formatNumber } from '@/i18n/format';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { FLOW_TYPES } from '@/onboarding/profile.schema';
import type { FlowType } from '@/agents/router';
import { BASELINE_MAX_MINUTES, BASELINE_MIN_MINUTES, type SettingsBaseline } from '@/settings/types';
import type { SaveOutcome } from './SettingsPanel';

export interface BaselinesCardProps {
  baselines: Record<FlowType, SettingsBaseline | null>;
  onSave: (flow: FlowType, minutes: number) => Promise<SaveOutcome>;
}

interface BaselineRowProps {
  flow: FlowType;
  baseline: SettingsBaseline | null;
  onSave: BaselinesCardProps['onSave'];
}

function BaselineRow({ flow, baseline, onSave }: BaselineRowProps) {
  const [value, setValue] = useState(baseline ? String(baseline.minutes) : '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flowLabel = t(`flow.${flow}` as ArKey);
  const inputLabel = `${flowLabel} — ${t('settings.baselines.minutes')}`;

  async function handleSave() {
    setSaved(false);
    setError(null);
    const minutes = Number(value);
    if (!Number.isInteger(minutes) || minutes < BASELINE_MIN_MINUTES || minutes > BASELINE_MAX_MINUTES) {
      setError(
        t('settings.baselines.invalid', {
          min: formatNumber(BASELINE_MIN_MINUTES),
          max: formatNumber(BASELINE_MAX_MINUTES),
        }),
      );
      return;
    }
    setSaving(true);
    const result = await onSave(flow, minutes);
    setSaving(false);
    if (!result.ok) {
      if (result.messageAr) setError(result.messageAr);
      return;
    }
    setSaved(true);
  }

  return (
    <div
      data-testid={`settings-baseline-${flow}`}
      className="flex flex-col gap-2 rounded-lg border border-slate-200 p-3 sm:flex-row sm:flex-wrap sm:items-end sm:gap-3"
    >
      <p className="flex-1 text-sm font-semibold text-slate-900 sm:min-w-[8rem]">{flowLabel}</p>
      <input
        type="number"
        inputMode="numeric"
        min={BASELINE_MIN_MINUTES}
        max={BASELINE_MAX_MINUTES}
        step={1}
        aria-label={inputLabel}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setSaved(false);
          setError(null);
        }}
        className="h-11 w-28 rounded-lg border border-slate-300 px-3 text-sm text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      />
      <Button type="button" variant="secondary" size="sm" onClick={handleSave} disabled={saving} loading={saving}>
        {t('settings.baselines.save')}
      </Button>
      <div className="flex flex-col gap-1 text-sm">
        <span className="text-slate-600">
          {baseline
            ? t('settings.baselines.measured', { minutes: formatNumber(baseline.minutes), date: formatDate(baseline.measuredAt) })
            : t('settings.baselines.none')}
        </span>
        {saved ? (
          <output className="text-xs font-semibold text-success-700">
            {t('settings.baselines.saved')}
          </output>
        ) : null}
        {error ? (
          <span role="alert" className="text-xs text-danger-700">
            {error}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** `settings.baselines`: the manually-measured minutes per chat flow (02 §5.9
 *  "الزمن اليدوي المرجعي"), always rendered — it does not depend on
 *  `firm_config` existing. One row per `FLOW_TYPES`, each its own save unit. */
export function BaselinesCard({ baselines, onSave }: BaselinesCardProps) {
  return (
    <Card title={t('settings.baselines')}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-slate-500">{t('settings.baselines.hint')}</p>
        <div className="flex flex-col gap-3">
          {FLOW_TYPES.map((flow) => (
            <BaselineRow key={flow} flow={flow} baseline={baselines[flow]} onSave={onSave} />
          ))}
        </div>
      </div>
    </Card>
  );
}
