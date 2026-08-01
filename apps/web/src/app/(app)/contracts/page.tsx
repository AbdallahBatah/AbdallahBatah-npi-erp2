'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useCallback } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { translateError } from '@/lib/errors';
import { useEnums, optionLabel } from '@/lib/useEnums';
import { formatMoney } from '@/lib/format';
import { PageHeader, StatusBadge, EmptyRow, LoadError, TableSkeleton } from '@/components/ui';

interface Contract {
  id: string;
  code: string;
  contractType: string;
  status: string;
  totalValue: string;
  customer?: { nameAr: string; nameEn: string };
  _count?: { milestones: number };
}

export default function ContractsPage() {
  const { t, locale, pick } = useI18n();
  const enums = useEnums();
  const [rows, setRows] = useState<Contract[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setLoadErr('');
    api
      .get<Contract[]>('/contracts')
      .then(setRows)
      .catch((e) => setLoadErr(translateError(e, locale)))
      .finally(() => setLoading(false));
  }, [locale]);
  useEffect(load, [load]);

  return (
    <div>
      <PageHeader title={t('contracts.title')} />
      {loadErr && !loading ? <LoadError message={loadErr} onRetry={load} /> : null}
      <div className="card table-sticky">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <th className="th">{t('common.code')}</th>
              <th className="th">{t('contracts.customer')}</th>
              <th className="th">{t('contracts.type')}</th>
              <th className="th">{t('contracts.value')}</th>
              <th className="th">{t('contracts.milestones')}</th>
              <th className="th">{t('common.status')}</th>
              <th className="th">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <TableSkeleton cols={7} />
            ) : rows.length === 0 ? (
              <EmptyRow colSpan={7} text={t('contracts.emptyHint')} actionHref="/proposals" actionText={t('nav.proposals')} />
            ) : (
              rows.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50">
                  <td className="td font-mono text-xs">{c.code}</td>
                  <td className="td">{c.customer ? pick(c.customer, 'name') : '—'}</td>
                  <td className="td">{optionLabel(enums?.contractTypes, c.contractType, locale)}</td>
                  <td className="td">{formatMoney(c.totalValue, locale)}</td>
                  <td className="td">{c._count?.milestones ?? 0}</td>
                  <td className="td"><StatusBadge status={c.status} /></td>
                  <td className="td">
                    <Link href={`/contracts/${c.id}`} className="btn-ghost btn-sm">
                      {t('common.details')}
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
