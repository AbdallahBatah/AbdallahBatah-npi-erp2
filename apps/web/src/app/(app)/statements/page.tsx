'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { formatDay, formatMoney } from '@/lib/format';
import { downloadCsv, fileStamp } from '@/lib/csv';
import { PageHeader, Modal, Field, LoadError, TableSkeleton, useConfirm, Btn } from '@/components/ui';
import { Icon } from '@/components/icons';

interface StatementLine {
  accountId: string;
  code: string;
  nameAr: string;
  nameEn: string;
  amount: number;
}

interface IncomeStatement {
  period: { from: string; to: string };
  revenue: StatementLine[];
  costOfRevenue: StatementLine[];
  otherExpenses: StatementLine[];
  totals: {
    revenue: number;
    costOfRevenue: number;
    grossProfit: number;
    grossMarginPct: number;
    otherExpenses: number;
    netResult: number;
  };
}

interface BalanceSheet {
  asOf: string;
  assets: StatementLine[];
  liabilities: StatementLine[];
  equity: StatementLine[];
  currentResult: number;
  totals: { assets: number; liabilities: number; equity: number; liabilitiesAndEquity: number };
  isBalanced: boolean;
}

interface FiscalPeriod {
  id: string;
  month: number;
  status: 'OPEN' | 'CLOSED';
}

interface FiscalYear {
  id: string;
  year: number;
  status: 'OPEN' | 'CLOSED';
  periods: FiscalPeriod[];
}

/** `YYYY-MM-DD` for a date input, in local time. */
function isoDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export default function StatementsPage() {
  const { t, locale, pick } = useI18n();
  const { can } = useAuth();
  const { act, busy } = useAct();
  const { confirm, confirmNode } = useConfirm();

  const today = new Date();
  const [from, setFrom] = useState(isoDay(new Date(today.getFullYear(), 0, 1)));
  const [to, setTo] = useState(isoDay(today));

  const [is, setIs] = useState<IncomeStatement | null>(null);
  const [bs, setBs] = useState<BalanceSheet | null>(null);
  const [years, setYears] = useState<FiscalYear[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');
  const [openYear, setOpenYear] = useState(false);

  const canManage = can('finance.period.manage');
  const months = t('st.fy.months').split(',');

  const load = useCallback(
    (f: string, tt: string) => {
      setLoading(true);
      setLoadErr('');
      Promise.all([
        api.get<IncomeStatement>(`/finance/reports/income-statement?from=${f}&to=${tt}`),
        api.get<BalanceSheet>(`/finance/reports/balance-sheet?asOf=${tt}`),
        api.get<FiscalYear[]>('/finance/fiscal/years'),
      ])
        .then(([a, b, c]) => {
          setIs(a);
          setBs(b);
          setYears(c);
        })
        .catch((e) => setLoadErr(translateError(e, locale)))
        .finally(() => setLoading(false));
    },
    [locale],
  );
  useEffect(() => load(from, to), [load]); // eslint-disable-line react-hooks/exhaustive-deps

  function exportIncome() {
    if (!is) return;
    const rows: Array<Array<string | number>> = [];
    const push = (section: string, lines: StatementLine[]) =>
      lines.forEach((l) => rows.push([section, l.code, pick(l, 'name'), l.amount]));
    push(t('st.is.revenue'), is.revenue);
    push(t('st.is.cost'), is.costOfRevenue);
    push(t('st.is.other'), is.otherExpenses);
    rows.push(['', '', t('st.is.gross'), is.totals.grossProfit]);
    rows.push(['', '', t('st.is.net'), is.totals.netResult]);
    downloadCsv(
      `income-statement-${fileStamp()}`,
      ['', t('common.code'), t('common.name'), t('common.total')],
      rows,
    );
  }

  function exportBalance() {
    if (!bs) return;
    const rows: Array<Array<string | number>> = [];
    const push = (section: string, lines: StatementLine[]) =>
      lines.forEach((l) => rows.push([section, l.code, pick(l, 'name'), l.amount]));
    push(t('st.bs.assets'), bs.assets);
    push(t('st.bs.liabilities'), bs.liabilities);
    push(t('st.bs.equity'), bs.equity);
    rows.push([t('st.bs.equity'), '', t('st.bs.result'), bs.currentResult]);
    rows.push(['', '', t('st.bs.totalAssets'), bs.totals.assets]);
    rows.push(['', '', t('st.bs.totalLiabEq'), bs.totals.liabilitiesAndEquity]);
    downloadCsv(
      `balance-sheet-${fileStamp()}`,
      ['', t('common.code'), t('common.name'), t('common.total')],
      rows,
    );
  }

  async function createYear(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const ok = await act(
      'openYear',
      () => api.post('/finance/fiscal/years', { year: Number(f.get('year')) }),
      { success: t('common.created') },
    );
    if (ok) {
      setOpenYear(false);
      load(from, to);
    }
  }

  async function togglePeriod(p: FiscalPeriod) {
    if (p.status === 'OPEN' && !(await confirm({
      title: t('st.fy.closePeriod'),
      message: t('confirm.closePeriod'),
    }))) {
      return;
    }
    const action = p.status === 'OPEN' ? 'close' : 'reopen';
    const ok = await act(`p:${p.id}`, () =>
      api.post(`/finance/fiscal/periods/${p.id}/${action}`, {}),
    );
    if (ok) load(from, to);
  }

  async function toggleYear(y: FiscalYear) {
    const closing = y.status === 'OPEN';
    const ready = await confirm({
      title: closing ? t('st.fy.close') : t('st.fy.reopen'),
      message: closing ? t('confirm.closeYear') : t('confirm.reopenYear'),
      danger: closing,
    });
    if (!ready) return;
    const ok = await act(`y:${y.id}`, () =>
      api.post(`/finance/fiscal/years/${y.id}/${closing ? 'close' : 'reopen'}`, {}),
    );
    if (ok) load(from, to);
  }

  const Section = ({ title, lines }: { title: string; lines: StatementLine[] }) => (
    <>
      <tr className="bg-slate-50">
        <td className="td font-semibold text-slate-700" colSpan={2}>
          {title}
        </td>
      </tr>
      {lines.map((l) => (
        <tr key={l.accountId} className="hover:bg-slate-50">
          <td className="td ps-8">
            <span className="me-2 font-mono text-xs text-slate-500">{l.code}</span>
            {pick(l, 'name')}
          </td>
          <td className="td-num">{formatMoney(l.amount, locale)}</td>
        </tr>
      ))}
    </>
  );

  // `tone` is passed only for the net result. A balance-sheet total is not a
  // win or a loss, so it stays neutral.
  const Total = ({
    label,
    value,
    strong,
    tone,
  }: {
    label: string;
    value: number;
    strong?: boolean;
    tone?: boolean;
  }) => {
    const color = tone ? (value < 0 ? 'text-danger-700' : 'text-success-700') : 'text-slate-900';
    const weight = strong ? `font-semibold ${color}` : 'font-medium';
    return (
      <tr className={strong ? 'border-t-2 border-slate-300' : 'border-t border-slate-200'}>
        <td className={`td ${weight}`}>{label}</td>
        <td className={`td-num ${weight}`}>{formatMoney(value, locale)}</td>
      </tr>
    );
  };

  return (
    <div>
      <PageHeader title={t('st.title')} subtitle={t('st.hint')} />

      <div className="mb-6 flex flex-wrap items-end gap-3">
        <Field label={t('st.from')}>
          <input
            className="input"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            dir="ltr"
          />
        </Field>
        <Field label={t('st.to')}>
          <input
            className="input"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            dir="ltr"
          />
        </Field>
        <Btn variant="primary" icon="refresh" busy={loading} onClick={() => load(from, to)}>
          {t('st.apply')}
        </Btn>
      </div>

      {loadErr && !loading ? <LoadError message={loadErr} onRetry={() => load(from, to)} /> : null}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* ── Income statement ─────────────────────────────────────────── */}
        <div className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-200 p-4">
            <div>
              <h2 className="font-semibold text-slate-800">{t('st.is.title')}</h2>
              {is ? (
                <p className="text-xs text-slate-500">
                  {formatDay(is.period.from, locale)} — {formatDay(is.period.to, locale)}
                </p>
              ) : null}
            </div>
            <Btn sm icon="download" disabled={!is} onClick={exportIncome}>
              {t('st.export')}
            </Btn>
          </div>
          <table className="min-w-full">
            <tbody className="divide-y divide-slate-100">
              {loading || !is ? (
                <TableSkeleton cols={2} rows={6} />
              ) : is.revenue.length + is.costOfRevenue.length + is.otherExpenses.length === 0 ? (
                <tr>
                  <td className="td text-slate-500" colSpan={2}>
                    {t('st.is.empty')}
                  </td>
                </tr>
              ) : (
                <>
                  <Section title={t('st.is.revenue')} lines={is.revenue} />
                  <Section title={t('st.is.cost')} lines={is.costOfRevenue} />
                  <Total label={t('st.is.gross')} value={is.totals.grossProfit} />
                  <tr>
                    <td className="td text-xs text-slate-500">{t('st.is.margin')}</td>
                    <td className="td-num text-xs text-slate-500">
                      {is.totals.grossMarginPct}%
                    </td>
                  </tr>
                  {is.otherExpenses.length > 0 ? (
                    <Section title={t('st.is.other')} lines={is.otherExpenses} />
                  ) : null}
                  <Total
                    label={is.totals.netResult >= 0 ? t('st.is.profit') : t('st.is.loss')}
                    value={is.totals.netResult}
                    strong
                    tone
                  />
                </>
              )}
            </tbody>
          </table>
        </div>

        {/* ── Balance sheet ────────────────────────────────────────────── */}
        <div className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-200 p-4">
            <div>
              <h2 className="font-semibold text-slate-800">{t('st.bs.title')}</h2>
              {bs ? (
                <p className="text-xs text-slate-500">
                  {t('st.asOf')} {formatDay(bs.asOf, locale)}
                </p>
              ) : null}
            </div>
            <Btn sm icon="download" disabled={!bs} onClick={exportBalance}>
              {t('st.export')}
            </Btn>
          </div>
          <table className="min-w-full">
            <tbody className="divide-y divide-slate-100">
              {loading || !bs ? (
                <TableSkeleton cols={2} rows={6} />
              ) : (
                <>
                  <Section title={t('st.bs.assets')} lines={bs.assets} />
                  <Total label={t('st.bs.totalAssets')} value={bs.totals.assets} strong />
                  <Section title={t('st.bs.liabilities')} lines={bs.liabilities} />
                  <Section title={t('st.bs.equity')} lines={bs.equity} />
                  <tr className="hover:bg-slate-50">
                    <td className="td ps-8 text-slate-600">{t('st.bs.result')}</td>
                    <td className="td-num">{formatMoney(bs.currentResult, locale)}</td>
                  </tr>
                  <Total
                    label={t('st.bs.totalLiabEq')}
                    value={bs.totals.liabilitiesAndEquity}
                    strong
                  />
                  <tr>
                    <td
                      className={`td text-xs ${bs.isBalanced ? 'text-success-600' : 'text-danger-600'}`}
                      colSpan={2}
                    >
                      {bs.isBalanced ? (
                        <span className="inline-flex items-center gap-1">
                          <Icon name="check" className="h-3.5 w-3.5" />
                          {t('st.bs.balanced')}
                        </span>
                      ) : (
                        t('st.bs.unbalanced')
                      )}
                    </td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Fiscal calendar ────────────────────────────────────────────── */}
      <div className="mt-8">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-slate-800">{t('st.fy.title')}</h2>
            <p className="text-xs text-slate-500">{t('st.fy.hint')}</p>
          </div>
          {canManage ? (
            <Btn variant="primary" icon="plus" onClick={() => setOpenYear(true)}>
              {t('st.fy.open')}
            </Btn>
          ) : null}
        </div>

        {years.length === 0 && !loading ? (
          <div className="card p-6 text-sm text-slate-500">{t('st.fy.empty')}</div>
        ) : (
          <div className="space-y-4">
            {years.map((y) => (
              <div key={y.id} className="card p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-3">
                    <span className="text-lg font-semibold text-slate-900">{y.year}</span>
                    <span
                      className={`badge ${
                        y.status === 'OPEN'
                          ? 'bg-success-50 text-success-700'
                          : 'bg-slate-100 text-slate-600'
                      }`}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          y.status === 'OPEN' ? 'bg-success-500' : 'bg-slate-400'
                        }`}
                      />
                      {t(`st.fy.status.${y.status}`)}
                    </span>
                  </div>
                  {canManage ? (
                    <Btn
                      variant={y.status === 'OPEN' ? 'danger' : 'ghost'}
                      sm
                      icon={y.status === 'OPEN' ? 'lock' : 'unlock'}
                      busy={busy(`y:${y.id}`)}
                      onClick={() => toggleYear(y)}
                    >
                      {y.status === 'OPEN' ? t('st.fy.close') : t('st.fy.reopen')}
                    </Btn>
                  ) : null}
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                  {y.periods.map((p) => (
                    <div
                      key={p.id}
                      className={`flex items-center justify-between rounded-lg border px-3 py-2 text-sm ${
                        p.status === 'OPEN'
                          ? 'border-slate-200 bg-white'
                          : 'border-slate-200 bg-slate-50 text-slate-500'
                      }`}
                    >
                      <span>{months[p.month - 1] ?? p.month}</span>
                      {canManage && y.status === 'OPEN' ? (
                        <button
                          className="text-xs text-brand-600 hover:underline disabled:opacity-50"
                          disabled={busy(`p:${p.id}`)}
                          onClick={() => togglePeriod(p)}
                        >
                          {p.status === 'OPEN' ? t('st.fy.closePeriod') : t('st.fy.reopenPeriod')}
                        </button>
                      ) : (
                        <span className="text-xs">{t(`st.fy.status.${p.status}`)}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Modal open={openYear} title={t('st.fy.open')} onClose={() => setOpenYear(false)}>
        <form onSubmit={createYear} className="grid gap-4">
          <Field label={t('st.fy.year')}>
            <input
              name="year"
              className="input"
              type="number"
              min={2000}
              max={2100}
              defaultValue={today.getFullYear()}
              required
              dir="ltr"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Btn onClick={() => setOpenYear(false)}>{t('common.cancel')}</Btn>
            <Btn type="submit" variant="primary" busy={busy('openYear')} disabled={busy()}>
              {t('common.create')}
            </Btn>
          </div>
        </form>
      </Modal>

      {confirmNode}
    </div>
  );
}
