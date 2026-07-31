'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { useToast } from '@/components/toast';
import { formatMoney, formatDate } from '@/lib/format';
import { PageHeader, StatusBadge, EmptyRow, Modal, Field, LoadError, useConfirm, Can } from '@/components/ui';

interface PoLine {
  id: string;
  qty: string;
  unitPrice: string;
  lineTotal: string;
  receivedQty: string;
  item: { sku: string; nameAr: string; nameEn: string; isSerialised: boolean; uom: string };
  wbsElement?: { code: string; nameAr: string; nameEn: string } | null;
}
interface Receipt {
  id: string;
  code: string;
  receivedAt: string;
  serialUnits: { id: string }[];
  vendorBills: { id: string; code: string; status: string }[];
}
interface Po {
  id: string;
  code: string;
  status: string;
  subtotal: string;
  vatAmount: string;
  total: string;
  vendor: { code: string; nameAr: string; nameEn: string };
  project?: { id: string; code: string; nameAr: string; nameEn: string } | null;
  lines: PoLine[];
  goodsReceipts: Receipt[];
}

interface ReceiveDraft { qty: number; serials: string }

export default function PoDetailPage() {
  const { t, locale, pick } = useI18n();
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [po, setPo] = useState<Po | null>(null);
  const [rOpen, setROpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, ReceiveDraft>>({});
  const [locations, setLocations] = useState<{ id: string; code: string; nameAr: string; nameEn: string }[]>([]);
  const [rLoc, setRLoc] = useState('');
  const [loadErr, setLoadErr] = useState('');
  const { act, busy } = useAct();
  const { confirm, confirmNode } = useConfirm();
  const toast = useToast();

  const load = useCallback(() => {
    setLoadErr('');
    api
      .get<Po>(`/procurement/purchase-orders/${id}`)
      .then(setPo)
      .catch((e) => setLoadErr(translateError(e, locale)));
    api.get('/procurement/locations').then(setLocations).catch(() => {});
  }, [id, locale]);
  useEffect(load, [load]);

  async function approve() {
    if (
      !(await confirm({ title: t('confirm.approvePoTitle'), message: t('confirm.approvePoMsg') }))
    )
      return;
    if (await act('approve', () => api.post(`/procurement/purchase-orders/${id}/approve`, {})))
      load();
  }

  function openReceive() {
    if (!po) return;
    const d: Record<string, ReceiveDraft> = {};
    for (const l of po.lines) {
      const remaining = Number(l.qty) - Number(l.receivedQty);
      if (remaining > 0) d[l.id] = { qty: remaining, serials: '' };
    }
    setDraft(d);
    setROpen(true);
  }

  async function receive() {
    if (!po) return;
    const lines = Object.entries(draft)
      .filter(([, v]) => v.qty > 0)
      .map(([poLineId, v]) => ({
        poLineId,
        qty: v.qty,
        serials: v.serials
          ? v.serials.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)
          : undefined,
      }));
    if (!lines.length) {
      toast.error(
        locale === 'ar'
          ? 'أدخل كمية مستلمة واحدة على الأقل'
          : 'Enter at least one received quantity',
      );
      return;
    }
    const ok = await act('receive', () =>
      api.post(`/procurement/purchase-orders/${id}/receive`, {
        lines,
        locationId: rLoc || undefined,
      }),
    );
    if (ok) {
      setROpen(false);
      load();
    }
  }

  async function bill(grnId: string) {
    if (
      !(await confirm({ title: t('confirm.postBillTitle'), message: t('confirm.postBillMsg'), danger: true }))
    )
      return;
    if (await act(`bill:${grnId}`, () => api.post('/procurement/bills', { goodsReceiptId: grnId })))
      load();
  }

  if (loadErr && !po) return <LoadError message={loadErr} onRetry={load} />;
  if (!po) return <div className="text-slate-400">{t('common.loading')}</div>;
  const receivable = ['APPROVED', 'PARTIALLY_RECEIVED'].includes(po.status);

  return (
    <div>
      <PageHeader
        title={`${po.code} — ${pick(po.vendor, 'name')}`}
        action={
          <div className="flex items-center gap-2">
            <StatusBadge status={po.status} />
            <Can perm="scm.procurement.write">
              {po.status === 'DRAFT' && (
                <button className="btn-primary text-xs" onClick={approve} disabled={busy()}>
                  ✅ {t('po.approve')}
                </button>
              )}
              {receivable && (
                <button className="btn-solar text-xs" onClick={openReceive} disabled={busy()}>
                  📦 {t('po.receive')}
                </button>
              )}
            </Can>
            <Link href="/procurement" className="btn-ghost text-xs">{t('common.back')}</Link>
          </div>
        }
      />
      {confirmNode}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <div className="card p-4">
          <p className="text-xs text-slate-500">{t('po.project')}</p>
          <p className="mt-1 font-medium">
            {po.project ? (
              <Link href={`/projects/${po.project.id}`} className="text-brand-700 hover:underline">
                {po.project.code}
              </Link>
            ) : '—'}
          </p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-slate-500">{t('po.subtotal')}</p>
          <p className="mt-1 font-medium">{formatMoney(po.subtotal, locale)}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-slate-500">{t('po.vat')}</p>
          <p className="mt-1 font-medium text-amber-600">{formatMoney(po.vatAmount, locale)}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-slate-500">{t('po.total')}</p>
          <p className="mt-1 font-bold text-brand-700">{formatMoney(po.total, locale)}</p>
        </div>
      </div>

      {/* Lines */}
      <div className="card mt-6 overflow-hidden">
        <div className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-800">
          {t('po.lines')}
        </div>
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="th">{t('po.item')}</th>
              <th className="th">{t('po.wbs')}</th>
              <th className="th text-end">{t('po.qty')}</th>
              <th className="th text-end">{t('po.received')}</th>
              <th className="th text-end">{t('po.unitPrice')}</th>
              <th className="th text-end">{t('common.total')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {po.lines.map((l) => (
              <tr key={l.id}>
                <td className="td">
                  <span className="font-mono text-xs text-slate-400">{l.item.sku}</span>{' '}
                  {pick(l.item, 'name')}{l.item.isSerialised ? ' 🔢' : ''}
                </td>
                <td className="td text-xs">{l.wbsElement ? `${l.wbsElement.code}` : '—'}</td>
                <td className="td text-end">{Number(l.qty)}</td>
                <td className="td text-end">
                  <span className={Number(l.receivedQty) >= Number(l.qty) ? 'text-emerald-600' : ''}>
                    {Number(l.receivedQty)}
                  </span>
                </td>
                <td className="td text-end">{formatMoney(l.unitPrice, locale)}</td>
                <td className="td text-end">{formatMoney(l.lineTotal, locale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Receipts */}
      <div className="card mt-6 overflow-hidden">
        <div className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-800">
          {t('po.receipts')}
        </div>
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="th">{t('common.code')}</th>
              <th className="th">{t('common.date')}</th>
              <th className="th text-center">{t('prj.serials')}</th>
              <th className="th">{t('po.bill')}</th>
              <th className="th">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {po.goodsReceipts.length === 0 ? (
              <EmptyRow colSpan={5} text={t('common.none')} />
            ) : (
              po.goodsReceipts.map((g) => (
                <tr key={g.id}>
                  <td className="td font-mono text-xs">{g.code}</td>
                  <td className="td text-xs text-slate-500">{formatDate(g.receivedAt, locale)}</td>
                  <td className="td text-center">{g.serialUnits.length}</td>
                  <td className="td">
                    {g.vendorBills.length > 0 ? (
                      <span className="badge bg-emerald-100 text-emerald-700">
                        {g.vendorBills[0].code}
                      </span>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </td>
                  <td className="td">
                    {g.vendorBills.length === 0 && (
                      <Can perm="scm.procurement.write">
                        <button className="btn-primary !px-3 !py-1 text-xs" onClick={() => bill(g.id)} disabled={busy()}>
                          🧾 {t('po.createBill')}
                        </button>
                      </Can>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Receive modal */}
      <Modal
        open={rOpen}
        title={t('po.receiveTitle')}
        onClose={() => setROpen(false)}
        dirty={Object.values(draft).some((d) => d.serials.trim().length > 0)}
      >
        <div className="space-y-4">
          <Field label={t('po.receiveLocation')}>
            <select className="input max-w-xs" value={rLoc} onChange={(e) => setRLoc(e.target.value)}>
              <option value="">{locations[0] ? `${locations[0].code} · ${pick(locations[0], 'name')}` : '—'}</option>
              {locations.slice(1).map((lo) => (
                <option key={lo.id} value={lo.id}>{lo.code} · {pick(lo, 'name')}</option>
              ))}
            </select>
          </Field>
          {po.lines
            .filter((l) => Number(l.qty) - Number(l.receivedQty) > 0)
            .map((l) => (
              <div key={l.id} className="rounded-lg border border-slate-200 p-3">
                <p className="mb-2 text-sm font-medium">
                  <span className="font-mono text-xs text-slate-400">{l.item.sku}</span>{' '}
                  {pick(l.item, 'name')}{l.item.isSerialised ? ' 🔢' : ''}
                  <span className="ms-2 text-xs text-slate-400">
                    {t('po.received')}: {Number(l.receivedQty)} / {Number(l.qty)}
                  </span>
                </p>
                <div className="flex items-start gap-3">
                  <Field label={t('po.qtyToReceive')}>
                    <input
                      type="number"
                      min={0}
                      max={Number(l.qty) - Number(l.receivedQty)}
                      className="input w-28"
                      value={draft[l.id]?.qty ?? 0}
                      onChange={(e) =>
                        setDraft({ ...draft, [l.id]: { ...(draft[l.id] ?? { serials: '' }), qty: Number(e.target.value) } })
                      }
                    />
                  </Field>
                  {l.item.isSerialised && (
                    <div className="flex-1">
                      <Field label={t('po.serialsHint')}>
                        <textarea
                          className="input min-h-[70px] font-mono text-xs"
                          value={draft[l.id]?.serials ?? ''}
                          onChange={(e) =>
                            setDraft({ ...draft, [l.id]: { ...(draft[l.id] ?? { qty: 0 }), serials: e.target.value } })
                          }
                          placeholder="SN-0001, SN-0002, …"
                        />
                      </Field>
                      {(() => {
                        const list = (draft[l.id]?.serials ?? '')
                          .split(/[\n,]+/)
                          .map((s) => s.trim())
                          .filter(Boolean);
                        const need = draft[l.id]?.qty ?? 0;
                        const dups = list.filter((s, i) => list.indexOf(s) !== i);
                        return (
                          <p className="mt-1 text-xs">
                            <span className={list.length === need ? 'text-emerald-600' : 'text-amber-600'}>
                              {t('po.serialCount')}: {list.length} / {need}
                            </span>
                            {dups.length > 0 && (
                              <span className="ms-3 text-rose-600">
                                {t('po.dupSerial')}: {Array.from(new Set(dups)).join('، ')}
                              </span>
                            )}
                          </p>
                        );
                      })()}
                    </div>
                  )}
                </div>
              </div>
            ))}
          <div className="flex justify-end gap-2">
            <button className="btn-ghost text-xs" onClick={() => setROpen(false)}>{t('common.cancel')}</button>
            <button
              className="btn-primary text-xs"
              onClick={receive}
              disabled={busy() || !Object.values(draft).some((d) => d.qty > 0)}
            >
              {busy('receive') ? t('common.loading') : t('po.receive')}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
