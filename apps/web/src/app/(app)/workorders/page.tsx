'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { useToast } from '@/components/toast';
import { useEnums, optionLabel } from '@/lib/useEnums';
import { formatDate } from '@/lib/format';
import { PageHeader, StatusBadge, EmptyRow, Modal, Field, LoadError, useConfirm, Can } from '@/components/ui';

interface Summary { open: number; inProgress: number; overdue: number; closedThisMonth: number }
interface Wo {
  id: string;
  code: string;
  titleAr: string;
  titleEn: string;
  woType: string;
  priority: string;
  status: string;
  slaDueAt?: string | null;
  scheduledAt?: string | null;
  asset?: { code: string; nameAr: string; nameEn: string } | null;
  assignedTo?: { nameAr: string; nameEn: string } | null;
  _count?: { parts: number };
}
interface Asset {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  assetType: string;
  status: string;
  parent?: { code: string } | null;
  project?: { code: string } | null;
  serialUnit?: { serialNo: string } | null;
  _count?: { workOrders: number };
}
interface Tech { id: string; nameAr: string; nameEn: string }
interface Plan {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  intervalDays: number;
  nextDueAt: string;
  isActive: boolean;
  asset?: { code: string; nameAr: string; nameEn: string } | null;
  _count?: { workOrders: number };
}

const PRIORITY_STYLE: Record<string, string> = {
  LOW: 'bg-slate-100 text-slate-600',
  MEDIUM: 'bg-brand-100 text-brand-800',
  HIGH: 'bg-amber-100 text-amber-800',
  CRITICAL: 'bg-rose-100 text-rose-700',
};

export default function WorkOrdersPage() {
  const { t, locale, pick } = useI18n();
  const enums = useEnums();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [rows, setRows] = useState<Wo[] | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [techs, setTechs] = useState<Tech[]>([]);
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const { act, busy } = useAct();
  const { confirm, confirmNode } = useConfirm();
  const toast = useToast();

  // Create WO modal
  const [wOpen, setWOpen] = useState(false);
  const [wTitleAr, setWTitleAr] = useState('');
  const [wTitleEn, setWTitleEn] = useState('');
  const [wType, setWType] = useState('CORRECTIVE');
  const [wPriority, setWPriority] = useState('MEDIUM');
  const [wAssetId, setWAssetId] = useState('');
  const [wAssignee, setWAssignee] = useState('');

  // Create plan modal
  const [mOpen, setMOpen] = useState(false);
  const [mNameAr, setMNameAr] = useState('');
  const [mNameEn, setMNameEn] = useState('');
  const [mAssetId, setMAssetId] = useState('');
  const [mInterval, setMInterval] = useState(90);
  const [mChecklist, setMChecklist] = useState('');

  const load = useCallback(() => {
    setLoadErr('');
    const fail = (e: unknown) => setLoadErr(translateError(e, locale));
    api.get<Summary>('/fsm/work-orders/summary').then(setSummary).catch(fail);
    api.get<Wo[]>('/fsm/work-orders').then(setRows).catch(fail);
    api.get<Asset[]>('/fsm/assets').then(setAssets).catch(fail);
    api.get<Tech[]>('/fsm/technicians').then(setTechs).catch(fail);
    api.get<Plan[]>('/fsm/plans').then(setPlans).catch(fail);
  }, [locale]);
  useEffect(load, [load]);

  async function createWo() {
    const ok = await act(
      'wo',
      () =>
        api.post('/fsm/work-orders', {
          titleAr: wTitleAr.trim() || wTitleEn.trim(),
          titleEn: wTitleEn.trim() || wTitleAr.trim(),
          woType: wType,
          priority: wPriority,
          assetId: wAssetId || undefined,
          assignedToId: wAssignee || undefined,
        }),
      { success: t('common.created') },
    );
    if (ok) {
      setWOpen(false);
      setWTitleAr(''); setWTitleEn(''); setWAssetId(''); setWAssignee('');
      load();
    }
  }

  async function createPlan() {
    const checklist = mChecklist
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => ({
        labelAr: l.replace(/\*$/, '').trim(),
        labelEn: l.replace(/\*$/, '').trim(),
        mandatory: l.endsWith('*'),
      }));
    const ok = await act(
      'plan',
      () =>
        api.post('/fsm/plans', {
          nameAr: mNameAr.trim() || mNameEn.trim(),
          nameEn: mNameEn.trim() || mNameAr.trim(),
          assetId: mAssetId || undefined,
          intervalDays: mInterval,
          checklist: checklist.length ? checklist : undefined,
        }),
      { success: t('common.created') },
    );
    if (ok) {
      setMOpen(false);
      setMNameAr(''); setMNameEn(''); setMAssetId(''); setMChecklist('');
      load();
    }
  }

  async function generateDue() {
    if (
      !(await confirm({ title: t('confirm.generateDueTitle'), message: t('confirm.generateDueMsg') }))
    )
      return;
    let generated = 0;
    const ok = await act(
      'generate',
      async () => {
        const res = await api.post<{ count?: number; generated?: unknown[] }>('/fsm/plans/generate-due', {});
        generated = res?.count ?? (Array.isArray(res?.generated) ? res.generated.length : 0);
      },
      { success: false },
    );
    if (ok) {
      toast.success(generated > 0 ? `${t('wo.generatedN')}: ${generated}` : t('wo.noneDue'));
      load();
    }
  }

  const cards = [
    { key: 'wo.summary.open', v: summary?.open, tone: 'text-brand-700' },
    { key: 'wo.summary.inProgress', v: summary?.inProgress, tone: 'text-amber-600' },
    { key: 'wo.summary.overdue', v: summary?.overdue, tone: 'text-rose-600' },
    { key: 'wo.summary.closed', v: summary?.closedThisMonth, tone: 'text-emerald-600' },
  ];

  return (
    <div>
      <PageHeader
        title={t('wo.title')}
        action={
          <Can perm="fsm.workorder.write">
            <button className="btn-primary text-xs" onClick={() => setWOpen(true)}>
              🔧 {t('wo.new')}
            </button>
          </Can>
        }
      />
      {loadErr && <div className="mb-6"><LoadError message={loadErr} onRetry={load} /></div>}
      {confirmNode}

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {cards.map((c) => (
          <div key={c.key} className="card p-4">
            <p className="text-xs text-slate-500">{t(c.key)}</p>
            <p className={`mt-1 text-xl font-bold ${c.tone}`}>{c.v ?? '—'}</p>
          </div>
        ))}
      </div>

      {/* Work orders table */}
      <div className="card overflow-hidden">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="th">{t('common.code')}</th>
              <th className="th">{t('wo.titleField')}</th>
              <th className="th">{t('wo.type')}</th>
              <th className="th">{t('wo.priority')}</th>
              <th className="th">{t('wo.asset')}</th>
              <th className="th">{t('wo.assignee')}</th>
              <th className="th">{t('common.status')}</th>
              <th className="th">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {!rows ? (
              <EmptyRow colSpan={8} text={t('common.loading')} />
            ) : rows.length === 0 ? (
              <EmptyRow colSpan={8} text={t('common.none')} />
            ) : (
              rows.map((w) => (
                <tr key={w.id} className="hover:bg-slate-50">
                  <td className="td font-mono text-xs">{w.code}</td>
                  <td className="td">{locale === 'ar' ? w.titleAr : w.titleEn}</td>
                  <td className="td">{optionLabel(enums?.woTypes, w.woType, locale)}</td>
                  <td className="td">
                    <span className={`badge ${PRIORITY_STYLE[w.priority] ?? ''}`}>
                      {optionLabel(enums?.woPriorities, w.priority, locale)}
                    </span>
                  </td>
                  <td className="td text-xs">{w.asset ? `${w.asset.code}` : '—'}</td>
                  <td className="td text-xs">{w.assignedTo ? pick(w.assignedTo, 'name') : '—'}</td>
                  <td className="td"><StatusBadge status={w.status} /></td>
                  <td className="td">
                    <Link href={`/workorders/${w.id}`} className="btn-ghost !px-3 !py-1 text-xs">
                      {t('common.details')}
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Maintenance plans */}
        <div className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
            <h3 className="text-sm font-semibold text-slate-800">{t('mp.title')}</h3>
            <Can perm="fsm.workorder.write">
              <div className="flex gap-2">
                <button className="btn-ghost !px-3 !py-1 text-xs" onClick={() => setMOpen(true)}>➕ {t('mp.new')}</button>
                <button className="btn-solar !px-3 !py-1 text-xs" onClick={generateDue} disabled={busy()}>
                  ⚙️ {t('mp.generate')}
                </button>
              </div>
            </Can>
          </div>
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="th">{t('common.code')}</th>
                <th className="th">{t('common.name')}</th>
                <th className="th">{t('wo.asset')}</th>
                <th className="th text-center">{t('mp.interval')}</th>
                <th className="th">{t('mp.nextDue')}</th>
                <th className="th text-center">{t('mp.generated')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {!plans ? (
                <EmptyRow colSpan={6} text={t('common.loading')} />
              ) : plans.length === 0 ? (
                <EmptyRow colSpan={6} text={t('common.none')} />
              ) : (
                plans.map((p) => (
                  <tr key={p.id}>
                    <td className="td font-mono text-xs">{p.code}</td>
                    <td className="td">{pick(p, 'name')}</td>
                    <td className="td text-xs">{p.asset?.code ?? '—'}</td>
                    <td className="td text-center">{p.intervalDays}</td>
                    <td className="td text-xs">{formatDate(p.nextDueAt, locale)}</td>
                    <td className="td text-center">{p._count?.workOrders ?? 0}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Asset register */}
        <div className="card overflow-hidden">
          <div className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-800">
            {t('astr.title')}
          </div>
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="th">{t('common.code')}</th>
                <th className="th">{t('common.name')}</th>
                <th className="th">{t('astr.type')}</th>
                <th className="th">{t('common.status')}</th>
                <th className="th text-center">{t('astr.workorders')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {assets.length === 0 ? (
                <EmptyRow colSpan={5} text={t('common.none')} />
              ) : (
                assets.map((a) => (
                  <tr key={a.id}>
                    <td className="td font-mono text-xs">
                      {a.parent ? <span className="text-slate-300">└ </span> : ''}{a.code}
                    </td>
                    <td className="td">{pick(a, 'name')}</td>
                    <td className="td">{optionLabel(enums?.assetTypes, a.assetType, locale)}</td>
                    <td className="td"><StatusBadge status={a.status} /></td>
                    <td className="td text-center">{a._count?.workOrders ?? 0}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* New WO modal */}
      <Modal open={wOpen} title={t('wo.new')} onClose={() => setWOpen(false)}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={`${t('wo.titleField')} (ع)`}>
            <input className="input" value={wTitleAr} onChange={(e) => setWTitleAr(e.target.value)} />
          </Field>
          <Field label={`${t('wo.titleField')} (EN — ${t('common.optional')})`}>
            <input className="input" dir="ltr" value={wTitleEn} onChange={(e) => setWTitleEn(e.target.value)} />
          </Field>
          <Field label={t('wo.type')}>
            <select className="input" value={wType} onChange={(e) => setWType(e.target.value)}>
              {(enums?.woTypes ?? []).map((o) => (
                <option key={o.value} value={o.value}>{locale === 'ar' ? o.labelAr : o.labelEn}</option>
              ))}
            </select>
          </Field>
          <Field label={t('wo.priority')}>
            <select className="input" value={wPriority} onChange={(e) => setWPriority(e.target.value)}>
              {(enums?.woPriorities ?? []).map((o) => (
                <option key={o.value} value={o.value}>{locale === 'ar' ? o.labelAr : o.labelEn}</option>
              ))}
            </select>
          </Field>
          <Field label={t('wo.asset')}>
            <select className="input" value={wAssetId} onChange={(e) => setWAssetId(e.target.value)}>
              <option value="">—</option>
              {assets.filter((a) => a.assetType !== 'PLANT').map((a) => (
                <option key={a.id} value={a.id}>{a.code} · {pick(a, 'name')}</option>
              ))}
            </select>
          </Field>
          <Field label={t('wo.assignee')}>
            <select className="input" value={wAssignee} onChange={(e) => setWAssignee(e.target.value)}>
              <option value="">—</option>
              {techs.map((x) => (
                <option key={x.id} value={x.id}>{pick(x, 'name')}</option>
              ))}
            </select>
          </Field>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-ghost text-xs" onClick={() => setWOpen(false)}>{t('common.cancel')}</button>
          <button className="btn-primary text-xs" onClick={createWo} disabled={busy() || !(wTitleAr.trim() || wTitleEn.trim())}>
            {busy('wo') ? t('common.loading') : t('common.create')}
          </button>
        </div>
      </Modal>

      {/* New plan modal */}
      <Modal open={mOpen} title={t('mp.new')} onClose={() => setMOpen(false)}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={`${t('common.name')} (ع)`}>
            <input className="input" value={mNameAr} onChange={(e) => setMNameAr(e.target.value)} />
          </Field>
          <Field label={`${t('common.name')} (EN — ${t('common.optional')})`}>
            <input className="input" dir="ltr" value={mNameEn} onChange={(e) => setMNameEn(e.target.value)} />
          </Field>
          <Field label={t('wo.asset')}>
            <select className="input" value={mAssetId} onChange={(e) => setMAssetId(e.target.value)}>
              <option value="">—</option>
              {assets.map((a) => (
                <option key={a.id} value={a.id}>{a.code} · {pick(a, 'name')}</option>
              ))}
            </select>
          </Field>
          <Field label={t('mp.interval')}>
            <input type="number" min={1} className="input" value={mInterval} onChange={(e) => setMInterval(Number(e.target.value))} />
          </Field>
        </div>
        <div className="mt-4">
          <Field label={t('mp.checklistItems')}>
            <textarea
              className="input min-h-[90px] text-xs"
              value={mChecklist}
              onChange={(e) => setMChecklist(e.target.value)}
              placeholder={'فحص التوصيلات *\nتنظيف الألواح\nقياس الجهد *'}
            />
          </Field>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-ghost text-xs" onClick={() => setMOpen(false)}>{t('common.cancel')}</button>
          <button className="btn-primary text-xs" onClick={createPlan} disabled={busy() || !(mNameAr.trim() || mNameEn.trim()) || !mInterval}>
            {busy('plan') ? t('common.loading') : t('common.create')}
          </button>
        </div>
      </Modal>
    </div>
  );
}
