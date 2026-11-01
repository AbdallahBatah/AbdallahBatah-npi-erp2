'use client';

/**
 * Package 4 · P4-2 (ADR-04 §4-2, owner work cycle step 11) — «طلب مواد المشروع».
 * Under /requisitions, so the requisitions screen's key guards it (no new
 * screen or key). The engineer raises; the projects GM approves; the keeper issues.
 */
import { FormEvent, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { formatDate } from '@/lib/format';
import { useLookup } from '@/lib/lookups';
import { PageHeader, StatusBadge, EmptyRow, LoadError, Modal, Field, Can, Btn, TableSkeleton } from '@/components/ui';
import { Icon } from '@/components/icons';

interface Row {
  id: string;
  code: string;
  status: string;
  neededBy: string | null;
  createdAt: string;
  project: { id: string; code: string; nameAr: string; nameEn: string };
  _count: { lines: number; issues: number };
}
interface ProjectRef { id: string; code: string; nameAr: string; nameEn: string }
interface ItemRef { id: string; sku: string; nameAr: string; nameEn: string; uom: string }
interface WbsRef { id: string; code: string; nameAr: string; nameEn: string }
interface DraftLine { itemId: string; wbsElementId: string; qty: string }

export default function MaterialRequestsPage() {
  const { t, locale, pick } = useI18n();
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [wbs, setWbs] = useState<WbsRef[]>([]);
  const [lines, setLines] = useState<DraftLine[]>([{ itemId: '', wbsElementId: '', qty: '' }]);
  const [formErr, setFormErr] = useState('');
  const { act, busy } = useAct();
  const projects = useLookup<ProjectRef>('projects', { enabled: open });
  const items = useLookup<ItemRef>('items', { enabled: open });

  const load = useCallback(() => {
    setLoading(true);
    setLoadErr('');
    api
      .get<Row[]>('/material-requests')
      .then(setRows)
      .catch((e) => setLoadErr(translateError(e, locale)))
      .finally(() => setLoading(false));
  }, [locale]);
  useEffect(load, [load]);

  // The project's budget lines, so each material is requested against one.
  useEffect(() => {
    if (!projectId) {
      setWbs([]);
      return;
    }
    api
      .get<{ wbsElements: WbsRef[] }>(`/projects/${projectId}`)
      .then((p) => setWbs(p.wbsElements))
      .catch(() => setWbs([]));
  }, [projectId]);

  const setLine = (i: number, patch: Partial<DraftLine>) =>
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const used = lines.filter((l) => l.itemId);
    if (!projectId || used.length === 0 || used.some((l) => !(Number(l.qty) > 0))) {
      setFormErr(t('mr.err.lines'));
      return;
    }
    setFormErr('');
    let createdId: string | null = null;
    const ok = await act('create', async () => {
      const mr = await api.post<{ id: string }>('/material-requests', {
        projectId,
        neededBy: String(f.get('neededBy') || '') || undefined,
        notes: String(f.get('notes') || '').trim() || undefined,
        lines: used.map((l) => ({ itemId: l.itemId, wbsElementId: l.wbsElementId || undefined, qty: Number(l.qty) })),
      });
      createdId = mr.id;
    });
    if (ok && createdId) router.push(`/requisitions/materials/${createdId}`);
  }

  return (
    <div>
      <PageHeader
        title={t('mr.title')}
        backHref="/requisitions"
        backLabel={t('nav.requisitions')}
        action={
          <div className="flex flex-wrap gap-2">
            {/* P5-4: what is left on site goes back on a return voucher. */}
            <Link href="/requisitions/returns" className="btn-ghost">
              {t('ret.title')}
            </Link>
            <Can perm="scm.requisition.write">
              <Btn variant="primary" icon="plus" onClick={() => setOpen(true)}>
                {t('mr.new')}
              </Btn>
            </Can>
          </div>
        }
      />
      {loadErr && !loading ? <LoadError message={loadErr} onRetry={load} /> : null}
      <div className="card table-sticky">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <th scope="col" className="th">{t('common.code')}</th>
              <th scope="col" className="th">{t('mr.project')}</th>
              <th scope="col" className="th text-end">{t('mr.lines')}</th>
              <th scope="col" className="th">{t('mr.neededBy')}</th>
              <th scope="col" className="th">{t('common.status')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <TableSkeleton cols={5} />
            ) : rows.length === 0 ? (
              <EmptyRow colSpan={5} text={t('mr.empty')} />
            ) : (
              rows.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="td">
                    <Link href={`/requisitions/materials/${r.id}`} className="font-mono text-xs font-semibold text-brand-700 hover:underline">
                      {r.code}
                    </Link>
                  </td>
                  <td className="td">
                    <span className="font-mono text-xs text-slate-500">{r.project.code}</span> {pick(r.project, 'name')}
                  </td>
                  <td className="td-num">{r._count.lines}</td>
                  <td className="td text-xs">{r.neededBy ? formatDate(r.neededBy, locale) : '—'}</td>
                  <td className="td">
                    <StatusBadge status={r.status} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Modal open={open} title={t('mr.new')} onClose={() => setOpen(false)}>
        <form onSubmit={create} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
            <Field label={t('mr.neededBy')}>
              <input type="date" name="neededBy" className="input" />
            </Field>
          </div>
          <div>
            <p className="label">{t('mr.lines')}</p>
            {formErr && (
              <p role="alert" className="mb-2 text-xs font-medium text-danger-600">
                {formErr}
              </p>
            )}
            <div className="space-y-2">
              {lines.map((l, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <select
                    aria-label={t('proposals.item')}
                    className="input min-w-[12rem] flex-1"
                    value={l.itemId}
                    onChange={(e) => setLine(i, { itemId: e.target.value })}
                    disabled={items.state !== 'ready'}
                  >
                    <option value="">—</option>
                    {items.rows.map((it) => (
                      <option key={it.id} value={it.id}>
                        {it.sku} · {pick(it, 'name')}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label={t('mr.budgetLine')}
                    className="input min-w-[10rem] flex-1"
                    value={l.wbsElementId}
                    onChange={(e) => setLine(i, { wbsElementId: e.target.value })}
                    disabled={wbs.length === 0}
                  >
                    <option value="">{t('mr.budgetLine')} —</option>
                    {wbs.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.code} · {pick(w, 'name')}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min={0}
                    step="0.001"
                    className="input w-28"
                    aria-label={t('proposals.qty')}
                    placeholder={t('proposals.qty')}
                    value={l.qty}
                    onChange={(e) => setLine(i, { qty: e.target.value })}
                  />
                  <button
                    type="button"
                    aria-label={`${t('proposals.removeLine')} ${i + 1}`}
                    className="rounded-md p-1.5 text-slate-500 hover:bg-danger-50 hover:text-danger-600"
                    onClick={() => setLines((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev))}
                  >
                    <Icon name="x" className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
            <button type="button" className="btn-ghost mt-2 text-xs" onClick={() => setLines((p) => [...p, { itemId: '', wbsElementId: '', qty: '' }])}>
              + {t('proposals.addLine')}
            </button>
          </div>
          <Field label={`${t('leads.notes')} (${t('common.optional')})`}>
            <textarea name="notes" className="input" rows={2} maxLength={2000} />
          </Field>
          <div className="flex justify-end gap-2">
            <Btn onClick={() => setOpen(false)}>{t('common.cancel')}</Btn>
            <Btn type="submit" variant="primary" busy={busy('create')} disabled={busy()}>
              {t('common.create')}
            </Btn>
          </div>
        </form>
      </Modal>
    </div>
  );
}
