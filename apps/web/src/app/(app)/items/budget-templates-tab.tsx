'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { formatNumber } from '@/lib/format';
import { useLookup } from '@/lib/lookups';
import { Modal, Field, EmptyRow, LoadError, Can, Btn, TableSkeleton } from '@/components/ui';
import { Icon } from '@/components/icons';

interface WorkItemRef {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  uom: string;
}
interface TemplateLine {
  workItemId: string;
  qty: string;
  description: string | null;
  workItem: WorkItemRef;
}
interface Template {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  panelCount: number | null;
  capacityKwp: string | null;
  notes: string | null;
  isActive: boolean;
  lines: TemplateLine[];
}
interface DraftLine {
  workItemId: string;
  qty: string;
  description: string;
}
const blank = (): DraftLine => ({ workItemId: '', qty: '', description: '' });

/**
 * Package 3 · P3-5 (ADR-03 §4-5) — «نماذج التكلفة التقديرية للمشاريع المعيارية»:
 * standard budgets (e.g. 990 and 1230 panels) a budget can start from. Work
 * items and quantities only — the cost is taken fresh when a budget is built.
 */
export function BudgetTemplatesTab() {
  const { t, locale, pick } = useI18n();
  const { can } = useAuth();
  const canWrite = can('commercial.item.write');
  const [rows, setRows] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');
  const [editing, setEditing] = useState<Template | 'new' | null>(null);
  const [lines, setLines] = useState<DraftLine[]>([blank()]);
  const [formErr, setFormErr] = useState('');
  const { act, busy } = useAct();
  const workItems = useLookup<WorkItemRef>('workItems', { enabled: editing !== null });

  const load = useCallback(() => {
    setLoading(true);
    setLoadErr('');
    api
      .get<Template[]>(`/budget-templates${canWrite ? '?all=1' : ''}`)
      .then(setRows)
      .catch((e) => setLoadErr(translateError(e, locale)))
      .finally(() => setLoading(false));
  }, [locale, canWrite]);

  useEffect(load, [load]);

  function open(row: Template | 'new') {
    setFormErr('');
    setLines(
      row === 'new' || row.lines.length === 0
        ? [blank()]
        : row.lines.map((l) => ({ workItemId: l.workItemId, qty: String(Number(l.qty)), description: l.description ?? '' })),
    );
    setEditing(row);
  }

  const setLine = (i: number, patch: Partial<DraftLine>) =>
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!editing) return;
    const f = new FormData(e.currentTarget);
    const used = lines.filter((l) => l.workItemId);
    if (used.length === 0 || used.some((l) => !(Number(l.qty) > 0))) {
      setFormErr(t('templates.err.lines'));
      return;
    }
    setFormErr('');
    const nameAr = String(f.get('nameAr') || '').trim();
    const num = (k: string) => (String(f.get(k) || '').trim() === '' ? null : Number(f.get(k)));
    const body = {
      nameAr,
      nameEn: String(f.get('nameEn') || '').trim() || nameAr,
      panelCount: num('panelCount'),
      capacityKwp: num('capacityKwp'),
      notes: String(f.get('notes') || '').trim() || null,
      lines: used.map((l) => ({
        workItemId: l.workItemId,
        qty: Number(l.qty),
        description: l.description.trim() || undefined,
      })),
    };
    const ok = await act(
      'save',
      () =>
        editing === 'new'
          ? api.post('/budget-templates', {
              ...body,
              code: String(f.get('code') || '').trim(),
              panelCount: body.panelCount ?? undefined,
              capacityKwp: body.capacityKwp ?? undefined,
              notes: body.notes ?? undefined,
            })
          : api.patch(`/budget-templates/${editing.id}`, body),
      { success: t(editing === 'new' ? 'common.created' : 'common.saved') },
    );
    if (ok) {
      setEditing(null);
      load();
    }
  }

  async function toggle(row: Template) {
    if (await act(`toggle:${row.id}`, () => api.patch(`/budget-templates/${row.id}`, { isActive: !row.isActive }))) load();
  }

  const current = editing && editing !== 'new' ? editing : null;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-2">
        <p className="text-sm text-slate-500">{t('templates.hint')}</p>
        <Can perm="commercial.item.write">
          <Btn variant="primary" icon="plus" onClick={() => open('new')}>
            {t('templates.new')}
          </Btn>
        </Can>
      </div>
      {loadErr && !loading ? (
        <div className="mb-6">
          <LoadError message={loadErr} onRetry={load} />
        </div>
      ) : null}

      <div className="card table-sticky">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <th scope="col" className="th">{t('common.code')}</th>
              <th scope="col" className="th">{t('common.name')}</th>
              <th scope="col" className="th text-end">{t('templates.panels')}</th>
              <th scope="col" className="th text-end">{t('templates.capacity')}</th>
              <th scope="col" className="th text-end">{t('templates.lineCount')}</th>
              <th scope="col" className="th">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <TableSkeleton cols={6} />
            ) : rows.length === 0 ? (
              <EmptyRow colSpan={6} text={t('templates.empty')} />
            ) : (
              rows.map((r) => (
                <tr key={r.id} className={`hover:bg-slate-50 ${r.isActive ? '' : 'opacity-60'}`}>
                  <td className="td font-mono text-xs">{r.code}</td>
                  <td className="td font-medium">{pick(r, 'name')}</td>
                  <td className="td-num">{r.panelCount ?? '—'}</td>
                  <td className="td-num">{r.capacityKwp ? formatNumber(r.capacityKwp, locale) : '—'}</td>
                  <td className="td-num">{r.lines.length}</td>
                  <td className="td">
                    <span className="flex gap-1">
                      <Btn sm onClick={() => open(r)} disabled={busy()}>
                        {canWrite ? t('common.edit') : t('templates.view')}
                      </Btn>
                      <Can perm="commercial.item.write">
                        <Btn sm busy={busy(`toggle:${r.id}`)} disabled={busy()} onClick={() => toggle(r)}>
                          {r.isActive ? t('workItems.deactivate') : t('workItems.activate')}
                        </Btn>
                      </Can>
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Modal
        open={editing !== null}
        title={editing === 'new' ? t('templates.new') : pick(current ?? { nameAr: '', nameEn: '' }, 'name')}
        onClose={() => setEditing(null)}
      >
        <form key={current?.id ?? 'new'} onSubmit={save} className="space-y-4">
          <fieldset disabled={!canWrite} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={t('common.code')}>
              <input name="code" className="input font-mono" dir="ltr" required maxLength={40} defaultValue={current?.code} disabled={!!current} />
            </Field>
            <Field label={`${t('common.name')} (ع)`}>
              <input name="nameAr" className="input" required maxLength={200} defaultValue={current?.nameAr} />
            </Field>
            <Field label={`${t('common.name')} (EN — ${t('common.optional')})`}>
              <input name="nameEn" className="input" dir="ltr" maxLength={200} defaultValue={current?.nameEn} />
            </Field>
            <Field label={t('templates.panels')}>
              <input name="panelCount" type="number" min={0} step={1} className="input" defaultValue={current?.panelCount ?? ''} />
            </Field>
            <Field label={t('templates.capacity')}>
              <input name="capacityKwp" type="number" min={0} step="0.001" className="input" defaultValue={current?.capacityKwp ? Number(current.capacityKwp) : ''} />
            </Field>
            <Field label={`${t('templates.notes')} (${t('common.optional')})`}>
              <input name="notes" className="input" maxLength={2000} defaultValue={current?.notes ?? ''} />
            </Field>
          </fieldset>

          <div>
            <p className="label">{t('budget.lines')}</p>
            {formErr && (
              <p role="alert" className="mb-2 text-xs font-medium text-danger-600">
                {formErr}
              </p>
            )}
            <div className="space-y-2">
              {lines.map((l, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <select
                    aria-label={t('budget.workItem')}
                    className="input min-w-[12rem] flex-1"
                    value={l.workItemId}
                    disabled={!canWrite || workItems.state === 'unavailable'}
                    onChange={(e) => setLine(i, { workItemId: e.target.value })}
                  >
                    <option value="">—</option>
                    {workItems.rows.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.code} · {pick(w, 'name')} ({w.uom})
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
                    disabled={!canWrite}
                    onChange={(e) => setLine(i, { qty: e.target.value })}
                  />
                  <input
                    className="input min-w-[10rem] flex-1"
                    aria-label={t('budget.description')}
                    placeholder={`${t('budget.description')} (${t('common.optional')})`}
                    maxLength={500}
                    value={l.description}
                    disabled={!canWrite}
                    onChange={(e) => setLine(i, { description: e.target.value })}
                  />
                  {canWrite && (
                    <button
                      type="button"
                      aria-label={`${t('proposals.removeLine')} ${i + 1}`}
                      className="rounded-md p-1.5 text-slate-500 hover:bg-danger-50 hover:text-danger-600"
                      onClick={() => setLines((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : [blank()]))}
                    >
                      <Icon name="x" className="h-4 w-4" />
                    </button>
                  )}
                </div>
              ))}
            </div>
            {canWrite && (
              <button type="button" className="btn-ghost mt-2 text-xs" onClick={() => setLines((prev) => [...prev, blank()])}>
                + {t('proposals.addLine')}
              </button>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <Btn onClick={() => setEditing(null)}>{t('common.cancel')}</Btn>
            {canWrite && (
              <Btn type="submit" variant="primary" busy={busy('save')} disabled={busy()}>
                {editing === 'new' ? t('common.create') : t('common.save')}
              </Btn>
            )}
          </div>
        </form>
      </Modal>
    </div>
  );
}
