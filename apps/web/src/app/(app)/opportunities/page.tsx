'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { useEnums } from '@/lib/useEnums';
import { formatMoney } from '@/lib/format';
import { PageHeader, StatusBadge, Modal, Field, EmptyRow, LoadError, Can, Btn, TableSkeleton } from '@/components/ui';

interface Customer { id: string; code: string; nameAr: string; nameEn: string }
interface Opportunity {
  id: string;
  code: string;
  name: string;
  stage: string;
  estimatedValue?: string | null;
  customer?: Customer;
  _count?: { proposals: number };
}

export default function OpportunitiesPage() {
  const { t, locale, pick } = useI18n();
  const enums = useEnums();
  const router = useRouter();
  const [opps, setOpps] = useState<Opportunity[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');
  const [open, setOpen] = useState(false);
  const [stageFilter, setStageFilter] = useState('');
  const { act, busy } = useAct();

  const load = useCallback(() => {
    setLoading(true);
    setLoadErr('');
    Promise.all([api.get<Opportunity[]>('/opportunities'), api.get<Customer[]>('/customers')])
      .then(([o, c]) => {
        setOpps(o);
        setCustomers(c);
      })
      .catch((e) => setLoadErr(translateError(e, locale)))
      .finally(() => setLoading(false));
  }, [locale]);

  useEffect(load, [load]);

  // Opened from a dashboard quick action.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('new') === '1') setOpen(true);
  }, []);

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const ok = await act(
      'create',
      () =>
        api.post('/opportunities', {
          name: f.get('name'),
          customerId: f.get('customerId'),
          estimatedKwp: f.get('estimatedKwp') ? Number(f.get('estimatedKwp')) : undefined,
          estimatedValue: f.get('estimatedValue') ? Number(f.get('estimatedValue')) : undefined,
        }),
      { success: t('common.created') },
    );
    if (ok) {
      setOpen(false);
      load();
    }
  }

  async function createProposal(oppId: string) {
    let pid: string | null = null;
    const ok = await act(`proposal:${oppId}`, async () => {
      const p = await api.post<{ id: string }>('/proposals', { opportunityId: oppId });
      pid = p.id;
    });
    if (ok && pid) router.push(`/proposals/${pid}`);
  }

  const shown = stageFilter ? opps.filter((o) => o.stage === stageFilter) : opps;

  return (
    <div>
      <PageHeader
        title={t('opps.title')}
        action={
          <Can perm="crm.opportunity.write">
            <Btn variant="primary" icon="plus" onClick={() => setOpen(true)}>
              {t('opps.new')}
            </Btn>
          </Can>
        }
      />

      {loadErr && !loading ? <LoadError message={loadErr} onRetry={load} /> : null}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select
          className="input !w-56"
          aria-label={t('opps.stage')}
          value={stageFilter}
          onChange={(e) => setStageFilter(e.target.value)}
        >
          <option value="">
            {t('opps.stage')}: {t('common.all')}
          </option>
          {enums?.opportunityStages.map((o) => (
            <option key={o.value} value={o.value}>
              {locale === 'ar' ? o.labelAr : o.labelEn}
            </option>
          ))}
        </select>
      </div>
      <div className="card table-sticky">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <th scope="col" className="th">{t('common.code')}</th>
              <th scope="col" className="th">{t('opps.name')}</th>
              <th scope="col" className="th">{t('opps.customer')}</th>
              <th scope="col" className="th">{t('opps.stage')}</th>
              <th scope="col" className="th">{t('opps.estValue')}</th>
              <th scope="col" className="th">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <TableSkeleton cols={6} />
            ) : shown.length === 0 ? (
              <EmptyRow
                colSpan={6}
                text={t('opps.emptyHint')}
                actionHref="/customers"
                actionText={t('nav.customers')}
              />
            ) : (
              shown.map((o) => (
                <tr key={o.id} className="hover:bg-slate-50">
                  <td className="td font-mono text-xs">{o.code}</td>
                  <td className="td font-medium">{o.name}</td>
                  <td className="td">{o.customer ? pick(o.customer, 'name') : '—'}</td>
                  <td className="td">
                    <StatusBadge status={o.stage} />
                  </td>
                  <td className="td">{formatMoney(o.estimatedValue, locale)}</td>
                  <td className="td">
                    <Can perm="commercial.proposal.write">
                      <Btn
                        variant="solar"
                        sm
                        icon="file-text"
                        busy={busy(`proposal:${o.id}`)}
                        disabled={busy()}
                        onClick={() => createProposal(o.id)}
                      >
                        {t('opps.createProposal')}
                      </Btn>
                    </Can>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Modal open={open} title={t('opps.new')} onClose={() => setOpen(false)}>
        <form onSubmit={create} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t('opps.name')}>
            <input name="name" className="input" required />
          </Field>
          <Field label={t('opps.customer')}>
            <select name="customerId" className="input" required defaultValue="">
              <option value="" disabled>
                —
              </option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} · {pick(c, 'name')}
                </option>
              ))}
            </select>
            {customers.length === 0 && (
              <p className="mt-1 text-xs text-warning-600">
                {locale === 'ar' ? 'لا يوجد عملاء بعد — ' : 'No customers yet — '}
                <a href="/customers" className="underline">
                  {locale === 'ar' ? 'أنشئ عميلاً أولاً' : 'create one first'}
                </a>
              </p>
            )}
          </Field>
          <Field label={t('leads.kwp')}>
            <input name="estimatedKwp" type="number" step="0.001" className="input" />
          </Field>
          <Field label={t('opps.estValue')}>
            <input name="estimatedValue" type="number" step="0.01" className="input" />
          </Field>
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Btn onClick={() => setOpen(false)}>{t('common.cancel')}</Btn>
            <Btn type="submit" variant="primary" busy={busy('create')} disabled={busy()}>
              {t('common.create')}
            </Btn>
          </div>
        </form>
      </Modal>
    </div>
  );
}
