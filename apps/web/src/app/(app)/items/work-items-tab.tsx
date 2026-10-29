'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { formatMoney } from '@/lib/format';
import { useLookup } from '@/lib/lookups';
import { Modal, Field, EmptyRow, LoadError, Can, Btn, TableSkeleton } from '@/components/ui';

export const WORK_ITEM_KINDS = ['MATERIAL', 'LABOUR', 'EQUIPMENT', 'SUBCONTRACT', 'EXPENSE', 'FINANCING'] as const;

interface WorkItem {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  kind: string;
  uom: string;
  /** null for a caller without finance.costs.view (server redaction). */
  defaultUnitCost: string | null;
  itemId: string | null;
  item: { id: string; sku: string; nameAr: string; nameEn: string } | null;
  sortOrder: number;
  isActive: boolean;
}

interface StockItem {
  id: string;
  sku: string;
  nameAr: string;
  nameEn: string;
}

/**
 * Package 3 · P3-3 (ADR-03 §4-3) — «بنود المشاريع»: the company's list of what
 * an estimated budget is made of. Lives on the items screen, under its keys.
 * A work item is switched off, never deleted.
 */
export function WorkItemsTab() {
  const { t, locale, pick } = useI18n();
  const { can } = useAuth();
  const showCost = can('finance.costs.view');
  const canWrite = can('commercial.item.write');
  const colCount = showCost ? 7 : 6;
  const [rows, setRows] = useState<WorkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');
  const [editing, setEditing] = useState<WorkItem | 'new' | null>(null);
  const [kind, setKind] = useState<string>('MATERIAL');
  const { act, busy } = useAct();
  const stock = useLookup<StockItem>('items', { enabled: editing !== null });

  const load = useCallback(() => {
    setLoading(true);
    setLoadErr('');
    api
      .get<WorkItem[]>(`/work-items${canWrite ? '?all=1' : ''}`)
      .then(setRows)
      .catch((e) => setLoadErr(translateError(e, locale)))
      .finally(() => setLoading(false));
  }, [locale, canWrite]);

  useEffect(load, [load]);

  function openEditor(row: WorkItem | 'new') {
    setKind(row === 'new' ? 'MATERIAL' : row.kind);
    setEditing(row);
  }

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!editing) return;
    const f = new FormData(e.currentTarget);
    const nameAr = String(f.get('nameAr') || '').trim();
    const nameEn = String(f.get('nameEn') || '').trim() || nameAr;
    const itemId = kind === 'MATERIAL' ? String(f.get('itemId') || '') || null : null;
    const body = {
      nameAr,
      nameEn,
      kind,
      uom: String(f.get('uom') || '').trim() || 'unit',
      sortOrder: Number(f.get('sortOrder') || 0),
      ...(showCost ? { defaultUnitCost: Number(f.get('defaultUnitCost') || 0) } : {}),
    };
    const ok = await act(
      'save',
      () =>
        editing === 'new'
          ? api.post('/work-items', { ...body, code: String(f.get('code') || '').trim(), ...(itemId ? { itemId } : {}) })
          : api.patch(`/work-items/${editing.id}`, { ...body, itemId }),
      { success: t(editing === 'new' ? 'common.created' : 'common.saved') },
    );
    if (ok) {
      setEditing(null);
      load();
    }
  }

  async function toggle(row: WorkItem) {
    if (await act(`toggle:${row.id}`, () => api.patch(`/work-items/${row.id}`, { isActive: !row.isActive }))) load();
  }

  const current = editing && editing !== 'new' ? editing : null;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-2">
        <p className="text-sm text-slate-500">{t('workItems.hint')}</p>
        <Can perm="commercial.item.write">
          <Btn variant="primary" icon="plus" onClick={() => openEditor('new')}>
            {t('workItems.new')}
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
              <th scope="col" className="th">{t('workItems.kind')}</th>
              <th scope="col" className="th">{t('items.uom')}</th>
              {showCost && <th scope="col" className="th">{t('workItems.defaultUnitCost')}</th>}
              <th scope="col" className="th">{t('workItems.stockItem')}</th>
              <th scope="col" className="th">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <TableSkeleton cols={colCount} />
            ) : rows.length === 0 ? (
              <EmptyRow colSpan={colCount} text={t('workItems.empty')} />
            ) : (
              rows.map((w) => (
                <tr key={w.id} className={`hover:bg-slate-50 ${w.isActive ? '' : 'opacity-60'}`}>
                  <td className="td font-mono text-xs">{w.code}</td>
                  <td className="td font-medium">{pick(w, 'name')}</td>
                  <td className="td">{t(`workItems.kind.${w.kind}`)}</td>
                  <td className="td">{w.uom}</td>
                  {showCost && <td className="td">{w.defaultUnitCost !== null ? formatMoney(w.defaultUnitCost, locale) : '—'}</td>}
                  <td className="td text-xs">{w.item ? `${w.item.sku} · ${pick(w.item, 'name')}` : '—'}</td>
                  <td className="td">
                    <Can perm="commercial.item.write">
                      <span className="flex gap-1">
                        <Btn sm onClick={() => openEditor(w)} disabled={busy()}>
                          {t('common.edit')}
                        </Btn>
                        <Btn sm busy={busy(`toggle:${w.id}`)} disabled={busy()} onClick={() => toggle(w)}>
                          {w.isActive ? t('workItems.deactivate') : t('workItems.activate')}
                        </Btn>
                      </span>
                    </Can>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Modal
        open={editing !== null}
        title={editing === 'new' ? t('workItems.new') : t('workItems.edit')}
        onClose={() => setEditing(null)}
      >
        {/* key: a fresh form (and fresh defaults) for each row opened */}
        <form key={current?.id ?? 'new'} onSubmit={save} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t('common.code')}>
            <input
              name="code"
              className="input font-mono"
              required
              maxLength={40}
              defaultValue={current?.code}
              disabled={!!current}
              dir="ltr"
            />
          </Field>
          <Field label={t('workItems.kind')}>
            <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
              {WORK_ITEM_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`workItems.kind.${k}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={`${t('common.name')} (ع)`}>
            <input name="nameAr" className="input" required maxLength={200} defaultValue={current?.nameAr} />
          </Field>
          <Field label={`${t('common.name')} (EN — ${t('common.optional')})`}>
            <input name="nameEn" className="input" dir="ltr" maxLength={200} defaultValue={current?.nameEn} />
          </Field>
          <Field label={t('items.uom')}>
            <input name="uom" className="input" maxLength={40} defaultValue={current?.uom ?? 'unit'} />
          </Field>
          <Field label={t('workItems.sortOrder')}>
            <input name="sortOrder" type="number" min={0} step={1} className="input" defaultValue={current?.sortOrder ?? 0} />
          </Field>
          {showCost && (
            <Field label={t('workItems.defaultUnitCost')}>
              <input
                name="defaultUnitCost"
                type="number"
                min={0}
                step="0.01"
                className="input"
                defaultValue={current?.defaultUnitCost ?? '0'}
              />
            </Field>
          )}
          {kind === 'MATERIAL' && (
            <Field label={`${t('workItems.stockItem')} (${t('common.optional')})`}>
              <select
                name="itemId"
                className="input"
                defaultValue={current?.itemId ?? ''}
                disabled={stock.state !== 'ready'}
              >
                <option value="">—</option>
                {stock.rows.map((it) => (
                  <option key={it.id} value={it.id}>
                    {it.sku} · {pick(it, 'name')}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Btn onClick={() => setEditing(null)}>{t('common.cancel')}</Btn>
            <Btn type="submit" variant="primary" busy={busy('save')} disabled={busy()}>
              {editing === 'new' ? t('common.create') : t('common.save')}
            </Btn>
          </div>
        </form>
      </Modal>
    </div>
  );
}
