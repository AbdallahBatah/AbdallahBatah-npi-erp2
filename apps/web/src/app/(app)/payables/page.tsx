'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { formatDate, formatMoney } from '@/lib/format';
import { PageHeader, Modal, Field, EmptyRow, LoadError, useConfirm, Can, Btn, TableSkeleton } from '@/components/ui';

interface Vendor {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
}

interface Payable {
  kind: 'BILL' | 'CLAIM';
  id: string;
  code: string;
  vendor: Vendor;
  documentDate: string;
  due: number;
  paid: number;
  outstanding: number;
  retentionWithheld: number;
  retentionReleased: boolean;
}

interface Allocation {
  id: string;
  amount: string;
  vendorBill?: { id: string; code: string } | null;
  progressClaim?: { id: string; code: string } | null;
}

interface Payment {
  id: string;
  code: string;
  vendor: Vendor;
  paymentDate: string;
  amount: string;
  method: string;
  reference?: string | null;
  allocations: Allocation[];
}

const METHODS = ['BANK_TRANSFER', 'CHEQUE', 'CASH'] as const;

export default function PayablesPage() {
  const { t, locale, pick } = useI18n();
  const { act, busy } = useAct();
  const { confirm, confirmNode } = useConfirm();

  const [open, setOpen] = useState<Payable[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');
  const [target, setTarget] = useState<Payable | null>(null);
  const [amount, setAmount] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setLoadErr('');
    Promise.all([
      api.get<Payable[]>('/finance/payables/outstanding'),
      api.get<Payment[]>('/finance/payables/payments'),
    ])
      .then(([o, p]) => {
        setOpen(o);
        setPayments(p);
      })
      .catch((e) => setLoadErr(translateError(e, locale)))
      .finally(() => setLoading(false));
  }, [locale]);
  useEffect(() => load(), [load]);

  const unsettled = open.filter((r) => r.outstanding > 0.009);
  const totalOutstanding = unsettled.reduce((s, r) => s + r.outstanding, 0);
  const totalRetention = open.reduce((s, r) => s + r.retentionWithheld, 0);

  function startPay(row: Payable) {
    setTarget(row);
    setAmount(String(row.outstanding));
  }

  async function pay(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!target) return;
    const f = new FormData(e.currentTarget);
    const ok = await act(
      'pay',
      () =>
        api.post('/finance/payables/payments', {
          vendorId: target.vendor.id,
          allocations: [{ kind: target.kind, documentId: target.id, amount: Number(amount) }],
          method: f.get('method'),
          reference: String(f.get('reference') || '').trim() || undefined,
          memo: String(f.get('memo') || '').trim() || undefined,
        }),
      { success: t('common.done') },
    );
    if (ok) {
      setTarget(null);
      load();
    }
  }

  async function releaseRetention(row: Payable) {
    const ready = await confirm({
      title: t('ap.release'),
      message: t('confirm.releaseSubRetention'),
    });
    if (!ready) return;
    const ok = await act(
      `rel:${row.id}`,
      () => api.post(`/finance/payables/claims/${row.id}/release-retention`, {}),
      { success: t('common.done') },
    );
    if (ok) load();
  }

  return (
    <div>
      <PageHeader title={t('ap.title')} subtitle={t('ap.hint')} />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <div className="stat">
          <div className="text-xs font-semibold text-slate-500">{t('ap.kpi.outstanding')}</div>
          <div className="mt-2 text-3xl font-bold tabular-nums text-slate-900">
            {formatMoney(totalOutstanding, locale)}
          </div>
        </div>
        <div className="stat">
          <div className="text-xs font-semibold text-slate-500">{t('ap.kpi.documents')}</div>
          <div className="mt-2 text-3xl font-bold tabular-nums text-slate-900">{unsettled.length}</div>
        </div>
        <div className="stat">
          <div className="text-xs font-semibold text-slate-500">{t('ap.kpi.retention')}</div>
          <div className="mt-2 text-3xl font-bold tabular-nums text-slate-900">
            {formatMoney(totalRetention, locale)}
          </div>
        </div>
      </div>

      {loadErr && !loading ? <LoadError message={loadErr} onRetry={load} /> : null}

      <h2 className="mb-3 text-lg font-bold text-slate-800">{t('ap.open.title')}</h2>
      <div className="card mb-8 overflow-hidden">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <th scope="col" className="th">{t('ap.doc')}</th>
              <th scope="col" className="th">{t('ap.vendor')}</th>
              <th scope="col" className="th">{t('common.date')}</th>
              <th scope="col" className="th">{t('ap.due')}</th>
              <th scope="col" className="th">{t('ap.paid')}</th>
              <th scope="col" className="th">{t('ap.outstanding')}</th>
              <th scope="col" className="th">{t('ap.retentionHeld')}</th>
              <th scope="col" className="th">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <TableSkeleton cols={8} />
            ) : open.length === 0 ? (
              <EmptyRow colSpan={8} text={t('ap.open.empty')} />
            ) : (
              open.map((r) => (
                <tr key={`${r.kind}:${r.id}`} className="hover:bg-slate-50">
                  <td className="td">
                    <div className="font-mono text-xs">{r.code}</div>
                    <div className="text-xs text-slate-500">{t(`ap.kind.${r.kind}`)}</div>
                  </td>
                  <td className="td">{pick(r.vendor, 'name')}</td>
                  <td className="td text-xs">{formatDate(r.documentDate, locale)}</td>
                  <td className="td">{formatMoney(r.due, locale)}</td>
                  <td className="td">{formatMoney(r.paid, locale)}</td>
                  <td className="td font-medium">
                    {r.outstanding > 0.009 ? (
                      formatMoney(r.outstanding, locale)
                    ) : (
                      <span className="text-success-600">{t('ap.settled')}</span>
                    )}
                  </td>
                  <td className="td text-xs">
                    {r.retentionWithheld > 0 ? (
                      formatMoney(r.retentionWithheld, locale)
                    ) : r.retentionReleased ? (
                      <span className="text-slate-500">{t('ap.released')}</span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="td">
                    <div className="flex gap-2">
                      <Can perm="finance.payment.write">
                        {r.outstanding > 0.009 ? (
                          <Btn sm icon="credit-card" onClick={() => startPay(r)}>
                            {t('ap.action')}
                          </Btn>
                        ) : null}
                        {r.kind === 'CLAIM' && r.retentionWithheld > 0 ? (
                          <Btn
                            sm
                            icon="unlock"
                            busy={busy(`rel:${r.id}`)}
                            onClick={() => releaseRetention(r)}
                          >
                            {t('ap.release')}
                          </Btn>
                        ) : null}
                      </Can>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <h2 className="mb-3 text-lg font-bold text-slate-800">{t('ap.history.title')}</h2>
      <div className="card overflow-hidden">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <th scope="col" className="th">{t('common.code')}</th>
              <th scope="col" className="th">{t('ap.vendor')}</th>
              <th scope="col" className="th">{t('common.date')}</th>
              <th scope="col" className="th">{t('ap.amount')}</th>
              <th scope="col" className="th">{t('ap.method')}</th>
              <th scope="col" className="th">{t('ap.allocations')}</th>
              <th scope="col" className="th">{t('ap.reference')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <TableSkeleton cols={7} />
            ) : payments.length === 0 ? (
              <EmptyRow colSpan={7} text={t('ap.history.empty')} />
            ) : (
              payments.map((p) => (
                <tr key={p.id} className="hover:bg-slate-50">
                  <td className="td font-mono text-xs">{p.code}</td>
                  <td className="td">{pick(p.vendor, 'name')}</td>
                  <td className="td text-xs">{formatDate(p.paymentDate, locale)}</td>
                  <td className="td font-medium">{formatMoney(p.amount, locale)}</td>
                  <td className="td text-xs">{t(`ap.method.${p.method}`)}</td>
                  <td className="td font-mono text-xs">
                    {p.allocations
                      .map((a) => a.vendorBill?.code ?? a.progressClaim?.code ?? '—')
                      .join('، ')}
                  </td>
                  <td className="td text-xs">{p.reference ?? '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Modal
        open={!!target}
        title={`${t('ap.modal.title')} — ${target?.code ?? ''}`}
        onClose={() => setTarget(null)}
      >
        <form onSubmit={pay} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t('ap.amount')}>
            <div className="flex gap-2">
              <input
                className="input"
                type="number"
                step="0.01"
                min="0.01"
                max={target?.outstanding}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
                dir="ltr"
              />
              <Btn sm className="whitespace-nowrap" onClick={() => setAmount(String(target?.outstanding ?? ''))}>
                {t('ap.full')}
              </Btn>
            </div>
          </Field>
          <Field label={t('ap.method')}>
            <select name="method" className="input" defaultValue="BANK_TRANSFER">
              {METHODS.map((m) => (
                <option key={m} value={m}>
                  {t(`ap.method.${m}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={`${t('ap.reference')} (${t('common.optional')})`}>
            <input name="reference" className="input" dir="ltr" />
          </Field>
          <Field label={`${t('ap.memo')} (${t('common.optional')})`}>
            <input name="memo" className="input" />
          </Field>
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Btn onClick={() => setTarget(null)}>{t('common.cancel')}</Btn>
            <Btn type="submit" variant="primary" busy={busy('pay')} disabled={busy()}>
              {t('ap.action')}
            </Btn>
          </div>
        </form>
      </Modal>

      {confirmNode}
    </div>
  );
}
