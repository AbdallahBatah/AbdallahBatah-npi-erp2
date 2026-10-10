'use client';

import { useState } from 'react';
import { t, type ArKey } from '@/i18n/ar';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { FLOW_TYPES, FLOW_REQUIRED_MODULE, MODULE_KEYS, MODULE_NAMES_AR, type ModuleKey } from '@/onboarding/profile.schema';
import type { SaveOutcome } from './SettingsPanel';

export interface ModulesCardProps {
  visibleModules: ModuleKey[];
  onSave: (modules: ModuleKey[]) => Promise<SaveOutcome>;
}

/** `settings.modules`: a checkbox per `MODULE_KEYS`. `finance` is always
 *  checked and disabled (02 §7, 03 §5: the module every profile keeps
 *  visible). Owns its own dirty/save/saved state — the only card the
 *  settings screen writes to directly rather than through a wizard rerun
 *  (D-7, `src/settings/types.ts`'s header comment). */
export function ModulesCard({ visibleModules, onSave }: ModulesCardProps) {
  const [selected, setSelected] = useState<Set<ModuleKey>>(() => new Set(visibleModules));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const savedSet = new Set(visibleModules);
  const dirty = selected.size !== savedSet.size || [...selected].some((m) => !savedSet.has(m));

  function toggle(key: ModuleKey, checked: boolean) {
    setSaved(false);
    setError(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  function hiddenFlows(key: ModuleKey): string[] {
    if (selected.has(key)) return [];
    return FLOW_TYPES.filter((flow) => FLOW_REQUIRED_MODULE[flow] === key).map((flow) => t(`flow.${flow}` as ArKey));
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    const result = await onSave([...selected]);
    setSaving(false);
    if (!result.ok) {
      if (result.messageAr) setError(result.messageAr);
      return;
    }
    setSaved(true);
  }

  return (
    <Card title={t('settings.modules')}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-slate-500">{t('settings.modules.hint')}</p>
        <div className="flex flex-col gap-2">
          {MODULE_KEYS.map((key) => {
            const isFinance = key === 'finance';
            const checked = isFinance || selected.has(key);
            const flows = hiddenFlows(key);
            return (
              <div key={key} className="flex flex-col gap-1 rounded-lg border border-slate-200 px-3 py-2">
                <label className="flex min-h-11 items-center gap-2 text-sm text-slate-900">
                  <input
                    type="checkbox"
                    data-testid={`settings-module-${key}`}
                    checked={checked}
                    disabled={isFinance}
                    onChange={(e) => toggle(key, e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 text-brand-600 focus-visible:ring-2 focus-visible:ring-brand-500"
                  />
                  {MODULE_NAMES_AR[key]}
                </label>
                {flows.length > 0 ? (
                  <p className="ps-6 text-xs text-slate-500">{t('settings.modules.hides_flows', { flows: flows.join('، ') })}</p>
                ) : null}
              </div>
            );
          })}
        </div>
        {error ? (
          <p role="alert" className="rounded-lg border border-danger-200 bg-danger-50/40 px-3 py-2 text-sm text-danger-700">
            {error}
          </p>
        ) : null}
        <div className="flex items-center gap-3">
          <Button type="button" size="sm" onClick={handleSave} disabled={!dirty || saving} loading={saving}>
            {t('settings.modules.save')}
          </Button>
          {saved ? (
            <span role="status" className="text-sm font-semibold text-success-700">
              {t('settings.modules.saved')}
            </span>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
