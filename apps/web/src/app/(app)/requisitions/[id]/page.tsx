'use client';

/**
 * One requisition: its lines, its position in the flow, and the buttons the
 * engine says this user may press right now.
 *
 * The buttons are not hardcoded. `workflow.actions` comes from the engine,
 * which filtered `wf_transitions` by the caller's live permissions and by each
 * transition's condition — so the screen cannot offer a move the server will
 * refuse, and a flow that gains a transition gains a button with no deploy.
 */
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { formatDate, formatDateTime, formatMoney } from '@/lib/format';
import {
  Btn,
  Field,
  LoadError,
  Modal,
  PageHeader,
  PageSkeleton,
  StatusBadge,
} from '@/components/ui';
import { Icon } from '@/components/icons';
import { ApprovalBanner, type ApprovalRequestView } from '@/components/approvals';

interface AvailableAction {
  actionCode: string;
  nameAr: string;
  nameEn: string;
  toState: string;
  requiresApproval: boolean;
  requiresComment: boolean;
}

interface HistoryRow {
  id: string;
  fromState: string;
  toState: string;
  actionCode: string;
  comment: string | null;
  createdAt: string;
  actor: { id: string; nameAr: string; nameEn: string } | null;
  fromStateName: { nameAr: string; nameEn: string } | null;
  toStateName: { nameAr: string; nameEn: string } | null;
}

interface Requisition {
  id: string;
  code: string;
  justification: string;
  status: string;
  estimatedTotal: string | number;
  currency: string;
  neededBy: string | null;
  createdAt: string;
  department: { nameAr: string; nameEn: string } | null;
  project: { id: string; code: string; nameAr: string; nameEn: string } | null;
  requestedBy: { nameAr: string; nameEn: string } | null;
  purchaseOrder: { id: string; code: string; status: string } | null;
  lines: Array<{
    id: string;
    qty: string | number;
    estimatedUnitPrice: string | number;
    lineTotal: string | number;
    notes: string | null;
    item: { sku: string; nameAr: string; nameEn: string; uom: string };
    wbsElement: { code: string; nameAr: string; nameEn: string } | null;
  }>;
  workflow: {
    instance: {
      currentState: string;
      state: { nameAr: string; nameEn: string };
      assigneeRole: { nameAr: string; nameEn: string } | null;
    } | null;
    history: HistoryRow[];
    actions: AvailableAction[];
  };
  pendingApproval: ApprovalRequestView | null;
}

export default function RequisitionPage() {
  const { id } = useParams<{ id: string }>();
  const { locale, t } = useI18n();
  const { act, busy } = useAct();
  const ar = locale === 'ar';

  const [pr, setPr] = useState<Requisition | null>(null);
  const [err, setErr] = useState('');
  const [pending, setPending] = useState<AvailableAction | null>(null);
  const [comment, setComment] = useState('');

  const load = useCallback(() => {
    setErr('');
    api
      .get<Requisition>(`/requisitions/${id}`)
      .then(setPr)
      .catch((e) => setErr(translateError(e, locale)));
  }, [id, locale]);
  useEffect(load, [load]);

  const run = async (action: AvailableAction, note: string) => {
    const ok = await act(action.actionCode, () =>
      api.post(`/requisitions/${id}/actions`, {
        action: action.actionCode,
        comment: note.trim() || undefined,
      }),
    );
    if (ok) {
      setPending(null);
      setComment('');
      load();
    }
  };

  if (err) return <LoadError message={err} onRetry={load} />;
  if (!pr) return <PageSkeleton />;

  const state = pr.workflow.instance?.state;

  return (
    <div>
      <PageHeader
        title={pr.code}
        subtitle={pr.justification}
        backHref="/requisitions"
        backLabel={t('pr.title')}
        action={
          <div className="flex flex-wrap gap-2">
            {pr.workflow.actions.map((a) => (
              <Btn
                key={a.actionCode}
                variant={a.actionCode === 'REJECT' ? 'danger' : 'primary'}
                busy={busy(a.actionCode)}
                onClick={() =>
                  // A move that demands a reason opens the box; the rest run
                  // straight through. The engine enforces this either way —
                  // the modal is a courtesy, not the control.
                  a.requiresComment ? setPending(a) : run(a, '')
                }
              >
                {ar ? a.nameAr : a.nameEn}
              </Btn>
            ))}
          </div>
        }
      />

      {pr.pendingApproval && <ApprovalBanner request={pr.pendingApproval} />}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-5">
          <section className="rounded-xl border border-slate-200 bg-white">
            <header className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-700">
              {t('pr.f.lines')}
            </header>
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2 text-start">{t('pr.col.item')}</th>
                  <th className="px-4 py-2 text-start">{t('pr.f.qty')}</th>
                  <th className="px-4 py-2 text-start">{t('pr.f.unitPrice')}</th>
                  <th className="px-4 py-2 text-end">{t('pr.col.lineTotal')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {pr.lines.map((l) => (
                  <tr key={l.id}>
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-slate-800">
                        {ar ? l.item.nameAr : l.item.nameEn}
                      </div>
                      <div className="text-xs text-slate-500">{l.item.sku}</div>
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-slate-600">
                      {Number(l.qty)} {l.item.uom}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-slate-600">
                      {formatMoney(Number(l.estimatedUnitPrice), locale)}
                    </td>
                    <td className="px-4 py-2.5 text-end tabular-nums font-medium text-slate-800">
                      {formatMoney(Number(l.lineTotal), locale)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t border-slate-200 bg-slate-50">
                <tr>
                  <td colSpan={3} className="px-4 py-3 text-slate-600">
                    {t('pr.f.estimatedTotal')}
                  </td>
                  <td className="px-4 py-3 text-end text-base font-semibold tabular-nums text-slate-900">
                    {formatMoney(Number(pr.estimatedTotal), locale)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </section>

          {/* The trail. Not a status word — who moved it, when, and what they
              said, which is the question people actually have. */}
          <section className="rounded-xl border border-slate-200 bg-white">
            <header className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-700">
              {t('wf.trail')}
            </header>
            <ol className="divide-y divide-slate-100">
              {pr.workflow.history.map((h) => (
                <li key={h.id} className="flex gap-3 px-4 py-3">
                  <Icon name="clock" className="mt-0.5 h-4 w-4 shrink-0 text-slate-300" />
                  <div className="min-w-0">
                    <div className="text-sm text-slate-800">
                      {h.actionCode === 'OPEN'
                        ? t('wf.opened')
                        : `${ar ? (h.fromStateName?.nameAr ?? h.fromState) : (h.fromStateName?.nameEn ?? h.fromState)} → ${
                            ar
                              ? (h.toStateName?.nameAr ?? h.toState)
                              : (h.toStateName?.nameEn ?? h.toState)
                          }`}
                    </div>
                    <div className="mt-0.5 text-xs text-slate-500">
                      {h.actor ? (ar ? h.actor.nameAr : h.actor.nameEn) : t('wf.system')} ·{' '}
                      {formatDateTime(h.createdAt, locale)}
                    </div>
                    {h.comment && (
                      <div className="mt-1 text-xs italic text-slate-600">“{h.comment}”</div>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        </div>

        <aside className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 text-sm">
          <Row label={t('pr.col.status')}>
            <StatusBadge status={pr.status} />
          </Row>
          {state && (
            <Row label={t('wf.state')}>{ar ? state.nameAr : state.nameEn}</Row>
          )}
          {pr.workflow.instance?.assigneeRole && (
            <Row label={t('wf.assignee')}>
              {ar
                ? pr.workflow.instance.assigneeRole.nameAr
                : pr.workflow.instance.assigneeRole.nameEn}
            </Row>
          )}
          <Row label={t('pr.col.department')}>
            {pr.department ? (ar ? pr.department.nameAr : pr.department.nameEn) : '—'}
          </Row>
          <Row label={t('pr.col.requestedBy')}>
            {pr.requestedBy ? (ar ? pr.requestedBy.nameAr : pr.requestedBy.nameEn) : '—'}
          </Row>
          <Row label={t('pr.col.neededBy')}>
            {pr.neededBy ? formatDate(pr.neededBy, locale) : '—'}
          </Row>
          {pr.project && <Row label={t('pr.col.project')}>{pr.project.code}</Row>}
          {pr.purchaseOrder && (
            <Row label={t('pr.col.purchaseOrder')}>
              <a
                href={`/procurement/${pr.purchaseOrder.id}`}
                className="font-medium text-brand-700 hover:underline"
              >
                {pr.purchaseOrder.code}
              </a>
            </Row>
          )}
        </aside>
      </div>

      <Modal
        open={pending !== null}
        onClose={() => setPending(null)}
        title={pending ? (ar ? pending.nameAr : pending.nameEn) : ''}
      >
        <div className="space-y-4">
          <Field label={t('wf.reason')} hint={t('wf.reasonHint')}>
            <textarea
              className="input min-h-[4.5rem]"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Btn variant="ghost" onClick={() => setPending(null)}>
              {t('common.cancel')}
            </Btn>
            <Btn
              variant="danger"
              disabled={!comment.trim()}
              busy={pending ? busy(pending.actionCode) : false}
              onClick={() => pending && run(pending, comment)}
            >
              {t('common.confirm')}
            </Btn>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-slate-100 pb-2 last:border-0 last:pb-0">
      <span className="text-xs text-slate-500">{label}</span>
      <span className="text-sm font-medium text-slate-800">{children}</span>
    </div>
  );
}
