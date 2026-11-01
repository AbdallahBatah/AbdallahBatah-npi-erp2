'use client';

/** Package 7 · P7-3 — receivables aging and the six-month cash forecast. */
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { translateError } from '@/lib/errors';
import { formatMoney } from '@/lib/format';
import { PageHeader, EmptyRow, LoadError, PageSkeleton } from '@/components/ui';

interface Report {
  asOf: string;
  aging: { notDue: number; d1_30: number; d31_60: number; d61_90: number; d90plus: number };
  overdue: Array<{ code: string; customer: { nameAr: string; nameEn: string }; outstanding: number; daysLate: number }>;
  forecast: Array<{ month: string; inflow: number; outflow: number; net: number; cumulative: number }>;
}

export default function CashFlowPage() {
  const { t, locale, pick } = useI18n();
  const [r, setR] = useState<Report | null>(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => {
    api
      .get<Report>('/finance/reports/cash-flow')
      .then(setR)
      .catch((e) => setErr(translateError(e, locale)));
  }, [locale]);
  useEffect(load, [load]);
  if (err && !r) return <LoadError message={err} onRetry={load} />;
  if (!r) return <PageSkeleton stats={5} />;
  const buckets: Array<[keyof Report['aging'], string]> = [
    ['notDue', t('cf.notDue')],
    ['d1_30', '1–30'],
    ['d31_60', '31–60'],
    ['d61_90', '61–90'],
    ['d90plus', '+90'],
  ];
  const max = Math.max(1, ...r.forecast.map((f) => Math.max(f.inflow, f.outflow)));

  return (
    <div className="space-y-6">
      <PageHeader title={t('cf.title')} subtitle={t('cf.hint')} backHref="/finance" backLabel={t('nav.finance')} />
      <section>
        <h2 className="mb-2 text-sm font-semibold text-slate-700">{t('cf.aging')}</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {buckets.map(([k, label]) => (
            <div key={k} className="card p-4">
              <p className="text-xs text-slate-500">{label}</p>
              <p className={`mt-1 font-bold ${k !== 'notDue' && r.aging[k] > 0 ? 'text-danger-700' : ''}`}>{formatMoney(r.aging[k], locale)}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="card overflow-hidden">
        <h2 className="card-title">{t('cf.forecast')}</h2>
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th scope="col" className="th">{t('cf.month')}</th>
              <th scope="col" className="th text-end">{t('cf.in')}</th>
              <th scope="col" className="th text-end">{t('cf.out')}</th>
              <th scope="col" className="th text-end">{t('cf.net')}</th>
              <th scope="col" className="th text-end">{t('cf.cumulative')}</th>
              <th scope="col" className="th w-48" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {r.forecast.map((f) => (
              <tr key={f.month}>
                <td className="td font-mono text-xs">{f.month}</td>
                <td className="td-num text-success-700">{formatMoney(f.inflow, locale)}</td>
                <td className="td-num text-danger-700">{formatMoney(f.outflow, locale)}</td>
                <td className={`td-num font-semibold ${f.net < 0 ? 'text-danger-700' : ''}`}>{formatMoney(f.net, locale)}</td>
                <td className={`td-num ${f.cumulative < 0 ? 'text-danger-700' : ''}`}>{formatMoney(f.cumulative, locale)}</td>
                <td className="td">
                  <div className="space-y-1">
                    <div className="h-1.5 rounded-full bg-success-500" style={{ width: `${(f.inflow / max) * 100}%` }} />
                    <div className="h-1.5 rounded-full bg-danger-500" style={{ width: `${(f.outflow / max) * 100}%` }} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card overflow-hidden">
        <h2 className="card-title">{t('cf.overdue')}</h2>
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <tbody className="divide-y divide-slate-100">
            {r.overdue.length === 0 ? (
              <EmptyRow colSpan={4} text={t('common.none')} />
            ) : (
              r.overdue.map((o) => (
                <tr key={o.code}>
                  <td className="td font-mono text-xs">{o.code}</td>
                  <td className="td">{pick(o.customer, 'name')}</td>
                  <td className="td-num">{formatMoney(o.outstanding, locale)}</td>
                  <td className="td-num text-danger-700">
                    {o.daysLate} {t('cf.days')}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
