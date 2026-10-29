'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { api, apiUpload } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { useEnums, optionLabel } from '@/lib/useEnums';
import { formatMoney, formatDate } from '@/lib/format';
import { PageHeader, StatusBadge, EmptyRow, LoadError, useConfirm, Can, Btn, PageSkeleton, Field } from '@/components/ui';
import { ApprovalChain, type ApprovalRequestView } from '@/components/approvals';
import { Icon } from '@/components/icons';
import { AttachmentsCard } from '@/components/attachments';

interface Milestone {
  id: string;
  sequence: number;
  descriptionAr: string;
  descriptionEn: string;
  amount: string;
  status: string;
  dueDate?: string | null;
  verifiedAt?: string | null;
  invoiceId?: string | null;
}
interface Contract {
  id: string;
  code: string;
  contractType: string;
  status: string;
  totalValue: string;
  retentionPct: string;
  advancePct: string;
  customer?: { nameAr: string; nameEn: string; code: string };
  opportunity?: { code: string; name: string };
  milestones: Milestone[];
  // Package 2 (ADR-01 as amended): a contract from a quote goes DRAFT → PENDING_APPROVAL → APPROVED → ACTIVE.
  proposalRevisionId?: string | null;
  proposalId?: string | null;
  submittedAt?: string | null;
  approvedAt?: string | null;
  approval?: ApprovalRequestView | null;
}

/** One payment row in the draft editor; the percentage and the amount follow each other. */
interface DraftPayment {
  descriptionAr: string;
  descriptionEn: string;
  pct: string;
  amount: string;
}
const money2 = (n: number) => (Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2);

export default function ContractDetailPage() {
  const { t, locale, pick } = useI18n();
  const { can } = useAuth();
  const enums = useEnums();
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;
  const [contract, setContract] = useState<Contract | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const { act, busy } = useAct();
  const { confirm, confirmNode } = useConfirm();
  // P2-1: the draft's payments, editable until it is raised.
  const [payments, setPayments] = useState<DraftPayment[] | null>(null);
  const [payErr, setPayErr] = useState('');
  // P2-2: the customer's signed copy, filed before activation.
  const [signedFile, setSignedFile] = useState<File | null>(null);
  const [filesKey, setFilesKey] = useState(0);

  const load = useCallback(() => {
    setLoadErr('');
    api
      .get<Contract>(`/contracts/${id}`)
      .then(setContract)
      .catch((e) => setLoadErr(translateError(e, locale)));
  }, [id, locale]);

  useEffect(load, [load]);

  async function activate() {
    if (!(await confirm({ title: t('confirm.activateTitle'), message: t('confirm.activateMsg') })))
      return;
    if (await act('activate', () => api.post(`/contracts/${id}/activate`, {}))) load();
  }

  // ── Package 2: draft terms, approval, signed copy ─────────────────────────
  const total = Number(contract?.totalValue ?? 0);
  function openPayments() {
    if (!contract) return;
    setPayErr('');
    setPayments(
      contract.milestones.map((m) => ({
        descriptionAr: m.descriptionAr,
        descriptionEn: m.descriptionEn,
        amount: String(Number(m.amount)),
        pct: total > 0 ? String(Math.round((Number(m.amount) / total) * 10000) / 100) : '',
      })),
    );
  }
  const setPayment = (i: number, patch: Partial<DraftPayment>) =>
    setPayments((prev) => prev && prev.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  const paySum = (payments ?? []).reduce((acc, p) => acc + (Number(p.amount) || 0), 0);

  async function savePayments(e: FormEvent) {
    e.preventDefault();
    if (!payments) return;
    if (payments.length === 0 || payments.some((p) => !(Number(p.amount) > 0) || !(p.descriptionAr || p.descriptionEn).trim())) {
      setPayErr(t('contracts.err.payments'));
      return;
    }
    setPayErr('');
    const ok = await act('payments', () =>
      api.patch(`/contracts/${id}`, {
        milestones: payments.map((p, i) => ({
          sequence: i + 1,
          descriptionAr: p.descriptionAr.trim() || p.descriptionEn.trim(),
          descriptionEn: p.descriptionEn.trim() || p.descriptionAr.trim(),
          amount: Number(p.amount),
          triggerType: 'PROGRESS',
        })),
      }),
    );
    if (ok) {
      setPayments(null);
      load();
    }
  }

  async function submitForApproval() {
    if (!(await confirm({ title: t('contracts.submitTitle'), message: t('contracts.submitMsg') }))) return;
    if (await act('submit', () => api.post(`/contracts/${id}/submit`, {}), { success: t('common.done') })) load();
  }

  async function uploadSignedAndActivate(e: FormEvent) {
    e.preventDefault();
    if (!signedFile) return;
    const ok = await act('activate', async () => {
      await apiUpload(`/attachments/CONTRACT/${id}`, signedFile);
      await api.post(`/contracts/${id}/activate`, {});
    });
    setFilesKey((k) => k + 1);
    if (ok) setSignedFile(null);
    load();
  }

  async function verify(milestoneId: string) {
    if (
      !(await confirm({
        title: t('confirm.verifyTitle'),
        message: t('confirm.verifyMsg'),
      }))
    )
      return;
    if (await act(`verify:${milestoneId}`, () => api.post(`/contracts/${id}/milestones/${milestoneId}/verify`, {})))
      load();
  }

  async function generateInvoice(milestoneId: string) {
    if (!(await confirm({ title: t('confirm.genInvTitle'), message: t('confirm.genInvMsg') })))
      return;
    let invId: string | null = null;
    const ok = await act(`invoice:${milestoneId}`, async () => {
      const inv = await api.post<{ id: string }>(
        `/finance/contracts/${id}/milestones/${milestoneId}/invoice`,
        {},
      );
      invId = inv.id;
    });
    if (ok && invId) router.push(`/invoices/${invId}`);
  }

  if (loadErr) return <LoadError message={loadErr} onRetry={load} />;
  if (!contract) return <PageSkeleton />;

  return (
    <div>
      <PageHeader
        title={
          contract.customer ? `${contract.code} · ${pick(contract.customer, 'name')}` : contract.code
        }
        backHref="/contracts"
        backLabel={t('contracts.title')}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={contract.status} />
            {/* A hand-written contract keeps the old draft → active move; one from a quote goes through the approval. */}
            {contract.status === 'DRAFT' && !contract.proposalRevisionId && (
              <Can perm="commercial.contract.write">
                <Btn variant="primary" sm icon="check-circle" busy={busy('activate')} disabled={busy()} onClick={activate}>
                  {t('contracts.activate')}
                </Btn>
              </Can>
            )}
            {contract.status === 'DRAFT' && contract.proposalRevisionId && (
              <Can perm="commercial.contract.write">
                <Btn variant="primary" sm icon="stamp" busy={busy('submit')} disabled={busy()} onClick={submitForApproval}>
                  {t('contracts.submit')}
                </Btn>
              </Can>
            )}
          </div>
        }
      />

      {/* Package 2: where the contract stands in the company's cycle. */}
      {contract.proposalRevisionId && contract.status === 'DRAFT' && (
        <div className="mb-4 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700" aria-live="polite">
          <Icon name="file-signature" className="me-1.5 inline h-4 w-4" />
          {t('contracts.banner.draft')}
        </div>
      )}
      {contract.status === 'PENDING_APPROVAL' && (
        <div className="mb-4 rounded-xl border border-warning-200 bg-warning-50/60 p-4 text-sm text-warning-900" aria-live="polite">
          <div className="flex flex-wrap items-center gap-2 font-semibold">
            <Icon name="stamp" className="h-4 w-4" />
            {t('contracts.banner.pending')}
            {can('commercial.proposal.approve') && (
              <Link href="/approvals" className="ms-2 text-xs underline">
                {t('proposals.openInbox')}
              </Link>
            )}
          </div>
          {contract.approval && (
            <div className="mt-3">
              <ApprovalChain request={contract.approval} />
            </div>
          )}
        </div>
      )}
      {contract.status === 'APPROVED' && (
        <div className="mb-4 rounded-xl border border-success-200 bg-success-50/60 p-4 text-sm text-success-900">
          <p className="flex items-center gap-2 font-semibold">
            <Icon name="check-circle" className="h-4 w-4" />
            {t('contracts.banner.approved')}
          </p>
          <Can perm="commercial.contract.write">
            <form onSubmit={uploadSignedAndActivate} className="mt-3 flex flex-wrap items-end gap-2">
              <Field label={t('contracts.signedCopy')}>
                <input
                  type="file"
                  className="input"
                  accept=".pdf,.png,.jpg,.jpeg,.webp"
                  onChange={(e) => setSignedFile(e.target.files?.[0] ?? null)}
                />
              </Field>
              <Btn type="submit" variant="primary" icon="check-circle" busy={busy('activate')} disabled={busy() || !signedFile}>
                {t('contracts.uploadAndActivate')}
              </Btn>
            </form>
          </Can>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <div className="card p-4">
          <p className="text-xs text-slate-500">{t('contracts.customer')}</p>
          <p className="mt-1 font-medium">{contract.customer ? pick(contract.customer, 'name') : '—'}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-slate-500">{t('contracts.type')}</p>
          <p className="mt-1 font-medium">{optionLabel(enums?.contractTypes, contract.contractType, locale)}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-slate-500">{t('contracts.value')}</p>
          <p className="mt-1 font-bold text-brand-700">{formatMoney(contract.totalValue, locale)}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-slate-500">
            {t('contracts.retention')} / {t('contracts.advance')}
          </p>
          <p className="mt-1 font-medium">
            {Number(contract.retentionPct)}% / {Number(contract.advancePct)}%
          </p>
        </div>
      </div>

      <div className="card mt-6 overflow-hidden">
        <div className="card-title flex items-center justify-between gap-2">
          <h3 className="font-semibold text-slate-800">{t('contracts.milestones')}</h3>
          {contract.status === 'DRAFT' && !payments && (
            <Can perm="commercial.contract.write">
              <Btn sm icon="undo" onClick={openPayments} disabled={busy()}>
                {t('contracts.editPayments')}
              </Btn>
            </Can>
          )}
        </div>
        {payments && (
          <form onSubmit={savePayments} className="space-y-2 border-b border-slate-100 p-4">
            {payErr && (
              <p role="alert" className="text-xs font-medium text-danger-600">
                {payErr}
              </p>
            )}
            {payments.map((p, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <span className="w-6 text-xs text-slate-500">{i + 1}</span>
                <input
                  className="input min-w-[10rem] flex-1"
                  aria-label={t('contracts.milestone')}
                  value={p.descriptionAr}
                  onChange={(e) => setPayment(i, { descriptionAr: e.target.value })}
                />
                <input
                  type="number"
                  min={0}
                  max={100}
                  step="0.01"
                  className="input w-24"
                  aria-label="%"
                  value={p.pct}
                  onChange={(e) =>
                    setPayment(i, { pct: e.target.value, amount: money2((total * (Number(e.target.value) || 0)) / 100) })
                  }
                />
                <span className="text-xs text-slate-400">%</span>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  className="input w-36"
                  aria-label={t('contracts.amount')}
                  value={p.amount}
                  onChange={(e) =>
                    setPayment(i, {
                      amount: e.target.value,
                      pct: total > 0 ? String(Math.round(((Number(e.target.value) || 0) / total) * 10000) / 100) : '',
                    })
                  }
                />
                <button
                  type="button"
                  aria-label={`${t('proposals.removeLine')} ${i + 1}`}
                  className="rounded-md p-1.5 text-slate-500 hover:bg-danger-50 hover:text-danger-600"
                  onClick={() => setPayments((prev) => prev && prev.filter((_, idx) => idx !== i))}
                >
                  <Icon name="x" className="h-4 w-4" />
                </button>
              </div>
            ))}
            <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
              <button
                type="button"
                className="btn-ghost text-xs"
                onClick={() => setPayments((prev) => [...(prev ?? []), { descriptionAr: '', descriptionEn: '', pct: '', amount: '' }])}
              >
                + {t('contracts.addPayment')}
              </button>
              <span className={`text-sm ${Math.abs(paySum - total) < 0.005 ? 'text-success-700' : 'font-semibold text-danger-600'}`}>
                {t('contracts.paymentsSum')}: {formatMoney(paySum, locale)} / {formatMoney(total, locale)}
              </span>
              <span className="flex gap-2">
                <Btn onClick={() => setPayments(null)}>{t('common.cancel')}</Btn>
                <Btn type="submit" variant="primary" busy={busy('payments')} disabled={busy()}>
                  {t('common.save')}
                </Btn>
              </span>
            </div>
          </form>
        )}
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <th scope="col" className="th">#</th>
              <th scope="col" className="th">{t('contracts.milestone')}</th>
              <th scope="col" className="th">{t('contracts.amount')}</th>
              <th scope="col" className="th">{t('common.status')}</th>
              <th scope="col" className="th">{t('contracts.verified')}</th>
              <th scope="col" className="th">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {contract.milestones.length === 0 ? (
              <EmptyRow colSpan={6} text={t('common.none')} />
            ) : (
              contract.milestones.map((m) => (
                <tr key={m.id} className="hover:bg-slate-50">
                  <td className="td">{m.sequence}</td>
                  <td className="td">{locale === 'ar' ? m.descriptionAr : m.descriptionEn}</td>
                  <td className="td">{formatMoney(m.amount, locale)}</td>
                  <td className="td"><StatusBadge status={m.status} /></td>
                  <td className="td text-xs text-slate-500">
                    {m.verifiedAt ? formatDate(m.verifiedAt, locale) : '—'}
                  </td>
                  <td className="td">
                    {/* Verifying is a contract right; raising the invoice from
                        it is a finance one — two different people in practice. */}
                    {m.status === 'PENDING' && contract.status === 'ACTIVE' && can('commercial.contract.write') ? (
                      <Btn
                        variant="solar"
                        sm
                        icon="check"
                        busy={busy(`verify:${m.id}`)}
                        disabled={busy()}
                        onClick={() => verify(m.id)}
                      >
                        {t('contracts.verify')}
                      </Btn>
                    ) : m.status === 'VERIFIED' && can('finance.invoice.write') ? (
                      <Btn
                        variant="primary"
                        sm
                        icon="receipt"
                        busy={busy(`invoice:${m.id}`)}
                        disabled={busy()}
                        onClick={() => generateInvoice(m.id)}
                      >
                        {t('contracts.generateInvoice')}
                      </Btn>
                    ) : m.status === 'INVOICED' && m.invoiceId ? (
                      <Link href={`/invoices/${m.invoiceId}`} className="btn-ghost btn-sm">
                        {t('contracts.viewInvoice')}
                      </Link>
                    ) : (
                      <span className="text-xs text-slate-500">—</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="mt-6">
        <AttachmentsCard key={filesKey} entityType="CONTRACT" entityId={id} />
      </div>
      {confirmNode}
    </div>
  );
}
