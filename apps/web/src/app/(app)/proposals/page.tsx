'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useCallback } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { translateError } from '@/lib/errors';
import { formatMoney } from '@/lib/format';
import { PageHeader, StatusBadge, EmptyRow, LoadError, TableSkeleton } from '@/components/ui';

interface Proposal {
  id: string;
  code: string;
  status: string;
  opportunity?: { code: string; name: string };
  revisions: { revisionNo: number; totalAmount: string }[];
}

export default function ProposalsPage() {
  const { t, locale } = useI18n();
  const [rows, setRows] = useState<Proposal[]>([]);
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

  return (
    <div>
      <PageHeader title={t('proposals.title')} />
      {loadErr && !loading ? <LoadError message={loadErr} onRetry={load} /> : null}
      <div className="card overflow-hidden">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <th className="th">{t('common.code')}</th>
              <th className="th">{t('proposals.opportunity')}</th>
              <th className="th">{t('proposals.latestRev')}</th>
              <th className="th">{t('common.total')}</th>
              <th className="th">{t('common.status')}</th>
              <th className="th">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <TableSkeleton cols={6} />
            ) : rows.length === 0 ? (
              <EmptyRow colSpan={6} text={t('proposals.emptyHint')} actionHref="/opportunities" actionText={t('nav.opportunities')} />
            ) : (
              rows.map((p) => {
                const latest = p.revisions[0];
                return (
                  <tr key={p.id} className="hover:bg-slate-50">
                    <td className="td font-mono text-xs">{p.code}</td>
                    <td className="td">{p.opportunity?.name ?? '—'}</td>
                    <td className="td">{latest ? `#${latest.revisionNo}` : '—'}</td>
                    <td className="td">{latest ? formatMoney(latest.totalAmount, locale) : '—'}</td>
                    <td className="td"><StatusBadge status={p.status} /></td>
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
