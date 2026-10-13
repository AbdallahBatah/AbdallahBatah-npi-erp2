'use client';

/**
 * Opportunity detail — CRM Phase 1 · Step 3 (§4.2).
 *
 * The funnel stepper (محتمل ← تأهيل ← عرض سعر ← تفاوض ← رابحة | خاسرة) with the
 * buttons that move the opportunity, the tender card for a tender, and the
 * proposals / contracts / attachments tabs. Every rule shown here (one step at
 * a time, a loss reason is mandatory, a closed opportunity is final) is
 * enforced by the server; this page only draws the buttons that can work.
 */
import { FormEvent, ReactNode, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { OPPORTUNITY_STAGE_FLOW, isOpenStage } from '@npi/shared';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { useEnums, optionLabel } from '@/lib/useEnums';
import { formatDate, formatMoney, formatNumber } from '@/lib/format';
import { AttachmentsCard } from '@/components/attachments';
import { ActivityTimeline } from '@/components/activity-timeline';
import { FollowUpTasksPanel } from '@/components/follow-up-tasks';
import { OppTypeBadge, daysUntil } from '@/components/opportunity-bits';
import {
  Btn,
  EmptyRow,
  Field,
  LoadError,
  Modal,
  PageHeader,
  PageSkeleton,
  StatusBadge,
  Tabs,
} from '@/components/ui';

interface Named { nameAr: string; nameEn: string }
interface Revision { id: string; revisionNo: number; totalAmount: string; status: string }
interface ProposalRow { id: string; code: string; status: string; createdAt: string; revisions: Revision[] }
interface ContractRow { id: string; code: string; status: string; contractType: string; totalValue: string; currency: string }
interface Detail {
  id: string;
  code: string;
  name: string;
  stage: string;
  opportunityType: string;
  estimatedKwp: string | null;
  estimatedValue: string | null;
  currency: string;
  expectedCloseDate: string | null;
  tenderReference: string | null;
  tenderCloseDate: string | null;
  bidBondAmount: string | null;
  bidBondBank: string | null;
  bidBondExpiry: string | null;
  bidBondReference: string | null;
  lossReasonId: string | null;
  lossNotes: string | null;
  closedAt: string | null;
  stageChangedAt: string | null;
  customer: Named & { id: string; code: string };
  owner: Named | null;
  lossReason: (Named & { id: string }) | null;
  proposals: ProposalRow[];
  contracts: ContractRow[];
}
interface LossReason extends Named { id: string }

/** A tender whose deadline is this close is flagged in red. */
const TENDER_WARN_DAYS = 7;
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '');

export default function OpportunityPage() {
  const { t, locale, pick } = useI18n();
  const { can } = useAuth();
  const enums = useEnums();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params.id;
  const { act, busy } = useAct();
  const [o, setO] = useState<Detail | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [tab, setTab] = useState('proposals');
  const [editOpen, setEditOpen] = useState(false);
  const [editType, setEditType] = useState('DIRECT');
  const [editErr, setEditErr] = useState('');
  const [lostOpen, setLostOpen] = useState(false);
  const [reasons, setReasons] = useState<LossReason[] | null>(null);
  const [lostErr, setLostErr] = useState('');

  const load = useCallback(() => {
    setLoadErr('');
    api
      .get<Detail>(`/opportunities/${id}`)
      .then(setO)
      .catch((e) => setLoadErr(translateError(e, locale)));
  }, [id, locale]);
  useEffect(load, [load]);

  // The reasons are fetched when the «خاسرة» window opens, so a reason switched
  // off a minute ago is already gone from the list.
  useEffect(() => {
    if (!lostOpen) return;
    setReasons(null);
    api
      .get<LossReason[]>('/loss-reasons')
      .then(setReasons)
      .catch(() => setReasons([]));
  }, [lostOpen]);

  if (loadErr && !o) return <LoadError message={loadErr} onRetry={load} />;
  if (!o) return <PageSkeleton />;

  const open = isOpenStage(o.stage);
  const writable = can('crm.opportunity.write');
  const idx = OPPORTUNITY_STAGE_FLOW.indexOf(o.stage as (typeof OPPORTUNITY_STAGE_FLOW)[number]);
  const nextStage = open && idx >= 0 && idx < OPPORTUNITY_STAGE_FLOW.length - 1 ? OPPORTUNITY_STAGE_FLOW[idx + 1] : null;
  const prevStage = open && idx > 0 ? OPPORTUNITY_STAGE_FLOW[idx - 1] : null;
  const stageName = (s: string) => optionLabel(enums?.opportunityStages, s, locale);
  const tender = o.opportunityType === 'TENDER';
  const tenderDays = daysUntil(o.tenderCloseDate);
  const tenderAlert = tender && open && tenderDays !== null && tenderDays <= TENDER_WARN_DAYS;

  async function move(stage: string) {
    if (await act('stage', () => api.post(`/opportunities/${id}/stage`, { stage }))) load();
  }

  async function markLost(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const lossReasonId = String(f.get('lossReasonId') ?? '');
    if (!lossReasonId) {
      // Same sentence the server would answer with; the server enforces it too.
      setLostErr(translateError(new ApiError(400, 'Loss reason is required'), locale));
      return;
    }
    setLostErr('');
    const ok = await act('lost', () =>
      api.post(`/opportunities/${id}/stage`, {
        stage: 'LOST',
        lossReasonId,
        lossNotes: String(f.get('lossNotes') ?? '').trim() || undefined,
      }),
    );
    if (ok) {
      setLostOpen(false);
      load();
    }
  }

  function openEdit() {
    setEditType(o!.opportunityType);
    setEditErr('');
    setEditOpen(true);
  }

  async function saveEdit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (k: string) => String(f.get(k) ?? '').trim();
    const num = (k: string) => (text(k) ? Number(text(k)) : undefined);
    let body: Record<string, unknown>;
    if (!open) {
      // A closed opportunity is a historical record: only the name and, for a
      // lost one, the notes can still be corrected.
      body = { name: text('name'), ...(o!.stage === 'LOST' ? { lossNotes: text('lossNotes') } : {}) };
    } else {
      if (editType === 'TENDER' && !text('tenderCloseDate')) {
        setEditErr(translateError(new ApiError(400, 'Tender close date is required'), locale));
        return;
      }
      setEditErr('');
      body = {
        name: text('name'),
        opportunityType: editType,
        estimatedKwp: num('estimatedKwp'),
        estimatedValue: num('estimatedValue'),
        expectedCloseDate: text('expectedCloseDate') || undefined,
        ...(editType === 'TENDER'
          ? {
              tenderReference: text('tenderReference') || undefined,
              tenderCloseDate: text('tenderCloseDate'),
              bidBondAmount: num('bidBondAmount'),
              bidBondBank: text('bidBondBank') || undefined,
              bidBondExpiry: text('bidBondExpiry') || undefined,
              bidBondReference: text('bidBondReference') || undefined,
            }
          : {}),
      };
    }
    const ok = await act('save', () => api.patch(`/opportunities/${id}`, body), { success: t('common.done') });
    if (ok) {
      setEditOpen(false);
      load();
    }
  }

  async function createProposal() {
    let pid: string | null = null;
    const ok = await act('proposal', async () => {
      const p = await api.post<{ id: string }>('/proposals', { opportunityId: id });
      pid = p.id;
    });
    if (ok && pid) router.push(`/proposals/${pid}`);
  }

  const tabs = [
    { key: 'proposals', label: t('opps.tab.proposals'), count: o.proposals.length },
    { key: 'contracts', label: t('opps.tab.contracts'), count: o.contracts.length },
    // CRM Step 5: the log and the tasks of this opportunity — the log behind the customers'
    // read key, the tasks behind the key of the /tasks screen (P1-6), as GET /activities
    // and GET /tasks are.
    ...(can('crm.customer.read') ? [{ key: 'activities', label: t('opps.tab.activities') }] : []),
    ...(can('crm.task.read') ? [{ key: 'tasks', label: t('opps.tab.tasks') }] : []),
    ...(can('platform.attachment.read') ? [{ key: 'files', label: t('opps.tab.files') }] : []),
  ];
  const activeTab = tabs.some((x) => x.key === tab) ? tab : 'proposals';

  // ── the stepper: the four open stages, then one node for the outcome ──
  const nodes = [
    ...OPPORTUNITY_STAGE_FLOW.map((s, i) => ({
      key: s,
      label: stageName(s),
      state: o.stage === 'WON' ? 'done' : open ? (i < idx ? 'done' : i === idx ? 'current' : 'todo') : 'muted',
    })),
    {
      key: 'END',
      label: o.stage === 'WON' ? stageName('WON') : o.stage === 'LOST' ? stageName('LOST') : t('opps.stage.final'),
      state: o.stage === 'WON' ? 'won' : o.stage === 'LOST' ? 'lost' : 'todo',
    },
  ];
  const circle: Record<string, string> = {
    done: 'bg-brand-600 text-white',
    current: 'bg-brand-600 text-white ring-4 ring-brand-100',
    todo: 'bg-slate-100 text-slate-500',
    muted: 'bg-slate-100 text-slate-400',
    won: 'bg-success-600 text-white ring-4 ring-success-100',
    lost: 'bg-danger-600 text-white ring-4 ring-danger-100',
  };

  return (
    <div>
      <PageHeader
        title={`${o.code} · ${o.name}`}
        backHref="/opportunities"
        backLabel={t('opps.backToList')}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <OppTypeBadge type={o.opportunityType} />
            <StatusBadge status={o.stage} />
            {writable && (
              <Btn sm onClick={openEdit}>
                {t('opps.edit')}
              </Btn>
            )}
          </div>
        }
      />

      {/* A closed opportunity: the verdict, and no buttons. */}
      {o.stage === 'WON' && (
        <output className="block mb-4 rounded-xl border border-success-200 bg-success-50/60 p-4 text-sm font-semibold text-success-900">
          {t('opps.closed.won').replace('{date}', formatDate(o.closedAt, locale))}
        </output>
      )}
      {o.stage === 'LOST' && (
        <div aria-live="polite" aria-atomic="true" className="mb-4 rounded-xl border border-danger-200 bg-danger-50/60 p-4 text-sm text-danger-900">
          <p className="font-semibold">
            {t('opps.closed.lost').replace('{date}', formatDate(o.closedAt, locale))}
            {o.lossReason && <> — {t('opps.closed.reason').replace('{reason}', pick(o.lossReason, 'name'))}</>}
          </p>
          {o.lossNotes && <p className="mt-1 whitespace-pre-line text-danger-800">{o.lossNotes}</p>}
        </div>
      )}

      <div className="card mb-5 grid grid-cols-2 gap-x-6 gap-y-4 p-5 text-sm sm:grid-cols-3 lg:grid-cols-4">
        <Fact label={t('opps.customer')}>
          <Link href={`/customers/${o.customer.id}`} className="font-medium text-brand-700 hover:underline">
            {o.customer.code} · {pick(o.customer, 'name')}
          </Link>
        </Fact>
        <Fact label={t('opps.type')}>{t(`opps.type.${tender ? 'TENDER' : 'DIRECT'}`)}</Fact>
        <Fact label={t('opps.estValue')}>{o.estimatedValue ? formatMoney(o.estimatedValue, locale, o.currency) : '—'}</Fact>
        <Fact label={t('leads.kwp')}>{o.estimatedKwp ? formatNumber(o.estimatedKwp, locale) : '—'}</Fact>
        <Fact label={t('opps.owner')}>{o.owner ? pick(o.owner, 'name') : '—'}</Fact>
        <Fact label={t('opps.expectedClose')}>{formatDate(o.expectedCloseDate, locale)}</Fact>
      </div>

      {/* The funnel */}
      <div className="card mb-5 p-5">
        <ol aria-label={t('opps.stepper')} className="flex items-center gap-1 overflow-x-auto pb-1 [scrollbar-width:none]">
          {nodes.map((n, i) => (
            <li key={n.key} className="flex shrink-0 items-center gap-1">
              <span className="flex items-center gap-2">
                <span
                  aria-current={n.state === 'current' ? 'step' : undefined}
                  className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${circle[n.state]}`}
                >
                  {n.state === 'done' || n.state === 'won' ? '✓' : n.state === 'lost' ? '×' : i + 1}
                </span>
                <span className={`text-sm ${n.state === 'current' ? 'font-bold text-slate-900' : 'text-slate-600'}`}>{n.label}</span>
              </span>
              {i < nodes.length - 1 && <span className="mx-2 h-px w-8 bg-slate-300 sm:w-12" aria-hidden />}
            </li>
          ))}
        </ol>

        {open && writable && (
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
            {nextStage && (
              <Btn
                variant="primary"
                icon="skip-forward"
                iconClassName="rtl:-scale-x-100"
                busy={busy('stage')}
                disabled={busy()}
                onClick={() => move(nextStage)}
              >
                {t('opps.stage.next').replace('{stage}', stageName(nextStage))}
              </Btn>
            )}
            {o.stage === 'NEGOTIATION' && (
              <span className="inline-flex flex-col">
                <Btn variant="primary" icon="check-circle" busy={busy('stage')} disabled={busy()} onClick={() => move('WON')}>
                  {t('opps.markWon')}
                </Btn>
              </span>
            )}
            {prevStage && (
              <Btn sm icon="undo" busy={busy('stage')} disabled={busy()} onClick={() => move(prevStage)}>
                {t('opps.stage.back').replace('{stage}', stageName(prevStage))}
              </Btn>
            )}
            <Btn variant="danger" sm icon="x" disabled={busy()} onClick={() => { setLostErr(''); setLostOpen(true); }}>
              {t('opps.markLost')}
            </Btn>
            {o.stage === 'NEGOTIATION' && <span className="text-xs text-slate-500">{t('opps.markWonHint')}</span>}
          </div>
        )}
      </div>

      {/* Tender card */}
      {tender && (
        <div className="card mb-5 p-5">
          <h2 className="mb-3 text-sm font-bold text-slate-800">{t('opps.tender.title')}</h2>
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 text-sm sm:grid-cols-3 lg:grid-cols-4">
            <Fact label={t('opps.tender.reference')} mono>{o.tenderReference ?? '—'}</Fact>
            <Fact label={t('opps.tender.closeDate')}>
              <span className={tenderAlert ? 'font-bold text-danger-600' : ''}>{formatDate(o.tenderCloseDate, locale)}</span>
              {tenderAlert && tenderDays !== null && (
                <span role="alert" className="mt-0.5 block text-xs font-semibold text-danger-600">
                  {tenderDays < 0 ? t('opps.tender.overdue') : t('opps.tender.soon').replace('{n}', String(tenderDays))}
                </span>
              )}
            </Fact>
            <Fact label={t('opps.bidBond.amount')}>{o.bidBondAmount ? formatMoney(o.bidBondAmount, locale, o.currency) : '—'}</Fact>
            <Fact label={t('opps.bidBond.bank')}>{o.bidBondBank ?? '—'}</Fact>
            <Fact label={t('opps.bidBond.expiry')}>{formatDate(o.bidBondExpiry, locale)}</Fact>
            <Fact label={t('opps.bidBond.reference')} mono>{o.bidBondReference ?? '—'}</Fact>
          </div>
        </div>
      )}

      <Tabs tabs={tabs} value={activeTab} onChange={setTab} />

      {activeTab === 'proposals' && (
        <div>
          {open && can('commercial.proposal.write') && (
            <div className="mb-3 flex justify-end">
              <Btn variant="solar" icon="file-text" busy={busy('proposal')} disabled={busy()} onClick={createProposal}>
                {t('opps.createProposal')}
              </Btn>
            </div>
          )}
          <div className="card overflow-hidden">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <th scope="col" className="th">{t('common.code')}</th>
                  <th scope="col" className="th">{t('common.status')}</th>
                  <th scope="col" className="th">{t('opps.col.revisions')}</th>
                  <th scope="col" className="th">{t('opps.col.value')}</th>
                  <th scope="col" className="th">{t('common.date')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {o.proposals.length === 0 ? (
                  <EmptyRow colSpan={5} text={t('opps.proposals.empty')} />
                ) : (
                  o.proposals.map((p) => {
                    const last = [...p.revisions].sort((a, b) => b.revisionNo - a.revisionNo)[0];
                    return (
                      <tr key={p.id} className="hover:bg-slate-50">
                        <td className="td font-mono text-xs">
                          <Link href={`/proposals/${p.id}`} className="text-brand-700 hover:underline">{p.code}</Link>
                        </td>
                        <td className="td"><StatusBadge status={p.status} /></td>
                        <td className="td tabular-nums">{p.revisions.length}</td>
                        <td className="td">{last ? formatMoney(last.totalAmount, locale, o.currency) : '—'}</td>
                        <td className="td text-xs">{formatDate(p.createdAt, locale)}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'contracts' && (
        <div className="card overflow-hidden">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50">
              <tr>
                <th scope="col" className="th">{t('common.code')}</th>
                <th scope="col" className="th">{t('common.type')}</th>
                <th scope="col" className="th">{t('common.status')}</th>
                <th scope="col" className="th">{t('opps.col.value')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {o.contracts.length === 0 ? (
                <EmptyRow colSpan={4} text={t('opps.contracts.empty')} />
              ) : (
                o.contracts.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50">
                    <td className="td font-mono text-xs">
                      <Link href={`/contracts/${c.id}`} className="text-brand-700 hover:underline">{c.code}</Link>
                    </td>
                    <td className="td">{optionLabel(enums?.contractTypes, c.contractType, locale)}</td>
                    <td className="td"><StatusBadge status={c.status} /></td>
                    <td className="td">{formatMoney(c.totalValue, locale, c.currency)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === 'activities' && (
        <ActivityTimeline customerId={o.customer.id} opportunityId={id} writable={can('crm.customer.write')} />
      )}

      {activeTab === 'tasks' && (
        <FollowUpTasksPanel customerId={o.customer.id} opportunityId={id} writable={can('crm.customer.write')} />
      )}

      {activeTab === 'files' && <AttachmentsCard entityType="OPPORTUNITY" entityId={id} />}

      {/* Mark as lost */}
      <Modal open={lostOpen} title={t('opps.lossTitle')} onClose={() => setLostOpen(false)}>
        <form onSubmit={markLost} className="grid grid-cols-1 gap-4">
          <p className="rounded-lg bg-warning-50 p-3 text-xs text-warning-900">{t('opps.lossWarn')}</p>
          <Field label={t('opps.lossReason')} error={lostErr}>
            <select name="lossReasonId" className="input" defaultValue="" onChange={() => setLostErr('')}>
              <option value="">{t('opps.lossReasonPick')}</option>
              {(reasons ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {pick(r, 'name')}
                </option>
              ))}
            </select>
          </Field>
          {reasons !== null && reasons.length === 0 && (
            <p className="text-xs text-danger-600">{t('opps.lossNoReasons')}</p>
          )}
          <Field label={`${t('opps.lossNotes')} (${t('common.optional')})`}>
            <textarea name="lossNotes" className="input min-h-[5rem]" />
          </Field>
          <div className="flex justify-end gap-2">
            <Btn onClick={() => setLostOpen(false)}>{t('common.cancel')}</Btn>
            <Btn type="submit" variant="danger" busy={busy('lost')} disabled={busy()}>
              {t('opps.markLost')}
            </Btn>
          </div>
        </form>
      </Modal>

      {/* Edit */}
      <Modal open={editOpen} title={t('opps.edit')} onClose={() => setEditOpen(false)}>
        <form key={`${o.id}:${o.stage}:${editOpen}`} onSubmit={saveEdit} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t('opps.name')}>
            <input name="name" className="input" required defaultValue={o.name} />
          </Field>
          {open ? (
            <>
              <Field label={t('opps.type')}>
                <select name="opportunityType" className="input" value={editType} onChange={(e) => setEditType(e.target.value)}>
                  {(enums?.opportunityTypes ?? []).map((x) => (
                    <option key={x.value} value={x.value}>
                      {locale === 'ar' ? x.labelAr : x.labelEn}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('leads.kwp')}>
                <input name="estimatedKwp" type="number" step="0.001" className="input" defaultValue={o.estimatedKwp ?? ''} />
              </Field>
              <Field label={t('opps.estValue')}>
                <input name="estimatedValue" type="number" step="0.01" className="input" defaultValue={o.estimatedValue ?? ''} />
              </Field>
              <Field label={t('opps.expectedClose')}>
                <input name="expectedCloseDate" type="date" className="input" dir="ltr" defaultValue={day(o.expectedCloseDate)} />
              </Field>
              {editType === 'TENDER' && (
                <fieldset className="grid grid-cols-1 gap-4 rounded-xl border border-solar-200 bg-solar-50/50 p-4 sm:col-span-2 sm:grid-cols-2">
                  <legend className="px-2 text-sm font-semibold text-solar-700">{t('opps.tender.title')}</legend>
                  <Field label={t('opps.tender.reference')}>
                    <input name="tenderReference" className="input" dir="ltr" defaultValue={o.tenderReference ?? ''} />
                  </Field>
                  <Field label={t('opps.tender.closeDate')} hint={t('opps.tender.closeRequired')} error={editErr}>
                    <input name="tenderCloseDate" type="date" className="input" dir="ltr" defaultValue={day(o.tenderCloseDate)} />
                  </Field>
                  <Field label={t('opps.bidBond.amount')}>
                    <input name="bidBondAmount" type="number" step="0.01" min={0} className="input" dir="ltr" defaultValue={o.bidBondAmount ?? ''} />
                  </Field>
                  <Field label={t('opps.bidBond.bank')}>
                    <input name="bidBondBank" className="input" defaultValue={o.bidBondBank ?? ''} />
                  </Field>
                  <Field label={t('opps.bidBond.expiry')}>
                    <input name="bidBondExpiry" type="date" className="input" dir="ltr" defaultValue={day(o.bidBondExpiry)} />
                  </Field>
                  <Field label={t('opps.bidBond.reference')}>
                    <input name="bidBondReference" className="input" dir="ltr" defaultValue={o.bidBondReference ?? ''} />
                  </Field>
                </fieldset>
              )}
            </>
          ) : (
            o.stage === 'LOST' && (
              <div className="sm:col-span-2">
                <Field label={t('opps.lossNotes')}>
                  <textarea name="lossNotes" className="input min-h-[5rem]" defaultValue={o.lossNotes ?? ''} />
                </Field>
              </div>
            )
          )}
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Btn onClick={() => setEditOpen(false)}>{t('common.cancel')}</Btn>
            <Btn type="submit" variant="primary" busy={busy('save')} disabled={busy()}>
              {t('common.save')}
            </Btn>
          </div>
        </form>
      </Modal>
    </div>
  );
}

function Fact({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div>
      <div className="text-xs font-semibold text-slate-500">{label}</div>
      <div className={`mt-0.5 text-slate-900 ${mono ? 'font-mono text-xs' : ''}`}>{children}</div>
    </div>
  );
}
