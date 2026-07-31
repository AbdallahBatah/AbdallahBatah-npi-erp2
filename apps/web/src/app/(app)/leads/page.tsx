'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { useEnums, optionLabel } from '@/lib/useEnums';
import { formatNumber } from '@/lib/format';
import { PageHeader, StatusBadge, Modal, Field, EmptyRow, LoadError, useConfirm } from '@/components/ui';

interface Lead {
  id: string;
  code: string;
  contactName: string;
  companyName?: string;
  source: string;
  status: string;
  estimatedKwp?: string | null;
}

export default function LeadsPage() {
  const { t, locale } = useI18n();
  const enums = useEnums();
  const router = useRouter();
  const PAGE = 25;
  const [leads, setLeads] = useState<Lead[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');
  const [open, setOpen] = useState(false);
  const { act, busy } = useAct();
  const { confirm, confirmNode } = useConfirm();

  const load = useCallback(() => {
    setLoading(true);
    setLoadErr('');
    const qs = new URLSearchParams({ take: String(PAGE), skip: String(page * PAGE) });
    if (search.trim()) qs.set('search', search.trim());
    if (statusFilter) qs.set('status', statusFilter);
    api
      .get<{ rows: Lead[]; total: number }>(`/leads?${qs}`)
      .then((d) => {
        setLeads(d.rows);
        setTotal(d.total);
      })
      .catch((e) => setLoadErr(translateError(e, locale)))
      .finally(() => setLoading(false));
  }, [locale, page, search, statusFilter]);

  useEffect(() => {
    const h = setTimeout(load, search ? 350 : 0);
    return () => clearTimeout(h);
  }, [load, search]);

  // Deep link from global search (?q=...).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('q');
    if (q) setSearch(q);
  }, []);

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const ok = await act(
      'create',
      () =>
        api.post('/leads', {
          contactName: f.get('contactName'),
          companyName: f.get('companyName') || undefined,
          source: f.get('source'),
          estimatedKwp: f.get('estimatedKwp') ? Number(f.get('estimatedKwp')) : undefined,
          phone: f.get('phone') || undefined,
          email: f.get('email') || undefined,
        }),
      { success: t('common.created') },
    );
    if (ok) {
      setOpen(false);
      load();
    }
  }

  async function convert(id: string) {
    if (!(await confirm({ title: t('confirm.convertTitle'), message: t('confirm.convertMsg') })))
      return;
    if (await act(`convert:${id}`, () => api.post(`/leads/${id}/convert`, {})))
      router.push(`/opportunities`);
  }

  return (
    <div>
      <PageHeader
        title={t('leads.title')}
        action={
          <button className="btn-primary" onClick={() => setOpen(true)}>
            + {t('leads.new')}
          </button>
        }
      />

      {loadErr && !loading ? <LoadError message={loadErr} onRetry={load} /> : null}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          className="input max-w-xs"
          placeholder={t('common.search') + '…'}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
        />
        <select
          className="input !w-44"
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value);
            setPage(0);
          }}
        >
          <option value="">{t('common.status')}: {locale === 'ar' ? 'الكل' : 'All'}</option>
          {enums?.leadStatuses.map((o) => (
            <option key={o.value} value={o.value}>
              {locale === 'ar' ? o.labelAr : o.labelEn}
            </option>
          ))}
        </select>
      </div>
      <div className="card overflow-hidden">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <th className="th">{t('common.code')}</th>
              <th className="th">{t('leads.contactName')}</th>
              <th className="th">{t('leads.company')}</th>
              <th className="th">{t('leads.source')}</th>
              <th className="th">{t('leads.kwp')}</th>
              <th className="th">{t('common.status')}</th>
              <th className="th">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <EmptyRow colSpan={7} text={t('common.loading')} />
            ) : leads.length === 0 ? (
              <EmptyRow colSpan={7} text={t('leads.emptyHint')} />
            ) : (
              leads.map((l) => (
                <tr key={l.id} className="hover:bg-slate-50">
                  <td className="td font-mono text-xs">{l.code}</td>
                  <td className="td font-medium">{l.contactName}</td>
                  <td className="td">{l.companyName ?? '—'}</td>
                  <td className="td">{optionLabel(enums?.leadSources, l.source, locale)}</td>
                  <td className="td">{l.estimatedKwp ? formatNumber(l.estimatedKwp, locale) : '—'}</td>
                  <td className="td"><StatusBadge status={l.status} /></td>
                  <td className="td">
                    {l.status !== 'CONVERTED' ? (
                      <button
                        className="btn-solar !px-3 !py-1 text-xs"
                        disabled={busy()}
                        onClick={() => convert(l.id)}
                      >
                        {busy(`convert:${l.id}`) ? t('common.loading') : t('leads.convert')}
                      </button>
                    ) : (
                      <span className="text-xs text-emerald-600">{t('leads.converted')}</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        {total > PAGE && (
          <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2.5 text-xs text-slate-500">
            <span>
              {page * PAGE + 1}–{Math.min((page + 1) * PAGE, total)} {t('common.of')} {total}
            </span>
            <span className="flex gap-1">
              <button className="btn-ghost !px-2.5 !py-1" disabled={page === 0} onClick={() => setPage(page - 1)}>
                {t('common.prev')}
              </button>
              <button
                className="btn-ghost !px-2.5 !py-1"
                disabled={(page + 1) * PAGE >= total}
                onClick={() => setPage(page + 1)}
              >
                {t('common.next')}
              </button>
            </span>
          </div>
        )}
      </div>

      <Modal open={open} title={t('leads.new')} onClose={() => setOpen(false)}>
        <form onSubmit={create} className="grid grid-cols-2 gap-4">
          <Field label={t('leads.contactName')}>
            <input name="contactName" className="input" required />
          </Field>
          <Field label={t('leads.company')}>
            <input name="companyName" className="input" />
          </Field>
          <Field label={t('leads.source')}>
            <select name="source" className="input" defaultValue="DIRECT">
              {enums?.leadSources.map((o) => (
                <option key={o.value} value={o.value}>
                  {locale === 'ar' ? o.labelAr : o.labelEn}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('leads.kwp')}>
            <input name="estimatedKwp" type="number" step="0.001" className="input" />
          </Field>
          <Field label={t('leads.phone')}>
            <input name="phone" className="input" />
          </Field>
          <Field label={t('leads.email')}>
            <input name="email" type="email" className="input" />
          </Field>
          <div className="col-span-2 flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </button>
            <button type="submit" className="btn-primary" disabled={busy()}>
              {busy('create') ? t('common.loading') : t('common.create')}
            </button>
          </div>
        </form>
      </Modal>
      {confirmNode}
    </div>
  );
}
