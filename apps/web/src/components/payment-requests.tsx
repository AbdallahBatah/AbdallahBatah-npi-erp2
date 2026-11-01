'use client';

/**
 * Package 6 · P6-1 (ADR-06) — «طلب صرف دفعة للموردين». One list and one
 * detail, mounted under /projects (engineer, signers) and /payables (the
 * accountant, who pays). The server narrows the engineer to his own requests.
 */
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { formatDate, formatMoney } from '@/lib/format';
import { useLookup } from '@/lib/lookups';
import { PageHeader, StatusBadge, EmptyRow, LoadError, Modal, Field, Btn, TableSkeleton, PageSkeleton } from '@/components/ui';
import { ApprovalBanner, type ApprovalRequestView } from '@/components/approvals';

interface Named { id: string; code: string; nameAr: string; nameEn: string }
interface Row {
  id: string;
  code: string;
  kind: 'ADVANCE' | 'AGAINST_BILL';
  amount: string;
  status: string;
  reason: string;
  createdAt: string;
  vendor: Named;
  project: { id: string; code: string } | null;
}
interface Detail extends Row {
  requestedById: string;
  decisionNote: string | null;
  paidAt: string | null;
  paymentRef: string | null;
  bill: { id: string; code: string; total: string; status: string } | null;
  approval: ApprovalRequestView | null;
}
interface OpenBill { kind: string; id: string; code: string; outstanding: number }

export function PaymentRequestList({ base }: { base: string }) {
  const { t, locale, pick } = useI18n();
  const { can } = useAuth();
  const router = useRouter();
  const { act, busy } = useAct();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(false);
  const [vendorId, setVendorId] = useState('');
  const [kind, setKind] = useState<'ADVANCE' | 'AGAINST_BILL'>('ADVANCE');
  const [bills, setBills] = useState<OpenBill[]>([]);
  const vendors = useLookup<Named>('vendors', { enabled: open });
  const projects = useLookup<Named>('projects', { enabled: open });

  const load = useCallback(() => {
    setLoading(true);
    api
      .get<Row[]>('/payment-requests')
      .then(setRows)
      .catch((e) => setErr(translateError(e, locale)))
      .finally(() => setLoading(false));
  }, [locale]);
  useEffect(load, [load]);

  useEffect(() => {
    setBills([]);
    if (!vendorId || kind !== 'AGAINST_BILL') return;
    api
      .get<OpenBill[]>(`/payment-requests/open-bills?vendorId=${encodeURIComponent(vendorId)}`)
      .then((r) => setBills(r.filter((b) => b.kind === 'BILL')))
      .catch(() => setBills([]));
  }, [vendorId, kind]);

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    let id: string | null = null;
    const ok = await act('create', async () => {
      const r = await api.post<{ id: string }>('/payment-requests', {
        vendorId,
        kind,
        vendorBillId: kind === 'AGAINST_BILL' ? String(f.get('vendorBillId') || '') : undefined,
        projectId: String(f.get('projectId') || '') || undefined,
        amount: Number(f.get('amount')),
        reason: String(f.get('reason') || '').trim(),
      });
      id = r.id;
    });
    if (ok && id) router.push(`${base}/${id}`);
  }

  return (
    <div>
      <PageHeader
        title={t('vpr.title')}
        subtitle={t('vpr.hint')}
        action={
          can('scm.requisition.write') ? (
            <Btn variant="primary" icon="plus" onClick={() => setOpen(true)}>
              {t('vpr.new')}
            </Btn>
          ) : undefined
        }
      />
      {err && <LoadError message={err} onRetry={load} />}
      <div className="card table-sticky">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th scope="col" className="th">{t('common.code')}</th>
              <th scope="col" className="th">{t('pr.vendor')}</th>
              <th scope="col" className="th">{t('vpr.kind')}</th>
              <th scope="col" className="th text-end">{t('vpr.amount')}</th>
              <th scope="col" className="th">{t('common.date')}</th>
              <th scope="col" className="th">{t('common.status')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <TableSkeleton cols={6} />
            ) : rows.length === 0 ? (
              <EmptyRow colSpan={6} text={t('common.none')} />
            ) : (
              rows.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="td">
                    <Link href={`${base}/${r.id}`} className="font-mono text-xs font-semibold text-brand-700 hover:underline">
                      {r.code}
                    </Link>
                  </td>
                  <td className="td">{pick(r.vendor, 'name')}</td>
                  <td className="td text-xs">{t(`vpr.kind.${r.kind}`)}</td>
                  <td className="td-num">{formatMoney(r.amount, locale)}</td>
                  <td className="td text-xs">{formatDate(r.createdAt, locale)}</td>
                  <td className="td">
                    <StatusBadge status={r.status} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Modal open={open} title={t('vpr.new')} onClose={() => setOpen(false)}>
        <form onSubmit={create} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={t('pr.vendor')}>
              <select className="input" value={vendorId} onChange={(e) => setVendorId(e.target.value)} required disabled={vendors.state !== 'ready'}>
                <option value="">—</option>
                {vendors.rows.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.code} · {pick(v, 'name')}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('vpr.kind')}>
              <select className="input" value={kind} onChange={(e) => setKind(e.target.value as 'ADVANCE' | 'AGAINST_BILL')}>
                <option value="ADVANCE">{t('vpr.kind.ADVANCE')}</option>
                <option value="AGAINST_BILL">{t('vpr.kind.AGAINST_BILL')}</option>
              </select>
            </Field>
            {kind === 'AGAINST_BILL' && (
              <Field label={t('vpr.bill')}>
                <select name="vendorBillId" className="input" required>
                  <option value="">—</option>
                  {bills.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.code} · {formatMoney(b.outstanding, locale)}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label={`${t('mr.project')} (${t('common.optional')})`}>
              <select name="projectId" className="input" disabled={projects.state !== 'ready'}>
                <option value="">—</option>
                {projects.rows.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code} · {pick(p, 'name')}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('vpr.amount')}>
              <input type="number" name="amount" min={0.01} step="0.01" className="input" required />
            </Field>
          </div>
          <Field label={t('exe.reason')}>
            <textarea name="reason" className="input" rows={3} required minLength={5} maxLength={1000} />
          </Field>
          <p className="text-xs text-slate-500">{t('vpr.chainHint')}</p>
          <div className="flex justify-end gap-2">
            <Btn onClick={() => setOpen(false)}>{t('common.cancel')}</Btn>
            <Btn type="submit" variant="primary" busy={busy('create')} disabled={busy()}>
              {t('exe.sendForApproval')}
            </Btn>
          </div>
        </form>
      </Modal>
    </div>
  );
}

export function PaymentRequestDetail({ id, base }: { id: string; base: string }) {
  const { t, locale, pick } = useI18n();
  const { user, can } = useAuth();
  const { act, busy } = useAct();
  const [r, setR] = useState<Detail | null>(null);
  const [err, setErr] = useState('');
  const [payOpen, setPayOpen] = useState(false);

  const load = useCallback(() => {
    api
      .get<Detail>(`/payment-requests/${id}`)
      .then(setR)
      .catch((e) => setErr(translateError(e, locale)));
  }, [id, locale]);
  useEffect(load, [load]);

  if (err && !r) return <LoadError message={err} onRetry={load} />;
  if (!r) return <PageSkeleton stats={0} />;

  async function pay(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const ok = await act('pay', () =>
      api.post(`/payment-requests/${id}/pay`, {
        method: String(f.get('method') || 'BANK_TRANSFER'),
        reference: String(f.get('reference') || '').trim() || undefined,
      }),
    );
    if (ok) {
      setPayOpen(false);
      load();
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${t('vpr.one')} ${r.code}`}
        backHref={base}
        backLabel={t('vpr.title')}
        action={
          r.status === 'APPROVED' && can('finance.payment.write') && r.requestedById !== user?.id ? (
            <Btn variant="primary" icon="wallet" onClick={() => setPayOpen(true)}>
              {t('vpr.pay')}
            </Btn>
          ) : undefined
        }
      />
      {r.approval && r.approval.status === 'PENDING' && <ApprovalBanner request={r.approval} />}
      <div className="card grid grid-cols-1 gap-4 p-5 text-sm sm:grid-cols-4">
        <div>
          <p className="label">{t('pr.vendor')}</p>
          {r.vendor.code} · {pick(r.vendor, 'name')}
        </div>
        <div>
          <p className="label">{t('vpr.kind')}</p>
          {t(`vpr.kind.${r.kind}`)}
          {r.bill && <span className="block font-mono text-xs text-slate-500">{r.bill.code}</span>}
        </div>
        <div>
          <p className="label">{t('vpr.amount')}</p>
          <span className="font-bold">{formatMoney(r.amount, locale)}</span>
        </div>
        <div>
          <p className="label">{t('common.status')}</p>
          <StatusBadge status={r.status} />
          {r.paidAt && (
            <span className="block text-xs text-success-700">
              {formatDate(r.paidAt, locale)} {r.paymentRef ? `· ${r.paymentRef}` : ''}
            </span>
          )}
        </div>
        {r.project && (
          <div>
            <p className="label">{t('mr.project')}</p>
            <Link href={`/projects/${r.project.id}`} className="text-brand-700 hover:underline">
              {r.project.code}
            </Link>
          </div>
        )}
        <p className="text-slate-700 sm:col-span-4">{r.reason}</p>
        {r.decisionNote && <p className="text-xs text-danger-700 sm:col-span-4">{r.decisionNote}</p>}
      </div>

      <Modal open={payOpen} title={t('vpr.pay')} onClose={() => setPayOpen(false)}>
        <form onSubmit={pay} className="space-y-4">
          <p className="text-sm">
            {formatMoney(r.amount, locale)} → {pick(r.vendor, 'name')}
          </p>
          <p className="text-xs text-slate-500">{r.kind === 'ADVANCE' ? t('vpr.advanceJournal') : t('vpr.billJournal')}</p>
          <Field label={t('vpr.method')}>
            <select name="method" className="input">
              <option value="BANK_TRANSFER">{t('vpr.method.BANK_TRANSFER')}</option>
              <option value="CHEQUE">{t('vpr.method.CHEQUE')}</option>
              <option value="CASH">{t('vpr.method.CASH')}</option>
            </select>
          </Field>
          <Field label={`${t('vpr.reference')} (${t('common.optional')})`}>
            <input name="reference" className="input" maxLength={120} />
          </Field>
          <div className="flex justify-end gap-2">
            <Btn onClick={() => setPayOpen(false)}>{t('common.cancel')}</Btn>
            <Btn type="submit" variant="primary" busy={busy('pay')} disabled={busy()}>
              {t('vpr.pay')}
            </Btn>
          </div>
        </form>
      </Modal>
    </div>
  );
}
