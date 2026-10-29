'use client';

/**
 * Package 3 · P3-6 (ADR-03 §4-6, owner work cycle step 6) — «تظهر الموازنة
 * التقديرية ... في الشاشة الرئيسية للمدير العام للاعتماد». The budgets waiting
 * on the caller's signature, with the figures the decision rests on. Signing
 * itself stays in the approvals inbox (one place for every chain); this card
 * shows what is waiting and links to both the budget and the inbox.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { formatDateTime, formatMoney, formatNumber } from '@/lib/format';
import { Icon } from '@/components/icons';

interface Row {
  requestId: string;
  proposalId: string;
  code: string;
  revisionNo: number;
  opportunity: { id: string; name: string };
  customer: { nameAr: string; nameEn: string };
  capacityKwp: string | null;
  totalAmount: string;
  estimatedCost: string | null;
  contingencyAmount: string | null;
  marginAmount: string | null;
  marginPct: number | null;
  belowFloor: boolean | null;
  raisedBy: { nameAr: string; nameEn: string } | null;
  waitingSince: string;
}

export function BudgetApprovalsCard() {
  const { t, locale, pick } = useI18n();
  const [data, setData] = useState<{ minMarginPct: number; rows: Row[] } | null>(null);

  useEffect(() => {
    api
      .get<{ minMarginPct: number; rows: Row[] }>('/proposals/awaiting-me')
      .then(setData)
      .catch(() => setData(null));
  }, []);

  if (!data) return null;

  return (
    <div className="card mb-4 p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-bold text-slate-800">
          <Icon name="stamp" className="h-4 w-4 text-warning-600" />
          {t('dash.budgets.title')}
          {data.rows.length > 0 && (
            <span className="rounded-full bg-warning-100 px-2 py-0.5 text-xs font-bold text-warning-800">{data.rows.length}</span>
          )}
        </h2>
        <Link href="/approvals" className="text-xs font-semibold text-brand-700 underline">
          {t('proposals.openInbox')}
        </Link>
      </div>
      {data.rows.length === 0 ? (
        <p className="text-sm text-slate-500">{t('dash.budgets.none')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-xs text-slate-500">
                <th scope="col" className="th">{t('dash.budgets.budget')}</th>
                <th scope="col" className="th text-end">{t('proposals.capacity')}</th>
                <th scope="col" className="th text-end">{t('budget.sellingTotal')}</th>
                <th scope="col" className="th text-end">{t('budget.estimatedCost')}</th>
                <th scope="col" className="th text-end">{t('budget.profit')}</th>
                <th scope="col" className="th text-end">{t('dash.budgets.margin')}</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.requestId} className={`border-b border-slate-50 ${r.belowFloor ? 'bg-danger-50/50' : ''}`}>
                  <td className="py-2">
                    <Link href={`/proposals/${r.proposalId}`} className="font-semibold text-brand-700 hover:underline">
                      {r.code} R{r.revisionNo}
                    </Link>
                    <div className="text-xs text-slate-500">
                      {pick(r.customer, 'name')} · {r.opportunity.name}
                    </div>
                    <div className="text-xs text-slate-400">
                      {r.raisedBy ? `${pick(r.raisedBy, 'name')} · ` : ''}
                      {formatDateTime(r.waitingSince, locale)}
                    </div>
                  </td>
                  <td className="td-num">{r.capacityKwp ? formatNumber(r.capacityKwp, locale) : '—'}</td>
                  <td className="td-num font-semibold">{formatMoney(r.totalAmount, locale)}</td>
                  <td className="td-num">{r.estimatedCost !== null ? formatMoney(r.estimatedCost, locale) : '—'}</td>
                  <td className="td-num">{r.marginAmount !== null ? formatMoney(r.marginAmount, locale) : '—'}</td>
                  <td className={`td-num ${r.belowFloor ? 'font-bold text-danger-700' : 'text-success-700'}`}>
                    {r.marginPct !== null ? `${r.marginPct}%` : '—'}
                    {r.belowFloor && (
                      <span className="ms-1 inline-flex" title={t('dash.budgets.belowFloor').replace('{n}', String(data.minMarginPct))}>
                        <Icon name="alert-triangle" className="h-3.5 w-3.5" />
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.rows.some((r) => r.belowFloor) && (
            <p className="mt-2 text-xs text-danger-700">
              {t('dash.budgets.belowFloor').replace('{n}', String(data.minMarginPct))}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
