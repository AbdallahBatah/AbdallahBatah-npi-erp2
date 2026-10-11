'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { useEnums, optionLabel } from '@/lib/useEnums';
import { formatDay, formatNumber } from '@/lib/format';
import { PageHeader, StatusBadge, EmptyRow, LoadError, useConfirm, Can, Btn, TableSkeleton } from '@/components/ui';
import { Icon } from '@/components/icons';

interface Dash {
  plants: number;
  openAlerts: number;
  totalActualKwh: number;
  totalExpectedKwh: number;
  portfolioPr: number | null;
  series: { date: string; asset: string; energyKwh: number; expectedKwh: number | null; pr: number | null }[];
}
interface Alert {
  id: string;
  code: string;
  alertType: string;
  severity: string;
  status: string;
  message: string;
  ruleRef?: string | null;
  detectedAt: string;
  asset?: { code: string; nameAr: string; nameEn: string };
  workOrder?: { id: string; code: string; status: string } | null;
}
interface Project { id: string; code: string; nameAr: string; nameEn: string }

const SEV_STYLE: Record<string, string> = {
  INFO: 'bg-slate-100 text-slate-600',
  WARNING: 'bg-warning-100 text-warning-800',
  CRITICAL: 'bg-danger-100 text-danger-700',
};

export default function TelemetryPage() {
  const { t, locale } = useI18n();
  const enums = useEnums();
  const [dash, setDash] = useState<Dash | null>(null);
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loadErr, setLoadErr] = useState('');
  const { act, busy } = useAct();
  const { confirm, confirmNode } = useConfirm();

  const load = useCallback(() => {
    setLoadErr('');
    const fail = (e: unknown) => setLoadErr(translateError(e, locale));
    api.get<Dash>('/telemetry/dashboard').then(setDash).catch(fail);
    api.get<Alert[]>('/telemetry/alerts').then(setAlerts).catch(fail);
    api.get<Project[]>('/projects').then(setProjects).catch(fail);
  }, [locale]);
  useEffect(load, [load]);

  async function run(key: string, fn: () => Promise<unknown>) {
    if (await act(key, fn)) load();
  }

  async function simulate() {
    const prj = projects[0];
    if (!prj) return;
    if (!(await confirm({ title: t('confirm.simulateTitle'), message: t('confirm.simulateMsg') })))
      return;
    // A deliberately bad day 2 days ago exercises the CRITICAL alert → auto WO path.
    void run('simulate', () => api.post('/telemetry/simulate', { projectId: prj.id, days: 14, badDayOffset: 2 }));
  }

  const maxKwh = Math.max(1, ...(dash?.series ?? []).map((s) => Math.max(s.energyKwh, s.expectedKwh ?? 0)));

  return (
    <div>
      <PageHeader
        title={t('tel.title')}
        action={
          <Can perm="fsm.workorder.write">
            <Btn variant="primary" icon="activity" busy={busy('simulate')} disabled={busy() || projects.length === 0} onClick={simulate}>
              {t('tel.simulate')}
            </Btn>
          </Can>
        }
      />
      <p className="mb-4 -mt-4 flex items-center gap-1.5 text-xs text-slate-500">
        <Icon name="alert-triangle" className="h-3.5 w-3.5 shrink-0 text-warning-500" />
        {t('tel.simulateHint')}
      </p>
      {loadErr && <div className="mb-4"><LoadError message={loadErr} onRetry={load} /></div>}
      {confirmNode}

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="stat">
          <p className="text-xs font-semibold text-slate-500">{t('tel.plants')}</p>
          <p className="mt-2 text-3xl font-bold tabular-nums text-slate-900">{dash?.plants ?? '—'}</p>
        </div>
        <div className="stat">
          <p className="text-xs font-semibold text-slate-500">{t('tel.openAlerts')}</p>
          <p className={`mt-2 text-3xl font-bold tabular-nums ${(dash?.openAlerts ?? 0) > 0 ? 'text-danger-600' : 'text-success-600'}`}>
            {dash?.openAlerts ?? '—'}
          </p>
        </div>
        <div className="stat">
          <p className="text-xs font-semibold text-slate-500">{t('tel.actual14')}</p>
          <p className="mt-2 text-3xl font-bold tabular-nums text-brand-700">
            {dash ? `${formatNumber(dash.totalActualKwh, locale)} kWh` : '—'}
          </p>
        </div>
        <div className="stat">
          <p className="text-xs font-semibold text-slate-500">{t('tel.pr')}</p>
          <p className={`mt-2 text-3xl font-bold tabular-nums ${dash?.portfolioPr && dash.portfolioPr < 0.8 ? 'text-warning-600' : 'text-success-600'}`}>
            {dash?.portfolioPr != null ? `${Math.round(dash.portfolioPr * 100)}%` : '—'}
          </p>
        </div>
      </div>

      {/* Actual vs expected bar chart */}
      <div className="card table-sticky">
        <h2 className="card-title">
          {t('tel.chart')}
        </h2>
        <div className="p-5">
          {!dash || dash.series.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-500">{t('tel.noPlant')}</p>
          ) : (
            <div className="flex items-end gap-1" style={{ height: 160 }} dir="ltr">
              {dash.series.map((s) => {
                const hA = Math.max(3, (s.energyKwh / maxKwh) * 150);
                const hE = Math.max(3, ((s.expectedKwh ?? 0) / maxKwh) * 150);
                const low = s.pr != null && s.pr < 0.8;
                return (
                  <div
                    key={`${s.date}|${s.asset}`}
                    tabIndex={0}
                    role="img"
                    aria-label={`${formatDay(s.date, locale)} · ${formatNumber(s.energyKwh, locale)}/${
                      s.expectedKwh ?? '—'
                    } kWh${s.pr != null ? ` · PR ${Math.round(s.pr * 100)}%` : ''}`}
                    className="group relative flex flex-1 items-end justify-center gap-0.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
                  >
                    <div className="w-2 rounded-t bg-slate-200" style={{ height: hE }} />
                    <div
                      className={`w-2 rounded-t ${low ? 'bg-warning-400' : 'bg-brand-500'}`}
                      style={{ height: hA }}
                    />
                    <div className="pointer-events-none absolute -top-8 hidden whitespace-nowrap rounded bg-slate-800 px-2 py-1 text-xs text-white group-hover:block group-focus:block">
                      {formatDay(s.date, locale)} · {formatNumber(s.energyKwh, locale)}/
                      {s.expectedKwh ?? '—'} kWh
                      {s.pr != null ? ` · PR ${Math.round(s.pr * 100)}%` : ''}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <div className="mt-3 flex items-center gap-4 text-xs text-slate-500">
            <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded bg-slate-200" /> {t('tel.expected')}</span>
            <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded bg-brand-500" /> {t('tel.actual')}</span>
            <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded bg-warning-400" /> PR &lt; 80%</span>
          </div>
        </div>
      </div>

      {/* Alerts */}
      <div className="card table-sticky mt-6">
        <h2 className="card-title">
          {t('tel.alerts')}
        </h2>
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th scope="col" className="th">{t('common.code')}</th>
              <th scope="col" className="th">{t('wo.asset')}</th>
              <th scope="col" className="th hidden lg:table-cell">{t('tel.alertType')}</th>
              <th scope="col" className="th">{t('tel.severity')}</th>
              <th scope="col" className="th">{t('tel.message')}</th>
              <th scope="col" className="th">{t('common.status')}</th>
              <th scope="col" className="th hidden lg:table-cell">{t('tel.wo')}</th>
              <th scope="col" className="th">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {!alerts ? (
              <TableSkeleton cols={8} />
            ) : alerts.length === 0 ? (
              <EmptyRow colSpan={8} text={t('common.none')} />
            ) : (
              alerts.map((a) => (
                <tr key={a.id} className="hover:bg-slate-50">
                  <td className="td font-mono text-xs">{a.code}</td>
                  <td className="td text-xs">{a.asset?.code}</td>
                  <td className="td hidden lg:table-cell">{optionLabel(enums?.alertTypes, a.alertType, locale)}</td>
                  <td className="td">
                    <span className={`badge ${SEV_STYLE[a.severity] ?? ''}`}>
                      {optionLabel(enums?.alertSeverities, a.severity, locale)}
                    </span>
                  </td>
                  <td className="td max-w-xs truncate text-xs text-slate-500" title={a.message}>
                    {a.message}
                    <span className="ms-1 font-mono text-xs text-slate-500">{a.ruleRef}</span>
                  </td>
                  <td className="td"><StatusBadge status={a.status} /></td>
                  <td className="td hidden lg:table-cell">
                    {a.workOrder ? (
                      <Link href={`/workorders/${a.workOrder.id}`} className="font-mono text-xs text-brand-700 hover:underline">
                        {a.workOrder.code} <StatusBadge status={a.workOrder.status} />
                      </Link>
                    ) : (
                      <span className="text-xs text-slate-500">—</span>
                    )}
                  </td>
                  <td className="td">
                    <span className="flex gap-1">
                      <Can perm="fsm.workorder.write">
                        {a.status === 'OPEN' && (
                          <Btn
                            sm
                            icon="eye"
                            busy={busy(`ack:${a.id}`)}
                            disabled={busy()}
                            onClick={() => run(`ack:${a.id}`, () => api.post(`/telemetry/alerts/${a.id}/acknowledge`, {}))}
                          >
                            {t('tel.ack')}
                          </Btn>
                        )}
                        {!a.workOrder && a.status !== 'RESOLVED' && (
                          <Btn
                            variant="primary"
                            sm
                            icon="wrench"
                            busy={busy(`wo:${a.id}`)}
                            disabled={busy()}
                            onClick={() => run(`wo:${a.id}`, () => api.post(`/telemetry/alerts/${a.id}/work-order`, {}))}
                          >
                            {t('tel.raiseWo')}
                          </Btn>
                        )}
                      </Can>
                    </span>
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
