'use client';

/** Package 5 · P5-4 — one material return: the keeper receives it (stock moves) or it is cancelled. */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { useLookup } from '@/lib/lookups';
import { PageHeader, StatusBadge, LoadError, Field, Can, Btn, PageSkeleton } from '@/components/ui';

interface Named { id: string; code: string; nameAr: string; nameEn: string }
interface Detail {
  id: string;
  code: string;
  status: string;
  raisedById: string;
  raisedAt: string;
  receivedAt: string | null;
  notes: string | null;
  project: Named;
  fromLocation: Named;
  toLocation: Named;
  lines: Array<{
    id: string;
    qty: string;
    serialUnitIds: string[];
    item: { sku: string; nameAr: string; nameEn: string; uom: string; isSerialised: boolean };
  }>;
}

export default function MaterialReturnPage() {
  const { id } = useParams<{ id: string }>();
  const { t, locale, pick } = useI18n();
  const { user, can } = useAuth();
  const { act, busy } = useAct();
  const [r, setR] = useState<Detail | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [toId, setToId] = useState('');
  const keeper = can('scm.procurement.write');
  const locations = useLookup<Named & { locationType?: string }>('locations', { enabled: keeper });

  const load = useCallback(() => {
    setLoadErr('');
    api
      .get<Detail>(`/material-returns/${id}`)
      .then((d) => {
        setR(d);
        setToId(d.toLocation.id);
      })
      .catch((e) => setLoadErr(translateError(e, locale)));
  }, [id, locale]);
  useEffect(load, [load]);

  if (loadErr && !r) return <LoadError message={loadErr} onRetry={load} />;
  if (!r) return <PageSkeleton stats={0} />;
  const inTransit = r.status === 'RAISED';

  const post = (key: string, path: string, body: unknown = {}) =>
    act(key, async () => {
      await api.post(path, body);
      load();
    });

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${t('ret.one')} ${r.code}`}
        backHref="/requisitions/returns"
        backLabel={t('ret.title')}
        action={
          inTransit ? (
            <div className="flex flex-wrap gap-2">
              {(r.raisedById === user?.id || keeper) && (
                <Btn busy={busy('cancel')} disabled={busy()} onClick={() => post('cancel', `/material-returns/${id}/cancel`)}>
                  {t('ret.cancel')}
                </Btn>
              )}
            </div>
          ) : undefined
        }
      />

      <div className="card grid grid-cols-1 gap-4 p-5 text-sm sm:grid-cols-4">
        <div>
          <p className="label">{t('mr.project')}</p>
          <Link href={`/projects/${r.project.id}/execution`} className="text-brand-700 hover:underline">
            {r.project.code} · {pick(r.project, 'name')}
          </Link>
        </div>
        <div>
          <p className="label">{t('common.status')}</p>
          <StatusBadge status={r.status} />
        </div>
        <div>
          <p className="label">{t('ret.route')}</p>
          {r.fromLocation.code} → {r.toLocation.code}
        </div>
        <div>
          <p className="label">{t('common.date')}</p>
          {formatDateTime(r.raisedAt, locale)}
          {r.receivedAt && <span className="block text-xs text-success-700">{formatDateTime(r.receivedAt, locale)}</span>}
        </div>
        {r.notes && <p className="text-slate-600 sm:col-span-4">{r.notes}</p>}
      </div>

      <div className="card overflow-hidden">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th scope="col" className="th">{t('proposals.item')}</th>
              <th scope="col" className="th text-end">{t('proposals.qty')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {r.lines.map((l) => (
              <tr key={l.id}>
                <td className="td">
                  <span className="font-mono text-xs text-slate-500">{l.item.sku}</span> {pick(l.item, 'name')}
                  {l.serialUnitIds.length > 0 && <span className="ms-2 text-xs text-slate-500">({l.serialUnitIds.length} {t('mr.units')})</span>}
                </td>
                <td className="td-num">
                  {Number(l.qty)} {l.item.uom}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {inTransit && keeper && r.raisedById !== user?.id && (
        <Can perm="scm.procurement.write">
          <div className="card flex flex-wrap items-end gap-3 p-5">
            <Field label={t('ret.toStore')}>
              <select className="input" value={toId} onChange={(e) => setToId(e.target.value)} disabled={locations.state !== 'ready'}>
                {locations.rows
                  .filter((l) => l.locationType !== 'SITE')
                  .map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.code} · {pick(l, 'name')}
                    </option>
                  ))}
              </select>
            </Field>
            <Btn variant="primary" icon="check" busy={busy('receive')} disabled={busy()} onClick={() => post('receive', `/material-returns/${id}/receive`, { toLocationId: toId || undefined })}>
              {t('ret.receive')}
            </Btn>
            <p className="w-full text-xs text-slate-500">{t('ret.receiveHint')}</p>
          </div>
        </Can>
      )}
    </div>
  );
}
