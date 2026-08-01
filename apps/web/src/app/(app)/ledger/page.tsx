'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { translateError } from '@/lib/errors';
import { formatMoney, formatDate, formatDay } from '@/lib/format';
import { downloadCsv, fileStamp } from '@/lib/csv';
import { translateMemo } from '@/lib/memo';
import { PageHeader, EmptyRow, LoadError, Btn, TableSkeleton } from '@/components/ui';

type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';

interface TbRow {
  accountId: string;
  code: string;
  nameAr: string;
  nameEn: string;
  accountType: AccountType;
  opening: number;
  debit: number;
  credit: number;
  closing: number;
  hasActivity: boolean;
}
interface TrialBalance {
  period: { from: string; to: string };
  rows: TbRow[];
  totals: { opening: number; debit: number; credit: number; closingDebit: number; closingCredit: number };
  isBalanced: boolean;
}
interface GlRow {
  id: string;
  entryId: string;
  postingDate: string;
  sourceType: string;
  sourceId: string;
  memo: string | null;
  isReversal: boolean;
  invoiceCode: string | null;
  debit: number;
  credit: number;
  balance: number;
}
interface GeneralLedger {
  account: { id: string; code: string; nameAr: string; nameEn: string; accountType: AccountType };
  period: { from: string; to: string };
  opening: number;
  pageOpening: number;
  closing: number;
  periodDebit: number;
  periodCredit: number;
  rows: GlRow[];
  total: number;
}

const TYPE_STYLE: Record<AccountType, string> = {
  ASSET: 'bg-sky-50 text-sky-700',
  LIABILITY: 'bg-amber-50 text-amber-700',
  EQUITY: 'bg-violet-50 text-violet-700',
  REVENUE: 'bg-emerald-50 text-emerald-700',
  EXPENSE: 'bg-rose-50 text-rose-600',
};

const PAGE = 50;

export default function LedgerPage() {
  const { t, locale, pick } = useI18n();
  const [tb, setTb] = useState<TrialBalance | null>(null);
  const [gl, setGl] = useState<GeneralLedger | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // Applied period — separate from the inputs so the ledger and the trial
  // balance always cover the exact same range the user last confirmed.
  const [period, setPeriod] = useState<{ from: string; to: string }>({ from: '', to: '' });
  const [showZero, setShowZero] = useState(false);
  const [loadErr, setLoadErr] = useState('');

  const qs = useCallback(
    (extra: Record<string, string | number> = {}) => {
      const p = new URLSearchParams();
      if (period.from) p.set('from', period.from);
      if (period.to) p.set('to', period.to);
      for (const [k, v] of Object.entries(extra)) p.set(k, String(v));
      const s = p.toString();
      return s ? `?${s}` : '';
    },
    [period],
  );

  const loadTb = useCallback(() => {
    setLoadErr('');
    api
      .get<TrialBalance>(`/finance/reports/trial-balance${qs()}`)
      .then(setTb)
      .catch((e) => setLoadErr(translateError(e, locale)));
  }, [qs, locale]);

  useEffect(loadTb, [loadTb]);

  useEffect(() => {
    if (!accountId) {
      setGl(null);
      return;
    }
    api
      .get<GeneralLedger>(
        `/finance/reports/general-ledger/${accountId}${qs({ take: PAGE, skip: page * PAGE })}`,
      )
      .then(setGl)
      .catch((e) => setLoadErr(translateError(e, locale)));
  }, [accountId, page, qs, locale]);

  function apply() {
    setPeriod({ from, to });
    setPage(0);
  }

  function openAccount(id: string) {
    setPage(0);
    setAccountId(id === accountId ? null : id);
  }

  const typeLabel = (ty: AccountType) => t(`gl.type.${ty}`);
  /** Accounting presentation: magnitude plus a debit/credit marker, never a minus sign. */
  const balanceCell = (v: number) => (
    <>
      {formatMoney(Math.abs(v), locale)}
      <span className="ms-1 text-[11px] text-slate-400">
        {v === 0 ? '' : v > 0 ? t('gl.debit') : t('gl.credit')}
      </span>
    </>
  );
  const sourceLabel = (src: string) => {
    const key = `gl.src.${src}`;
    const label = t(key);
    return label === key ? src : label;
  };

  const visibleRows = (tb?.rows ?? []).filter((r) => showZero || r.hasActivity);

  function exportTb() {
    if (!tb) return;
    downloadCsv(
      `trial-balance-${fileStamp()}`,
      [
        t('gl.accountNo'),
        t('gl.account'),
        t('gl.type'),
        t('gl.opening'),
        t('gl.debit'),
        t('gl.credit'),
        t('gl.closing'),
      ],
      [
        ...visibleRows.map((r) => [
          r.code,
          pick(r, 'name'),
          typeLabel(r.accountType),
          r.opening,
          r.debit,
          r.credit,
          r.closing,
        ]),
        [
          '',
          t('fin.total'),
          '',
          tb.totals.opening,
          tb.totals.debit,
          tb.totals.credit,
          tb.totals.closingDebit - tb.totals.closingCredit,
        ],
      ],
    );
  }

  /** Exports the whole period, not just the page on screen. */
  async function exportGl() {
    if (!gl) return;
    const CHUNK = 500; // server cap on `take`
    const all: GlRow[] = [];
    try {
      for (let skip = 0; skip < gl.total && skip < 20000; skip += CHUNK) {
        const chunk = await api.get<GeneralLedger>(
          `/finance/reports/general-ledger/${gl.account.id}${qs({ take: CHUNK, skip })}`,
        );
        all.push(...chunk.rows);
      }
    } catch (e) {
      setLoadErr(translateError(e, locale));
      return;
    }
    downloadCsv(
      `ledger-${gl.account.code}-${fileStamp()}`,
      [
        t('common.date'),
        t('gl.detail.source'),
        t('gl.detail.memo'),
        t('gl.debit'),
        t('gl.credit'),
        t('gl.detail.balance'),
      ],
      [
        ['', t('gl.detail.openingRow'), '', '', '', gl.opening],
        ...all.map((r) => [
          r.postingDate.slice(0, 10),
          `${sourceLabel(r.sourceType)}${r.invoiceCode ? ` ${r.invoiceCode}` : ''}`,
          translateMemo(r.memo, locale),
          r.debit,
          r.credit,
          r.balance,
        ]),
        ['', t('fin.total'), '', gl.periodDebit, gl.periodCredit, gl.closing],
      ],
    );
  }

  return (
    <div>
      <PageHeader
        title={t('gl.title')}
        subtitle={tb ? `${formatDay(tb.period.from, locale)} — ${formatDay(tb.period.to, locale)}` : undefined}
        action={
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-slate-500">
              {t('gl.from')}
              <input type="date" className="input mt-1" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="text-xs text-slate-500">
              {t('gl.to')}
              <input type="date" className="input mt-1" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
            <Btn sm icon="refresh" onClick={apply}>
              {t('gl.apply')}
            </Btn>
          </div>
        }
      />

      {loadErr ? (
        <div className="mb-6">
          <LoadError message={loadErr} onRetry={loadTb} />
        </div>
      ) : null}

      {/* Trial balance */}
      <div className="card table-sticky">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-3">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-semibold text-slate-800">{t('gl.tb.title')}</h3>
              {tb && (
                <span
                  className={`badge ${tb.isBalanced ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-600'}`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${tb.isBalanced ? 'bg-emerald-500' : 'bg-rose-500'}`}
                  />
                  {tb.isBalanced ? t('gl.tb.balanced') : t('gl.tb.unbalanced')}
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-slate-400">{t('gl.tb.hint')}</p>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-slate-500">
              <input type="checkbox" checked={showZero} onChange={(e) => setShowZero(e.target.checked)} />
              {t('gl.tb.showZero')}
            </label>
            <Btn sm icon="download" disabled={!tb} onClick={exportTb}>
              {t('gl.export')}
            </Btn>
          </div>
        </div>
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="th">{t('gl.accountNo')}</th>
              <th className="th">{t('gl.account')}</th>
              <th className="th">{t('gl.type')}</th>
              <th className="th text-end">{t('gl.opening')}</th>
              <th className="th text-end">{t('gl.debit')}</th>
              <th className="th text-end">{t('gl.credit')}</th>
              <th className="th text-end">{t('gl.closing')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {!tb ? (
              <TableSkeleton cols={7} />
            ) : visibleRows.length === 0 ? (
              <EmptyRow colSpan={7} text={t('common.none')} />
            ) : (
              visibleRows.map((r) => (
                <tr
                  key={r.accountId}
                  onClick={() => openAccount(r.accountId)}
                  className={`cursor-pointer hover:bg-slate-50 ${
                    r.accountId === accountId ? 'bg-brand-50/60' : ''
                  }`}
                >
                  <td className="td font-mono text-xs">{r.code}</td>
                  <td className="td">{pick(r, 'name')}</td>
                  <td className="td">
                    <span className={`badge ${TYPE_STYLE[r.accountType]}`}>{typeLabel(r.accountType)}</span>
                  </td>
                  <td className="td text-end text-slate-500">{balanceCell(r.opening)}</td>
                  <td className="td text-end">{r.debit ? formatMoney(r.debit, locale) : '—'}</td>
                  <td className="td text-end">{r.credit ? formatMoney(r.credit, locale) : '—'}</td>
                  <td
                    className={`td text-end font-medium ${
                      r.closing >= 0 ? 'text-slate-800' : 'text-amber-700'
                    }`}
                  >
                    {balanceCell(r.closing)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
          {tb && visibleRows.length > 0 && (
            <tfoot className="border-t-2 border-slate-200 bg-slate-50/60">
              <tr>
                <td className="td text-xs font-bold text-slate-600" colSpan={3}>
                  {t('fin.total')}
                </td>
                <td className="td text-end text-slate-500">{formatMoney(tb.totals.opening, locale)}</td>
                <td className="td text-end font-bold">{formatMoney(tb.totals.debit, locale)}</td>
                <td className="td text-end font-bold">{formatMoney(tb.totals.credit, locale)}</td>
                <td className="td text-end text-xs text-slate-500">
                  {formatMoney(tb.totals.closingDebit, locale)} {t('gl.debit')} /{' '}
                  {formatMoney(tb.totals.closingCredit, locale)} {t('gl.credit')}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* General ledger for the selected account */}
      <div className="card mt-6 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-3">
          <div>
            <h3 className="font-semibold text-slate-800">
              {t('gl.detail.title')}
              {gl && (
                <span className="ms-2 text-sm font-normal text-slate-500">
                  <span className="font-mono text-xs">{gl.account.code}</span> · {pick(gl.account, 'name')}
                </span>
              )}
            </h3>
            {gl && (
              <p className="mt-1 text-xs text-slate-400">
                {t('gl.detail.entries')}: {gl.total} · {t('gl.opening')}: {balanceCell(gl.opening)} ·{' '}
                {t('gl.debit')}: {formatMoney(gl.periodDebit, locale)} · {t('gl.credit')}:{' '}
                {formatMoney(gl.periodCredit, locale)} · {t('gl.closing')}: {balanceCell(gl.closing)}
              </p>
            )}
          </div>
          {gl && (
            <div className="flex items-center gap-2">
              <Btn sm icon="download" onClick={exportGl}>
                {t('gl.export')}
              </Btn>
              <Btn sm icon="x" onClick={() => setAccountId(null)}>
                {t('gl.detail.close')}
              </Btn>
            </div>
          )}
        </div>

        {!accountId ? (
          <p className="px-5 py-12 text-center text-sm text-slate-500">{t('gl.detail.hint')}</p>
        ) : (
          <>
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="th">{t('common.date')}</th>
                  <th className="th">{t('gl.detail.source')}</th>
                  <th className="th">{t('gl.detail.memo')}</th>
                  <th className="th text-end">{t('gl.debit')}</th>
                  <th className="th text-end">{t('gl.credit')}</th>
                  <th className="th text-end">{t('gl.detail.balance')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {!gl ? (
                  <TableSkeleton cols={6} />
                ) : (
                  <>
                    <tr className="bg-slate-50/60">
                      <td className="td text-xs text-slate-500" colSpan={5}>
                        {page === 0 ? t('gl.detail.openingRow') : t('gl.detail.carried')}
                      </td>
                      <td className="td text-end text-xs font-medium text-slate-600">
                        {balanceCell(page === 0 ? gl.opening : gl.pageOpening)}
                      </td>
                    </tr>
                    {gl.rows.length === 0 ? (
                      <EmptyRow colSpan={6} text={t('gl.detail.empty')} />
                    ) : (
                      gl.rows.map((r) => (
                        <tr key={r.id} className="hover:bg-slate-50">
                          <td className="td whitespace-nowrap">{formatDate(r.postingDate, locale)}</td>
                          <td className="td">
                            <span className="text-xs text-slate-700">{sourceLabel(r.sourceType)}</span>
                            {r.invoiceCode && (
                              <span className="ms-1 font-mono text-[11px] text-slate-400">{r.invoiceCode}</span>
                            )}
                            {r.isReversal && (
                              <span className="ms-1 badge bg-amber-50 text-amber-700">
                                {t('gl.detail.reversal')}
                              </span>
                            )}
                          </td>
                          <td className="td text-xs text-slate-500">
                            {translateMemo(r.memo, locale) || '—'}
                          </td>
                          <td className="td text-end">{r.debit ? formatMoney(r.debit, locale) : '—'}</td>
                          <td className="td text-end">{r.credit ? formatMoney(r.credit, locale) : '—'}</td>
                          <td className="td text-end font-medium">{balanceCell(r.balance)}</td>
                        </tr>
                      ))
                    )}
                  </>
                )}
              </tbody>
            </table>

            {gl && gl.total > PAGE && (
              <div className="flex items-center justify-between border-t border-slate-100 px-5 py-3 text-xs text-slate-500">
                <span>
                  {page * PAGE + 1}–{Math.min((page + 1) * PAGE, gl.total)} {t('common.of')} {gl.total}
                </span>
                <span className="flex gap-1">
                  <Btn sm disabled={page === 0} onClick={() => setPage(page - 1)}>
                    {t('common.prev')}
                  </Btn>
                  <Btn sm disabled={(page + 1) * PAGE >= gl.total} onClick={() => setPage(page + 1)}>
                    {t('common.next')}
                  </Btn>
                </span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
