'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useCallback } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { translateError } from '@/lib/errors';
import { formatDay, formatMoney } from '@/lib/format';
import { PageHeader, StatusBadge, EmptyRow, LoadError, TableSkeleton } from '@/components/ui';
import { daysUntil } from '@/components/opportunity-bits';
import { Icon } from '@/components/icons';
import { useEnums } from '@/lib/useEnums';

interface Proposal {
  id: string;
  code: string;
  status: string;
  opportunity?: { code: string; name: string };
  revisions: { revisionNo: number; totalAmount: string; status: string; validUntil: string | null }[];
  // The open signature chain, when the proposal is waiting on someone.
  pendingApproval?: {
    currentStep: number;
    steps: { sequence: number; role: { nameAr: string; nameEn: string } }[];
  } | null;
}

/** Statuses in which the validity date is still a live deadline. */
const LIVE = new Set(['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT']);

export default function ProposalsPage() {
  const { t, locale } = useI18n();
  const ar = locale === 'ar';
  const enums = useEnums();
  const [rows, setRows] = useState<Proposal[]>([]);
  const [stageFilter, setStageFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setLoadErr('');
    api
      .get<Proposal[]>('/proposals')
      .then(setRows)
      .catch((e) => setLoadErr(translateError(e, locale)))
      .finally(() => setLoading(false));
  }, [locale]);
  useEffect(load, [load]);

  // Client-side: the whole list is already loaded, so filtering the pipeline
  // costs no request. Same pattern /leads has always had.
  const shown = stageFilter ? rows.filter((r) => r.status === stageFilter) : rows;

  return (
    <div>
      <PageHeader title={t('proposals.title')} />
      {loadErr && !loading ? <LoadError message={loadErr} onRetry={load} /> : null}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select
          className="input !w-56"
          aria-label={t('common.status')}
          value={stageFilter}
          onChange={(e) => setStageFilter(e.target.value)}
        >
          <option value="">
            {t('common.status')}: {t('common.all')}
          </option>
          {enums?.proposalStatuses.map((o) => (
            <option key={o.value} value={o.value}>
              {ar ? o.labelAr : o.labelEn}
            </option>
          ))}
        </select>
      </div>

      <div className="card overflow-hidden">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <th scope="col" className="th">{t('common.code')}</th>
              <th scope="col" className="th">{t('proposals.opportunity')}</th>
              <th scope="col" className="th">{t('proposals.latestRev')}</th>
              <th scope="col" className="th">{t('proposals.validUntil')}</th>
              <th scope="col" className="th">{t('common.total')}</th>
              <th scope="col" className="th">{t('common.status')}</th>
              <th scope="col" className="th">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <TableSkeleton cols={7} />
            ) : shown.length === 0 ? (
              <EmptyRow colSpan={7} text={t('proposals.emptyHint')} actionHref="/opportunities" actionText={t('nav.opportunities')} />
            ) : (
              shown.map((p) => {
                const latest = p.revisions[0];
                const left = latest?.validUntil ? daysUntil(latest.validUntil) : null;
                // Red once the day has passed or fewer than 7 days remain, while it still matters.
                const urgent = left !== null && LIVE.has(p.status) && left <= 7;
                const waitingOn = p.pendingApproval?.steps.find((s) => s.sequence === p.pendingApproval!.currentStep);
                return (
                  <tr key={p.id} className="hover:bg-slate-50">
                    <td className="td font-mono text-xs">{p.code}</td>
                    <td className="td">{p.opportunity?.name ?? '—'}</td>
                    <td className="td">{latest ? `#${latest.revisionNo}` : '—'}</td>
                    <td className={`td ${urgent ? 'font-semibold text-danger-600' : ''}`}>
                      {latest?.validUntil ? (
                        <span className="inline-flex items-center gap-1">
                          {urgent && <Icon name="alert-triangle" className="h-3.5 w-3.5" />}
                          {formatDay(latest.validUntil, locale)}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="td">{latest ? formatMoney(latest.totalAmount, locale) : '—'}</td>
                    <td className="td">
                      <div className="flex flex-col items-start gap-1">
                        <StatusBadge status={p.status} />
                        {waitingOn && (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-warning-700">
                            <Icon name="stamp" className="h-3 w-3" />
                            {t('proposals.pendingWith').replace('{role}', ar ? waitingOn.role.nameAr : waitingOn.role.nameEn)}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="td">
                      <Link href={`/proposals/${p.id}`} className="btn-ghost btn-sm">
                        {t('common.details')}
                      </Link>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
