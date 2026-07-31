'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { formatDate } from '@/lib/format';
import { PageHeader, StatusBadge, EmptyRow, Modal, Field, LoadError, useConfirm } from '@/components/ui';

interface Serial {
  id: string;
  serialNo: string;
  batchNo?: string | null;
  currentState: string;
  installedAt?: string | null;
  item?: { sku: string; nameAr: string; nameEn: string };
  project?: { code: string } | null;
  goodsReceipt?: { code: string } | null;
  manufacturerVendor?: { nameAr: string; nameEn: string } | null;
  location?: { id: string; code: string; nameAr: string; nameEn: string } | null;
}
interface Loc { id: string; code: string; nameAr: string; nameEn: string }
interface Claim {
  id: string;
  code: string;
  status: string;
  defectAr: string;
  defectEn: string;
  serialUnit: { id: string; serialNo: string; item: { id: string; sku: string; nameAr: string; nameEn: string } };
  replacementSerialUnit?: { serialNo: string } | null;
  manufacturerVendor?: { nameAr: string; nameEn: string } | null;
  workOrder?: { id: string; code: string } | null;
}

export default function AssetsPage() {
  const { t, locale, pick } = useI18n();
  const [rows, setRows] = useState<Serial[] | null>(null);
  const [claims, setClaims] = useState<Claim[] | null>(null);
  const [locations, setLocations] = useState<Loc[]>([]);
  const [moveId, setMoveId] = useState<string | null>(null);
  const [moveTo, setMoveTo] = useState('');
  const [loadErr, setLoadErr] = useState('');
  const { act: runAct, busy } = useAct();
  const { confirm, confirmNode } = useConfirm();
  // RMA modal
  const [cOpen, setCOpen] = useState(false);
  const [cSerial, setCSerial] = useState<Serial | null>(null);
  const [cDefAr, setCDefAr] = useState('');
  const [cDefEn, setCDefEn] = useState('');
  // Replacement pick per claim
  const [replPick, setReplPick] = useState<Record<string, string>>({});

  const PAGE = 50;
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [stockUnits, setStockUnits] = useState<Serial[]>([]);

  const load = useCallback(() => {
    setLoadErr('');
    const fail = (e: unknown) => setLoadErr(translateError(e, locale));
    const qs = new URLSearchParams({ take: String(PAGE), skip: String(page * PAGE) });
    if (search.trim()) qs.set('search', search.trim());
    if (stateFilter) qs.set('state', stateFilter);
    api
      .get<{ rows: Serial[]; total: number }>(`/procurement/serial-units?${qs}`)
      .then((d) => {
        setRows(d.rows);
        setTotal(d.total);
      })
      .catch(fail);
    // Replacement pickers need ALL in-stock units regardless of the table page.
    api.get<Serial[]>('/procurement/serial-units?state=IN_STOCK').then(setStockUnits).catch(() => {});
    api.get<Loc[]>('/procurement/locations').then(setLocations).catch(fail);
    api.get<Claim[]>('/fsm/warranty-claims').then(setClaims).catch(fail);
  }, [locale, page, search, stateFilter]);
  useEffect(() => {
    const h = setTimeout(load, search ? 350 : 0);
    return () => clearTimeout(h);
  }, [load, search]);

  async function act(key: string, fn: () => Promise<unknown>) {
    const ok = await runAct(key, fn);
    if (ok) load();
    return ok;
  }

  function replacementOptions(claim: Claim) {
    return stockUnits.filter((s) => s.item?.sku === claim.serialUnit.item.sku);
  }

  async function install(id: string) {
    if (!(await confirm({ title: t('confirm.installTitle'), message: t('confirm.installMsg') })))
      return;
    act(`install:${id}`, () => api.post(`/procurement/serial-units/${id}/install`, {}));
  }

  async function transfer(serialUnitId: string) {
    if (!moveTo) return;
    const ok = await act(`move:${serialUnitId}`, () =>
      api.post('/procurement/transfers', { serialUnitId, toLocationId: moveTo }),
    );
    if (ok) {
      setMoveId(null);
      setMoveTo('');
    }
  }

  async function replaceSerial(claimId: string) {
    if (
      !(await confirm({ title: t('confirm.replaceTitle'), message: t('confirm.replaceMsg'), danger: true }))
    )
      return;
    act(`replace:${claimId}`, () =>
      api.post(`/fsm/warranty-claims/${claimId}/replace`, {
        replacementSerialUnitId: replPick[claimId],
      }),
    );
  }

  return (
    <div>
      <PageHeader title={t('ast.title')} />
      {loadErr && <div className="mb-6"><LoadError message={loadErr} onRetry={load} /></div>}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          className="input max-w-xs"
          placeholder={t('ast.searchHint')}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
        />
        <select
          className="input !w-44"
          value={stateFilter}
          onChange={(e) => {
            setStateFilter(e.target.value);
            setPage(0);
          }}
        >
          <option value="">{t('common.status')}: {locale === 'ar' ? 'الكل' : 'All'}</option>
          {['IN_STOCK', 'INSTALLED', 'FAULTY', 'RETURNED', 'SCRAPPED'].map((s) => (
            <option key={s} value={s}>{s === 'IN_STOCK' ? (locale === 'ar' ? 'في المخزون' : 'In stock') : s === 'INSTALLED' ? (locale === 'ar' ? 'مركَّب' : 'Installed') : s === 'FAULTY' ? (locale === 'ar' ? 'معطّل' : 'Faulty') : s === 'RETURNED' ? (locale === 'ar' ? 'مرتجع' : 'Returned') : locale === 'ar' ? 'مُتلَف' : 'Scrapped'}</option>
          ))}
        </select>
      </div>
      <div className="card table-sticky">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="th">{t('ast.serial')}</th>
              <th className="th">{t('ast.item')}</th>
              <th className="th">{t('ast.state')}</th>
              <th className="th">{t('ast.location')}</th>
              <th className="th">{t('ast.project')}</th>
              <th className="th">{t('ast.grn')}</th>
              <th className="th">{t('ast.manufacturer')}</th>
              <th className="th">{t('ast.installedAt')}</th>
              <th className="th">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {!rows ? (
              <EmptyRow colSpan={9} text={t('common.loading')} />
            ) : rows.length === 0 ? (
              <EmptyRow colSpan={9} text={t('common.none')} />
            ) : (
              rows.map((s) => (
                <tr key={s.id} className="hover:bg-slate-50">
                  <td className="td font-mono text-xs">{s.serialNo}</td>
                  <td className="td">
                    <span className="font-mono text-xs text-slate-400">{s.item?.sku}</span>{' '}
                    {s.item ? pick(s.item, 'name') : '—'}
                  </td>
                  <td className="td"><StatusBadge status={s.currentState} /></td>
                  <td className="td text-xs">
                    {s.location ? (
                      <><span className="font-mono text-slate-400">{s.location.code}</span> {pick(s.location, 'name')}</>
                    ) : '—'}
                  </td>
                  <td className="td font-mono text-xs">{s.project?.code ?? '—'}</td>
                  <td className="td font-mono text-xs">{s.goodsReceipt?.code ?? '—'}</td>
                  <td className="td text-xs">{s.manufacturerVendor ? pick(s.manufacturerVendor, 'name') : '—'}</td>
                  <td className="td text-xs text-slate-500">
                    {s.installedAt ? formatDate(s.installedAt, locale) : '—'}
                  </td>
                  <td className="td">
                    {s.currentState === 'INSTALLED' && (
                      <button
                        className="btn-danger !px-3 !py-1 text-xs"
                        onClick={() => { setCSerial(s); setCDefAr(''); setCDefEn(''); setCOpen(true); }}
                      >
                        ⚠️ {t('rma.fault')}
                      </button>
                    )}
                    {s.currentState === 'IN_STOCK' && (
                      moveId === s.id ? (
                        <span className="flex items-center gap-1">
                          <select className="input !w-36 !py-1 text-xs" value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
                            <option value="">{t('ast.transferTo')}…</option>
                            {locations.filter((l) => l.id !== s.location?.id).map((l) => (
                              <option key={l.id} value={l.id}>{l.code}</option>
                            ))}
                          </select>
                          <button className="btn-primary !px-2 !py-1 text-xs" disabled={busy() || !moveTo} onClick={() => transfer(s.id)}>✓</button>
                          <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => { setMoveId(null); setMoveTo(''); }}>✕</button>
                        </span>
                      ) : (
                        <span className="flex items-center gap-1">
                          <button
                            className="btn-solar !px-3 !py-1 text-xs"
                            disabled={busy()}
                            onClick={() => install(s.id)}
                          >
                            🔧 {t('ast.install')}
                          </button>
                          <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => setMoveId(s.id)}>
                            🔄 {t('ast.transfer')}
                          </button>
                        </span>
                      )
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        {total > PAGE && (
          <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2.5 text-xs text-slate-500">
            <span>
              {page * PAGE + 1}–{Math.min((page + 1) * PAGE, total)} {t('common.of')} {total}
            </span>
            <span className="flex gap-1">
              <button className="btn-ghost !px-2.5 !py-1" disabled={page === 0} onClick={() => setPage(page - 1)}>
                {t('common.prev')}
              </button>
              <button
                className="btn-ghost !px-2.5 !py-1"
                disabled={(page + 1) * PAGE >= total}
                onClick={() => setPage(page + 1)}
              >
                {t('common.next')}
              </button>
            </span>
          </div>
        )}
      </div>

      {/* FSM-09: warranty claims */}
      <div className="card mt-6 overflow-hidden">
        <div className="border-b border-slate-100 px-5 py-3.5">
          <h3 className="text-sm font-bold text-slate-800">{t('rma.title')}</h3>
          <p className="mt-1 text-xs text-slate-400">{t('rma.hint')}</p>
        </div>
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="th">{t('common.code')}</th>
              <th className="th">{t('rma.serial')}</th>
              <th className="th">{t('rma.defect')}</th>
              <th className="th">{t('rma.manufacturer')}</th>
              <th className="th">{t('rma.replacement')}</th>
              <th className="th">{t('common.status')}</th>
              <th className="th">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {!claims ? (
              <EmptyRow colSpan={7} text={t('common.loading')} />
            ) : claims.length === 0 ? (
              <EmptyRow colSpan={7} text={t('common.none')} />
            ) : (
              claims.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50">
                  <td className="td font-mono text-xs">
                    {c.code}
                    {c.workOrder && (
                      <Link href={`/workorders/${c.workOrder.id}`} className="ms-2 text-brand-700 hover:underline">
                        {c.workOrder.code}
                      </Link>
                    )}
                  </td>
                  <td className="td font-mono text-xs">{c.serialUnit.serialNo}</td>
                  <td className="td max-w-[220px] truncate text-xs text-slate-500" title={locale === 'ar' ? c.defectAr : c.defectEn}>
                    {locale === 'ar' ? c.defectAr : c.defectEn}
                  </td>
                  <td className="td text-xs">{c.manufacturerVendor ? pick(c.manufacturerVendor, 'name') : '—'}</td>
                  <td className="td font-mono text-xs">{c.replacementSerialUnit?.serialNo ?? '—'}</td>
                  <td className="td"><StatusBadge status={c.status} /></td>
                  <td className="td">
                    {c.status === 'DRAFT' && (
                      <button className="btn-primary !px-3 !py-1 text-xs" disabled={busy()} onClick={() => act(`submit:${c.id}`, () => api.post(`/fsm/warranty-claims/${c.id}/submit`, {}))}>
                        📤 {t('rma.submit')}
                      </button>
                    )}
                    {c.status === 'SUBMITTED' && (
                      <span className="flex gap-1">
                        <button className="btn-primary !px-2.5 !py-1 text-xs" disabled={busy()} onClick={() => act(`approve:${c.id}`, () => api.post(`/fsm/warranty-claims/${c.id}/approve`, {}))}>
                          ✓ {t('rma.approve')}
                        </button>
                        <button className="btn-danger !px-2.5 !py-1 text-xs" disabled={busy()} onClick={() => act(`reject:${c.id}`, () => api.post(`/fsm/warranty-claims/${c.id}/reject`, {}))}>
                          ✕ {t('rma.reject')}
                        </button>
                      </span>
                    )}
                    {c.status === 'APPROVED' && (
                      <span className="flex items-center gap-1">
                        <select
                          className="input !w-40 !py-1 text-xs"
                          value={replPick[c.id] ?? ''}
                          onChange={(e) => setReplPick({ ...replPick, [c.id]: e.target.value })}
                        >
                          <option value="">{t('rma.selectReplacement')}</option>
                          {replacementOptions(c).map((s) => (
                            <option key={s.id} value={s.id}>{s.serialNo}</option>
                          ))}
                        </select>
                        <button
                          className="btn-solar !px-2.5 !py-1 text-xs"
                          disabled={busy() || !replPick[c.id]}
                          onClick={() => replaceSerial(c.id)}
                        >
                          🔁 {t('rma.replace')}
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* New claim modal */}
      <Modal open={cOpen} title={`${t('rma.new')} — ${cSerial?.serialNo ?? ''}`} onClose={() => setCOpen(false)}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={`${t('rma.defect')} (ع)`}>
            <input className="input" value={cDefAr} onChange={(e) => setCDefAr(e.target.value)} />
          </Field>
          <Field label={`${t('rma.defect')} (EN — ${t('common.optional')})`}>
            <input className="input" dir="ltr" value={cDefEn} onChange={(e) => setCDefEn(e.target.value)} />
          </Field>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-ghost text-xs" onClick={() => setCOpen(false)}>{t('common.cancel')}</button>
          <button
            className="btn-danger text-xs"
            disabled={busy() || !(cDefAr.trim() || cDefEn.trim()) || !cSerial}
            onClick={async () => {
              const ok = await act('claim', () =>
                api.post('/fsm/warranty-claims', {
                  serialUnitId: cSerial!.id,
                  defectAr: cDefAr.trim() || cDefEn.trim(),
                  defectEn: cDefEn.trim() || cDefAr.trim(),
                }),
              );
              if (ok) setCOpen(false);
            }}
          >
            {busy('claim') ? t('common.loading') : t('common.create')}
          </button>
        </div>
      </Modal>
      {confirmNode}
    </div>
  );
}
