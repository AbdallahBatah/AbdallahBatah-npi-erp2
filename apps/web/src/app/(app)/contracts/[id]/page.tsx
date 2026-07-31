'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { useEnums, optionLabel } from '@/lib/useEnums';
import { formatMoney, formatDate } from '@/lib/format';
import { PageHeader, StatusBadge, LoadError, useConfirm, Can } from '@/components/ui';
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
}

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

  async function verify(milestoneId: string) {
    if (
      !(await confirm({
        title: t('confirm.verifyTitle'),
        message: t('confirm.verifyMsg'),
        danger: true,
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
  if (!contract) return <div className="text-slate-400">{t('common.loading')}</div>;

  return (
    <div>
      <PageHeader
        title={contract.code}
        action={
          <div className="flex items-center gap-2">
            <StatusBadge status={contract.status} />
            {contract.status === 'DRAFT' && (
              <Can perm="commercial.contract.write">
                <button className="btn-primary text-xs" onClick={activate} disabled={busy()}>
                  {t('contracts.activate')}
                </button>
              </Can>
            )}
            <Link href="/contracts" className="btn-ghost text-xs">
              {t('common.back')}
            </Link>
          </div>
        }
      />

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
        <div className="border-b border-slate-100 px-5 py-3">
          <h3 className="font-semibold text-slate-800">{t('contracts.milestones')}</h3>
        </div>
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <th className="th">#</th>
              <th className="th">{t('contracts.milestone')}</th>
              <th className="th">{t('contracts.amount')}</th>
              <th className="th">{t('common.status')}</th>
              <th className="th">{t('contracts.verified')}</th>
              <th className="th">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {contract.milestones.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-slate-400">
                  {t('common.none')}
                </td>
              </tr>
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
                      <button
                        className="btn-solar !px-3 !py-1 text-xs"
                        disabled={busy()}
                        onClick={() => verify(m.id)}
                      >
                        {busy(`verify:${m.id}`) ? t('common.loading') : t('contracts.verify')}
                      </button>
                    ) : m.status === 'VERIFIED' && can('finance.invoice.write') ? (
                      <button
                        className="btn-primary !px-3 !py-1 text-xs"
                        disabled={busy()}
                        onClick={() => generateInvoice(m.id)}
                      >
                        {busy(`invoice:${m.id}`) ? t('common.loading') : `🧾 ${t('contracts.generateInvoice')}`}
                      </button>
                    ) : m.status === 'INVOICED' && m.invoiceId ? (
                      <Link href={`/invoices/${m.invoiceId}`} className="btn-ghost !px-3 !py-1 text-xs">
                        {t('contracts.viewInvoice')}
                      </Link>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="mt-6">
        <AttachmentsCard entityType="CONTRACT" entityId={id} />
      </div>
      {confirmNode}
    </div>
  );
}
