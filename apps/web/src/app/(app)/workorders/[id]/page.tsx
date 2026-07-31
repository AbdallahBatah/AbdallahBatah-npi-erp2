'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { useEnums, optionLabel } from '@/lib/useEnums';
import { formatMoney, formatDate } from '@/lib/format';
import { PageHeader, StatusBadge, EmptyRow, Modal, Field, LoadError, useConfirm, Tabs } from '@/components/ui';
import { AttachmentsCard } from '@/components/attachments';

interface Part {
  id: string;
  qty: string;
  unitCost: string;
  totalCost: string;
  item: { sku: string; nameAr: string; nameEn: string; uom: string };
}
interface Ts {
  id: string;
  workDate: string;
  hours: string;
  hourlyRate: string;
  amount: string;
  memo?: string | null;
  user: { nameAr: string; nameEn: string };
}
interface ChecklistItem {
  label: string;
  done: boolean;
  note?: string;
  labelAr?: string;
  labelEn?: string;
  mandatory?: boolean;
}
interface Wo {
  id: string;
  code: string;
  titleAr: string;
  titleEn: string;
  description?: string | null;
  woType: string;
  origin: string;
  priority: string;
  status: string;
  scheduledAt?: string | null;
  slaDueAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  closedAt?: string | null;
  checklistJson?: ChecklistItem[] | null;
  asset?: { id: string; code: string; nameAr: string; nameEn: string; assetType: string } | null;
  project?: { id: string; code: string } | null;
  assignedTo?: { id: string; nameAr: string; nameEn: string } | null;
  maintenancePlan?: { code: string; nameAr: string; nameEn: string } | null;
  parts: Part[];
  partsCost: number;
  timesheets: Ts[];
  labourCost: number;
}
interface Tech { id: string; nameAr: string; nameEn: string }
interface Item { id: string; sku: string; nameAr: string; nameEn: string; isSerialised: boolean }
interface Loc { id: string; code: string; nameAr: string; nameEn: string }

export default function WorkOrderDetailPage() {
  const { t, locale, pick } = useI18n();
  const enums = useEnums();
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [wo, setWo] = useState<Wo | null>(null);
  const [tab, setTab] = useState('parts');
  const [techs, setTechs] = useState<Tech[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [locations, setLocations] = useState<Loc[]>([]);
  const [loadErr, setLoadErr] = useState('');
  const { act, busy } = useAct();
  const { confirm, confirmNode } = useConfirm();

  const [assignee, setAssignee] = useState('');
  const [pOpen, setPOpen] = useState(false);
  const [pItemId, setPItemId] = useState('');
  const [pQty, setPQty] = useState(1);
  const [pLoc, setPLoc] = useState('');
  const [cOpen, setCOpen] = useState(false);
  const [checklist, setChecklist] = useState<ChecklistItem[]>([]);
  const [tHours, setTHours] = useState(1);
  const [tRate, setTRate] = useState(80);

  const load = useCallback(() => {
    setLoadErr('');
    const fail = (e: unknown) => setLoadErr(translateError(e, locale));
    api.get<Wo>(`/fsm/work-orders/${id}`).then(setWo).catch(fail);
    api.get<Tech[]>('/fsm/technicians').then(setTechs).catch(fail);
    api.get<Item[]>('/items').then(setItems).catch(fail);
    api.get<Loc[]>('/procurement/locations').then(setLocations).catch(fail);
  }, [id, locale]);
  useEffect(load, [load]);

  async function run(key: string, fn: () => Promise<unknown>) {
    const ok = await act(key, fn);
    if (ok) load();
    return ok;
  }

  async function closeWo() {
    if (
      !(await confirm({ title: t('confirm.closeWoTitle'), message: t('confirm.closeWoMsg'), danger: true }))
    )
      return;
    run('close', () => api.post(`/fsm/work-orders/${id}/close`, {}));
  }

  async function cancelWo() {
    if (
      !(await confirm({ title: t('confirm.cancelWoTitle'), message: t('confirm.cancelWoMsg'), danger: true }))
    )
      return;
    run('cancel', () => api.post(`/fsm/work-orders/${id}/cancel`, {}));
  }

  function openComplete() {
    // Start from the plan template if this WO came from one; else free-form.
    setChecklist(wo?.checklistJson ?? []);
    setCOpen(true);
  }

  if (loadErr && !wo) return <LoadError message={loadErr} onRetry={load} />;
  if (!wo) return <div className="text-slate-400">{t('common.loading')}</div>;

  return (
    <div>
      <PageHeader
        title={`${wo.code} — ${locale === 'ar' ? wo.titleAr : wo.titleEn}`}
        action={
          <div className="flex items-center gap-2">
            <StatusBadge status={wo.status} />
            {['OPEN', 'ASSIGNED'].includes(wo.status) && (
              <button className="btn-primary text-xs" onClick={() => run('start', () => api.post(`/fsm/work-orders/${id}/start`, {}))} disabled={busy()}>
                ▶️ {t('wo.start')}
              </button>
            )}
            {wo.status === 'IN_PROGRESS' && (
              <>
                <button className="btn-ghost text-xs" onClick={() => setPOpen(true)} disabled={busy()}>
                  ⚙️ {t('wo.addPart')}
                </button>
                <button className="btn-solar text-xs" onClick={openComplete} disabled={busy()}>
                  ✅ {t('wo.complete')}
                </button>
              </>
            )}
            {wo.status === 'COMPLETED' && (
              <button className="btn-primary text-xs" onClick={closeWo} disabled={busy()}>
                🔒 {t('wo.close')}
              </button>
            )}
            {!['CLOSED', 'CANCELLED'].includes(wo.status) && (
              <button className="btn-ghost text-xs !text-rose-600" onClick={cancelWo} disabled={busy()}>
                {t('wo.cancel')}
              </button>
            )}
            <Link href="/workorders" className="btn-ghost text-xs">{t('common.back')}</Link>
          </div>
        }
      />

      {confirmNode}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="card p-4">
          <p className="text-xs text-slate-500">{t('wo.type')} / {t('wo.origin')}</p>
          <p className="mt-1 text-sm font-medium">
            {optionLabel(enums?.woTypes, wo.woType, locale)} · {optionLabel(enums?.woOrigins, wo.origin, locale)}
          </p>
          {wo.maintenancePlan && (
            <p className="mt-1 text-xs text-slate-400">{wo.maintenancePlan.code} — {pick(wo.maintenancePlan, 'name')}</p>
          )}
        </div>
        <div className="card p-4">
          <p className="text-xs text-slate-500">{t('wo.asset')}</p>
          <p className="mt-1 text-sm font-medium">{wo.asset ? `${wo.asset.code} · ${pick(wo.asset, 'name')}` : '—'}</p>
          {wo.project && <p className="mt-1 text-xs text-slate-400">{wo.project.code}</p>}
        </div>
        <div className="card p-4">
          <p className="text-xs text-slate-500">{t('wo.assignee')}</p>
          {wo.assignedTo ? (
            <p className="mt-1 text-sm font-medium">{pick(wo.assignedTo, 'name')}</p>
          ) : ['OPEN', 'ASSIGNED'].includes(wo.status) ? (
            <div className="mt-1 flex items-center gap-1">
              <select className="input !py-1 text-xs" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                <option value="">—</option>
                {techs.map((x) => (
                  <option key={x.id} value={x.id}>{pick(x, 'name')}</option>
                ))}
              </select>
              <button
                className="btn-primary !px-2 !py-1 text-xs"
                disabled={busy() || !assignee}
                onClick={() => run('assign', () => api.post(`/fsm/work-orders/${id}/assign`, { assignedToId: assignee }))}
              >
                {t('wo.assign')}
              </button>
            </div>
          ) : (
            <p className="mt-1 text-sm text-slate-400">—</p>
          )}
        </div>
        <div className="card p-4">
          <p className="text-xs text-slate-500">{t('wo.slaDue')}</p>
          <p className={`mt-1 text-sm font-medium ${wo.slaDueAt && new Date(wo.slaDueAt) < new Date() && !['CLOSED', 'COMPLETED', 'CANCELLED'].includes(wo.status) ? 'text-rose-600' : ''}`}>
            {wo.slaDueAt ? formatDate(wo.slaDueAt, locale) : '—'}
          </p>
          <p className="mt-1 text-xs text-slate-400">
            {wo.startedAt ? `▶ ${formatDate(wo.startedAt, locale)}` : ''}{wo.closedAt ? ` · 🔒 ${formatDate(wo.closedAt, locale)}` : ''}
          </p>
        </div>
      </div>

      {/* The four identity cards above stay pinned; the working sections are
          tabbed so a technician sees one job at a time. */}
      <div className="mt-6">
        <Tabs
          tabs={[
            { key: 'parts', label: t('wo.parts'), count: wo.parts?.length },
            { key: 'labour', label: t('time.title'), count: wo.timesheets?.length },
            { key: 'checklist', label: t('wo.checklist'), count: wo.checklistJson?.length },
            { key: 'files', label: t('att.title') },
          ]}
          value={tab}
          onChange={setTab}
        />
      </div>

      {tab === 'parts' && (
      <div className="grid grid-cols-1 gap-6">
        {/* Parts */}
        <div className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
            <h3 className="text-sm font-semibold text-slate-800">{t('wo.parts')}</h3>
            <span className="text-xs text-slate-500">
              {t('wo.partsCost')}: <b className="text-brand-700">{formatMoney(wo.partsCost, locale)}</b>
            </span>
          </div>
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="th">{t('po.item')}</th>
                <th className="th text-end">{t('po.qty')}</th>
                <th className="th text-end">{t('items.unitCost')}</th>
                <th className="th text-end">{t('common.total')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {wo.parts.length === 0 ? (
                <EmptyRow colSpan={4} text={t('common.none')} />
              ) : (
                wo.parts.map((p) => (
                  <tr key={p.id}>
                    <td className="td">
                      <span className="font-mono text-xs text-slate-400">{p.item.sku}</span>{' '}
                      {pick(p.item, 'name')}
                    </td>
                    <td className="td text-end">{Number(p.qty)} {p.item.uom}</td>
                    <td className="td text-end">{formatMoney(p.unitCost, locale)}</td>
                    <td className="td text-end">{formatMoney(p.totalCost, locale)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
      )}

      {tab === 'labour' && (
      <div className="grid grid-cols-1 gap-6">
        {/* FSM-07: labour hours */}
        <div className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
            <h3 className="text-sm font-semibold text-slate-800">{t('time.title')}</h3>
            <span className="text-xs text-slate-500">
              {t('time.labourCost')}: <b className="text-brand-700">{formatMoney(wo.labourCost, locale)}</b>
            </span>
          </div>
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="th">{t('time.tech')}</th>
                <th className="th text-end">{t('time.hours')}</th>
                <th className="th text-end">{t('time.rate')}</th>
                <th className="th text-end">{t('common.total')}</th>
                <th className="th">{t('common.date')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {wo.timesheets.length === 0 ? (
                <EmptyRow colSpan={5} text={t('common.none')} />
              ) : (
                wo.timesheets.map((ts) => (
                  <tr key={ts.id}>
                    <td className="td text-xs">{pick(ts.user, 'name')}</td>
                    <td className="td text-end">{Number(ts.hours)}</td>
                    <td className="td text-end">{formatMoney(ts.hourlyRate, locale)}</td>
                    <td className="td text-end font-medium">{formatMoney(ts.amount, locale)}</td>
                    <td className="td text-xs text-slate-500">{formatDate(ts.workDate, locale)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          {['IN_PROGRESS', 'COMPLETED'].includes(wo.status) && (
            <div className="flex items-center gap-2 border-t border-slate-100 px-5 py-3">
              <input
                type="number" min={0.25} step={0.25}
                className="input !w-24"
                value={tHours}
                onChange={(e) => setTHours(Number(e.target.value))}
                placeholder={t('time.hours')}
              />
              <input
                type="number" min={0} step={5}
                className="input !w-28"
                value={tRate}
                onChange={(e) => setTRate(Number(e.target.value))}
                placeholder={t('time.rate')}
              />
              <button
                className="btn-ghost !px-3 !py-1.5 text-xs"
                disabled={busy() || !tHours}
                onClick={() => run('time', () => api.post(`/fsm/work-orders/${id}/time`, { hours: tHours, hourlyRate: tRate }))}
              >
                ⏱️ {t('time.add')}
              </button>
            </div>
          )}
        </div>

      </div>
      )}

      {tab === 'checklist' && (
      <div className="grid grid-cols-1 gap-6">
        {/* Checklist */}
        <div className="card overflow-hidden">
          <div className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-800">
            {t('wo.checklist')}
          </div>
          {wo.checklistJson && wo.checklistJson.length > 0 ? (
            <ul className="divide-y divide-slate-100">
              {wo.checklistJson.map((c, i) => (
                <li key={i} className="flex items-center justify-between px-5 py-2 text-sm">
                  <span className={c.done ? 'text-slate-500 line-through' : 'text-slate-700'}>
                    {c.done ? '✅' : '⬜'}{' '}
                    {locale === 'ar' ? c.labelAr ?? c.label : c.labelEn ?? c.label}
                    {c.mandatory && (
                      <span className="ms-2 rounded bg-rose-50 px-1.5 py-0.5 text-[10px] font-semibold text-rose-600">
                        {locale === 'ar' ? 'إلزامي' : 'Required'}
                      </span>
                    )}
                  </span>
                  {c.note && <span className="text-xs text-slate-400">{c.note}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-5 py-8 text-center text-sm text-slate-400">{t('common.none')}</p>
          )}
        </div>
      </div>
      )}

      {tab === 'files' && <AttachmentsCard entityType="WORK_ORDER" entityId={id} />}

      {/* Add part modal */}
      <Modal open={pOpen} title={t('wo.addPart')} onClose={() => setPOpen(false)}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label={t('po.item')}>
            <select className="input" value={pItemId} onChange={(e) => setPItemId(e.target.value)}>
              <option value="">—</option>
              {items.filter((i) => !i.isSerialised).map((i) => (
                <option key={i.id} value={i.id}>{i.sku} · {pick(i, 'name')}</option>
              ))}
            </select>
          </Field>
          <Field label={t('po.qty')}>
            <input type="number" min={0.001} className="input" value={pQty} onChange={(e) => setPQty(Number(e.target.value))} />
          </Field>
          <Field label={t('stk.from')}>
            <select className="input" value={pLoc} onChange={(e) => setPLoc(e.target.value)}>
              <option value="">—</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>{l.code} · {pick(l, 'name')}</option>
              ))}
            </select>
          </Field>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-ghost text-xs" onClick={() => setPOpen(false)}>{t('common.cancel')}</button>
          <button
            className="btn-primary text-xs"
            disabled={busy() || !pItemId || !pLoc || !pQty}
            onClick={async () => {
              const ok = await run('part', () =>
                api.post(`/fsm/work-orders/${id}/parts`, { itemId: pItemId, qty: pQty, fromLocationId: pLoc }),
              );
              if (ok) {
                setPOpen(false);
                setPItemId(''); setPQty(1); setPLoc('');
              }
            }}
          >
            {busy('part') ? t('common.loading') : t('wo.addPart')}
          </button>
        </div>
      </Modal>

      {/* Complete modal (checklist) */}
      <Modal open={cOpen} title={t('wo.complete')} onClose={() => setCOpen(false)}>
        <p className="mb-3 text-xs text-slate-400">{t('wo.checklistHint')}</p>
        <div className="space-y-2">
          {checklist.map((c, i) => (
            <label key={i} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={c.done}
                onChange={(e) => setChecklist(checklist.map((x, xi) => (xi === i ? { ...x, done: e.target.checked } : x)))}
              />
              {locale === 'ar' ? c.labelAr ?? c.label : c.labelEn ?? c.label}
              {c.mandatory && (
                <span className="rounded bg-rose-50 px-1.5 py-0.5 text-[10px] font-semibold text-rose-600">
                  {locale === 'ar' ? 'إلزامي' : 'Required'}
                </span>
              )}
            </label>
          ))}
          <div className="flex items-center gap-2">
            <input
              className="input flex-1 text-xs"
              placeholder={t('wo.checklist')}
              id="new-check-item"
              onKeyDown={(e) => {
                const target = e.target as HTMLInputElement;
                if (e.key === 'Enter' && target.value.trim()) {
                  setChecklist([...checklist, { label: target.value.trim(), done: true }]);
                  target.value = '';
                }
              }}
            />
            <span className="text-xs text-slate-400">↵</span>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-ghost text-xs" onClick={() => setCOpen(false)}>{t('common.cancel')}</button>
          <button
            className="btn-solar text-xs"
            disabled={busy()}
            onClick={async () => {
              const ok = await run('complete', () =>
                api.post(`/fsm/work-orders/${id}/complete`, { checklist }),
              );
              if (ok) setCOpen(false);
            }}
          >
            {busy('complete') ? t('common.loading') : t('wo.complete')}
          </button>
        </div>
      </Modal>
    </div>
  );
}
