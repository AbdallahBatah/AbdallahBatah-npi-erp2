'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { formatMoney, formatDate } from '@/lib/format';
import { PageHeader, EmptyRow, LoadError, useConfirm, Btn, TableSkeleton } from '@/components/ui';

interface PocRow {
  contractId: string;
  code: string;
  customer: { nameAr: string; nameEn: string };
  contractValue: number;
  progressPct: number;
  recognizedRevenue: number;
  billedRevenue: number;
  postedAdjustment: number;
  targetAdjustment: number;
  unpostedDelta: number;
  position: 'CONTRACT_ASSET' | 'CONTRACT_LIABILITY' | 'BALANCED';
}
interface VatReturn {
  period: { from: string; to: string };
  invoiceCount: number;
  boxes: {
    standardRatedSales: number;
    outputVat: number;
    zeroRatedSales: number;
    exemptSales: number;
    standardRatedPurchases: number;
    inputVat: number;
  };
  netVatDue: number;
}
interface ProfRow {
  contractId: string;
  code: string;
  customer: { nameAr: string; nameEn: string };
  status: string;
  contractValue: number;
  estCost: number;
  estMargin: number;
  estMarginPct: number;
  billed: number;
  progressPct: number;
  earnedMargin: number;
  actualCost: number;
  marginToDate: number;
  projectCode?: string | null;
  costBasis: 'ACTUAL' | 'BOM_ESTIMATE';
}

const POSITION_STYLE: Record<PocRow['position'], string> = {
  CONTRACT_ASSET: 'bg-sky-100 text-sky-700',
  CONTRACT_LIABILITY: 'bg-amber-100 text-amber-700',
  BALANCED: 'bg-emerald-100 text-emerald-700',
};

export default function FinanceReportsPage() {
  const { t, locale, pick } = useI18n();
  const { can } = useAuth();
  const [poc, setPoc] = useState<PocRow[] | null>(null);
  const [vat, setVat] = useState<VatReturn | null>(null);
  const [prof, setProf] = useState<ProfRow[] | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [loadErr, setLoadErr] = useState('');
  const { act, busy } = useAct();
  const { confirm, confirmNode } = useConfirm();

  const loadVat = useCallback(
    (f?: string, tt?: string) => {
      const qs = new URLSearchParams();
      if (f) qs.set('from', f);
      if (tt) qs.set('to', tt);
      const q = qs.toString();
      api
        .get<VatReturn>(`/finance/reports/vat-return${q ? `?${q}` : ''}`)
        .then(setVat)
        .catch((e) => setLoadErr(translateError(e, locale)));
    },
    [locale],
  );

  const loadAll = useCallback(() => {
    setLoadErr('');
    api
      .get<PocRow[]>('/finance/reports/poc')
      .then(setPoc)
      .catch((e) => setLoadErr(translateError(e, locale)));
    api
      .get<ProfRow[]>('/finance/reports/profitability')
      .then(setProf)
      .catch((e) => setLoadErr(translateError(e, locale)));
    loadVat();
  }, [loadVat, locale]);

  useEffect(loadAll, [loadAll]);

  async function recognize(row: PocRow) {
    if (
      !(await confirm({
        title: t('confirm.recognizeTitle'),
        message: `${t('confirm.recognizeMsg')} (${formatMoney(Math.abs(row.unpostedDelta), locale)})`,
        danger: true,
      }))
    )
      return;
    if (await act(`rec:${row.contractId}`, () => api.post(`/finance/reports/poc/${row.contractId}/recognize`, {})))
      loadAll();
  }

  const positionLabel = (p: PocRow['position']) =>
    p === 'CONTRACT_ASSET' ? t('fin.poc.asset') : p === 'CONTRACT_LIABILITY' ? t('fin.poc.liability') : t('fin.poc.balanced');

  const sum = (arr: number[] | undefined) => (arr ?? []).reduce((s, v) => s + v, 0);
  const totContracts = sum(poc?.map((r) => r.contractValue));
  const totRecognized = sum(poc?.map((r) => r.recognizedRevenue));
  const totBilled = sum(poc?.map((r) => r.billedRevenue));
  const avgMargin = prof && prof.length ? sum(prof.map((r) => r.estMarginPct)) / prof.length : null;

  const kpis = [
    { key: 'fin.kpi.contracts', v: poc ? formatMoney(totContracts, locale) : '—', tone: 'text-slate-800' },
    { key: 'fin.kpi.recognized', v: poc ? formatMoney(totRecognized, locale) : '—', tone: 'text-brand-700' },
    { key: 'fin.kpi.billed', v: poc ? formatMoney(totBilled, locale) : '—', tone: 'text-emerald-600' },
    {
      key: vat && vat.netVatDue < 0 ? 'fin.vat.refundable' : 'fin.kpi.netVat',
      v: vat ? formatMoney(Math.abs(vat.netVatDue), locale) : '—',
      tone: vat && vat.netVatDue < 0 ? 'text-emerald-600' : 'text-amber-600',
    },
    {
      key: 'fin.kpi.avgMargin',
      v: avgMargin !== null ? `${avgMargin.toFixed(1)}%` : '—',
      tone: avgMargin !== null && avgMargin < 0 ? 'text-rose-600' : 'text-slate-800',
    },
  ];

  return (
    <div>
      <PageHeader title={t('fin.title')} />
      {loadErr ? <div className="mb-6"><LoadError message={loadErr} onRetry={loadAll} /></div> : null}
      {confirmNode}

      {/* KPI strip */}
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-5">
        {kpis.map((k) => (
          <div key={k.key} className="card p-4">
            <p className="text-xs text-slate-500">{t(k.key)}</p>
            <p className={`mt-1 text-lg font-bold ${k.tone}`}>{k.v}</p>
          </div>
        ))}
      </div>

      {/* FIN-05: IFRS-15 percentage of completion */}
      <div className="card overflow-hidden">
        <div className="border-b border-slate-100 px-5 py-3">
          <h3 className="font-semibold text-slate-800">{t('fin.poc.title')}</h3>
          <p className="mt-1 text-xs text-slate-600">{t('fin.poc.hint')}</p>
        </div>
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="th">{t('fin.poc.contract')}</th>
              <th className="th">{t('fin.poc.value')}</th>
              <th className="th">{t('fin.poc.progress')}</th>
              <th className="th text-end">{t('fin.poc.recognized')}</th>
              <th className="th text-end">{t('fin.poc.billed')}</th>
              <th className="th">{t('fin.poc.position')}</th>
              <th className="th text-end">{t('fin.poc.posted')}</th>
              <th className="th">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {!poc ? (
              <TableSkeleton cols={8} />
            ) : poc.length === 0 ? (
              <EmptyRow colSpan={8} text={t('common.none')} />
            ) : (
              poc.map((r) => (
                <tr key={r.contractId} className="hover:bg-slate-50">
                  <td className="td">
                    <span className="font-mono text-xs">{r.code}</span>
                    <p className="text-xs text-slate-600">{pick(r.customer, 'name')}</p>
                  </td>
                  <td className="td">{formatMoney(r.contractValue, locale)}</td>
                  <td className="td">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-slate-100">
                        <div
                          className="h-full rounded-full bg-brand-500"
                          style={{ width: `${Math.min(100, r.progressPct)}%` }}
                        />
                      </div>
                      <span className="text-xs text-slate-500">{r.progressPct}%</span>
                    </div>
                  </td>
                  <td className="td text-end">{formatMoney(r.recognizedRevenue, locale)}</td>
                  <td className="td text-end">{formatMoney(r.billedRevenue, locale)}</td>
                  <td className="td">
                    <span className={`badge ${POSITION_STYLE[r.position]}`}>{positionLabel(r.position)}</span>
                  </td>
                  <td className="td text-end">{formatMoney(r.postedAdjustment, locale)}</td>
                  <td className="td">
                    {Math.abs(r.unpostedDelta) >= 0.01 && can('finance.invoice.write') ? (
                      <Btn
                        variant="primary"
                        sm
                        icon="book"
                        busy={busy(`rec:${r.contractId}`)}
                        disabled={busy()}
                        onClick={() => recognize(r)}
                      >
                        {t('fin.poc.recognize')}
                      </Btn>
                    ) : (
                      <span className="text-xs text-slate-600">{t('fin.poc.nothing')}</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
          {poc && poc.length > 1 && (
            <tfoot className="border-t-2 border-slate-200 bg-slate-50/60">
              <tr>
                <td className="td text-xs font-bold text-slate-600">{t('fin.total')}</td>
                <td className="td font-bold">{formatMoney(totContracts, locale)}</td>
                <td className="td" />
                <td className="td text-end font-bold">{formatMoney(totRecognized, locale)}</td>
                <td className="td text-end font-bold">{formatMoney(totBilled, locale)}</td>
                <td className="td" colSpan={3} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* VAT return */}
        <div className="card overflow-hidden">
          <div className="border-b border-slate-100 px-5 py-3">
            <h3 className="font-semibold text-slate-800">{t('fin.vat.title')}</h3>
          </div>
          <div className="space-y-3 p-5 text-sm">
            <div className="flex items-end gap-2">
              <label className="flex-1 text-xs text-slate-500">
                {t('fin.vat.from')}
                <input type="date" className="input mt-1" value={from} onChange={(e) => setFrom(e.target.value)} />
              </label>
              <label className="flex-1 text-xs text-slate-500">
                {t('fin.vat.to')}
                <input type="date" className="input mt-1" value={to} onChange={(e) => setTo(e.target.value)} />
              </label>
              <Btn sm icon="refresh" onClick={() => loadVat(from || undefined, to || undefined)}>
                {t('fin.vat.apply')}
              </Btn>
            </div>
            {vat ? (
              <div>
                <p className="pb-3 text-xs text-slate-500">
                  {t('fin.vat.from')} {formatDate(vat.period.from, locale)} — {t('fin.vat.to')}{' '}
                  {formatDate(vat.period.to, locale)} · {t('fin.vat.invoices')}: {vat.invoiceCount}
                </p>

                {/* Net due — the number that matters */}
                <div
                  className={`mb-4 rounded-xl border p-4 text-center ${
                    vat.netVatDue < 0
                      ? 'border-emerald-200 bg-emerald-50/60'
                      : 'border-amber-200 bg-amber-50/60'
                  }`}
                >
                  <p className="text-xs text-slate-500">
                    {vat.netVatDue < 0 ? t('fin.vat.refundable') : t('fin.vat.netDue')}
                  </p>
                  <p
                    className={`mt-1 text-2xl font-bold ${
                      vat.netVatDue < 0 ? 'text-emerald-700' : 'text-amber-700'
                    }`}
                  >
                    {formatMoney(Math.abs(vat.netVatDue), locale)}
                  </p>
                </div>

                <p className="mb-1 text-[11px] font-bold text-slate-500">{t('fin.vat.salesGroup')}</p>
                <div className="mb-3 divide-y divide-slate-100 rounded-lg bg-slate-50/60 px-3">
                  {[
                    ['fin.vat.stdSales', vat.boxes.standardRatedSales],
                    ['fin.vat.outputVat', vat.boxes.outputVat],
                    ['fin.vat.zeroRated', vat.boxes.zeroRatedSales],
                    ['fin.vat.exempt', vat.boxes.exemptSales],
                  ].map(([key, val]) => (
                    <div key={key as string} className="flex items-center justify-between py-1.5">
                      <span className="text-xs text-slate-500">{t(key as string)}</span>
                      <span className="text-sm text-slate-700">{formatMoney(val as number, locale)}</span>
                    </div>
                  ))}
                </div>
                <p className="mb-1 text-[11px] font-bold text-slate-500">{t('fin.vat.purchGroup')}</p>
                <div className="divide-y divide-slate-100 rounded-lg bg-slate-50/60 px-3">
                  {[
                    ['fin.vat.purchases', vat.boxes.standardRatedPurchases],
                    ['fin.vat.inputVat', vat.boxes.inputVat],
                  ].map(([key, val]) => (
                    <div key={key as string} className="flex items-center justify-between py-1.5">
                      <span className="text-xs text-slate-500">{t(key as string)}</span>
                      <span className="text-sm text-slate-700">{formatMoney(val as number, locale)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-3" aria-hidden>
                <div className="skeleton h-3 w-24" />
                <div className="skeleton h-3 w-40" />
                <div className="skeleton h-3 w-32" />
              </div>
            )}
          </div>
        </div>

        {/* FIN-07: profitability */}
        <div className="card overflow-hidden lg:col-span-2">
          <div className="border-b border-slate-100 px-5 py-3">
            <h3 className="font-semibold text-slate-800">{t('fin.prof.title')}</h3>
            <p className="mt-1 text-xs text-slate-600">{t('fin.prof.hint')}</p>
          </div>
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="th">{t('fin.poc.contract')}</th>
                <th className="th text-end">{t('fin.poc.value')}</th>
                <th className="th text-end">{t('fin.prof.estCost')}</th>
                <th className="th text-end">{t('fin.prof.actualCost')}</th>
                <th className="th text-end">{t('fin.prof.marginPct')}</th>
                <th className="th text-end">{t('fin.poc.billed')}</th>
                <th className="th text-end">{t('fin.prof.marginToDate')}</th>
                <th className="th text-end">{t('fin.prof.earned')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {!prof ? (
                <TableSkeleton cols={8} />
              ) : prof.length === 0 ? (
                <EmptyRow colSpan={8} text={t('common.none')} />
              ) : (
                prof.map((r) => (
                  <tr
                    key={r.contractId}
                    className={`hover:bg-slate-50 ${r.marginToDate < 0 ? 'bg-rose-50/40' : ''}`}
                  >
                    <td className="td">
                      <span className="font-mono text-xs">{r.code}</span>
                      <p className="text-xs text-slate-600">{pick(r.customer, 'name')}</p>
                    </td>
                    <td className="td text-end">{formatMoney(r.contractValue, locale)}</td>
                    <td className="td text-end">{formatMoney(r.estCost, locale)}</td>
                    <td className="td text-end">
                      {formatMoney(r.actualCost, locale)}
                      {r.costBasis === 'ACTUAL' && (
                        <span className="ms-1 badge bg-brand-100 text-brand-800">{t('fin.prof.actualBadge')}</span>
                      )}
                    </td>
                    <td className="td text-end">
                      <div className="flex items-center justify-end gap-2">
                        <span className={r.estMarginPct < 0 ? 'font-medium text-rose-600' : ''}>
                          {r.estMarginPct}%
                        </span>
                        <div className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-100">
                          <div
                            className={`h-full rounded-full ${r.estMarginPct < 0 ? 'bg-rose-500' : r.estMarginPct < 10 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                            style={{ width: `${Math.min(100, Math.max(4, Math.abs(r.estMarginPct)))}%` }}
                          />
                        </div>
                      </div>
                    </td>
                    <td className="td text-end">{formatMoney(r.billed, locale)}</td>
                    <td className={`td text-end font-medium ${r.marginToDate >= 0 ? 'text-emerald-700' : 'text-rose-600'}`}>
                      {formatMoney(r.marginToDate, locale)}
                    </td>
                    <td className="td text-end">{formatMoney(r.earnedMargin, locale)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
