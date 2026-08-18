'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { formatDate } from '@/lib/format';
import { PageHeader, StatusBadge, statusLabel, EmptyRow, Modal, Field, LoadError, useConfirm, Can, Btn, TableSkeleton } from '@/components/ui';

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
          type="search"
          className="input max-w-xs"
          aria-label={t('ast.searchHint')}
          placeholder={t('ast.searchHint')}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
        />
        <select
          className="input !w-44"
          aria-label={t('common.status')}
          value={stateFilter}
          onChange={(e) => {
            setStateFilter(e.target.value);
            setPage(0);
          }}
        >
          <option value="">
            {t('common.status')}: {t('common.all')}
          </option>
          {['IN_STOCK', 'INSTALLED', 'FAULTY', 'RETURNED', 'SCRAPPED'].map((s) => (
            <option key={s} value={s}>
              {statusLabel(s, locale)}
            </option>
          ))}
        </select>
      </div>
      <div className="card table-sticky">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th scope="col" className="th">{t('ast.serial')}</th>
              <th scope="col" className="th">{t('ast.item')}</th>
              <th scope="col" className="th">{t('ast.state')}</th>
              <th scope="col" className="th hidden xl:table-cell">{t('ast.location')}</th>
              <th scope="col" className="th hidden xl:table-cell">{t('ast.project')}</th>
              <th scope="col" className="th hidden xl:table-cell">{t('ast.grn')}</th>
              <th scope="col" className="th hidden xl:table-cell">{t('ast.manufacturer')}</th>
              <th scope="col" className="th hidden xl:table-cell">{t('ast.installedAt')}</th>
              <th scope="col" className="th">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {!rows ? (
              <TableSkeleton cols={9} />
            ) : rows.length === 0 ? (
              <EmptyRow colSpan={9} text={t('common.none')} />
            ) : (
              rows.map((s) => (
                <tr key={s.id} className="hover:bg-slate-50">
                  <td className="td font-mono text-xs">{s.serialNo}</td>
                  <td className="td">
                    <span className="font-mono text-xs text-slate-500">{s.item?.sku}</span>{' '}
                    {s.item ? pick(s.item, 'name') : '—'}
                    {/* The folded location, re-surfaced where the eye already is. */}
                    <span className="mt-0.5 block text-xs text-slate-500 xl:hidden">
                      {s.location ? `${s.location.code} · ${pick(s.location, 'name')}` : '—'}
                    </span>
                  </td>
                  <td className="td"><StatusBadge status={s.currentState} /></td>
                  <td className="td hidden text-xs xl:table-cell">
                    {s.location ? (
                      <><span className="font-mono text-slate-500">{s.location.code}</span> {pick(s.location, 'name')}</>
                    ) : '—'}
                  </td>
                  <td className="td hidden font-mono text-xs xl:table-cell">{s.project?.code ?? '—'}</td>
                  <td className="td hidden font-mono text-xs xl:table-cell">{s.goodsReceipt?.code ?? '—'}</td>
                  <td className="td hidden text-xs xl:table-cell">{s.manufacturerVendor ? pick(s.manufacturerVendor, 'name') : '—'}</td>
                  <td className="td hidden text-xs text-slate-500 xl:table-cell">
                    {s.installedAt ? formatDate(s.installedAt, locale) : '—'}
                  </td>
                  <td className="td">
                    {s.currentState === 'INSTALLED' && (
                      <Can perm="fsm.workorder.write">
                        <Btn
                          variant="danger"
                          sm
                          icon="alert-triangle"
                          onClick={() => { setCSerial(s); setCDefAr(''); setCDefEn(''); setCOpen(true); }}
                        >
                          {t('rma.fault')}
                        </Btn>
                      </Can>
                    )}
                    {s.currentState === 'IN_STOCK' && (
                      <Can perm="scm.procurement.write">
                      {moveId === s.id ? (
                        <span className="flex items-center gap-1">
                          <select className="input !w-36 !py-1 text-xs" value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
                            <option value="">{t('ast.transferTo')}…</option>
                            {locations.filter((l) => l.id !== s.location?.id).map((l) => (
                              <option key={l.id} value={l.id}>{l.code}</option>
                            ))}
                          </select>
                          <Btn variant="primary" sm icon="check" aria-label={t('ast.transfer')} className="!px-2" busy={busy(`move:${s.id}`)} disabled={busy() || !moveTo} onClick={() => transfer(s.id)} />
                          <Btn sm icon="x" aria-label={t('common.cancel')} className="!px-2" onClick={() => { setMoveId(null); setMoveTo(''); }} />
                        </span>
                      ) : (
                        <span className="flex items-center gap-1">
                          <Btn
                            variant="solar"
                            sm
                            icon="wrench"
                            busy={busy(`install:${s.id}`)}
                            disabled={busy()}
                            onClick={() => install(s.id)}
                          >
                            {t('ast.install')}
                          </Btn>
                          <Btn sm icon="refresh" onClick={() => setMoveId(s.id)}>
                            {t('ast.transfer')}
                          </Btn>
                        </span>
                      )}
                      </Can>
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
              <Btn sm disabled={page === 0} onClick={() => setPage(page - 1)}>
                {t('common.prev')}
              </Btn>
              <Btn sm disabled={(page + 1) * PAGE >= total} onClick={() => setPage(page + 1)}>
                {t('common.next')}
              </Btn>
            </span>
          </div>
        )}
      </div>

      {/* FSM-09: warranty claims */}
      <div className="card mt-6 overflow-hidden">
        <div className="card-title">
          <h3 className="text-sm font-bold text-slate-800">{t('rma.title')}</h3>
          <p className="mt-1 text-xs text-slate-500">{t('rma.hint')}</p>
        </div>
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th scope="col" className="th">{t('common.code')}</th>
              <th scope="col" className="th">{t('rma.serial')}</th>
              <th scope="col" className="th">{t('rma.defect')}</th>
              <th scope="col" className="th">{t('rma.manufacturer')}</th>
              <th scope="col" className="th">{t('rma.replacement')}</th>
              <th scope="col" className="th">{t('common.status')}</th>
              <th scope="col" className="th">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {!claims ? (
              <TableSkeleton cols={7} />
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
                      <Btn variant="primary" sm icon="upload" busy={busy(`submit:${c.id}`)} disabled={busy()} onClick={() => act(`submit:${c.id}`, () => api.post(`/fsm/warranty-claims/${c.id}/submit`, {}))}>
                        {t('rma.submit')}
                      </Btn>
                    )}
                    {c.status === 'SUBMITTED' && (
                      <span className="flex gap-1">
                        <Btn variant="primary" sm icon="check" busy={busy(`approve:${c.id}`)} disabled={busy()} onClick={() => act(`approve:${c.id}`, () => api.post(`/fsm/warranty-claims/${c.id}/approve`, {}))}>
                          {t('rma.approve')}
                        </Btn>
                        <Btn variant="danger" sm icon="x" busy={busy(`reject:${c.id}`)} disabled={busy()} onClick={() => act(`reject:${c.id}`, () => api.post(`/fsm/warranty-claims/${c.id}/reject`, {}))}>
                          {t('rma.reject')}
                        </Btn>
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
                        <Btn
                          variant="solar"
                          sm
                          icon="refresh"
                          busy={busy(`replace:${c.id}`)}
                          disabled={busy() || !replPick[c.id]}
                          onClick={() => replaceSerial(c.id)}
                        >
                          {t('rma.replace')}
                        </Btn>
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
          <Btn
            variant="danger"
            sm
            busy={busy('claim')}
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
            {t('common.create')}
          </Btn>
        </div>
      </Modal>
      {confirmNode}
    </div>
  );
}
