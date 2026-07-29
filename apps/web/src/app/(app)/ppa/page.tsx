'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { formatMoney, formatDate, formatNumber } from '@/lib/format';
import { PageHeader, StatusBadge, EmptyRow, Modal, Field, LoadError, useConfirm } from '@/components/ui';

interface Term {
  id: string;
  code: string;
  ratePerKwh: string;
  escalationPctPerYear: string;
  fixedMonthlyFee: string;
  billingCycle: string;
  status: string;
  startDate: string;
  contract?: { code: string; contractType: string; customer?: { nameAr: string; nameEn: string } };
  project?: { code: string; nameAr: string; nameEn: string };
  _count?: { settlementRuns: number };
}
interface Run {
  id: string;
  code: string;
  periodStart: string;
  periodEnd: string;
  energyKwh: string;
  appliedRate: string;
  variableAmount: string;
  fixedAmount: string;
  subtotal: string;
  ppaTerm?: { code: string; contract?: { code: string } };
  invoice?: { id: string; code: string; status: string; total: string } | null;
}
interface Project { id: string; code: string; nameAr: string; nameEn: string }
interface Contract { id: string; code: string; contractType: string; status: string; customer?: { nameAr: string; nameEn: string } }

export default function PpaPage() {
  const { t, locale, pick } = useI18n();
  const [terms, setTerms] = useState<Term[] | null>(null);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [loadErr, setLoadErr] = useState('');
  const { act, busy } = useAct();
  const { confirm, confirmNode } = useConfirm();

  // Term modal
  const [tOpen, setTOpen] = useState(false);
  const [fContractId, setFContractId] = useState('');
  const [fProjectId, setFProjectId] = useState('');
  const [fRate, setFRate] = useState(0.32);
  const [fEsc, setFEsc] = useState(2);
  const [fFixed, setFFixed] = useState(0);

  // Settle modal
  const [sOpen, setSOpen] = useState(false);
  const [sTermId, setSTermId] = useState('');
  const [sFrom, setSFrom] = useState('');
  const [sTo, setSTo] = useState('');

  const load = useCallback(() => {
    setLoadErr('');
    const fail = (e: unknown) => setLoadErr(translateError(e, locale));
    api.get<Term[]>('/ppa/terms').then(setTerms).catch(fail);
    api.get<Run[]>('/ppa/runs').then(setRuns).catch(fail);
    api.get<Project[]>('/projects').then(setProjects).catch(fail);
    api
      .get<Contract[]>('/contracts')
      .then((c) =>
        setContracts(c.filter((x) => ['PPA', 'OM'].includes(x.contractType) && x.status === 'ACTIVE')),
      )
      .catch(fail);
  }, [locale]);
  useEffect(load, [load]);

  function openSettle(termId: string) {
    setSTermId(termId);
    // Default to the last 14 days (matching the simulated telemetry window).
    const now = new Date();
    const from = new Date(now.getTime() - 14 * 24 * 3600 * 1000);
    setSFrom(from.toISOString().slice(0, 10));
    setSTo(new Date(now.getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10));
    setSOpen(true);
  }

  return (
    <div>
      <PageHeader
        title={t('ppa.title')}
        action={
          <button className="btn-primary text-xs" onClick={() => setTOpen(true)}>
            ⚡ {t('ppa.new')}
          </button>
        }
      />
      <p className="mb-4 -mt-4 text-xs text-slate-400">{t('ppa.hint')}</p>
      {loadErr ? <div className="mb-4"><LoadError message={loadErr} onRetry={load} /></div> : null}

      {/* Terms */}
      <div className="card overflow-hidden">
        <div className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-800">
          {t('ppa.terms')}
        </div>
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="th">{t('common.code')}</th>
              <th className="th">{t('ppa.contract')}</th>
              <th className="th">{t('ppa.project')}</th>
              <th className="th text-end">{t('ppa.rate')}</th>
              <th className="th text-end">{t('ppa.escalation')}</th>
              <th className="th text-end">{t('ppa.fixedFee')}</th>
              <th className="th">{t('common.status')}</th>
              <th className="th">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {!terms ? (
              <EmptyRow colSpan={8} text={t('common.loading')} />
            ) : terms.length === 0 ? (
              <EmptyRow colSpan={8} text={t('common.none')} />
            ) : (
              terms.map((tm) => (
                <tr key={tm.id} className="hover:bg-slate-50">
                  <td className="td font-mono text-xs">{tm.code}</td>
                  <td className="td">
                    <span className="font-mono text-xs">{tm.contract?.code}</span>
                    <p className="text-xs text-slate-400">
                      {tm.contract?.customer ? pick(tm.contract.customer, 'name') : ''}
                    </p>
                  </td>
                  <td className="td font-mono text-xs">{tm.project?.code}</td>
                  <td className="td text-end">{Number(tm.ratePerKwh)}</td>
                  <td className="td text-end">{Number(tm.escalationPctPerYear)}%</td>
                  <td className="td text-end">{formatMoney(tm.fixedMonthlyFee, locale)}</td>
                  <td className="td"><StatusBadge status={tm.status} /></td>
                  <td className="td">
                    {tm.status === 'ACTIVE' && (
                      <button className="btn-solar !px-3 !py-1 text-xs" onClick={() => openSettle(tm.id)}>
                        💰 {t('ppa.settle')}
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Runs */}
      <div className="card mt-6 overflow-hidden">
        <div className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-800">
          {t('ppa.runs')}
        </div>
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="th">{t('common.code')}</th>
              <th className="th">{t('ppa.period')}</th>
              <th className="th text-end">{t('ppa.energy')}</th>
              <th className="th text-end">{t('ppa.appliedRate')}</th>
              <th className="th text-end">{t('ppa.variable')}</th>
              <th className="th text-end">{t('ppa.fixed')}</th>
              <th className="th text-end">{t('inv.subtotal')}</th>
              <th className="th">{t('ppa.invoice')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {!runs ? (
              <EmptyRow colSpan={8} text={t('common.loading')} />
            ) : runs.length === 0 ? (
              <EmptyRow colSpan={8} text={t('common.none')} />
            ) : (
              runs.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="td font-mono text-xs">{r.code}</td>
                  <td className="td text-xs text-slate-500">
                    {formatDate(r.periodStart, locale)} — {formatDate(r.periodEnd, locale)}
                  </td>
                  <td className="td text-end font-medium">{formatNumber(Number(r.energyKwh), locale)}</td>
                  <td className="td text-end">{Number(r.appliedRate)}</td>
                  <td className="td text-end">{formatMoney(r.variableAmount, locale)}</td>
                  <td className="td text-end">{formatMoney(r.fixedAmount, locale)}</td>
                  <td className="td text-end font-medium">{formatMoney(r.subtotal, locale)}</td>
                  <td className="td">
                    {r.invoice ? (
                      <Link href={`/invoices/${r.invoice.id}`} className="font-mono text-xs text-brand-700 hover:underline">
                        {r.invoice.code} <StatusBadge status={r.invoice.status} />
                      </Link>
                    ) : '—'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* New term modal */}
      <Modal open={tOpen} title={t('ppa.new')} onClose={() => setTOpen(false)}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={`${t('ppa.contract')} (PPA/OM)`}>
            <select className="input" value={fContractId} onChange={(e) => setFContractId(e.target.value)}>
              <option value="">{t('ppa.inlineHint')}</option>
              {contracts.map((c) => (
                <option key={c.id} value={c.id}>{c.code} · {c.customer ? pick(c.customer, 'name') : ''}</option>
              ))}
            </select>
          </Field>
          <Field label={t('ppa.project')}>
            <select className="input" value={fProjectId} onChange={(e) => setFProjectId(e.target.value)}>
              <option value="">—</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.code} · {pick(p, 'name')}</option>
              ))}
            </select>
          </Field>
          <Field label={t('ppa.rate')}>
            <input type="number" min={0.0001} step="0.0001" className="input" value={fRate} onChange={(e) => setFRate(Number(e.target.value))} />
          </Field>
          <Field label={t('ppa.escalation')}>
            <input type="number" min={0} step="0.1" className="input" value={fEsc} onChange={(e) => setFEsc(Number(e.target.value))} />
          </Field>
          <Field label={t('ppa.fixedFee')}>
            <input type="number" min={0} step="0.01" className="input" value={fFixed} onChange={(e) => setFFixed(Number(e.target.value))} />
          </Field>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-ghost text-xs" onClick={() => setTOpen(false)}>{t('common.cancel')}</button>
          <button
            className="btn-primary text-xs"
            disabled={busy() || !fProjectId || !fRate}
            onClick={async () => {
              const ok = await act(
                'term',
                () =>
                  api.post('/ppa/terms', {
                    contractId: fContractId || undefined,
                    projectId: fProjectId,
                    ratePerKwh: fRate,
                    escalationPctPerYear: fEsc,
                    fixedMonthlyFee: fFixed,
                  }),
                { success: t('common.created') },
              );
              if (ok) {
                setTOpen(false);
                load();
              }
            }}
          >
            {busy('term') ? t('common.loading') : t('common.create')}
          </button>
        </div>
      </Modal>

      {/* Settle modal */}
      <Modal
        open={sOpen}
        title={`${t('ppa.settle')}${(() => {
          const term = terms?.find((x) => x.id === sTermId);
          return term ? ` — ${term.code}` : '';
        })()}`}
        onClose={() => setSOpen(false)}
      >
        <div className="grid grid-cols-2 gap-4">
          <Field label={t('fin.vat.from')}>
            <input type="date" className="input" value={sFrom} onChange={(e) => setSFrom(e.target.value)} />
          </Field>
          <Field label={t('fin.vat.to')}>
            <input type="date" className="input" value={sTo} onChange={(e) => setSTo(e.target.value)} />
          </Field>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-ghost text-xs" onClick={() => setSOpen(false)}>{t('common.cancel')}</button>
          <button
            className="btn-solar text-xs"
            disabled={busy() || !sFrom || !sTo}
            onClick={async () => {
              if (
                !(await confirm({
                  title: t('confirm.settleTitle'),
                  message: t('confirm.settleMsg'),
                  danger: true,
                }))
              )
                return;
              const ok = await act('settle', () =>
                api.post(`/ppa/terms/${sTermId}/settle`, { periodStart: sFrom, periodEnd: sTo }),
              );
              if (ok) {
                setSOpen(false);
                load();
              }
            }}
          >
            {busy('settle') ? t('common.loading') : t('ppa.settle')}
          </button>
        </div>
      </Modal>
      {confirmNode}
    </div>
  );
}
