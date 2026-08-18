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
import { PageHeader, StatusBadge, EmptyRow, Modal, Field, LoadError, useConfirm, Tabs, Can, Btn, PageSkeleton } from '@/components/ui';
import { AttachmentsCard } from '@/components/attachments';
import { ApprovalChain, type ApprovalRequestView } from '@/components/approvals';
import { useToast } from '@/components/toast';
import { PROJECT_STAGE_FLOW as STAGE_FLOW } from '@npi/shared';

interface Wbs {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  budgetAmount: string;
  committed: number;
  actual: number;
  variance: number;
}
interface Po {
  id: string;
  code: string;
  status: string;
  subtotal: string;
  total: string;
  vendor?: { nameAr: string; nameEn: string };
}
interface CostEntry {
  id: string;
  costType: string;
  sourceType: string;
  amount: string;
  memo?: string | null;
  postedAt: string;
}
interface Serial {
  id: string;
  serialNo: string;
  currentState: string;
  item?: { sku: string; nameAr: string; nameEn: string };
}
interface ChangeOrder {
  id: string;
  code: string;
  descriptionAr: string;
  descriptionEn: string;
  amountDelta: string;
  scheduleImpactDays: number;
  status: string;
  /** Set while the change order is sitting in the approval matrix (package و). */
  pendingApproval: ApprovalRequestView | null;
}
interface Claim {
  id: string;
  code: string;
  sequence: number;
  claimedAmount: string;
  vatAmount: string;
  retentionWithheld: string;
  netPayable: string;
  status: string;
  pendingApproval: ApprovalRequestView | null;
}
interface Subcontract {
  id: string;
  code: string;
  scopeAr: string;
  scopeEn: string;
  amount: string;
  retentionPct: string;
  status: string;
  vendor?: { nameAr: string; nameEn: string };
  claims: Claim[];
}
interface Project {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  stage: string;
  capacityKwp?: string | null;
  contract?: { id: string; code: string; totalValue: string; customer?: { nameAr: string; nameEn: string } };
  wbsElements: Wbs[];
  purchaseOrders: Po[];
  costEntries: CostEntry[];
  serialUnits: Serial[];
  changeOrders: ChangeOrder[];
  subcontracts: Subcontract[];
  costSummary: { budget: number; committed: number; actual: number; variance: number };
}

// Order comes from the shared package — the API enforces the same sequence.

export default function ProjectDetailPage() {
  const { t, locale, pick } = useI18n();
  const enums = useEnums();
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [p, setP] = useState<Project | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [tab, setTab] = useState('wbs');
  const { act, busy } = useAct();
  const { confirm, confirmNode } = useConfirm();
  const toast = useToast();
  // Change order modal
  const [coOpen, setCoOpen] = useState(false);
  const [coDescAr, setCoDescAr] = useState('');
  const [coDescEn, setCoDescEn] = useState('');
  const [coDelta, setCoDelta] = useState(0);
  const [coDays, setCoDays] = useState(0);
  const [coWbs, setCoWbs] = useState('');
  // Subcontract modal
  const [subOpen, setSubOpen] = useState(false);
  const [subVendorId, setSubVendorId] = useState('');
  const [subScopeAr, setSubScopeAr] = useState('');
  const [subScopeEn, setSubScopeEn] = useState('');
  const [subAmount, setSubAmount] = useState(0);
  const [subRet, setSubRet] = useState(10);
  const [subWbs, setSubWbs] = useState('');
  const [vendors, setVendors] = useState<{ id: string; code: string; nameAr: string; nameEn: string }[]>([]);
  // Claim inline input per agreement
  const [claimAmounts, setClaimAmounts] = useState<Record<string, number>>({});

  const load = useCallback(() => {
    setLoadErr('');
    api
      .get<Project>(`/projects/${id}`)
      .then(setP)
      .catch((e) => setLoadErr(translateError(e, locale)));
    api.get('/procurement/vendors').then(setVendors).catch(() => {});
  }, [id, locale]);
  useEffect(load, [load]);

  async function createCo() {
    const ok = await act(
      'co',
      () =>
        api.post(`/projects/${id}/change-orders`, {
          descriptionAr: coDescAr.trim() || coDescEn.trim(),
          descriptionEn: coDescEn.trim() || coDescAr.trim(),
          amountDelta: coDelta,
          scheduleImpactDays: coDays,
          wbsElementId: coWbs || undefined,
        }),
      { success: t('common.created') },
    );
    if (ok) {
      setCoOpen(false);
      setCoDescAr(''); setCoDescEn(''); setCoDelta(0); setCoDays(0); setCoWbs('');
      load();
    }
  }

  /**
   * Both approve actions below may be routed into the approval matrix instead
   * of applying — the response says which happened, so the toast reads it
   * rather than claiming success the document has not had yet.
   */
  async function approveThenReload(key: string, path: string): Promise<void> {
    let res: { pendingApproval?: ApprovalRequestView | null } | undefined;
    const ok = await act(
      key,
      async () => {
        res = await api.post(path, {});
      },
      { success: false },
    );
    if (ok) {
      toast.success(res?.pendingApproval ? t('apr.sentForApproval') : t('common.done'));
      load();
    }
  }

  async function approveCo(coId: string) {
    if (
      !(await confirm({ title: t('confirm.approveCoTitle'), message: t('confirm.approveCoMsg') }))
    )
      return;
    await approveThenReload(`approveCo:${coId}`, `/projects/change-orders/${coId}/approve`);
  }

  async function createSub() {
    const ok = await act(
      'sub',
      () =>
        api.post('/procurement/subcontracts', {
          vendorId: subVendorId,
          projectId: id,
          wbsElementId: subWbs || undefined,
          scopeAr: subScopeAr.trim() || subScopeEn.trim(),
          scopeEn: subScopeEn.trim() || subScopeAr.trim(),
          amount: subAmount,
          retentionPct: subRet,
        }),
      { success: t('common.created') },
    );
    if (ok) {
      setSubOpen(false);
      setSubVendorId(''); setSubScopeAr(''); setSubScopeEn(''); setSubAmount(0);
      load();
    }
  }

  async function addClaim(agreementId: string) {
    const amount = claimAmounts[agreementId];
    if (!amount || amount <= 0) return;
    const ok = await act(`claim:${agreementId}`, () =>
      api.post(`/procurement/subcontracts/${agreementId}/claims`, { claimedAmount: amount }),
    );
    if (ok) {
      setClaimAmounts({ ...claimAmounts, [agreementId]: 0 });
      load();
    }
  }

  async function approveClaim(claimId: string) {
    if (
      !(await confirm({
        title: t('confirm.approveClaimTitle'),
        message: t('confirm.approveClaimMsg'),
      }))
    )
      return;
    await approveThenReload(`approveClaim:${claimId}`, `/procurement/claims/${claimId}/approve`);
  }

  async function nextStage() {
    if (!p) return;
    const idx = STAGE_FLOW.indexOf(p.stage);
    if (idx < 0 || idx >= STAGE_FLOW.length - 1) return;
    if (!(await confirm({ title: t('confirm.nextStageTitle'), message: t('confirm.nextStageMsg') })))
      return;
    if (await act('stage', () => api.post(`/projects/${id}/stage`, { stage: STAGE_FLOW[idx + 1] })))
      load();
  }

  if (loadErr && !p) return <LoadError message={loadErr} onRetry={load} />;
  if (!p) return <PageSkeleton />;
  const cs = p.costSummary;
  const maxBar = Math.max(cs.budget, cs.committed + cs.actual, 1);

  return (
    <div>
      <PageHeader
        title={`${p.code} · ${pick(p, 'name')}`}
        backHref="/projects"
        backLabel={t('prj.title')}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={p.stage} />
            {p.stage !== 'CLOSED' && (
              <Can perm="projects.project.write">
                <Btn variant="primary" sm icon="skip-forward" iconClassName="rtl:-scale-x-100" busy={busy('stage')} disabled={busy()} onClick={nextStage}>
                  {t('prj.nextStage')}: {optionLabel(enums?.projectStages, STAGE_FLOW[STAGE_FLOW.indexOf(p.stage) + 1] ?? '', locale)}
                </Btn>
              </Can>
            )}
          </div>
        }
      />
      {confirmNode}

      {/* Cost summary (PRJ-03) */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[
          { key: 'prj.budget', v: cs.budget, tone: 'text-slate-700' },
          { key: 'prj.committed', v: cs.committed, tone: 'text-warning-600' },
          { key: 'prj.actual', v: cs.actual, tone: 'text-brand-700' },
          { key: 'prj.variance', v: cs.variance, tone: cs.variance >= 0 ? 'text-success-600' : 'text-danger-600' },
        ].map((c) => (
          <div key={c.key} className="card p-4">
            <p className="text-xs text-slate-500">{t(c.key)}</p>
            <p className={`mt-1 text-lg font-bold tabular-nums ${c.tone}`}>{formatMoney(c.v, locale)}</p>
          </div>
        ))}
      </div>

      {/* budget vs committed+actual bar */}
      <div className="card mt-4 p-4">
        <p className="mb-2 text-xs text-slate-500">{t('prj.costSummary')}</p>
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="w-24 text-xs text-slate-500">{t('prj.budget')}</span>
            <div className="h-3 flex-1 overflow-hidden rounded-full bg-slate-100">
              <div className="h-full bg-slate-400" style={{ width: `${(cs.budget / maxBar) * 100}%` }} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-24 text-xs text-slate-500">{t('prj.actual')} + {t('prj.committed')}</span>
            <div className="h-3 flex-1 overflow-hidden rounded-full bg-slate-100">
              <div className="flex h-full">
                <div className="h-full bg-brand-500" style={{ width: `${(cs.actual / maxBar) * 100}%` }} />
                <div className="h-full bg-warning-400" style={{ width: `${(cs.committed / maxBar) * 100}%` }} />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* The cost figures above stay pinned — they are the project's vital
          signs. Everything below is tabbed: this page used to stack twelve
          cards on one scroll. */}
      <div className="mt-6">
        <Tabs
          tabs={[
            { key: 'wbs', label: t('prj.wbs'), count: p.wbsElements.length },
            { key: 'cost', label: t('prj.tab.cost'), count: p.purchaseOrders.length + p.costEntries.length },
            { key: 'subs', label: t('prj.tab.subs'), count: p.changeOrders.length + p.subcontracts.length },
            { key: 'files', label: t('att.title') },
          ]}
          value={tab}
          onChange={setTab}
        />
      </div>

      {tab === 'wbs' && (
      <div className="grid grid-cols-1 gap-6">
        {/* WBS */}
        <div className="card overflow-hidden">
          <h2 className="card-title">
            {t('prj.wbs')}
          </h2>
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th scope="col" className="th">{t('common.code')}</th>
                <th scope="col" className="th">{t('common.name')}</th>
                <th scope="col" className="th text-end">{t('prj.budget')}</th>
                <th scope="col" className="th text-end">{t('prj.committed')}</th>
                <th scope="col" className="th text-end">{t('prj.actual')}</th>
                <th scope="col" className="th text-end">{t('prj.variance')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {p.wbsElements.map((w) => (
                <tr key={w.id}>
                  <td className="td font-mono text-xs">{w.code}</td>
                  <td className="td">{locale === 'ar' ? w.nameAr : w.nameEn}</td>
                  <td className="td-num">{formatMoney(w.budgetAmount, locale)}</td>
                  <td className="td-num">{formatMoney(w.committed, locale)}</td>
                  <td className="td-num">{formatMoney(w.actual, locale)}</td>
                  <td className={`td text-end ${w.variance >= 0 ? 'text-success-600' : 'text-danger-600'}`}>
                    {formatMoney(w.variance, locale)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      )}

      {tab === 'cost' && (
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* POs */}
        <div className="card overflow-hidden">
          <h2 className="card-title">
            {t('prj.pos')}
          </h2>
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th scope="col" className="th">{t('common.code')}</th>
                <th scope="col" className="th">{t('po.vendor')}</th>
                <th scope="col" className="th text-end">{t('po.total')}</th>
                <th scope="col" className="th">{t('common.status')}</th>
                <th scope="col" className="th">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {p.purchaseOrders.length === 0 ? (
                <EmptyRow colSpan={5} text={t('common.none')} />
              ) : (
                p.purchaseOrders.map((po) => (
                  <tr key={po.id}>
                    <td className="td font-mono text-xs">{po.code}</td>
                    <td className="td">{po.vendor ? pick(po.vendor, 'name') : '—'}</td>
                    <td className="td-num">{formatMoney(po.total, locale)}</td>
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

        {/* Cost ledger */}
        <div className="card overflow-hidden">
          <h2 className="card-title">
            {t('prj.costEntries')}
          </h2>
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th scope="col" className="th">{t('prj.costType')}</th>
                <th scope="col" className="th">{t('prj.source')}</th>
                <th scope="col" className="th text-end">{t('contracts.amount')}</th>
                <th scope="col" className="th">{t('common.date')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {p.costEntries.length === 0 ? (
                <EmptyRow colSpan={4} text={t('common.none')} />
              ) : (
                p.costEntries.map((ce) => (
                  <tr key={ce.id}>
                    <td className="td">{optionLabel(enums?.costTypes, ce.costType, locale)}</td>
                    <td className="td text-xs text-slate-500">{ce.memo ?? ce.sourceType}</td>
                    <td className="td-num">{formatMoney(ce.amount, locale)}</td>
                    <td className="td text-xs text-slate-500">{formatDate(ce.postedAt, locale)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Serial units */}
        <div className="card overflow-hidden">
          <h2 className="card-title">
            {t('prj.serials')}
          </h2>
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th scope="col" className="th">{t('ast.serial')}</th>
                <th scope="col" className="th">{t('ast.item')}</th>
                <th scope="col" className="th">{t('ast.state')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {p.serialUnits.length === 0 ? (
                <EmptyRow colSpan={3} text={t('common.none')} />
              ) : (
                p.serialUnits.slice(0, 12).map((s) => (
                  <tr key={s.id}>
                    <td className="td font-mono text-xs">{s.serialNo}</td>
                    <td className="td">{s.item ? pick(s.item, 'name') : '—'}</td>
                    <td className="td"><StatusBadge status={s.currentState} /></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
      )}

      {tab === 'subs' && (
      <>
      {/* PRJ-06: change orders */}
      <div className="card overflow-hidden">
        <div className="card-title flex items-center justify-between">
          <div>
            <h3 className="font-bold">{t('co.title')}</h3>
            <p className="mt-1 text-xs text-slate-500">{t('co.hint')}</p>
          </div>
          <Can perm="projects.project.write"><Btn variant="primary" sm icon="plus" onClick={() => setCoOpen(true)}>{t('co.new')}</Btn></Can>
        </div>
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th scope="col" className="th">{t('common.code')}</th>
              <th scope="col" className="th">{t('co.desc')}</th>
              <th scope="col" className="th text-end">{t('co.delta')}</th>
              <th scope="col" className="th text-center">{t('co.days')}</th>
              <th scope="col" className="th">{t('common.status')}</th>
              <th scope="col" className="th">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {p.changeOrders.length === 0 ? (
              <EmptyRow colSpan={6} text={t('common.none')} />
            ) : (
              p.changeOrders.map((co) => (
                <tr key={co.id}>
                  <td className="td font-mono text-xs">{co.code}</td>
                  <td className="td">{locale === 'ar' ? co.descriptionAr : co.descriptionEn}</td>
                  <td className={`td text-end font-medium ${Number(co.amountDelta) >= 0 ? 'text-success-700' : 'text-danger-600'}`}>
                    {Number(co.amountDelta) >= 0 ? '+' : ''}{formatMoney(co.amountDelta, locale)}
                  </td>
                  <td className="td text-center">{co.scheduleImpactDays}</td>
                  <td className="td"><StatusBadge status={co.status} /></td>
                  <td className="td">
                    {co.pendingApproval ? (
                      <ApprovalChain request={co.pendingApproval} />
                    ) : (
                      co.status === 'DRAFT' && (
                        <Can perm="projects.project.write"><Btn variant="primary" sm icon="check-circle" busy={busy(`approveCo:${co.id}`)} disabled={busy()} onClick={() => approveCo(co.id)}>
                          {t('co.approve')}
                        </Btn></Can>
                      )
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* PRJ-07: subcontracts & claims */}
      <div className="card mt-6 overflow-hidden">
        <div className="card-title flex items-center justify-between">
          <div>
            <h3 className="font-bold">{t('sub.title')}</h3>
            <p className="mt-1 text-xs text-slate-500">{t('sub.hint')}</p>
          </div>
          <Can perm="scm.procurement.write"><Btn variant="primary" sm icon="plus" onClick={() => setSubOpen(true)}>{t('sub.new')}</Btn></Can>
        </div>
        {p.subcontracts.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-slate-500">{t('common.none')}</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {p.subcontracts.map((sub) => {
              const claimed = sub.claims.reduce((s, c) => s + Number(c.claimedAmount), 0);
              return (
                <div key={sub.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <span className="font-mono text-xs text-slate-500">{sub.code}</span>{' '}
                      <span className="font-medium">{sub.vendor ? pick(sub.vendor, 'name') : ''}</span>
                      <span className="ms-2 text-xs text-slate-500">{locale === 'ar' ? sub.scopeAr : sub.scopeEn}</span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-slate-500">
                      <span>{t('sub.amount')}: <b className="text-slate-800">{formatMoney(sub.amount, locale)}</b></span>
                      <span>{t('sub.retention')}: {Number(sub.retentionPct)}%</span>
                      <span>{t('sub.claimedTotal')}: <b className="text-brand-700">{formatMoney(claimed, locale)}</b></span>
                      <StatusBadge status={sub.status} />
                    </div>
                  </div>
                  {sub.claims.length > 0 && (
                    <table className="mt-3 min-w-full text-xs">
                      <thead>
                        <tr>
                          <th scope="col" className="th">#</th>
                          <th scope="col" className="th">{t('common.code')}</th>
                          <th scope="col" className="th text-end">{t('sub.claimed')}</th>
                          <th scope="col" className="th text-end">{t('inv.vat')}</th>
                          <th scope="col" className="th text-end">{t('inv.retention')}</th>
                          <th scope="col" className="th text-end">{t('sub.net')}</th>
                          <th scope="col" className="th">{t('common.status')}</th>
                          <th scope="col" className="th"><span className="sr-only">{t('common.actions')}</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        {sub.claims.map((c) => (
                          <tr key={c.id} className="border-t border-slate-50">
                            <td className="td">{c.sequence}</td>
                            <td className="td font-mono">{c.code}</td>
                            <td className="td-num">{formatMoney(c.claimedAmount, locale)}</td>
                            <td className="td-num">{formatMoney(c.vatAmount, locale)}</td>
                            <td className="td-num">{formatMoney(c.retentionWithheld, locale)}</td>
                            <td className="td-num font-medium">{formatMoney(c.netPayable, locale)}</td>
                            <td className="td"><StatusBadge status={c.status} /></td>
                            <td className="td-num">
                              {c.pendingApproval ? (
                                <div className="flex justify-end"><ApprovalChain request={c.pendingApproval} /></div>
                              ) : (
                                c.status === 'SUBMITTED' && (
                                  <Can perm="scm.procurement.write"><Btn variant="primary" sm className="!px-2 !py-0.5 !text-xs" busy={busy(`approveClaim:${c.id}`)} disabled={busy()} onClick={() => approveClaim(c.id)}>
                                    {t('sub.approveClaim')}
                                  </Btn></Can>
                                )
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {sub.status === 'ACTIVE' && (
                    <div className="mt-3 flex items-center gap-2">
                      <input
                        type="number"
                        min={0}
                        className="input w-40"
                        placeholder={t('sub.claimed')}
                        value={claimAmounts[sub.id] || ''}
                        onChange={(e) => setClaimAmounts({ ...claimAmounts, [sub.id]: Number(e.target.value) })}
                      />
                      <Btn sm icon="file-text" busy={busy(`claim:${sub.id}`)} disabled={busy()} onClick={() => addClaim(sub.id)}>
                        {t('sub.newClaim')}
                      </Btn>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      </>
      )}

      {tab === 'files' && <AttachmentsCard entityType="PROJECT" entityId={id} />}

      {/* Change order modal */}
      <Modal open={coOpen} title={t('co.new')} onClose={() => setCoOpen(false)}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={`${t('co.desc')} (ع)`}>
            <input className="input" value={coDescAr} onChange={(e) => setCoDescAr(e.target.value)} />
          </Field>
          <Field label={`${t('co.desc')} (EN — ${t('common.optional')})`}>
            <input className="input" dir="ltr" value={coDescEn} onChange={(e) => setCoDescEn(e.target.value)} />
          </Field>
          <Field label={t('co.delta')}>
            <input type="number" step="0.01" className="input" value={coDelta} onChange={(e) => setCoDelta(Number(e.target.value))} />
          </Field>
          <Field label={t('co.days')}>
            <input type="number" className="input" value={coDays} onChange={(e) => setCoDays(Number(e.target.value))} />
          </Field>
          <Field label={t('po.wbs')}>
            <select className="input" value={coWbs} onChange={(e) => setCoWbs(e.target.value)}>
              <option value="">—</option>
              {p.wbsElements.map((w) => (
                <option key={w.id} value={w.id}>{w.code} · {locale === 'ar' ? w.nameAr : w.nameEn}</option>
              ))}
            </select>
          </Field>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Btn sm onClick={() => setCoOpen(false)}>{t('common.cancel')}</Btn>
          <Btn variant="primary" sm busy={busy('co')} disabled={busy() || !(coDescAr.trim() || coDescEn.trim()) || !coDelta} onClick={createCo}>
            {t('common.create')}
          </Btn>
        </div>
      </Modal>

      {/* Subcontract modal */}
      <Modal open={subOpen} title={t('sub.new')} onClose={() => setSubOpen(false)}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t('po.vendor')}>
            <select className="input" value={subVendorId} onChange={(e) => setSubVendorId(e.target.value)}>
              <option value="">—</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>{v.code} · {pick(v, 'name')}</option>
              ))}
            </select>
          </Field>
          <Field label={t('po.wbs')}>
            <select className="input" value={subWbs} onChange={(e) => setSubWbs(e.target.value)}>
              <option value="">—</option>
              {p.wbsElements.map((w) => (
                <option key={w.id} value={w.id}>{w.code} · {locale === 'ar' ? w.nameAr : w.nameEn}</option>
              ))}
            </select>
          </Field>
          <Field label={`${t('sub.scope')} (ع)`}>
            <input className="input" value={subScopeAr} onChange={(e) => setSubScopeAr(e.target.value)} />
          </Field>
          <Field label={`${t('sub.scope')} (EN — ${t('common.optional')})`}>
            <input className="input" dir="ltr" value={subScopeEn} onChange={(e) => setSubScopeEn(e.target.value)} />
          </Field>
          <Field label={t('sub.amount')}>
            <input type="number" min={0} step="0.01" className="input" value={subAmount} onChange={(e) => setSubAmount(Number(e.target.value))} />
          </Field>
          <Field label={t('sub.retention')}>
            <input type="number" min={0} max={100} className="input" value={subRet} onChange={(e) => setSubRet(Number(e.target.value))} />
          </Field>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Btn sm onClick={() => setSubOpen(false)}>{t('common.cancel')}</Btn>
          <Btn variant="primary" sm busy={busy('sub')} disabled={busy() || !subVendorId || !(subScopeAr.trim() || subScopeEn.trim()) || !subAmount} onClick={createSub}>
            {t('common.create')}
          </Btn>
        </div>
      </Modal>
    </div>
  );
}
