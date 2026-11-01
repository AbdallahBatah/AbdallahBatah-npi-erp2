'use client';

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { useToast } from '@/components/toast';
import { formatMoney, formatDate } from '@/lib/format';
import { PageHeader, StatusBadge, EmptyRow, Modal, Field, LoadError, useConfirm, Can, Btn, PageSkeleton } from '@/components/ui';
import { ApprovalBanner, type ApprovalRequestView } from '@/components/approvals';

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
  /** P4-5: DRAFT → INSPECTED → ACCEPTED | PARTIALLY_REJECTED. Only an accepted receipt is billed. */
  status: string;
  rejectionNote?: string | null;
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
  /** P4-5: DRAFT (recorded) → MATCHED (three-way) → APPROVED (journal) → SCHEDULED. */
  vendorBills: Array<{ id: string; code: string; status: string; total: string; vendorRef: string | null; createdAt: string }>;
  /** P4-4: delivery place and date set while the requisition was sourced. */
  deliveryLocation?: { code: string; nameAr: string; nameEn: string } | null;
  expectedDelivery?: string | null;
  /** Set while the PO is sitting in the approval matrix (package و). */
  pendingApproval: ApprovalRequestView | null;
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
  const [billGrn, setBillGrn] = useState<string | null>(null);
  const [rejectId, setRejectId] = useState<string | null>(null);

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
    // The same click means two different things depending on the matrix, so
    // the toast has to read the answer rather than assume "approved".
    let res: { pendingApproval?: ApprovalRequestView | null } | undefined;
    const ok = await act(
      'approve',
      async () => {
        res = await api.post(`/procurement/purchase-orders/${id}/approve`, {});
      },
      { success: false },
    );
    if (ok) {
      toast.success(res?.pendingApproval ? t('apr.sentForApproval') : t('common.done'));
      load();
    }
  }

  async function send() {
    if (
      !(await confirm({ title: t('confirm.sendPoTitle'), message: t('confirm.sendPoMsg') }))
    )
      return;
    if (await act('send', () => api.post(`/procurement/purchase-orders/${id}/send`, {}))) load();
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

  // P4-5: recording the vendor's invoice posts nothing; approving it does.
  async function bill(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!billGrn) return;
    const vendorRef = String(new FormData(e.currentTarget).get('vendorRef') || '').trim() || undefined;
    if (await act(`bill:${billGrn}`, () => api.post('/procurement/bills', { goodsReceiptId: billGrn, vendorRef }))) {
      setBillGrn(null);
      load();
    }
  }

  /** One receipt or bill step: inspect, accept, match, approve, schedule. */
  async function step(key: string, path: string, comment?: string) {
    if (await act(key, () => api.post(path, comment ? { comment } : {}))) load();
  }

  async function rejectGrn(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!rejectId) return;
    const comment = String(new FormData(e.currentTarget).get('comment') || '').trim();
    if (await act(`rej:${rejectId}`, () => api.post(`/procurement/receipts/${rejectId}/reject`, { comment }))) {
      setRejectId(null);
      load();
    }
  }

  async function approveBill(billId: string) {
    if (!(await confirm({ title: t('confirm.postBillTitle'), message: t('confirm.postBillMsg'), danger: true }))) return;
    await step(`bapprove:${billId}`, `/procurement/bills/${billId}/approve`);
  }

  if (loadErr && !po) return <LoadError message={loadErr} onRetry={load} />;
  if (!po) return <PageSkeleton stats={3} />;
  // Same rule as the server's receive(): goods are booked against an order the
  // vendor was sent, so APPROVED is not receivable until the send step.
  const receivable = ['SENT', 'PARTIALLY_RECEIVED'].includes(po.status);

  return (
    <div>
      <PageHeader
        title={`${po.code} — ${pick(po.vendor, 'name')}`}
        backHref="/procurement"
        backLabel={t('po.title')}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={po.status} />
            <Can perm="scm.procurement.write">
              {po.status === 'DRAFT' && !po.pendingApproval && (
                <Btn variant="primary" sm icon="check-circle" busy={busy('approve')} disabled={busy()} onClick={approve}>
                  {t('po.approve')}
                </Btn>
              )}
              {po.status === 'APPROVED' && !po.pendingApproval && (
                <Btn variant="primary" sm icon="upload" busy={busy('send')} disabled={busy()} onClick={send}>
                  {t('po.send')}
                </Btn>
              )}
              {receivable && (
                <Btn variant="solar" sm icon="package" disabled={busy()} onClick={openReceive}>
                  {t('po.receive')}
                </Btn>
              )}
            </Can>
          </div>
        }
      />
      {confirmNode}

      {po.pendingApproval && <ApprovalBanner request={po.pendingApproval} />}

      {(po.deliveryLocation || po.expectedDelivery) && (
        <p className="mb-4 text-sm text-slate-600">
          {po.deliveryLocation && (
            <span className="me-4">
              {t('pr.deliverTo')}: {po.deliveryLocation.code} · {pick(po.deliveryLocation, 'name')}
            </span>
          )}
          {po.expectedDelivery && (
            <span>
              {t('pr.col.neededBy')}: {formatDate(po.expectedDelivery, locale)}
            </span>
          )}
        </p>
      )}

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
          <p className="mt-1 font-medium text-warning-700">{formatMoney(po.vatAmount, locale)}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-slate-500">{t('po.total')}</p>
          <p className="mt-1 font-bold text-brand-700">{formatMoney(po.total, locale)}</p>
        </div>
      </div>

      {/* Lines */}
      <div className="card mt-6 overflow-hidden">
        <h2 className="card-title">
          {t('po.lines')}
        </h2>
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th scope="col" className="th">{t('po.item')}</th>
              <th scope="col" className="th">{t('po.wbs')}</th>
              <th scope="col" className="th text-end">{t('po.qty')}</th>
              <th scope="col" className="th text-end">{t('po.received')}</th>
              <th scope="col" className="th text-end">{t('po.unitPrice')}</th>
              <th scope="col" className="th text-end">{t('common.total')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {po.lines.map((l) => (
              <tr key={l.id}>
                <td className="td">
                  <span className="font-mono text-xs text-slate-500">{l.item.sku}</span>{' '}
                  {pick(l.item, 'name')}{l.item.isSerialised ? ' · S/N' : ''}
                </td>
                <td className="td text-xs">{l.wbsElement ? `${l.wbsElement.code}` : '—'}</td>
                <td className="td-num">{Number(l.qty)}</td>
                <td className="td-num">
                  <span className={Number(l.receivedQty) >= Number(l.qty) ? 'text-success-700' : ''}>
                    {Number(l.receivedQty)}
                  </span>
                </td>
                <td className="td-num">{formatMoney(l.unitPrice, locale)}</td>
                <td className="td-num">{formatMoney(l.lineTotal, locale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Receipts */}
      <div className="card mt-6 overflow-hidden">
        <h2 className="card-title">
          {t('po.receipts')}
        </h2>
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th scope="col" className="th">{t('common.code')}</th>
              <th scope="col" className="th">{t('common.date')}</th>
              <th scope="col" className="th">{t('common.status')}</th>
              <th scope="col" className="th text-center">{t('prj.serials')}</th>
              <th scope="col" className="th">{t('po.bill')}</th>
              <th scope="col" className="th">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {po.goodsReceipts.length === 0 ? (
              <EmptyRow colSpan={6} text={t('common.none')} />
            ) : (
              po.goodsReceipts.map((g) => (
                <tr key={g.id}>
                  <td className="td font-mono text-xs">{g.code}</td>
                  <td className="td text-xs text-slate-500">{formatDate(g.receivedAt, locale)}</td>
                  <td className="td">
                    <StatusBadge status={g.status} />
                    {g.rejectionNote && <p className="mt-1 text-xs text-danger-700">{g.rejectionNote}</p>}
                  </td>
                  <td className="td text-center">{g.serialUnits.length}</td>
                  <td className="td">
                    {g.vendorBills.length > 0 ? (
                      <span className="badge bg-success-100 text-success-700">
                        {g.vendorBills[0].code}
                      </span>
                    ) : (
                      <span className="text-xs text-slate-500">—</span>
                    )}
                  </td>
                  <td className="td">
                    <Can perm="scm.procurement.write">
                      <div className="flex flex-wrap gap-2">
                        {g.status === 'DRAFT' && (
                          <Btn sm icon="search" busy={busy(`insp:${g.id}`)} disabled={busy()} onClick={() => step(`insp:${g.id}`, `/procurement/receipts/${g.id}/inspect`)}>
                            {t('grn.inspect')}
                          </Btn>
                        )}
                        {g.status === 'INSPECTED' && (
                          <>
                            <Btn variant="primary" sm icon="check" busy={busy(`acc:${g.id}`)} disabled={busy()} onClick={() => step(`acc:${g.id}`, `/procurement/receipts/${g.id}/accept`)}>
                              {t('grn.accept')}
                            </Btn>
                            <Btn variant="danger" sm disabled={busy()} onClick={() => setRejectId(g.id)}>
                              {t('grn.rejectPartial')}
                            </Btn>
                          </>
                        )}
                        {g.status === 'ACCEPTED' && g.vendorBills.length === 0 && (
                          <Btn variant="primary" sm icon="receipt" disabled={busy()} onClick={() => setBillGrn(g.id)}>
                            {t('po.createBill')}
                          </Btn>
                        )}
                      </div>
                    </Can>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* P4-5: vendor bills — record → three-way match → approve (journal) → schedule. */}
      <div className="card mt-6 overflow-hidden">
        <h2 className="card-title">{t('bill.title')}</h2>
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th scope="col" className="th">{t('common.code')}</th>
              <th scope="col" className="th">{t('bill.vendorRef')}</th>
              <th scope="col" className="th text-end">{t('po.total')}</th>
              <th scope="col" className="th">{t('common.status')}</th>
              <th scope="col" className="th">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {po.vendorBills.length === 0 ? (
              <EmptyRow colSpan={5} text={t('common.none')} />
            ) : (
              po.vendorBills.map((b) => (
                <tr key={b.id}>
                  <td className="td font-mono text-xs">{b.code}</td>
                  <td className="td text-xs">{b.vendorRef ?? '—'}</td>
                  <td className="td-num">{formatMoney(b.total, locale)}</td>
                  <td className="td">
                    <StatusBadge status={b.status} />
                  </td>
                  <td className="td">
                    <div className="flex flex-wrap gap-2">
                      {b.status === 'DRAFT' && (
                        <Can perm="scm.procurement.write">
                          <Btn sm icon="scale" busy={busy(`match:${b.id}`)} disabled={busy()} onClick={() => step(`match:${b.id}`, `/procurement/bills/${b.id}/match`)}>
                            {t('bill.match')}
                          </Btn>
                        </Can>
                      )}
                      {b.status === 'MATCHED' && (
                        <Can perm="finance.payment.write">
                          <Btn variant="primary" sm icon="check" busy={busy(`bapprove:${b.id}`)} disabled={busy()} onClick={() => approveBill(b.id)}>
                            {t('bill.approve')}
                          </Btn>
                        </Can>
                      )}
                      {b.status === 'APPROVED' && (
                        <Can perm="finance.payment.write">
                          <Btn sm icon="clock" busy={busy(`sched:${b.id}`)} disabled={busy()} onClick={() => step(`sched:${b.id}`, `/procurement/bills/${b.id}/schedule`)}>
                            {t('bill.schedule')}
                          </Btn>
                        </Can>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Modal open={!!billGrn} title={t('po.createBill')} onClose={() => setBillGrn(null)}>
        <form onSubmit={bill} className="space-y-4">
          <p className="text-xs text-slate-500">{t('bill.recordHint')}</p>
          <Field label={`${t('bill.vendorRef')} (${t('common.optional')})`}>
            <input name="vendorRef" className="input" maxLength={100} />
          </Field>
          <div className="flex justify-end gap-2">
            <Btn sm onClick={() => setBillGrn(null)}>{t('common.cancel')}</Btn>
            <Btn type="submit" variant="primary" sm busy={busy(`bill:${billGrn}`)} disabled={busy()}>
              {t('po.createBill')}
            </Btn>
          </div>
        </form>
      </Modal>

      <Modal open={!!rejectId} title={t('grn.rejectPartial')} onClose={() => setRejectId(null)}>
        <form onSubmit={rejectGrn} className="space-y-4">
          <Field label={t('grn.rejectReason')}>
            <textarea name="comment" className="input" rows={3} required minLength={3} maxLength={1000} />
          </Field>
          <div className="flex justify-end gap-2">
            <Btn sm onClick={() => setRejectId(null)}>{t('common.cancel')}</Btn>
            <Btn type="submit" variant="danger" sm busy={busy(`rej:${rejectId}`)} disabled={busy()}>
              {t('grn.rejectPartial')}
            </Btn>
          </div>
        </form>
      </Modal>

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
                  <span className="font-mono text-xs text-slate-500">{l.item.sku}</span>{' '}
                  {pick(l.item, 'name')}{l.item.isSerialised ? ' · S/N' : ''}
                  <span className="ms-2 text-xs text-slate-500">
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
                            <span className={list.length === need ? 'text-success-700' : 'text-warning-700'}>
                              {t('po.serialCount')}: {list.length} / {need}
                            </span>
                            {dups.length > 0 && (
                              <span className="ms-3 text-danger-600">
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
            <Btn sm onClick={() => setROpen(false)}>{t('common.cancel')}</Btn>
            <Btn
              variant="primary"
              sm
              busy={busy('receive')}
              disabled={busy() || !Object.values(draft).some((d) => d.qty > 0)}
              onClick={receive}
            >
              {t('po.receive')}
            </Btn>
          </div>
        </div>
      </Modal>
    </div>
  );
}
