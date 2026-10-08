'use client';

/**
 * The reader's half of the approval matrix (package و): the signature chain
 * as a thing you can look at, and the inbox of what is waiting on you.
 *
 * The chain is rendered as an ordered trail rather than a status word on
 * purpose — "step 2 of 3, finance signed at 14:20, procurement is next" is the
 * question people actually have, and a badge saying PENDING answers none of it.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { formatDateTime, formatMoney } from '@/lib/format';
import { Btn, EmptyRow, Field, LoadError, Modal, StatusBadge, TableSkeleton } from '@/components/ui';
import { Icon } from '@/components/icons';

export type ApprovalDocType =
  | 'PURCHASE_REQUISITION'
  | 'PURCHASE_ORDER'
  | 'PROGRESS_CLAIM'
  | 'CHANGE_ORDER'
  | 'PROPOSAL';

export interface ApprovalStepView {
  sequence: number;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  role: { id: string; nameAr: string; nameEn: string };
  decidedBy: { id: string; nameAr: string; nameEn: string } | null;
  decidedAt: string | null;
  note: string | null;
}
export interface ApprovalRequestView {
  id: string;
  documentType: ApprovalDocType;
  documentId: string;
  documentCode: string;
  amount: number;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  currentStep: number;
  createdAt: string;
  closedAt: string | null;
  raisedBy: { id: string; nameAr: string; nameEn: string } | null;
  steps: ApprovalStepView[];
  /** Inbox rows only — see ApprovalService.inbox for why blocked rows stay. */
  canDecide?: boolean;
  blockedReason?: 'RAISED_BY_YOU' | 'ALREADY_SIGNED';
}

export const DOC_LABEL: Record<ApprovalDocType, { ar: string; en: string }> = {
  PURCHASE_REQUISITION: { ar: 'طلب شراء', en: 'Purchase requisition' },
  PROPOSAL: { ar: 'عرض سعر', en: 'Proposal' },
  PURCHASE_ORDER: { ar: 'أمر شراء', en: 'Purchase order' },
  PROGRESS_CLAIM: { ar: 'مستخلص مقاول', en: 'Subcontractor claim' },
  CHANGE_ORDER: { ar: 'أمر تغيير', en: 'Change order' },
};

/** The ordered trail of signatures — who signed, who is next, who has not. */
export function ApprovalChain({ request }: { request: ApprovalRequestView }) {
  const { locale, t } = useI18n();
  const ar = locale === 'ar';
  return (
    <ol className="flex flex-wrap items-stretch gap-2">
      {request.steps.map((s) => {
        const isCurrent = request.status === 'PENDING' && s.sequence === request.currentStep;
        const tone =
          s.status === 'APPROVED'
            ? 'border-success-200 bg-success-50/70 text-success-800'
            : s.status === 'REJECTED'
              ? 'border-danger-200 bg-danger-50/70 text-danger-800'
              : isCurrent
                ? 'border-warning-300 bg-warning-50/70 text-warning-900'
                : 'border-slate-200 bg-slate-50/70 text-slate-500';
        return (
          <li key={s.sequence} className={`rounded-lg border px-3 py-2 text-xs ${tone}`}>
            <div className="flex items-center gap-1.5 font-semibold">
              <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-white/70 text-xs">
                {s.sequence}
              </span>
              {ar ? s.role.nameAr : s.role.nameEn}
              {s.status === 'APPROVED' && <Icon name="check" className="h-3 w-3" />}
              {s.status === 'REJECTED' && <Icon name="x" className="h-3 w-3" />}
              {isCurrent && <Icon name="clock" className="h-3 w-3" />}
            </div>
            <div className="mt-0.5 text-xs opacity-80">
              {s.decidedBy
                ? `${ar ? s.decidedBy.nameAr : s.decidedBy.nameEn} · ${formatDateTime(s.decidedAt, locale)}`
                : isCurrent
                  ? t('apr.awaiting')
                  : '—'}
            </div>
            {s.note && <div className="mt-1 max-w-[22rem] text-xs italic opacity-90">“{s.note}”</div>}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * A compact "this document is in the matrix" strip for a document's own page,
 * so nobody has to guess why the approve button stopped doing anything.
 */
export function ApprovalBanner({ request }: { request: ApprovalRequestView }) {
  const { locale, t } = useI18n();
  const ar = locale === 'ar';
  const current = request.steps.find((s) => s.sequence === request.currentStep);
  return (
    <div className="mb-4 rounded-xl border border-warning-200 bg-warning-50/60 p-4">
      <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-warning-900">
        <Icon name="stamp" className="h-4 w-4" />
        {t('apr.awaiting')}
        <span className="text-xs font-normal">
          {t('apr.stepOf')
            .replace('{n}', String(request.currentStep))
            .replace('{total}', String(request.steps.length))}
          {current ? ` · ${t('apr.pendingOn').replace('{role}', ar ? current.role.nameAr : current.role.nameEn)}` : ''}
        </span>
      </div>
      <div className="mt-3">
        <ApprovalChain request={request} />
      </div>
    </div>
  );
}

/** Everything waiting on the signed-in user's role, with the two decisions. */
export function ApprovalInbox({ onDecided }: { onDecided?: () => void }) {
  const { locale, t } = useI18n();
  const { act, busy } = useAct();
  const ar = locale === 'ar';

  const [rows, setRows] = useState<ApprovalRequestView[] | null>(null);
  const [err, setErr] = useState('');
  const [decide, setDecide] = useState<{ req: ApprovalRequestView; approve: boolean } | null>(null);
  const [note, setNote] = useState('');

  const load = useCallback(() => {
    setErr('');
    api
      .get<ApprovalRequestView[]>('/approvals/inbox')
      .then(setRows)
      .catch((e) => setErr(translateError(e, locale)));
  }, [locale]);
  useEffect(load, [load]);

  async function submit() {
    if (!decide) return;
    const ok = await act('decide', () =>
      api.post(`/approvals/${decide.req.id}/decide`, {
        decision: decide.approve ? 'APPROVE' : 'REJECT',
        note: note.trim() || undefined,
      }),
    );
    if (ok) {
      setDecide(null);
      setNote('');
      load();
      onDecided?.();
    }
  }

  if (err) return <LoadError message={err} onRetry={load} />;
  if (!rows) return <TableSkeleton cols={4} />;

  return (
    <>
      <div className="card overflow-hidden">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th scope="col" className="th">{t('apr.document')}</th>
              <th scope="col" className="th text-end">{t('apr.amount')}</th>
              <th scope="col" className="th">{t('apr.raisedBy')}</th>
              <th scope="col" className="th">{t('apr.chain')}</th>
              <th scope="col" className="th text-end">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 ? (
              <EmptyRow colSpan={5} text={t('apr.empty')} />
            ) : (
              rows.map((r) => (
                <tr key={r.id}>
                  <td className="td">
                    <div className="font-mono text-xs text-slate-500">{r.documentCode}</div>
                    <div className="text-xs font-semibold text-slate-700">
                      {ar ? DOC_LABEL[r.documentType].ar : DOC_LABEL[r.documentType].en}
                    </div>
                    {r.documentType === 'PROPOSAL' && (
                      <Link
                        href={`/proposals/${r.documentId}`}
                        className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-brand-700 underline"
                      >
                        <Icon name="file-text" className="h-3 w-3" />
                        {t('apr.openDocument')}
                      </Link>
                    )}
                  </td>
                  <td className="td-num font-semibold text-slate-800">
                    {formatMoney(r.amount, locale)}
                  </td>
                  <td className="td text-xs">
                    {r.raisedBy ? (ar ? r.raisedBy.nameAr : r.raisedBy.nameEn) : '—'}
                    <div className="text-xs text-slate-500">{formatDateTime(r.createdAt, locale)}</div>
                  </td>
                  <td className="td">
                    <ApprovalChain request={r} />
                  </td>
                  <td className="td">
                    {r.canDecide === false ? (
                      // Shown, not hidden: if this user is the only holder of
                      // the role, the chain is stuck and that must be visible.
                      <div className="text-end text-xs leading-5 text-warning-700">
                        {r.blockedReason === 'ALREADY_SIGNED'
                          ? t('apr.blocked.alreadySigned')
                          : t('apr.blocked.raisedByYou')}
                      </div>
                    ) : (
                      <div className="flex justify-end gap-1.5">
                        <Btn
                          sm
                          variant="primary"
                          icon="check-circle"
                          disabled={busy()}
                          onClick={() => {
                            setNote('');
                            setDecide({ req: r, approve: true });
                          }}
                        >
                          {t('apr.approve')}
                        </Btn>
                        <Btn
                          sm
                          icon="x"
                          variant="danger"
                          disabled={busy()}
                          onClick={() => {
                            setNote('');
                            setDecide({ req: r, approve: false });
                          }}
                        >
                          {t('apr.reject')}
                        </Btn>
                      </div>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Modal
        open={!!decide}
        title={decide?.approve ? t('apr.approveTitle') : t('apr.rejectTitle')}
        onClose={() => setDecide(null)}
        dirty={note.trim().length > 0}
      >
        {decide && (
          <form
            className="grid gap-4"
            onSubmit={(ev) => {
              ev.preventDefault();
              submit();
            }}
          >
            <div className="rounded-lg bg-slate-50 p-3 text-sm">
              <div className="font-mono text-xs text-slate-500">{decide.req.documentCode}</div>
              <div className="mt-0.5 font-semibold text-slate-800">
                {ar ? DOC_LABEL[decide.req.documentType].ar : DOC_LABEL[decide.req.documentType].en}
                {' · '}
                {formatMoney(decide.req.amount, locale)}
              </div>
            </div>
            <p className="text-sm leading-6 text-slate-600">
              {decide.approve
                ? decide.req.currentStep >= decide.req.steps.length
                  ? t('apr.approveMsg')
                  : t('apr.stepOf')
                      .replace('{n}', String(decide.req.currentStep))
                      .replace('{total}', String(decide.req.steps.length))
                : t('apr.rejectMsg')}
            </p>
            <Field label={decide.approve ? t('apr.note') : t('apr.rejectNote')}>
              <textarea
                className="input min-h-[72px]"
                required={!decide.approve}
                maxLength={500}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Btn onClick={() => setDecide(null)}>{t('common.cancel')}</Btn>
              <Btn
                type="submit"
                variant={decide.approve ? 'primary' : 'danger'}
                busy={busy('decide')}
                disabled={busy()}
              >
                {decide.approve ? t('apr.approve') : t('apr.reject')}
              </Btn>
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}

/** Every chain this organization has opened — the control view. */
export function ApprovalHistory() {
  const { locale, t } = useI18n();
  const ar = locale === 'ar';
  const [data, setData] = useState<{ total: number; rows: ApprovalRequestView[] } | null>(null);
  const [err, setErr] = useState('');
  const [docType, setDocType] = useState('');
  const [status, setStatus] = useState('');

  const load = useCallback(() => {
    setErr('');
    const qs = new URLSearchParams();
    if (docType) qs.set('documentType', docType);
    if (status) qs.set('status', status);
    api
      .get<{ total: number; rows: ApprovalRequestView[] }>(`/approvals/history?${qs}`)
      .then(setData)
      .catch((e) => setErr(translateError(e, locale)));
  }, [locale, docType, status]);
  useEffect(load, [load]);

  if (err) return <LoadError message={err} onRetry={load} />;

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-end gap-3 card-title">
        <label className="block">
          <span className="mb-1 block text-xs text-slate-500">{t('apr.document')}</span>
          <select className="input py-1.5 text-xs" value={docType} onChange={(e) => setDocType(e.target.value)}>
            <option value="">{t('apr.allDocs')}</option>
            {(Object.keys(DOC_LABEL) as ApprovalDocType[]).map((k) => (
              <option key={k} value={k}>
                {ar ? DOC_LABEL[k].ar : DOC_LABEL[k].en}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-slate-500">{t('common.status')}</span>
          <select className="input py-1.5 text-xs" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">{t('apr.allStatuses')}</option>
            {/* Status words, not the button verbs — these have to read the
                same as the badge in the row beside them. */}
            <option value="PENDING">{t('apr.st.pending')}</option>
            <option value="APPROVED">{t('apr.st.approved')}</option>
            <option value="REJECTED">{t('apr.st.rejected')}</option>
          </select>
        </label>
        {data && (
          <span className="ms-auto text-xs text-slate-500">
            {t('apr.total')}: {data.total}
          </span>
        )}
      </div>
      {!data ? (
        <TableSkeleton cols={5} />
      ) : (
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th scope="col" className="th">{t('apr.document')}</th>
              <th scope="col" className="th text-end">{t('apr.amount')}</th>
              <th scope="col" className="th">{t('apr.raisedBy')}</th>
              <th scope="col" className="th">{t('common.status')}</th>
              <th scope="col" className="th">{t('apr.chain')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.rows.length === 0 ? (
              <EmptyRow colSpan={5} text={t('apr.historyEmpty')} />
            ) : (
              data.rows.map((r) => (
                <tr key={r.id}>
                  <td className="td">
                    <div className="font-mono text-xs text-slate-500">{r.documentCode}</div>
                    <div className="text-xs font-semibold text-slate-700">
                      {ar ? DOC_LABEL[r.documentType].ar : DOC_LABEL[r.documentType].en}
                    </div>
                  </td>
                  <td className="td-num font-semibold text-slate-800">{formatMoney(r.amount, locale)}</td>
                  <td className="td text-xs">
                    {r.raisedBy ? (ar ? r.raisedBy.nameAr : r.raisedBy.nameEn) : '—'}
                    <div className="text-xs text-slate-500">{formatDateTime(r.createdAt, locale)}</div>
                  </td>
                  <td className="td">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="td">
                    <ApprovalChain request={r} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
