'use client';

/**
 * Admin → Facility → "Proposal settings" (CRM Phase 1 · Step 4).
 *
 * The two numbers the proposal screens run on: how many days a new proposal revision
 * is valid when its author names no date, and how old a purchase cost may be before
 * the screen warns about it. Both are settings, not constants in code (spec 4.3).
 * The financial limit that sends a proposal to the executive for approval is NOT
 * here: it is a band of the approval matrix, edited in its own tab.
 */
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { Btn, Field, LoadError } from '@/components/ui';

const VALIDITY = 'crm.proposal.validityDays';
const WARN = 'crm.proposal.costAgeWarnDays';
/** Package 3 · P3-6: the margin under which a budget is flagged to the general manager. */
const MIN_MARGIN = 'crm.proposal.minMarginPct';

type Settings = Record<string, number | string | boolean>;

export function ProposalSettingsCard() {
  const { t, locale } = useI18n();
  const { act, busy } = useAct();
  const [values, setValues] = useState<{ validity: string; warn: string; minMargin: string } | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    setErr('');
    api
      .get<Settings>('/admin/settings')
      .then((s) =>
        setValues({ validity: String(s[VALIDITY] ?? 30), warn: String(s[WARN] ?? 30), minMargin: String(s[MIN_MARGIN] ?? 15) }),
      )
      .catch((e) => setErr(translateError(e, locale)));
  }, [locale]);
  useEffect(load, [load]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!values) return;
    const ok = await act('proposalSettings', () =>
      api.patch('/admin/settings', {
        [VALIDITY]: Number(values.validity),
        [WARN]: Number(values.warn),
        [MIN_MARGIN]: Number(values.minMargin),
      }),
    );
    if (ok) load();
  }

  return (
    <div className="card max-w-2xl p-6">
      <h2 className="text-base font-bold text-slate-800">{t('adm.settings.proposals.title')}</h2>
      <p className="mt-1 text-xs leading-6 text-slate-500">{t('adm.settings.proposals.hint')}</p>
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
          <Field label={t('adm.settings.proposals.validityDays')}>
            <input
              type="number"
              min={1}
              max={365}
              step={1}
              className="input"
              value={values.validity}
              onChange={(e) => setValues({ ...values, validity: e.target.value })}
            />
          </Field>
          <Field label={t('adm.settings.proposals.costAgeWarnDays')}>
            <input
              type="number"
              min={1}
              max={365}
              step={1}
              className="input"
              value={values.warn}
              onChange={(e) => setValues({ ...values, warn: e.target.value })}
            />
          </Field>
          <Field label={t('adm.settings.proposals.minMarginPct')}>
            <input
              type="number"
              min={0}
              max={100}
              step={1}
              className="input"
              value={values.minMargin}
              onChange={(e) => setValues({ ...values, minMargin: e.target.value })}
            />
          </Field>
          <div className="flex justify-end sm:col-span-2">
            <Btn type="submit" variant="primary" busy={busy('proposalSettings')} disabled={busy()}>
              {t('common.save')}
            </Btn>
          </div>
        </form>
      )}
    </div>
  );
}
