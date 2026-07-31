'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useCallback } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { translateError } from '@/lib/errors';
import { formatMoney } from '@/lib/format';
import { PageHeader, StatusBadge, EmptyRow, LoadError } from '@/components/ui';

interface Summary {
  issuedInvoices: number;
  accountsReceivable: number | string;
  vatOutput: number | string;
  retentionHeld: number | string;
}
interface Invoice {
  id: string;
  code: string;
  status: string;
  subtotal: string;
  vatAmount: string;
  total: string;
  netPayable: string;
  customer?: { nameAr: string; nameEn: string };
  contract?: { code: string };
  eInvoice?: { uuid: string; authorityStatus: string; submissionMode: string } | null;
}

export default function InvoicesPage() {
  const { t, locale, pick } = useI18n();
  const [rows, setRows] = useState<Invoice[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setLoadErr('');
    Promise.all([api.get<Invoice[]>('/finance/invoices'), api.get<Summary>('/finance/summary')])
      .then(([inv, sum]) => {
        setRows(inv);
        setSummary(sum);
      })
      .catch((e) => setLoadErr(translateError(e, locale)))
      .finally(() => setLoading(false));
  }, [locale]);
  useEffect(load, [load]);

  const cards = [
    { key: 'inv.summary.receivable', value: formatMoney(summary?.accountsReceivable, locale), tone: 'text-brand-700' },
    { key: 'inv.summary.vat', value: formatMoney(summary?.vatOutput, locale), tone: 'text-amber-600' },
    { key: 'inv.summary.retention', value: formatMoney(summary?.retentionHeld, locale), tone: 'text-slate-700' },
    { key: 'inv.summary.issued', value: String(summary?.issuedInvoices ?? '—'), tone: 'text-emerald-600' },
  ];

  return (
    <div>
      <PageHeader title={t('inv.title')} />
      {loadErr && !loading ? <div className="mb-6"><LoadError message={loadErr} onRetry={load} /></div> : null}

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {cards.map((c) => (
          <div key={c.key} className="card p-4">
            <p className="text-xs text-slate-500">{t(c.key)}</p>
            <p className={`mt-1 text-xl font-bold ${c.tone}`}>{c.value}</p>
          </div>
        ))}
      </div>

      <div className="card table-sticky">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <th className="th">{t('common.code')}</th>
              <th className="th">{t('inv.customer')}</th>
              <th className="th">{t('inv.total')}</th>
              <th className="th">{t('inv.netPayable')}</th>
              <th className="th">{t('inv.status')}</th>
              <th className="th">{t('inv.zatcaStatus')}</th>
              <th className="th">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <EmptyRow colSpan={7} text={t('common.loading')} />
            ) : rows.length === 0 ? (
              <EmptyRow colSpan={7} text={t('inv.emptyHint')} actionHref="/contracts" actionText={t('nav.contracts')} />
            ) : (
              rows.map((inv) => (
                <tr key={inv.id} className="hover:bg-slate-50">
                  <td className="td font-mono text-xs">{inv.code}</td>
                  <td className="td">{inv.customer ? pick(inv.customer, 'name') : '—'}</td>
                  <td className="td">{formatMoney(inv.total, locale)}</td>
                  <td className="td font-medium">{formatMoney(inv.netPayable, locale)}</td>
                  <td className="td"><StatusBadge status={inv.status} /></td>
                  <td className="td">
                    {inv.eInvoice ? (
                      <StatusBadge status={inv.eInvoice.authorityStatus} />
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </td>
                  <td className="td">
                    <Link href={`/invoices/${inv.id}`} className="btn-ghost !px-3 !py-1 text-xs">
                      {t('common.details')}
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
