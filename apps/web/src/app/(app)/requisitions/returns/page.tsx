'use client';

/**
 * Package 5 · P5-4 (ADR-05) — «مرتجع المواد»: what is left on a project's
 * site goes back to the store. The engineer raises from what the site holds;
 * the keeper receives, and only then does stock move.
 */
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { formatDate } from '@/lib/format';
import { useLookup } from '@/lib/lookups';
import { PageHeader, StatusBadge, EmptyRow, LoadError, Modal, Field, Can, Btn, TableSkeleton } from '@/components/ui';

interface Row {
  id: string;
  code: string;
  status: string;
  raisedAt: string;
  project: { id: string; code: string; nameAr: string; nameEn: string };
  toLocation: { code: string };
  _count: { lines: number };
}
interface Named { id: string; code: string; nameAr: string; nameEn: string }
interface SiteItem {
  item: { id: string; sku: string; nameAr: string; nameEn: string; uom: string; isSerialised: boolean };
  available: string;
  units: Array<{ id: string; serialNo: string }>;
}

export default function MaterialReturnsPage() {
  const { t, locale, pick } = useI18n();
  const router = useRouter();
  const { act, busy } = useAct();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [site, setSite] = useState<{ items: SiteItem[]; site: Named | null } | null>(null);
  const [qtys, setQtys] = useState<Record<string, string>>({});
  const [serials, setSerials] = useState<Record<string, string[]>>({});
  const [formErr, setFormErr] = useState('');
  const projects = useLookup<Named>('projects', { enabled: open });

  const load = useCallback(() => {
    setLoading(true);
    setLoadErr('');
    api
      .get<Row[]>('/material-returns')
      .then(setRows)
      .catch((e) => setLoadErr(translateError(e, locale)))
      .finally(() => setLoading(false));
  }, [locale]);
  useEffect(load, [load]);

  useEffect(() => {
    setSite(null);
    setQtys({});
    setSerials({});
    if (!projectId) return;
    api
      .get<{ items: SiteItem[]; site: Named | null }>(`/material-returns/site-stock?projectId=${encodeURIComponent(projectId)}`)
      .then(setSite)
      .catch((e) => setFormErr(translateError(e, locale)));
  }, [projectId, locale]);

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!site) return;
    const lines = site.items
      .map((r) => {
        const ids = serials[r.item.id] ?? [];
        const qty = r.item.isSerialised ? ids.length : Number(qtys[r.item.id] || 0);
        return { itemId: r.item.id, qty, serialUnitIds: r.item.isSerialised ? ids : undefined };
      })
      .filter((l) => l.qty > 0);
    if (lines.length === 0) {
      setFormErr(t('ret.err.lines'));
      return;
    }
    setFormErr('');
    const notes = String(new FormData(e.currentTarget).get('notes') || '').trim() || undefined;
    let createdId: string | null = null;
    const ok = await act('create', async () => {
      const r = await api.post<{ id: string }>('/material-returns', { projectId, notes, lines });
      createdId = r.id;
    });
    if (ok && createdId) router.push(`/requisitions/returns/${createdId}`);
  }

  return (
    <div>
      <PageHeader
        title={t('ret.title')}
        subtitle={t('ret.hint')}
        backHref="/requisitions/materials"
        backLabel={t('mr.title')}
        action={
          <Can perm="scm.requisition.write">
            <Btn variant="primary" icon="plus" onClick={() => setOpen(true)}>
              {t('ret.new')}
            </Btn>
          </Can>
        }
      />
      {loadErr && !loading ? <LoadError message={loadErr} onRetry={load} /> : null}
      <div className="card table-sticky">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <th scope="col" className="th">{t('common.code')}</th>
              <th scope="col" className="th">{t('mr.project')}</th>
              <th scope="col" className="th">{t('ret.toStore')}</th>
              <th scope="col" className="th text-end">{t('mr.lines')}</th>
              <th scope="col" className="th">{t('common.date')}</th>
              <th scope="col" className="th">{t('common.status')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <TableSkeleton cols={6} />
            ) : rows.length === 0 ? (
              <EmptyRow colSpan={6} text={t('ret.empty')} />
            ) : (
              rows.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="td">
                    <Link href={`/requisitions/returns/${r.id}`} className="font-mono text-xs font-semibold text-brand-700 hover:underline">
                      {r.code}
                    </Link>
                  </td>
                  <td className="td">
                    <span className="font-mono text-xs text-slate-500">{r.project.code}</span> {pick(r.project, 'name')}
                  </td>
                  <td className="td font-mono text-xs">{r.toLocation.code}</td>
                  <td className="td-num">{r._count.lines}</td>
                  <td className="td text-xs">{formatDate(r.raisedAt, locale)}</td>
                  <td className="td">
                    <StatusBadge status={r.status} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Modal open={open} title={t('ret.new')} onClose={() => setOpen(false)}>
        <form onSubmit={create} className="space-y-4">
          <Field label={t('mr.project')}>
            <select className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)} disabled={projects.state !== 'ready'}>
              <option value="">—</option>
              {projects.rows.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code} · {pick(p, 'name')}
                </option>
              ))}
            </select>
          </Field>
          {formErr && (
            <p role="alert" className="text-xs font-medium text-danger-600">
              {formErr}
            </p>
          )}
          {site && (site.items.length === 0 ? (
            <p className="text-sm text-slate-500">{t('ret.nothingOnSite')}</p>
          ) : (
            <div className="max-h-[50vh] space-y-3 overflow-y-auto">
              {site.items.map((r) => (
                <div key={r.item.id} className="rounded-md border border-slate-200 p-3 text-sm">
                  <p className="font-medium">
                    {r.item.sku} · {pick(r.item, 'name')}
                  </p>
                  <p className="text-xs text-slate-500">
                    {t('ret.onSite')}: {Number(r.available)} {r.item.uom}
                  </p>
                  {r.item.isSerialised ? (
                    <select
                      multiple
                      aria-label={t('mr.units')}
                      className="input mt-2 h-28"
                      value={serials[r.item.id] ?? []}
                      onChange={(e) =>
                        setSerials((p) => ({ ...p, [r.item.id]: Array.from(e.target.selectedOptions).map((o) => o.value) }))
                      }
                    >
                      {r.units.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.serialNo}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="number"
                      min={0}
                      max={Number(r.available)}
                      step="0.001"
                      aria-label={`${t('proposals.qty')} ${r.item.sku}`}
                      className="input mt-2 w-32"
                      value={qtys[r.item.id] ?? ''}
                      onChange={(e) => setQtys((p) => ({ ...p, [r.item.id]: e.target.value }))}
                    />
                  )}
                </div>
              ))}
            </div>
          ))}
          <Field label={`${t('leads.notes')} (${t('common.optional')})`}>
            <textarea name="notes" className="input" rows={2} maxLength={1000} />
          </Field>
          <div className="flex justify-end gap-2">
            <Btn onClick={() => setOpen(false)}>{t('common.cancel')}</Btn>
            <Btn type="submit" variant="primary" busy={busy('create')} disabled={busy() || !site || site.items.length === 0}>
              {t('ret.raise')}
            </Btn>
          </div>
        </form>
      </Modal>
    </div>
  );
}
