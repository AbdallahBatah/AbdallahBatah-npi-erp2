'use client';

/** Package 7 · P7-2 — the warranty register: every project's warranties, soonest to end first. */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { WARRANTY_KINDS } from '@npi/shared';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { translateError } from '@/lib/errors';
import { formatDate } from '@/lib/format';
import { PageHeader, EmptyRow, LoadError, TableSkeleton } from '@/components/ui';

interface Row {
  id: string;
  kind: string;
  years: number;
  startsAt: string;
  endsAt: string;
  project: { id: string; code: string; nameAr: string; nameEn: string };
}

export default function WarrantiesPage() {
  const { t, locale, pick } = useI18n();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const load = useCallback(() => {
    setLoading(true);
    api
      .get<Row[]>('/projects/warranties')
      .then(setRows)
      .catch((e) => setErr(translateError(e, locale)))
      .finally(() => setLoading(false));
  }, [locale]);
  useEffect(load, [load]);
  const now = Date.now();

  return (
    <div>
      <PageHeader title={t('wty.title')} subtitle={t('wty.hint')} backHref="/projects" backLabel={t('prj.title')} />
      {err && <LoadError message={err} onRetry={load} />}
      <div className="card table-sticky">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th scope="col" className="th">{t('mr.project')}</th>
              <th scope="col" className="th">{t('wty.kind')}</th>
              <th scope="col" className="th text-end">{t('wty.years')}</th>
              <th scope="col" className="th">{t('wty.from')}</th>
              <th scope="col" className="th">{t('wty.to')}</th>
              <th scope="col" className="th text-end">{t('wty.daysLeft')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <TableSkeleton cols={6} />
            ) : rows.length === 0 ? (
              <EmptyRow colSpan={6} text={t('wty.empty')} />
            ) : (
              rows.map((w) => {
                const k = WARRANTY_KINDS.find((x) => x.value === w.kind);
                const left = Math.ceil((new Date(w.endsAt).getTime() - now) / 864e5);
                return (
                  <tr key={w.id}>
                    <td className="td">
                      <Link href={`/projects/${w.project.id}/handover`} className="text-brand-700 hover:underline">
                        {w.project.code}
                      </Link>{' '}
                      {pick(w.project, 'name')}
                    </td>
                    <td className="td">{k ? (locale === 'ar' ? k.labelAr : k.labelEn) : w.kind}</td>
                    <td className="td-num">{w.years}</td>
                    <td className="td text-xs">{formatDate(w.startsAt, locale)}</td>
                    <td className="td text-xs">{formatDate(w.endsAt, locale)}</td>
                    <td className={`td-num ${left < 0 ? 'text-slate-400' : left < 90 ? 'text-warning-700' : ''}`}>{left < 0 ? t('wty.ended') : left}</td>
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
