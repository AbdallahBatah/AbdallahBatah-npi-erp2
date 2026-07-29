'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { formatMoney, formatDate } from '@/lib/format';
import { PageHeader, StatusBadge, LoadError, useConfirm } from '@/components/ui';

interface Line { id: string; descriptionAr: string; descriptionEn: string; qty: string; unitPrice: string; lineSubtotal: string; vatAmount: string }
interface JLine { id: string; debit: string; credit: string; account: { code: string; nameAr: string; nameEn: string } }
interface Payment { id: string; code: string; amount: string; method: string; reference?: string | null; receivedAt: string }
interface Invoice {
  id: string;
  code: string;
  status: string;
  issueDate: string;
  currency: string;
  subtotal: string;
  vatAmount: string;
  retentionAmount: string;
  total: string;
  netPayable: string;
  customer?: { nameAr: string; nameEn: string; vatNumber?: string | null };
  contract?: { code: string };
  lines: Line[];
  eInvoice?: {
    uuid: string; invoiceHash: string; previousInvoiceHash: string;
    cryptographicStamp: string; submissionMode: string; authorityStatus: string;
    authorityResponseRef?: string | null; isSimulated: boolean;
  } | null;
  qrDataUrl?: string | null;
  journalEntries: { id: string; memo?: string; lines: JLine[] }[];
  retentionEntry?: { id: string; withheldAmount: string; status: string } | null;
  payments: Payment[];
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <span className="text-slate-500">{label}</span>
      <span className={strong ? 'font-bold text-slate-900' : 'text-slate-700'}>{value}</span>
    </div>
  );
}

export default function InvoiceDetailPage() {
  const { t, locale } = useI18n();
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [inv, setInv] = useState<Invoice | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [payAmount, setPayAmount] = useState(0);
  const [payMethod, setPayMethod] = useState('BANK_TRANSFER');
  const [payRef, setPayRef] = useState('');
  const { act, busy } = useAct();
  const { confirm, confirmNode } = useConfirm();

  const load = useCallback(() => {
    setLoadErr('');
    api
      .get<Invoice>(`/finance/invoices/${id}`)
      .then(setInv)
      .catch((e) => setLoadErr(translateError(e, locale)));
  }, [id, locale]);
  useEffect(load, [load]);

  async function issue() {
    if (
      !(await confirm({
        title: t('confirm.issueTitle'),
        message: t('confirm.issueMsg'),
        danger: true,
      }))
    )
      return;
    if (await act('issue', () => api.post(`/finance/invoices/${id}/issue`, {}))) load();
  }

  async function releaseRetention(entryId: string) {
    if (
      !(await confirm({
        title: t('confirm.releaseTitle'),
        message: t('confirm.releaseMsg'),
        danger: true,
      }))
    )
      return;
    if (await act('release', () => api.post(`/finance/retention/${entryId}/release`, {}))) load();
  }

  if (loadErr) return <LoadError message={loadErr} onRetry={load} />;
  if (!inv) return <div className="text-slate-400">{t('common.loading')}</div>;
  const e = inv.eInvoice;
  const paid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
  const outstanding = Math.max(0, Number(inv.netPayable) - paid);
  const canPay = ['ISSUED', 'CLEARED'].includes(inv.status) && outstanding > 0.009;

  return (
    <div>
      <PageHeader
        title={`${t('inv.invoice')} ${inv.code}`}
        action={
          <div className="flex items-center gap-2">
            <StatusBadge status={inv.status} />
            {inv.status === 'DRAFT' && (
              <button className="btn-primary text-xs" onClick={issue} disabled={busy()}>
                {busy('issue') ? t('common.loading') : `🔏 ${t('inv.issue')}`}
              </button>
            )}
            <Link href="/invoices" className="btn-ghost text-xs">{t('common.back')}</Link>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Lines + totals */}
        <div className="lg:col-span-2 space-y-6">
          <div className="card overflow-hidden">
            <div className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-800">
              {t('inv.lines')}
            </div>
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="th">{t('inv.description')}</th>
                  <th className="th text-end">{t('inv.qty')}</th>
                  <th className="th text-end">{t('inv.unitPrice')}</th>
                  <th className="th text-end">{t('common.total')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {inv.lines.map((l) => (
                  <tr key={l.id}>
                    <td className="td">{locale === 'ar' ? l.descriptionAr : l.descriptionEn}</td>
                    <td className="td text-end">{Number(l.qty)}</td>
                    <td className="td text-end">{formatMoney(l.unitPrice, locale)}</td>
                    <td className="td text-end">{formatMoney(l.lineSubtotal, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="border-t border-slate-100 px-5 py-3">
              <Row label={t('inv.subtotal')} value={formatMoney(inv.subtotal, locale)} />
              <Row label={t('inv.vat')} value={formatMoney(inv.vatAmount, locale)} />
              <Row label={t('inv.total')} value={formatMoney(inv.total, locale)} strong />
              {Number(inv.retentionAmount) > 0 && (
                <Row label={`− ${t('inv.retention')}`} value={formatMoney(inv.retentionAmount, locale)} />
              )}
              <div className="mt-2 border-t border-dashed border-slate-200 pt-2">
                <Row label={t('inv.netPayable')} value={formatMoney(inv.netPayable, locale)} strong />
              </div>
            </div>
          </div>

          {/* Journal */}
          {inv.journalEntries.length > 0 && (
            <div className="card overflow-hidden">
              <div className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-800">
                {t('inv.journal')}
              </div>
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="th">{t('inv.account')}</th>
                    <th className="th text-end">{t('inv.debit')}</th>
                    <th className="th text-end">{t('inv.credit')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {inv.journalEntries[0].lines.map((jl) => (
                    <tr key={jl.id}>
                      <td className="td">
                        <span className="font-mono text-xs text-slate-400">{jl.account.code}</span>{' '}
                        {locale === 'ar' ? jl.account.nameAr : jl.account.nameEn}
                      </td>
                      <td className="td text-end">{Number(jl.debit) ? formatMoney(jl.debit, locale) : '—'}</td>
                      <td className="td text-end">{Number(jl.credit) ? formatMoney(jl.credit, locale) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ZATCA e-invoice panel */}
        <div className="space-y-6">
          {e ? (
            <div className="card overflow-hidden">
              <div className="flex items-center justify-between border-b border-slate-100 bg-gradient-to-l from-emerald-50 to-white px-5 py-3">
                <span className="text-sm font-semibold text-slate-800">{t('inv.einvoice')}</span>
                <StatusBadge status={e.authorityStatus} />
              </div>
              <div className="p-5">
                {inv.qrDataUrl && (
                  <div className="mb-4 flex flex-col items-center">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={inv.qrDataUrl} alt="ZATCA QR" width={180} height={180} className="rounded border border-slate-200" />
                    <span className="mt-1 text-[11px] text-slate-400">{t('inv.qr')}</span>
                  </div>
                )}
                <div className="space-y-2 text-xs">
                  <Field
                    label={t('inv.mode')}
                    value={e.submissionMode === 'CLEARANCE' ? t('inv.modeClearance') : t('inv.modeReporting')}
                  />
                </div>
                <details className="mt-3 text-xs">
                  <summary className="cursor-pointer select-none text-slate-400 hover:text-slate-600">
                    {t('inv.techDetails')}
                  </summary>
                  <div className="mt-2 space-y-2">
                    <Field label={t('inv.uuid')} value={e.uuid} mono />
                    <Field label={t('inv.hash')} value={e.invoiceHash} mono truncate />
                    <Field label={t('inv.pih')} value={e.previousInvoiceHash} mono truncate />
                    <Field label={t('inv.stamp')} value={e.cryptographicStamp} mono truncate />
                  </div>
                </details>
                {e.isSimulated && (
                  <p className="mt-4 rounded-lg bg-amber-50 p-2 text-[11px] leading-relaxed text-amber-700">
                    ⚠️ {t('inv.simulated')}
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div className="card p-5 text-center text-sm text-slate-400">
              {t('inv.einvoice')}
              <p className="mt-2 text-xs">{inv.status === 'DRAFT' ? '—' : ''}</p>
            </div>
          )}

          <div className="card p-5 text-sm">
            <Row label={t('inv.customer')} value={inv.customer ? (locale === 'ar' ? inv.customer.nameAr : inv.customer.nameEn) : '—'} />
            {inv.contract && <Row label={t('nav.contracts')} value={inv.contract.code} />}
            <Row label={t('common.code')} value={inv.code} />
            <Row label={t('common.date')} value={formatDate(inv.issueDate, locale)} />
            {inv.retentionEntry && (
              <div className="flex items-center justify-between py-1.5 text-sm">
                <span className="text-slate-500">{t('inv.retention')}</span>
                <span className="flex items-center gap-2">
                  <span className="text-slate-700">{formatMoney(inv.retentionEntry.withheldAmount, locale)}</span>
                  {inv.retentionEntry.status === 'WITHHELD' ? (
                    <button
                      className="btn-solar !px-2 !py-0.5 text-[11px]"
                      disabled={busy()}
                      title={t('pay.releaseHint')}
                      onClick={() => releaseRetention(inv.retentionEntry!.id)}
                    >
                      🔓 {t('pay.releaseRetention')}
                    </button>
                  ) : (
                    <StatusBadge status={inv.retentionEntry.status} />
                  )}
                </span>
              </div>
            )}
          </div>

          {/* W7: payments */}
          <div className="card overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
              <h3 className="text-sm font-bold text-slate-800">{t('pay.title')}</h3>
              <span className="text-xs text-slate-400">
                {t('pay.outstanding')}: <b className={outstanding > 0.009 ? 'text-amber-600' : 'text-emerald-600'}>{formatMoney(outstanding, locale)}</b>
              </span>
            </div>
            <div className="p-5">
              {inv.payments.length > 0 && (
                <ul className="mb-4 space-y-2">
                  {inv.payments.map((p) => (
                    <li key={p.id} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-xs">
                      <span>
                        <span className="font-mono text-slate-400">{p.code}</span>
                        <span className="ms-2 text-slate-500">{formatDate(p.receivedAt, locale)}</span>
                        {p.reference && <span className="ms-2 text-slate-400">{p.reference}</span>}
                      </span>
                      <span className="font-bold text-emerald-700">{formatMoney(p.amount, locale)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {canPay ? (
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <input
                      type="number"
                      min={0.01}
                      max={outstanding}
                      step="0.01"
                      className="input flex-1"
                      placeholder={t('pay.amount')}
                      value={payAmount || ''}
                      onChange={(ev) => setPayAmount(Number(ev.target.value))}
                    />
                    <button
                      type="button"
                      className="btn-ghost !px-2 text-[11px]"
                      onClick={() => setPayAmount(Number(outstanding.toFixed(2)))}
                    >
                      {t('pay.full')}
                    </button>
                    <select className="input !w-32" value={payMethod} onChange={(ev) => setPayMethod(ev.target.value)}>
                      <option value="BANK_TRANSFER">{locale === 'ar' ? 'تحويل بنكي' : 'Bank transfer'}</option>
                      <option value="CHEQUE">{locale === 'ar' ? 'شيك' : 'Cheque'}</option>
                      <option value="CASH">{locale === 'ar' ? 'نقداً' : 'Cash'}</option>
                    </select>
                  </div>
                  <input
                    className="input"
                    placeholder={t('pay.reference')}
                    value={payRef}
                    onChange={(ev) => setPayRef(ev.target.value)}
                  />
                  <button
                    className="btn-primary w-full text-xs"
                    disabled={busy() || !payAmount}
                    onClick={async () => {
                      const ok = await act('pay', () =>
                        api.post(`/finance/invoices/${id}/payments`, {
                          amount: payAmount,
                          method: payMethod,
                          reference: payRef || undefined,
                        }),
                      );
                      if (ok) {
                        setPayAmount(0);
                        setPayRef('');
                        load();
                      }
                    }}
                  >
                    💳 {t('pay.add')}
                  </button>
                </div>
              ) : inv.status === 'PAID' ? (
                <p className="text-center text-xs font-semibold text-emerald-600">✓ {locale === 'ar' ? 'مدفوعة بالكامل' : 'Fully paid'}</p>
              ) : null}
            </div>
          </div>
        </div>
      </div>
      {confirmNode}
    </div>
  );
}

function Field({ label, value, mono, truncate }: { label: string; value: string; mono?: boolean; truncate?: boolean }) {
  return (
    <div>
      <span className="block text-slate-400">{label}</span>
      <span
        className={`block ${mono ? 'font-mono' : ''} ${truncate ? 'truncate' : 'break-all'} text-slate-700`}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}
