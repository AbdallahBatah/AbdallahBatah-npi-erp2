'use client';

/**
 * P4-7 — «استلام مواد بدون أمر شراء» (owner work cycle step 15). The keeper
 * books what arrived; stock rises at once; finance is told to record the bill.
 */
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { useLookup } from '@/lib/lookups';
import { PageHeader, EmptyRow, LoadError, Modal, Field, Can, Btn, TableSkeleton } from '@/components/ui';
import { Icon } from '@/components/icons';

interface Named { id: string; code: string; nameAr: string; nameEn: string }
interface ItemRef { id: string; sku: string; nameAr: string; nameEn: string; uom: string; isSerialised?: boolean }
interface Row {
  id: string;
  code: string;
  receivedAt: string;
  deliveryNoteRef: string | null;
  vendor: { code: string; nameAr: string; nameEn: string };
  location: { code: string; nameAr: string; nameEn: string };
  lines: Array<{ id: string; qty: string; item: { sku: string; nameAr: string; nameEn: string; uom: string } }>;
}
interface Draft { itemId: string; qty: string; unitCost: string }

export default function DirectReceiptsPage() {
  const { t, locale, pick } = useI18n();
  const { act, busy } = useAct();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<Draft[]>([{ itemId: '', qty: '', unitCost: '' }]);
  const vendors = useLookup<Named>('vendors', { enabled: open });
  const locations = useLookup<Named>('locations', { enabled: open });
  const items = useLookup<ItemRef>('items', { enabled: open });

  const load = useCallback(() => {
    setLoading(true);
    api
      .get<Row[]>('/procurement/direct-receipts')
      .then(setRows)
      .catch((e) => setErr(translateError(e, locale)))
      .finally(() => setLoading(false));
  }, [locale]);
  useEffect(load, [load]);

  const setLine = (i: number, patch: Partial<Draft>) => setLines((p) => p.map((l, x) => (x === i ? { ...l, ...patch } : l)));

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const used = lines.filter((l) => l.itemId && Number(l.qty) > 0);
    if (used.length === 0) return;
    const ok = await act('create', () =>
      api.post('/procurement/direct-receipts', {
        vendorId: String(f.get('vendorId') || ''),
        locationId: String(f.get('locationId') || ''),
        deliveryNoteRef: String(f.get('deliveryNoteRef') || '').trim() || undefined,
        notes: String(f.get('notes') || '').trim() || undefined,
        lines: used.map((l) => ({ itemId: l.itemId, qty: Number(l.qty), unitCost: l.unitCost ? Number(l.unitCost) : undefined })),
      }),
    );
    if (ok) {
      setOpen(false);
      setLines([{ itemId: '', qty: '', unitCost: '' }]);
      load();
    }
  }

  return (
    <div>
      <PageHeader
        title={t('drn.title')}
        subtitle={t('drn.hint')}
        backHref="/procurement"
        backLabel={t('po.title')}
        action={
          <Can perm="scm.procurement.write">
            <Btn variant="primary" icon="plus" onClick={() => setOpen(true)}>
              {t('drn.new')}
            </Btn>
          </Can>
        }
      />
      {err && <LoadError message={err} onRetry={load} />}
      <div className="card table-sticky">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th scope="col" className="th">{t('common.code')}</th>
              <th scope="col" className="th">{t('pr.vendor')}</th>
              <th scope="col" className="th">{t('drn.location')}</th>
              <th scope="col" className="th">{t('mr.lines')}</th>
              <th scope="col" className="th">{t('common.date')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <TableSkeleton cols={5} />
            ) : rows.length === 0 ? (
              <EmptyRow colSpan={5} text={t('common.none')} />
            ) : (
              rows.map((r) => (
                <tr key={r.id}>
                  <td className="td font-mono text-xs">
                    {r.code}
                    {r.deliveryNoteRef && <span className="block text-slate-400">{r.deliveryNoteRef}</span>}
                  </td>
                  <td className="td">{pick(r.vendor, 'name')}</td>
                  <td className="td font-mono text-xs">{r.location.code}</td>
                  <td className="td text-xs">
                    {r.lines.map((l) => (
                      <div key={l.id}>
                        {l.item.sku} · {Number(l.qty)} {l.item.uom}
                      </div>
                    ))}
                  </td>
                  <td className="td text-xs">{formatDateTime(r.receivedAt, locale)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Modal open={open} title={t('drn.new')} onClose={() => setOpen(false)}>
        <form onSubmit={create} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label={t('pr.vendor')}>
              <select name="vendorId" className="input" required disabled={vendors.state !== 'ready'}>
                <option value="">—</option>
                {vendors.rows.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.code} · {pick(v, 'name')}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('drn.location')}>
              <select name="locationId" className="input" required disabled={locations.state !== 'ready'}>
                <option value="">—</option>
                {locations.rows.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.code} · {pick(l, 'name')}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={`${t('drn.deliveryNote')} (${t('common.optional')})`}>
              <input name="deliveryNoteRef" className="input" maxLength={80} />
            </Field>
          </div>
          <div className="space-y-2">
            {lines.map((l, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <select aria-label={t('proposals.item')} className="input min-w-[12rem] flex-1" value={l.itemId} onChange={(e) => setLine(i, { itemId: e.target.value })} disabled={items.state !== 'ready'}>
                  <option value="">—</option>
                  {items.rows
                    .filter((it) => !it.isSerialised)
                    .map((it) => (
                      <option key={it.id} value={it.id}>
                        {it.sku} · {pick(it, 'name')}
                      </option>
                    ))}
                </select>
                <input type="number" min={0} step="0.001" aria-label={t('proposals.qty')} placeholder={t('proposals.qty')} className="input w-28" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} />
                <input type="number" min={0} step="0.01" aria-label={t('drn.unitCost')} placeholder={t('drn.unitCost')} className="input w-32" value={l.unitCost} onChange={(e) => setLine(i, { unitCost: e.target.value })} />
                <button type="button" aria-label={t('proposals.removeLine')} className="rounded-md p-1.5 text-slate-500 hover:bg-danger-50" onClick={() => setLines((p) => (p.length > 1 ? p.filter((_, x) => x !== i) : p))}>
                  <Icon name="x" className="h-4 w-4" />
                </button>
              </div>
            ))}
            <button type="button" className="btn-ghost text-xs" onClick={() => setLines((p) => [...p, { itemId: '', qty: '', unitCost: '' }])}>
              + {t('proposals.addLine')}
            </button>
          </div>
          <Field label={`${t('leads.notes')} (${t('common.optional')})`}>
            <textarea name="notes" className="input" rows={2} maxLength={1000} />
          </Field>
          <p className="text-xs text-slate-500">{t('drn.serialHint')}</p>
          <div className="flex justify-end gap-2">
            <Btn onClick={() => setOpen(false)}>{t('common.cancel')}</Btn>
            <Btn type="submit" variant="primary" busy={busy('create')} disabled={busy()}>
              {t('drn.receive')}
            </Btn>
          </div>
        </form>
      </Modal>
    </div>
  );
}
