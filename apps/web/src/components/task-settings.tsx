'use client';

/**
 * Admin → Facility → "Follow-up settings" (CRM Phase 1 · Step 5).
 *
 * When the owner of a follow-up task is reminded: how many days before the due day, and at
 * which hour (Riyadh time). Both are settings, not constants in code (spec: «كل حد أو
 * نسبة قيمة في الإعدادات لا رقم في الكود»). The reminder is an in-system notification;
 * the daily e-mail digest is out of this release.
 */
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { Btn, Field, LoadError } from '@/components/ui';

const DAYS = 'crm.task.reminderDaysBefore';
const HOUR = 'crm.task.reminderHour';

type Settings = Record<string, number | string | boolean>;

export function TaskSettingsCard() {
  const { t, locale } = useI18n();
  const { act, busy } = useAct();
  const [values, setValues] = useState<{ days: string; hour: string } | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    setErr('');
    api
      .get<Settings>('/admin/settings')
      .then((s) => setValues({ days: String(s[DAYS] ?? 1), hour: String(s[HOUR] ?? 8) }))
      .catch((e) => setErr(translateError(e, locale)));
  }, [locale]);
  useEffect(load, [load]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!values) return;
    const ok = await act('taskSettings', () =>
      api.patch('/admin/settings', { [DAYS]: Number(values.days), [HOUR]: Number(values.hour) }),
    );
    if (ok) load();
  }

  return (
    <div className="card max-w-2xl p-6">
      <h2 className="text-base font-bold text-slate-800">{t('adm.settings.tasks.title')}</h2>
      <p className="mt-1 text-xs leading-6 text-slate-500">{t('adm.settings.tasks.hint')}</p>
      {err ? (
        <div className="mt-4">
          <LoadError message={err} onRetry={load} />
        </div>
      ) : !values ? (
        <div className="mt-4 space-y-3" aria-hidden>
          <div className="skeleton h-9 w-full" />
          <div className="skeleton h-9 w-full" />
        </div>
      ) : (
        <form className="mt-4 grid gap-4 sm:grid-cols-2" onSubmit={save}>
          <Field label={t('adm.settings.tasks.daysBefore')}>
            <input
              type="number"
              min={0}
              max={30}
              step={1}
              className="input"
              dir="ltr"
              value={values.days}
              onChange={(e) => setValues({ ...values, days: e.target.value })}
            />
          </Field>
          <Field label={t('adm.settings.tasks.hour')}>
            <input
              type="number"
              min={0}
              max={23}
              step={1}
              className="input"
              dir="ltr"
              value={values.hour}
              onChange={(e) => setValues({ ...values, hour: e.target.value })}
            />
          </Field>
          <div className="flex justify-end sm:col-span-2">
            <Btn type="submit" variant="primary" busy={busy('taskSettings')} disabled={busy()}>
              {t('common.save')}
            </Btn>
          </div>
        </form>
      )}
    </div>
  );
}
