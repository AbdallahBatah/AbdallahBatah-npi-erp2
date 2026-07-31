'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { formatMoney, formatNumber } from '@/lib/format';
import { PageHeader } from '@/components/ui';

interface Summary {
  openLeads: number;
  openOpportunities: number;
  totalContracts: number;
  activeContracts: number;
  pipelineValue: number | string;
}
interface FinSummary {
  issuedInvoices: number;
  accountsReceivable: number | string;
  vatOutput: number | string;
  retentionHeld: number | string;
}
interface WoSummary { open: number; inProgress: number; overdue: number; closedThisMonth: number }
interface TelDash { plants: number; openAlerts: number; totalActualKwh: number; portfolioPr: number | null }

/** Tailwind needs literal class names — map a tile count to its grid. */
const GRID_COLS: Record<number, string> = {
  1: 'lg:grid-cols-1',
  2: 'lg:grid-cols-2',
  3: 'lg:grid-cols-3',
  4: 'lg:grid-cols-4',
};

export default function DashboardPage() {
  const { t, locale } = useI18n();
  const { can } = useAuth();
  const [data, setData] = useState<Summary | null>(null);
  const [fin, setFin] = useState<FinSummary | null>(null);
  const [wo, setWo] = useState<WoSummary | null>(null);
  const [tel, setTel] = useState<TelDash | null>(null);

  // One flag per data source, keyed to the permission its endpoint requires.
  // A user without the permission must never see the tile at all: firing the
  // call anyway and rendering the 403 as "—" makes the system look broken.
  const canCrm = can('crm.lead.read'); // /reference/dashboard
  const canFin = can('finance.invoice.read'); // /finance/summary
  const canOps = can('fsm.workorder.read'); // work-order summary + telemetry

  useEffect(() => {
    if (canCrm) api.get<Summary>('/reference/dashboard').then(setData).catch(() => setData(null));
    if (canFin) api.get<FinSummary>('/finance/summary').then(setFin).catch(() => setFin(null));
    if (canOps) {
      api.get<WoSummary>('/fsm/work-orders/summary').then(setWo).catch(() => setWo(null));
      api.get<TelDash>('/telemetry/dashboard').then(setTel).catch(() => setTel(null));
    }
  }, [canCrm, canFin, canOps]);

  // A tile needs both its data source and read access to the page it links to.
  const kpis = [
    { key: 'dash.openLeads', value: data?.openLeads, icon: '🎯', href: '/leads', show: canCrm },
    { key: 'dash.openOpps', value: data?.openOpportunities, icon: '💡', href: '/opportunities', show: canCrm && can('crm.opportunity.read') },
    { key: 'dash.activeContracts', value: data?.activeContracts, icon: '📝', href: '/contracts', show: canCrm && can('commercial.contract.read') },
    { key: 'inv.summary.issued', value: fin?.issuedInvoices, icon: '🧾', href: '/invoices', show: canFin },
  ].filter((c) => c.show);

  const steps = [
    { key: 'dash.step.lead', icon: '🎯' },
    { key: 'dash.step.opp', icon: '💡' },
    { key: 'dash.step.proposal', icon: '📄' },
    { key: 'dash.step.contract', icon: '📝' },
  ];

  const num = (v: number | undefined | null) =>
    v == null ? '—' : formatNumber(v, locale);

  return (
    <div>
      <PageHeader title={t('dash.title')} subtitle={t('app.tagline')} />

      {/* Row 1: sales KPIs */}
      {kpis.length > 0 && (
      <div className={`grid grid-cols-2 gap-4 ${GRID_COLS[kpis.length] ?? 'lg:grid-cols-4'}`}>
        {kpis.map((c) => (
          <Link key={c.key} href={c.href} className="stat group">
            <div className="flex items-start justify-between">
              <p className="text-xs font-semibold text-slate-400">{t(c.key)}</p>
              <span className="text-lg opacity-40 transition group-hover:opacity-80">{c.icon}</span>
            </div>
            <p className="mt-2 text-3xl font-bold tracking-tight text-slate-900">{num(c.value)}</p>
          </Link>
        ))}
      </div>
      )}

      {/* Row 2: money + operations */}
      {(canCrm || canOps) && (
      <div className={`mt-4 grid grid-cols-1 gap-4 ${GRID_COLS[(canCrm ? 1 : 0) + (canOps ? 2 : 0)] ?? 'lg:grid-cols-3'}`}>
        {canCrm && (
        <div className="stat">
          <p className="text-xs font-semibold text-slate-400">{t('dash.pipeline')}</p>
          <p className="mt-2 text-2xl font-bold text-brand-700">
            {formatMoney(data?.pipelineValue, locale)}
          </p>
          {/* Receivables/retention come from the finance summary — a separate
              permission from the pipeline figure above them. */}
          {canFin && (
          <div className="mt-3 space-y-1.5 border-t border-slate-100 pt-3 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-slate-400">{t('inv.summary.receivable')}</span>
              <span className="font-semibold text-slate-700">{formatMoney(fin?.accountsReceivable, locale)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-400">{t('inv.summary.retention')}</span>
              <span className="font-semibold text-slate-700">{formatMoney(fin?.retentionHeld, locale)}</span>
            </div>
          </div>
          )}
        </div>
        )}

        {canOps && (
        <Link href="/workorders" className="stat group">
          <div className="flex items-start justify-between">
            <p className="text-xs font-semibold text-slate-400">{t('wo.title')}</p>
            <span className="text-lg opacity-40 transition group-hover:opacity-80">🔧</span>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 text-center">
            <div className="rounded-lg bg-sky-50 py-2">
              <p className="text-xl font-bold text-sky-700">{num(wo?.open)}</p>
              <p className="text-[10px] font-medium text-sky-600">{t('wo.summary.open')}</p>
            </div>
            <div className="rounded-lg bg-amber-50 py-2">
              <p className="text-xl font-bold text-amber-700">{num(wo?.inProgress)}</p>
              <p className="text-[10px] font-medium text-amber-600">{t('wo.summary.inProgress')}</p>
            </div>
            <div className={`rounded-lg py-2 ${(wo?.overdue ?? 0) > 0 ? 'bg-rose-50' : 'bg-emerald-50'}`}>
              <p className={`text-xl font-bold ${(wo?.overdue ?? 0) > 0 ? 'text-rose-700' : 'text-emerald-700'}`}>
                {num(wo?.overdue)}
              </p>
              <p className={`text-[10px] font-medium ${(wo?.overdue ?? 0) > 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
                {t('wo.summary.overdue')}
              </p>
            </div>
          </div>
        </Link>
        )}

        {canOps && (
        <Link href="/telemetry" className="stat group">
          <div className="flex items-start justify-between">
            <p className="text-xs font-semibold text-slate-400">{t('tel.title')}</p>
            <span className="text-lg opacity-40 transition group-hover:opacity-80">📡</span>
          </div>
          <div className="mt-2 flex items-end justify-between">
            <div>
              <p className="text-2xl font-bold text-slate-900">
                {tel ? `${num(Math.round(tel.totalActualKwh))}` : '—'}
                <span className="ms-1 text-xs font-medium text-slate-400">kWh</span>
              </p>
              <p className="mt-0.5 text-[11px] text-slate-400">{t('tel.actual14')}</p>
            </div>
            <div className="text-end">
              <p className={`text-2xl font-bold ${tel?.portfolioPr && tel.portfolioPr < 0.8 ? 'text-amber-600' : 'text-emerald-600'}`}>
                {tel?.portfolioPr != null ? `${Math.round(tel.portfolioPr * 100)}%` : '—'}
              </p>
              <p className="mt-0.5 text-[11px] text-slate-400">PR</p>
            </div>
            <div className="text-end">
              <p className={`text-2xl font-bold ${(tel?.openAlerts ?? 0) > 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
                {num(tel?.openAlerts)}
              </p>
              <p className="mt-0.5 text-[11px] text-slate-400">{t('tel.openAlerts')}</p>
            </div>
          </div>
        </Link>
        )}
      </div>
      )}

      {/* A role with none of the three data sources (e.g. a pure warehouse
          keeper) gets an explicit message rather than a blank page. */}
      {kpis.length === 0 && !canCrm && !canOps && (
        <div className="card p-8 text-center text-sm text-slate-500">{t('dash.noMetrics')}</div>
      )}

      {/* Workflow */}
      <div className="card mt-6 p-6">
        <h2 className="mb-5 text-sm font-bold text-slate-800">{t('dash.flow')}</h2>
        <div className="flex flex-wrap items-center gap-2">
          {steps.map((s, i) => (
            <div key={s.key} className="flex items-center gap-2">
              <div className="flex items-center gap-2.5 rounded-xl border border-brand-100 bg-gradient-to-b from-brand-50/80 to-white px-4 py-3">
                <span className="text-base">{s.icon}</span>
                <span className="text-sm font-semibold text-brand-800">{t(s.key)}</span>
              </div>
              {i < steps.length - 1 && (
                <span className="text-slate-300 rtl:rotate-180">→</span>
              )}
            </div>
          ))}
          <span className="text-slate-300 rtl:rotate-180">→</span>
          <div className="flex items-center gap-2.5 rounded-xl border border-solar-200 bg-gradient-to-b from-solar-50 to-white px-4 py-3">
            <span className="text-base">⚡</span>
            <span className="text-sm font-semibold text-solar-700">
              {locale === 'ar' ? 'تشغيل + تسوية' : 'Operate + settle'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
