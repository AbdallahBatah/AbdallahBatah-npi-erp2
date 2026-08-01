'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { useValidate } from '@/lib/useValidate';
import { useDraft } from '@/lib/useDraft';
import { translateError } from '@/lib/errors';
import { useEnums, optionLabel } from '@/lib/useEnums';
import { formatMoney } from '@/lib/format';
import { PageHeader, StatusBadge, EmptyRow, Modal, Field, LoadError, Can, Btn, TableSkeleton } from '@/components/ui';
import { Icon } from '@/components/icons';

interface Vendor {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  vendorType: string;
  isManufacturer: boolean;
  _count?: { purchaseOrders: number };
}
interface Po {
  id: string;
  code: string;
  status: string;
  subtotal: string;
  vatAmount: string;
  total: string;
  vendor?: { code: string; nameAr: string; nameEn: string };
  project?: { id: string; code: string } | null;
}
interface Item { id: string; sku: string; nameAr: string; nameEn: string; unitCost: string; isSerialised: boolean }
interface Project { id: string; code: string; nameAr: string; nameEn: string }
interface PoLineDraft { itemId: string; qty: number; unitPrice: number }
interface StockRow {
  id: string;
  qty: string;
  item: { sku: string; nameAr: string; nameEn: string; uom: string };
  location: { code: string; nameAr: string; nameEn: string; locationType: string };
}
interface Loc { id: string; code: string; nameAr: string; nameEn: string; locationType: string }

export default function ProcurementPage() {
  const { t, locale, pick } = useI18n();
  const enums = useEnums();
  const [vendors, setVendors] = useState<Vendor[] | null>(null);
  const [pos, setPos] = useState<Po[] | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);

  const [vOpen, setVOpen] = useState(false);
  const [vNameAr, setVNameAr] = useState('');
  const [vNameEn, setVNameEn] = useState('');
  const [vType, setVType] = useState('SUPPLIER');
  const [vManufacturer, setVManufacturer] = useState(false);
  const [vVat, setVVat] = useState('');

  const [pOpen, setPOpen] = useState(false);
  const [pVendorId, setPVendorId] = useState('');
  const [pProjectId, setPProjectId] = useState('');
  const [pLines, setPLines] = useState<PoLineDraft[]>([]);
  const [stock, setStock] = useState<StockRow[] | null>(null);
  const [locations, setLocations] = useState<Loc[]>([]);
  const [tOpen, setTOpen] = useState(false);
  const [tItemId, setTItemId] = useState('');
  const [tFrom, setTFrom] = useState('');
  const [tTo, setTTo] = useState('');
  const [tQty, setTQty] = useState(1);
  const [loadErr, setLoadErr] = useState('');
  const { act, busy } = useAct();

  const load = useCallback(() => {
    setLoadErr('');
    Promise.all([
      api.get<Vendor[]>('/procurement/vendors'),
      api.get<Po[]>('/procurement/purchase-orders'),
      api.get<Item[]>('/items'),
      api.get<Project[]>('/projects'),
      api.get<StockRow[]>('/procurement/stock'),
      api.get<Loc[]>('/procurement/locations'),
    ])
      .then(([v, p, i, pr, st, lo]) => {
        setVendors(v);
        setPos(p);
        setItems(i);
        setProjects(pr);
        setStock(st);
        setLocations(lo);
      })
      .catch((e) => setLoadErr(translateError(e, locale)));
  }, [locale]);
  useEffect(load, [load]);

  // Opened from a dashboard quick action.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('new') === '1') { setPOpen(true); if (pLines.length === 0) addLine(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function transfer() {
    const ok = await act('transfer', () =>
      api.post('/procurement/transfers', {
        itemId: tItemId,
        qty: tQty,
        fromLocationId: tFrom,
        toLocationId: tTo,
      }),
    );
    if (ok) {
      setTOpen(false);
      load();
    }
  }

  async function createVendor() {
    if (!(vNameAr.trim() || vNameEn.trim())) return;
    const ok = await act(
      'vendor',
      () =>
        api.post('/procurement/vendors', {
          nameAr: vNameAr.trim() || vNameEn.trim(),
          nameEn: vNameEn.trim() || vNameAr.trim(),
          vendorType: vType,
          isManufacturer: vManufacturer,
          vatNumber: vVat || undefined,
        }),
      { success: t('common.created') },
    );
    if (ok) {
      setVOpen(false);
      setVNameAr(''); setVNameEn(''); setVVat(''); setVManufacturer(false); setVType('SUPPLIER');
      load();
    }
  }

  function addLine() {
    const first = items[0];
    if (!first) return;
    setPLines([...pLines, { itemId: first.id, qty: 1, unitPrice: Number(first.unitCost) }]);
  }
  function setLine(i: number, patch: Partial<PoLineDraft>) {
    setPLines(pLines.map((l, idx) => {
      if (idx !== i) return l;
      const next = { ...l, ...patch };
      // Picking a new item defaults the price to its catalogue cost.
      if (patch.itemId) {
        const it = items.find((x) => x.id === patch.itemId);
        if (it) next.unitPrice = Number(it.unitCost);
      }
      return next;
    }));
  }
  const poSubtotal = pLines.reduce((s, l) => s + l.qty * l.unitPrice, 0);

  const poValidation = useValidate(
    { pVendorId, pLines },
    {
      pVendorId: (v) => (!v.pVendorId ? t('valid.required') : undefined),
      pLines: (v) =>
        v.pLines.length === 0
          ? t('valid.needLine')
          : v.pLines.some((l) => !l.qty || l.qty <= 0)
            ? t('valid.qtyPositive')
            : v.pLines.some((l) => l.unitPrice < 0)
              ? t('valid.negative')
              : undefined,
    },
  );

  // A purchase order is typed line by line against a catalogue; a refresh
  // mid-entry used to lose all of it.
  const poDraft = useDraft(
    'po:new',
    { pVendorId, pProjectId, pLines },
    (saved) => {
      setPVendorId(saved.pVendorId);
      setPProjectId(saved.pProjectId);
      setPLines(saved.pLines);
    },
    { shouldSave: (v) => Boolean(v.pVendorId || v.pProjectId || v.pLines.length > 0) },
  );

  async function createPo() {
    // Was a silent `return` — the button simply did nothing and said nothing.
    if (!poValidation.validateAll()) return;
    const ok = await act(
      'po',
      () =>
        api.post('/procurement/purchase-orders', {
          vendorId: pVendorId,
          projectId: pProjectId || undefined,
          lines: pLines,
        }),
      { success: t('common.created') },
    );
    if (ok) {
      setPOpen(false);
      setPVendorId(''); setPProjectId(''); setPLines([]);
      poValidation.reset();
      poDraft.clear();
      load();
    }
  }

  return (
    <div>
      <PageHeader
        title={t('po.title')}
        action={
          <Can perm="scm.procurement.write">
            <div className="flex gap-2">
              <Btn icon="plus" onClick={() => setVOpen(true)}>{t('po.newVendor')}</Btn>
              <Btn variant="primary" icon="cart" onClick={() => { setPOpen(true); if (pLines.length === 0) addLine(); }}>
                {t('po.new')}
              </Btn>
            </div>
          </Can>
        }
      />
      {loadErr && <div className="mb-6"><LoadError message={loadErr} onRetry={load} /></div>}

      {/* Purchase orders */}
      <div className="card overflow-hidden">
        <div className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-800">
          {t('po.orders')}
        </div>
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="th">{t('common.code')}</th>
              <th className="th">{t('po.vendor')}</th>
              <th className="th">{t('po.project')}</th>
              <th className="th text-end">{t('po.subtotal')}</th>
              <th className="th text-end">{t('po.total')}</th>
              <th className="th">{t('common.status')}</th>
              <th className="th">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {!pos ? (
              <TableSkeleton cols={7} />
            ) : pos.length === 0 ? (
              <EmptyRow colSpan={7} text={t('common.none')} />
            ) : (
              pos.map((po) => (
                <tr key={po.id} className="hover:bg-slate-50">
                  <td className="td font-mono text-xs">{po.code}</td>
                  <td className="td">{po.vendor ? pick(po.vendor, 'name') : '—'}</td>
                  <td className="td font-mono text-xs">{po.project?.code ?? '—'}</td>
                  <td className="td text-end">{formatMoney(po.subtotal, locale)}</td>
                  <td className="td text-end">{formatMoney(po.total, locale)}</td>
                  <td className="td"><StatusBadge status={po.status} /></td>
                  <td className="td">
                    <Link href={`/procurement/${po.id}`} className="btn-ghost btn-sm">
                      {t('common.details')}
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Vendors */}
      <div className="card mt-6 overflow-hidden">
        <div className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-800">
          {t('po.vendors')}
        </div>
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="th">{t('common.code')}</th>
              <th className="th">{t('common.name')}</th>
              <th className="th">{t('po.vendorType')}</th>
              <th className="th text-center">{t('po.manufacturer')}</th>
              <th className="th text-center">{t('po.orders')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {!vendors ? (
              <TableSkeleton cols={5} />
            ) : vendors.length === 0 ? (
              <EmptyRow colSpan={5} text={t('common.none')} />
            ) : (
              vendors.map((v) => (
                <tr key={v.id} className="hover:bg-slate-50">
                  <td className="td font-mono text-xs">{v.code}</td>
                  <td className="td">{pick(v, 'name')}</td>
                  <td className="td">{optionLabel(enums?.vendorTypes, v.vendorType, locale)}</td>
                  <td className="td text-center">
                    {v.isManufacturer ? (
                      <Icon name="check" className="mx-auto h-4 w-4 text-success-600" />
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                  <td className="td text-center">{v._count?.purchaseOrders ?? 0}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* SCM-04: stock by location */}
      <div className="card mt-6 overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <h3 className="text-sm font-semibold text-slate-800">{t('stk.title')}</h3>
          <Can perm="scm.procurement.write">
            <Btn sm icon="refresh" onClick={() => setTOpen(true)}>
              {t('stk.transfer')}
            </Btn>
          </Can>
        </div>
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="th">{t('po.item')}</th>
              <th className="th">{t('stk.location')}</th>
              <th className="th text-end">{t('stk.qty')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {!stock ? (
              <TableSkeleton cols={3} />
            ) : stock.length === 0 ? (
              <EmptyRow colSpan={3} text={t('common.none')} />
            ) : (
              stock.map((s) => (
                <tr key={s.id}>
                  <td className="td">
                    <span className="font-mono text-xs text-slate-400">{s.item.sku}</span>{' '}
                    {pick(s.item, 'name')}
                  </td>
                  <td className="td">
                    <span className="font-mono text-xs text-slate-400">{s.location.code}</span>{' '}
                    {pick(s.location, 'name')}
                  </td>
                  <td className="td text-end font-medium">{Number(s.qty)} {s.item.uom}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Transfer modal */}
      <Modal open={tOpen} title={t('stk.transfer')} onClose={() => setTOpen(false)}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t('po.item')}>
            <select className="input" value={tItemId} onChange={(e) => setTItemId(e.target.value)}>
              <option value="">—</option>
              {items.filter((i) => !i.isSerialised).map((i) => (
                <option key={i.id} value={i.id}>{i.sku} · {pick(i, 'name')}</option>
              ))}
            </select>
          </Field>
          <Field label={t('stk.qty')}>
            <input type="number" min={0.001} className="input" value={tQty} onChange={(e) => setTQty(Number(e.target.value))} />
          </Field>
          <Field label={t('stk.from')}>
            <select className="input" value={tFrom} onChange={(e) => setTFrom(e.target.value)}>
              <option value="">—</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>{l.code} · {pick(l, 'name')}</option>
              ))}
            </select>
          </Field>
          <Field label={t('stk.to')}>
            <select className="input" value={tTo} onChange={(e) => setTTo(e.target.value)}>
              <option value="">—</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>{l.code} · {pick(l, 'name')}</option>
              ))}
            </select>
          </Field>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Btn sm onClick={() => setTOpen(false)}>{t('common.cancel')}</Btn>
          <Btn variant="primary" sm busy={busy('transfer')} disabled={busy() || !tItemId || !tFrom || !tTo || !tQty} onClick={transfer}>
            {t('stk.transfer')}
          </Btn>
        </div>
      </Modal>

      {/* New vendor modal */}
      <Modal open={vOpen} title={t('po.newVendor')} onClose={() => setVOpen(false)}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={`${t('common.name')} (ع)`}>
            <input className="input" value={vNameAr} onChange={(e) => setVNameAr(e.target.value)} />
          </Field>
          <Field label={`${t('common.name')} (EN — ${t('common.optional')})`}>
            <input className="input" dir="ltr" value={vNameEn} onChange={(e) => setVNameEn(e.target.value)} />
          </Field>
          <Field label={t('po.vendorType')}>
            <select className="input" value={vType} onChange={(e) => setVType(e.target.value)}>
              {(enums?.vendorTypes ?? []).map((o) => (
                <option key={o.value} value={o.value}>{locale === 'ar' ? o.labelAr : o.labelEn}</option>
              ))}
            </select>
          </Field>
          <Field label="الرقم الضريبي / VAT No.">
            <input className="input" value={vVat} onChange={(e) => setVVat(e.target.value)} />
          </Field>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={vManufacturer} onChange={(e) => setVManufacturer(e.target.checked)} />
            {t('po.manufacturer')}
          </label>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Btn sm onClick={() => setVOpen(false)}>{t('common.cancel')}</Btn>
          <Btn variant="primary" sm busy={busy('vendor')} disabled={busy() || !(vNameAr.trim() || vNameEn.trim())} onClick={createVendor}>
            {t('common.create')}
          </Btn>
        </div>
      </Modal>

      {/* New PO modal */}
      <Modal open={pOpen} title={t('po.new')} onClose={() => setPOpen(false)}>
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={t('po.vendor')} error={poValidation.errorOf('pVendorId')}>
              <select
                className="input"
                value={pVendorId}
                onChange={(e) => setPVendorId(e.target.value)}
                onBlur={() => poValidation.onBlur('pVendorId')}
              >
                <option value="">—</option>
                {(vendors ?? []).map((v) => (
                  <option key={v.id} value={v.id}>{v.code} · {pick(v, 'name')}</option>
                ))}
              </select>
            </Field>
            <Field label={t('po.project')}>
              <select className="input" value={pProjectId} onChange={(e) => setPProjectId(e.target.value)}>
                <option value="">—</option>
                {projects.map((pr) => (
                  <option key={pr.id} value={pr.id}>{pr.code} · {pick(pr, 'name')}</option>
                ))}
              </select>
            </Field>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="label !mb-0">{t('po.lines')}</span>
              <Btn sm icon="plus" onClick={addLine}>{t('po.addLine')}</Btn>
            </div>
            {poValidation.errorOf('pLines') && (
              <p role="alert" className="mb-2 text-[11px] font-medium text-danger-600">
                {poValidation.errorOf('pLines')}
              </p>
            )}
            <div className="space-y-2">
              {pLines.map((l, i) => (
                <div key={i} className="flex items-center gap-2">
                  <select className="input flex-1" value={l.itemId} onChange={(e) => setLine(i, { itemId: e.target.value })}>
                    {items.map((it) => (
                      <option key={it.id} value={it.id}>
                        {it.sku} · {pick(it, 'name')}{it.isSerialised ? ' · S/N' : ''}
                      </option>
                    ))}
                  </select>
                  <input type="number" min={1} className="input w-24" value={l.qty}
                    onChange={(e) => setLine(i, { qty: Number(e.target.value) })} placeholder={t('po.qty')} />
                  <input type="number" min={0} step="0.01" className="input w-32" value={l.unitPrice}
                    onChange={(e) => setLine(i, { unitPrice: Number(e.target.value) })} placeholder={t('po.unitPrice')} />
                  <button
                    type="button"
                    aria-label={t('common.close')}
                    className="rounded-md p-1.5 text-slate-400 transition hover:bg-danger-50 hover:text-danger-600"
                    onClick={() => setPLines(pLines.filter((_, idx) => idx !== i))}
                  >
                    <Icon name="x" className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-1 border-t border-slate-100 pt-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-slate-500">{t('po.subtotal')}</span>
              <span className="text-slate-700">{formatMoney(poSubtotal, locale)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-500">{t('po.vat')} (15%)</span>
              <span className="text-slate-700">{formatMoney(poSubtotal * 0.15, locale)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="font-medium text-slate-700">{t('po.total')}</span>
              <span className="font-bold text-brand-700">{formatMoney(poSubtotal * 1.15, locale)}</span>
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Btn sm onClick={() => setPOpen(false)}>{t('common.cancel')}</Btn>
            {/* Only disabled while in flight: a greyed-out button explains
                nothing, so let the click land and name what is missing. */}
            <Btn variant="primary" sm busy={busy('po')} disabled={busy()} onClick={createPo}>
              {t('common.create')}
            </Btn>
          </div>
        </div>
      </Modal>
    </div>
  );
}
