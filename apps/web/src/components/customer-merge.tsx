'use client';

/**
 * Admin → "Customer merge" (CRM Phase 1, Step 2).
 *
 * Shows the suggested groups of duplicate customers and, per group, lets the
 * administrator pick the record that survives. The list is always view-only;
 * the merge button works only when the organization has switched
 * `crm.customer.mergeEnabled` on (it ships OFF, and a banner says so). A merge
 * cannot be undone from the app, so confirming it asks for the file name of the
 * database backup taken first.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { formatDate } from '@/lib/format';
import { Btn, Field, LoadError, Modal, PageSkeleton } from '@/components/ui';

interface Member {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  crNumber: string | null;
  vatNumber: string | null;
  mobile: string | null;
  createdAt: string;
  counts: Record<'leads' | 'opportunities' | 'contracts' | 'invoices' | 'contacts' | 'activities' | 'followUpTasks', number>;
  totalDocuments: number;
}
type Reason = { kind: 'CR' | 'VAT' | 'MOBILE'; value: string } | { kind: 'NAME'; score: number };
interface Group {
  id: string;
  reasons: Reason[];
  members: Member[];
  suggestedSurvivorId: string;
}
interface DuplicatesResponse {
  mergeEnabled: boolean;
  threshold: number;
  truncated: boolean;
  groups: Group[];
}

const COUNT_KEYS = ['leads', 'opportunities', 'contracts', 'invoices', 'contacts', 'activities', 'followUpTasks'] as const;

export function CustomerMergeCard() {
  const { t, locale, pick } = useI18n();
  const { act, busy } = useAct();
  const [data, setData] = useState<DuplicatesResponse | null>(null);
  const [err, setErr] = useState('');
  const [survivors, setSurvivors] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<Group | null>(null);
  const [backupRef, setBackupRef] = useState('');

  const load = useCallback(() => {
    setErr('');
    api
      .get<DuplicatesResponse>('/customers/duplicates')
      .then(setData)
      .catch((e) => setErr(translateError(e, locale)));
  }, [locale]);
  useEffect(load, [load]);

  if (err) return <LoadError message={err} onRetry={load} />;
  if (!data) return <PageSkeleton stats={0} />;

  const survivorOf = (g: Group) => survivors[g.id] ?? g.suggestedSurvivorId;

  async function runMerge(g: Group) {
    const survivorId = survivorOf(g);
    const ok = await act(
      'merge',
      () =>
        api.post('/customers/merge', {
          survivorId,
          mergedIds: g.members.map((m) => m.id).filter((x) => x !== survivorId),
          backupRef: backupRef.trim(),
        }),
      { success: t('cust.merge.done') },
    );
    if (ok) {
      setConfirming(null);
      setBackupRef('');
      load();
    }
  }

  const reasonLabel = (r: Reason) =>
    r.kind === 'NAME'
      ? `${t('cust.merge.reason.NAME')} ${Math.round(r.score * 100)}%`
      : `${t(`cust.merge.reason.${r.kind}`)}: ${r.value}`;

  return (
    <div>
      {!data.mergeEnabled && (
        <output className="block mb-4 rounded-xl border border-warning-200 bg-warning-50/60 p-4 text-sm font-semibold text-warning-900">
          {t('cust.merge.disabledBanner')}
        </output>
      )}
      <p className="mb-1 text-sm text-slate-600">{t('cust.merge.hint')}</p>
      <p className="mb-5 text-xs text-slate-500">
        {t('cust.merge.threshold')}: {Math.round(data.threshold * 100)}%
        {data.truncated ? ` — ${t('cust.merge.truncated')}` : ''}
      </p>

      {data.groups.length === 0 ? (
        <div className="card p-8 text-center text-sm text-slate-500">{t('cust.merge.empty')}</div>
      ) : (
        <div className="space-y-5">
          {data.groups.map((g, n) => (
            <section key={g.id} className="card overflow-hidden" aria-label={`${t('cust.merge.group')} ${n + 1}`}>
              <div className="card-title flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="font-bold">
                    {t('cust.merge.group')} {n + 1}
                  </h3>
                  <p className="mt-1 flex flex-wrap gap-1.5">
                    {g.reasons.map((r) => (
                      <span key={reasonLabel(r)} className="badge bg-warning-50 text-warning-700">
                        {reasonLabel(r)}
                      </span>
                    ))}
                  </p>
                </div>
                <Btn
                  variant="primary"
                  disabled={!data.mergeEnabled || busy()}
                  title={data.mergeEnabled ? undefined : t('cust.merge.disabledBanner')}
                  onClick={() => {
                    setBackupRef('');
                    setConfirming(g);
                  }}
                >
                  {t('cust.merge.button')}
                </Btn>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-slate-200">
                  <thead className="bg-slate-50">
                    <tr>
                      <th scope="col" className="th">{t('cust.merge.survivor')}</th>
                      <th scope="col" className="th">{t('common.code')}</th>
                      <th scope="col" className="th">{t('common.name')}</th>
                      <th scope="col" className="th">{t('cust.cr')} / {t('cust.vat')} / {t('cust.mobile')}</th>
                      <th scope="col" className="th">{t('cust.col.date')}</th>
                      {COUNT_KEYS.map((k) => (
                        <th key={k} scope="col" className="th">{t(`cust.merge.c.${k}`)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {g.members.map((m) => (
                      <tr key={m.id} className={survivorOf(g) === m.id ? 'bg-brand-50/40' : 'hover:bg-slate-50'}>
                        <td className="td">
                          <label className="flex items-center gap-2 text-xs">
                            <input
                              type="radio"
                              name={`survivor-${g.id}`}
                              checked={survivorOf(g) === m.id}
                              onChange={() => setSurvivors((s) => ({ ...s, [g.id]: m.id }))}
                            />
                            {m.id === g.suggestedSurvivorId && (
                              <span className="badge bg-success-50 text-success-700">{t('cust.merge.suggested')}</span>
                            )}
                          </label>
                        </td>
                        <td className="td font-mono text-xs">
                          <Link href={`/customers/${m.id}`} className="text-brand-700 hover:underline">
                            {m.code}
                          </Link>
                        </td>
                        <td className="td font-medium">{pick(m, 'name')}</td>
                        <td className="td font-mono text-xs" dir="ltr">
                          {[m.crNumber, m.vatNumber, m.mobile].filter(Boolean).join(' · ') || '—'}
                        </td>
                        <td className="td text-xs">{formatDate(m.createdAt, locale)}</td>
                        {COUNT_KEYS.map((k) => (
                          <td key={k} className="td text-center">{m.counts[k]}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      )}

      <Modal open={!!confirming} title={t('cust.merge.confirmTitle')} onClose={() => setConfirming(null)}>
        {confirming && (
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void runMerge(confirming);
            }}
          >
            <p className="text-sm leading-7 text-slate-700">{t('cust.merge.confirmMsg')}</p>
            <p className="text-sm font-semibold text-slate-900">
              {t('cust.merge.survivor')}:{' '}
              {confirming.members.find((m) => m.id === survivorOf(confirming))?.code}
            </p>
            <Field label={t('cust.merge.backupLabel')} hint={t('cust.merge.backupHint')}>
              <input
                className="input"
                dir="ltr"
                required
                minLength={8}
                value={backupRef}
                onChange={(e) => setBackupRef(e.target.value)}
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Btn onClick={() => setConfirming(null)}>{t('common.cancel')}</Btn>
              <Btn
                type="submit"
                variant="danger"
                busy={busy('merge')}
                disabled={busy() || backupRef.trim().length < 8}
              >
                {t('cust.merge.button')}
              </Btn>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
