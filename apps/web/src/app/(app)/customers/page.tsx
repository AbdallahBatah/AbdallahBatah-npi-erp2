'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { useEnums, optionLabel } from '@/lib/useEnums';
import { PageHeader, Modal, Field, EmptyRow, LoadError, Can } from '@/components/ui';

interface Customer {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  customerType: string;
  vatNumber?: string | null;
  crNumber?: string | null;
  phone?: string | null;
  email?: string | null;
}

export default function CustomersPage() {
  const { t, locale, pick } = useI18n();
  const enums = useEnums();
  const [rows, setRows] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const { act, busy } = useAct();

  const load = useCallback(
    (q?: string) => {
      setLoading(true);
      setLoadErr('');
      api
        .get<Customer[]>(`/customers${q ? `?search=${encodeURIComponent(q)}` : ''}`)
        .then(setRows)
        .catch((e) => setLoadErr(translateError(e, locale)))
        .finally(() => setLoading(false));
    },
    [locale],
  );
  useEffect(() => load(), [load]);

  // Deep link from global search (?q=...).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('q');
    if (q) setSearch(q);
  }, []);
  // Opened from a dashboard quick action.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('new') === '1') setOpen(true);
  }, []);

  // Debounced server-side search.
  useEffect(() => {
    const h = setTimeout(() => load(search.trim() || undefined), 350);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const nameAr = String(f.get('nameAr') || '').trim();
    const nameEn = String(f.get('nameEn') || '').trim();
    const ok = await act(
      'create',
      () =>
        api.post('/customers', {
          nameAr: nameAr || nameEn,
          nameEn: nameEn || nameAr,
          customerType: f.get('customerType'),
          vatNumber: f.get('vatNumber') || undefined,
          crNumber: f.get('crNumber') || undefined,
          phone: f.get('phone') || undefined,
          email: f.get('email') || undefined,
        }),
      { success: t('common.created') },
    );
    if (ok) {
      setOpen(false);
      load(search.trim() || undefined);
    }
  }

  return (
    <div>
      <PageHeader
        title={t('cust.title')}
        subtitle={t('cust.hint')}
        action={
          <Can perm="crm.customer.write">
            <button className="btn-primary" onClick={() => setOpen(true)}>
              + {t('cust.new')}
            </button>
          </Can>
        }
      />

      <div className="mb-4">
        <input
          className="input max-w-sm"
          placeholder={t('common.search') + '…'}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {loadErr && !loading ? <LoadError message={loadErr} onRetry={() => load(search.trim() || undefined)} /> : null}
      <div className="card table-sticky">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <th className="th">{t('common.code')}</th>
              <th className="th">{t('common.name')}</th>
              <th className="th">{t('common.type')}</th>
              <th className="th">{t('cust.vat')}</th>
              <th className="th">{t('leads.phone')}</th>
              <th className="th">{t('leads.email')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <EmptyRow colSpan={6} text={t('common.loading')} />
            ) : rows.length === 0 ? (
              <EmptyRow colSpan={6} text={t('cust.empty')} />
            ) : (
              rows.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50">
                  <td className="td font-mono text-xs">{c.code}</td>
                  <td className="td font-medium">{pick(c, 'name')}</td>
                  <td className="td">{optionLabel(enums?.customerTypes, c.customerType, locale)}</td>
                  <td className="td font-mono text-xs">{c.vatNumber ?? '—'}</td>
                  <td className="td text-xs">{c.phone ?? '—'}</td>
                  <td className="td text-xs">{c.email ?? '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Modal open={open} title={t('cust.new')} onClose={() => setOpen(false)}>
        <form onSubmit={create} className="grid grid-cols-2 gap-4">
          <Field label={t('cust.nameAr')}>
            <input name="nameAr" className="input" required dir="rtl" />
          </Field>
          <Field label={`${t('cust.nameEn')} (${t('common.optional')})`}>
            <input name="nameEn" className="input" dir="ltr" />
          </Field>
          <Field label={t('common.type')}>
            <select name="customerType" className="input" defaultValue="CI">
              {enums?.customerTypes.map((o) => (
                <option key={o.value} value={o.value}>
                  {locale === 'ar' ? o.labelAr : o.labelEn}
                </option>
              ))}
            </select>
          </Field>
          <Field label={`${t('cust.vat')} (${t('common.optional')})`}>
            <input name="vatNumber" className="input" dir="ltr" />
          </Field>
          <Field label={`${t('cust.cr')} (${t('common.optional')})`}>
            <input name="crNumber" className="input" dir="ltr" />
          </Field>
          <Field label={`${t('leads.phone')} (${t('common.optional')})`}>
            <input name="phone" className="input" dir="ltr" />
          </Field>
          <Field label={`${t('leads.email')} (${t('common.optional')})`}>
            <input name="email" type="email" className="input" dir="ltr" />
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
    </div>
  );
}
