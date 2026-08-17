'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { formatMoney, formatDate } from '@/lib/format';
// NB: this page defines its own read-only `Field` below — do not import ui's.
import { PageHeader, StatusBadge, LoadError, Modal, useConfirm, Tabs, Can, Btn, PageSkeleton } from '@/components/ui';
import { Icon } from '@/components/icons';
import { AttachmentsCard } from '@/components/attachments';

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
  retentionEntry?: {
    id: string;
    withheldAmount: string;
    /** Returned to the customer by credit notes — not part of what is held. */
    creditedAmount?: string;
    status: string;
  } | null;
  payments: Payment[];
  invoiceType: string;
  creditReason?: string | null;
  creditedTotal: number;
  outstanding: number;
  creditNotes: Array<{
    id: string;
    code: string;
    total: string;
    creditReason?: string | null;
    issueDate: string;
  }>;
  creditedInvoice?: { id: string; code: string } | null;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

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
  const { can } = useAuth();
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [inv, setInv] = useState<Invoice | null>(null);
  const [tab, setTab] = useState('pay');
  const [loadErr, setLoadErr] = useState('');
  const [payAmount, setPayAmount] = useState(0);
  const [payMethod, setPayMethod] = useState('BANK_TRANSFER');
  const [payRef, setPayRef] = useState('');
  const [cnOpen, setCnOpen] = useState(false);
  const [cnFull, setCnFull] = useState(true);
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

  async function createCreditNote(reason: string, amount?: number) {
    const ok = await act(
      'creditNote',
      () => api.post(`/finance/invoices/${id}/credit-note`, { reason, amount }),
      { success: t('common.done') },
    );
    if (ok) {
      setCnOpen(false);
      load();
    }
  }

  if (loadErr) return <LoadError message={loadErr} onRetry={load} />;
  if (!inv) return <PageSkeleton stats={3} />;
  const e = inv.eInvoice;
  // Outstanding comes from the server: it also nets off credit notes, which
  // the payments list alone cannot see.
  const outstanding = Math.max(0, inv.outstanding);
  // Recording a customer payment is finance.invoice.write — NOT
  // finance.payment.write, which guards the vendor side under /payables.
  const canPay =
    ['ISSUED', 'CLEARED'].includes(inv.status) && outstanding > 0.009 && can('finance.invoice.write');
  const isCreditNote = inv.invoiceType === 'CREDIT_NOTE';
  // Only a reported invoice can be corrected, and only up to what is left.
  const creditable = round2(Number(inv.total) - inv.creditedTotal);
  const canCredit =
    !isCreditNote && ['ISSUED', 'CLEARED', 'PAID'].includes(inv.status) && creditable > 0.009;

  return (
    <div>
      <PageHeader
        title={`${t('inv.invoice')} ${inv.code}`}
        backHref="/invoices"
        backLabel={t('inv.title')}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={inv.status} />
            <Can perm="finance.invoice.write">
              {inv.status === 'DRAFT' && (
                <Btn variant="primary" sm icon="stamp" busy={busy('issue')} disabled={busy()} onClick={issue}>
                  {t('inv.issue')}
                </Btn>
              )}
              {canCredit && (
                <Btn sm icon="undo" onClick={() => setCnOpen(true)}>
                  {t('cn.new')}
                </Btn>
              )}
            </Can>
            <Link href={`/invoices/${id}/print`} className="btn-ghost btn-sm">
              <Icon name="printer" className="h-3.5 w-3.5" />
              {t('print.button')}
            </Link>
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
                        <span className="font-mono text-xs text-slate-600">{jl.account.code}</span>{' '}
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
                    <img src={inv.qrDataUrl} alt="ZATCA QR" width={180} height={180} className="rounded border border-slate-200" />
                    <span className="mt-1 text-[11px] text-slate-600">{t('inv.qr')}</span>
                  </div>
                )}
                <div className="space-y-2 text-xs">
                  <Field
                    label={t('inv.mode')}
                    value={e.submissionMode === 'CLEARANCE' ? t('inv.modeClearance') : t('inv.modeReporting')}
                  />
                </div>
                <details className="mt-3 text-xs">
                  <summary className="cursor-pointer select-none text-slate-600 hover:text-slate-800">
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
                  <p className="mt-4 flex items-start gap-1.5 rounded-lg bg-amber-50 p-2 text-[11px] leading-relaxed text-amber-700">
                    <Icon name="alert-triangle" className="mt-px h-3.5 w-3.5 shrink-0" />
                    {t('inv.simulated')}
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div className="card p-5 text-center text-sm text-slate-600">
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
                  {/* What is still held: the credited part has gone back to the customer. */}
                  <span className="text-slate-700">
                    {formatMoney(
                      Number(inv.retentionEntry.withheldAmount) -
                        Number(inv.retentionEntry.creditedAmount ?? 0),
                      locale,
                    )}
                  </span>
                  {inv.retentionEntry.status === 'WITHHELD' && inv.status !== 'CANCELLED' && can('finance.invoice.write') ? (
                    <Btn
                      variant="solar"
                      sm
                      icon="unlock"
                      className="!px-2 !py-0.5 !text-[11px]"
                      busy={busy('release')}
                      disabled={busy()}
                      title={t('pay.releaseHint')}
                      onClick={() => releaseRetention(inv.retentionEntry!.id)}
                    >
                      {t('pay.releaseRetention')}
                    </Btn>
                  ) : (
                    <StatusBadge status={inv.retentionEntry.status} />
                  )}
                </span>
              </div>
            )}
          </div>

          {/* The document, its ZATCA status and its identity stay visible; the
              working panels below are tabbed — five stacked cards in a narrow
              column was the density problem on this screen. */}
          <Tabs
            tabs={[
              { key: 'pay', label: t('pay.title'), count: inv.payments.length },
              { key: 'credit', label: t('cn.title'), count: inv.creditNotes.length },
              { key: 'files', label: t('att.title') },
            ]}
            value={tab}
            onChange={setTab}
          />

          {/* W7: payments */}
          {tab === 'pay' && (
          <div className="card overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
              <h3 className="text-sm font-bold text-slate-800">{t('pay.title')}</h3>
              <span className="text-xs text-slate-600">
                {inv.outstanding < -0.009 ? (
                  <>
                    {t('cn.refundDue')}:{' '}
                    <b className="text-rose-600">{formatMoney(-inv.outstanding, locale)}</b>
                  </>
                ) : (
                  <>
                    {t('pay.outstanding')}:{' '}
                    <b className={outstanding > 0.009 ? 'text-amber-600' : 'text-emerald-600'}>
                      {formatMoney(outstanding, locale)}
                    </b>
                  </>
                )}
              </span>
            </div>
            <div className="p-5">
              {inv.payments.length > 0 && (
                <ul className="mb-4 space-y-2">
                  {inv.payments.map((p) => (
                    <li key={p.id} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-xs">
                      <span>
                        <span className="font-mono text-slate-600">{p.code}</span>
                        <span className="ms-2 text-slate-500">{formatDate(p.receivedAt, locale)}</span>
                        {p.reference && <span className="ms-2 text-slate-600">{p.reference}</span>}
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
                  <Btn
                    variant="primary"
                    sm
                    icon="credit-card"
                    className="w-full"
                    busy={busy('pay')}
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
                    {t('pay.add')}
                  </Btn>
                </div>
              ) : inv.status === 'PAID' ? (
                <p className="flex items-center justify-center gap-1.5 text-xs font-semibold text-success-600">
                  <Icon name="check-circle" className="h-4 w-4" />
                  {locale === 'ar' ? 'مدفوعة بالكامل' : 'Fully paid'}
                </p>
              ) : null}
            </div>
          </div>
          )}

          {/* Credit notes: this invoice's corrections, or what it corrects. */}
          {tab === 'credit' && (inv.creditNotes.length > 0 || isCreditNote ? (
            <div className="card overflow-hidden">
              <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
                <h3 className="text-sm font-bold text-slate-800">{t('cn.title')}</h3>
                {inv.creditedTotal > 0 ? (
                  <span className="text-xs text-slate-600">
                    {t('cn.credited')}:{' '}
                    <b className="text-rose-600">{formatMoney(inv.creditedTotal, locale)}</b>
                  </span>
                ) : null}
              </div>
              <div className="p-5 text-xs">
                {isCreditNote ? (
                  <p className="text-slate-600">
                    {t('cn.against')}{' '}
                    {inv.creditedInvoice ? (
                      <Link
                        href={`/invoices/${inv.creditedInvoice.id}`}
                        className="font-mono text-brand-600 hover:underline"
                      >
                        {inv.creditedInvoice.code}
                      </Link>
                    ) : (
                      '—'
                    )}
                    {inv.creditReason ? ` — ${inv.creditReason}` : ''}
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {inv.creditNotes.map((c) => (
                      <li
                        key={c.id}
                        className="flex items-center justify-between rounded-lg bg-rose-50/60 px-3 py-2"
                      >
                        <span>
                          <Link
                            href={`/invoices/${c.id}`}
                            className="font-mono text-brand-600 hover:underline"
                          >
                            {c.code}
                          </Link>
                          <span className="ms-2 text-slate-500">
                            {formatDate(c.issueDate, locale)}
                          </span>
                          {c.creditReason ? (
                            <span className="ms-2 text-slate-600">{c.creditReason}</span>
                          ) : null}
                        </span>
                        <span className="font-bold text-rose-700">
                          −{formatMoney(c.total, locale)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ) : (
            <div className="card p-5 text-center text-sm text-slate-600">{t('common.none')}</div>
          ))}

          {/* M2: documents attached to this invoice */}
          {tab === 'files' && <AttachmentsCard entityType="INVOICE" entityId={id} />}
        </div>
      </div>

      <Modal open={cnOpen} title={t('cn.new')} onClose={() => setCnOpen(false)}>
        <form
          className="grid gap-4"
          onSubmit={(ev) => {
            ev.preventDefault();
            const f = new FormData(ev.currentTarget);
            const amount = cnFull ? undefined : Number(f.get('amount'));
            createCreditNote(String(f.get('reason') || '').trim(), amount);
          }}
        >
          <p className="rounded-lg bg-amber-50 p-3 text-xs leading-relaxed text-amber-800">
            {t('cn.hint')}
          </p>
          <label className="block">
            <span className="mb-1 block text-sm text-slate-600">{t('cn.reason')}</span>
            <input name="reason" className="input" required maxLength={300} />
          </label>
          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="radio" checked={cnFull} onChange={() => setCnFull(true)} />
              {t('cn.full')}
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" checked={!cnFull} onChange={() => setCnFull(false)} />
              {t('cn.partial')}
            </label>
          </div>
          {cnFull ? (
            <p className="text-xs text-slate-500">
              {t('cn.fullAmount')}: <b>{formatMoney(creditable, locale)}</b>
            </p>
          ) : (
            <label className="block">
              <span className="mb-1 block text-sm text-slate-600">{t('cn.amount')}</span>
              <input
                name="amount"
                type="number"
                step="0.01"
                min="0.01"
                max={creditable}
                className="input"
                required
                dir="ltr"
              />
            </label>
          )}
          <div className="flex justify-end gap-2">
            <Btn onClick={() => setCnOpen(false)}>{t('common.cancel')}</Btn>
            <Btn type="submit" variant="danger" busy={busy('creditNote')} disabled={busy()}>
              {t('cn.issue')}
            </Btn>
          </div>
        </form>
      </Modal>

      {confirmNode}
    </div>
  );
}

function Field({ label, value, mono, truncate }: { label: string; value: string; mono?: boolean; truncate?: boolean }) {
  return (
    <div>
      <span className="block text-slate-600">{label}</span>
      <span
        className={`block ${mono ? 'font-mono' : ''} ${truncate ? 'truncate' : 'break-all'} text-slate-700`}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}
