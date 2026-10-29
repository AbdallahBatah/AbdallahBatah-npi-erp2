'use client';

/**
 * Package 4 · P4-2 / P4-3 (ADR-04 §4-2, §4-3) — one material request.
 * Engineer: edit/submit/cancel, confirm receipt of a voucher.
 * Projects GM: approve/reject (never their own). Keeper: issue a voucher from a
 * store, cancel it while in transit, raise a purchase requisition for the shortage.
 */
import { FormEvent, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { formatDate } from '@/lib/format';
import { useLookup } from '@/lib/lookups';
import { PageHeader, StatusBadge, LoadError, Modal, Field, Can, Btn, PageSkeleton, useConfirm } from '@/components/ui';

interface Named { id: string; code: string; nameAr: string; nameEn: string }
interface Line {
  id: string;
  itemId: string;
  qty: string;
  issuedQty: string;
  receivedQty: string;
  purchasedQty: string;
  item: { id: string; sku: string; nameAr: string; nameEn: string; uom: string; isSerialised: boolean };
  wbsElement: Named | null;
}
interface Issue {
  id: string;
  code: string;
  status: string;
  issuedAt: string;
  receivedAt: string | null;
  fromLocation: Named;
  toLocation: Named;
  lines: Array<{ requestLineId: string; qty: string; serialUnitIds: string[] }>;
}
interface Detail {
  id: string;
  code: string;
  status: string;
  requestedById: string;
  neededBy: string | null;
  notes: string | null;
  rejectionNote: string | null;
  createdAt: string;
  project: Named & { projectManagerId: string | null };
  lines: Line[];
  issues: Issue[];
  requisitions: Array<{ id: string; code: string; status: string }>;
}
interface StockRow {
  requestLineId: string;
  left: string;
  available: string;
  units: Array<{ id: string; serialNo: string }>;
}

const n = (v: string | number) => Number(v);

export default function MaterialRequestPage() {
  const { id } = useParams<{ id: string }>();
  const { t, locale, pick } = useI18n();
  const { user, can } = useAuth();
  const [mr, setMr] = useState<Detail | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const { act, busy } = useAct();
  const { confirm, confirmNode } = useConfirm();
  const [rejectOpen, setRejectOpen] = useState(false);
  const [issueOpen, setIssueOpen] = useState(false);
  const [fromId, setFromId] = useState('');
  const [stock, setStock] = useState<StockRow[]>([]);
  const [qtys, setQtys] = useState<Record<string, string>>({});
  const [serials, setSerials] = useState<Record<string, string[]>>({});
  const [issueErr, setIssueErr] = useState('');
  const locations = useLookup<Named & { locationType?: string }>('locations', { enabled: issueOpen });

  const load = useCallback(() => {
    setLoadErr('');
    api
      .get<Detail>(`/material-requests/${id}`)
      .then(setMr)
      .catch((e) => setLoadErr(translateError(e, locale)));
  }, [id, locale]);
  useEffect(load, [load]);

  // What the chosen store can send for each line still owed.
  useEffect(() => {
    if (!issueOpen || !fromId) {
      setStock([]);
      return;
    }
    api
      .get<StockRow[]>(`/material-requests/${id}/stock?fromLocationId=${encodeURIComponent(fromId)}`)
      .then((rows) => {
        setStock(rows);
        setQtys(Object.fromEntries(rows.map((r) => [r.requestLineId, String(Math.min(n(r.left), n(r.available)) > 0 ? Math.min(n(r.left), n(r.available)) : '')])));
        setSerials({});
      })
      .catch((e) => setIssueErr(translateError(e, locale)));
  }, [issueOpen, fromId, id, locale]);

  if (loadErr && !mr) return <LoadError message={loadErr} onRetry={load} />;
  if (!mr) return <PageSkeleton stats={0} />;

  const mine = user?.id === mr.requestedById;
  const engineerHere = mine || user?.id === mr.project.projectManagerId;
  const open = ['APPROVED', 'PARTIAL'].includes(mr.status);
  const shortage = mr.lines.some((l) => n(l.qty) - n(l.issuedQty) - n(l.purchasedQty) > 0);
  const lineOf = (lineId: string) => mr.lines.find((l) => l.id === lineId);

  const post = (key: string, path: string, body: unknown = {}) =>
    act(key, async () => {
      await api.post(path, body);
      load();
    });

  async function reject(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const note = String(new FormData(e.currentTarget).get('note') || '').trim();
    const ok = await post('reject', `/material-requests/${id}/reject`, { note });
    if (ok) setRejectOpen(false);
  }

  async function issue(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const lines = stock
      .map((s) => {
        const l = lineOf(s.requestLineId)!;
        const ids = serials[s.requestLineId] ?? [];
        const qty = l.item.isSerialised ? ids.length : n(qtys[s.requestLineId] || 0);
        return { requestLineId: s.requestLineId, qty, serialUnitIds: l.item.isSerialised ? ids : undefined };
      })
      .filter((x) => x.qty > 0);
    if (!fromId || lines.length === 0) {
      setIssueErr(t('mr.err.issue'));
      return;
    }
    setIssueErr('');
    const notes = String(new FormData(e.currentTarget).get('notes') || '').trim() || undefined;
    const ok = await post('issue', `/material-requests/${id}/issues`, { fromLocationId: fromId, notes, lines });
    if (ok) setIssueOpen(false);
  }

  async function raiseShortage() {
    if (!(await confirm({ title: t('mr.shortage'), message: t('mr.shortageConfirm') }))) return;
    await post('shortage', `/material-requests/${id}/requisition`);
  }

  return (
    <div className="space-y-6">
      {confirmNode}
      <PageHeader
        title={`${t('mr.one')} ${mr.code}`}
        backHref="/requisitions/materials"
        backLabel={t('mr.title')}
        action={
          <div className="flex flex-wrap gap-2">
            {mine && mr.status === 'DRAFT' && (
              <Btn variant="primary" busy={busy('submit')} disabled={busy()} onClick={() => post('submit', `/material-requests/${id}/submit`)}>
                {t('mr.submit')}
              </Btn>
            )}
            {mine && ['DRAFT', 'SUBMITTED'].includes(mr.status) && (
              <Btn busy={busy('cancel')} disabled={busy()} onClick={() => post('cancel', `/material-requests/${id}/cancel`)}>
                {t('mr.cancel')}
              </Btn>
            )}
            {!mine && mr.status === 'SUBMITTED' && can('scm.procurement.approve') && (
              <>
                <Btn variant="primary" busy={busy('approve')} disabled={busy()} onClick={() => post('approve', `/material-requests/${id}/approve`)}>
                  {t('mr.approve')}
                </Btn>
                <Btn onClick={() => setRejectOpen(true)}>{t('mr.reject')}</Btn>
              </>
            )}
            {open && (
              <Can perm="scm.procurement.write">
                <Btn variant="primary" icon="plus" onClick={() => { setIssueErr(''); setIssueOpen(true); }}>
                  {t('mr.issue')}
                </Btn>
                {shortage && (
                  <Btn busy={busy('shortage')} disabled={busy()} onClick={raiseShortage}>
                    {t('mr.shortage')}
                  </Btn>
                )}
              </Can>
            )}
          </div>
        }
      />

      <div className="card grid grid-cols-1 gap-4 p-5 text-sm sm:grid-cols-4">
        <div>
          <p className="label">{t('mr.project')}</p>
          <Link href={`/projects/${mr.project.id}`} className="text-brand-700 hover:underline">
            {mr.project.code} · {pick(mr.project, 'name')}
          </Link>
        </div>
        <div>
          <p className="label">{t('common.status')}</p>
          <StatusBadge status={mr.status} />
        </div>
        <div>
          <p className="label">{t('mr.neededBy')}</p>
          {mr.neededBy ? formatDate(mr.neededBy, locale) : '—'}
        </div>
        <div>
          <p className="label">{t('mr.requisitions')}</p>
          {mr.requisitions.length === 0
            ? '—'
            : mr.requisitions.map((r) => (
                <Link key={r.id} href={`/requisitions/${r.id}`} className="me-2 font-mono text-xs text-brand-700 hover:underline">
                  {r.code}
                </Link>
              ))}
        </div>
        {mr.notes && <p className="sm:col-span-4 text-slate-600">{mr.notes}</p>}
        {mr.status === 'REJECTED' && mr.rejectionNote && (
          <p role="alert" className="sm:col-span-4 rounded-md bg-danger-50 p-3 text-danger-700">
            {t('mr.rejectedBecause')}: {mr.rejectionNote}
          </p>
        )}
      </div>

      <div className="card table-sticky">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <th scope="col" className="th">{t('proposals.item')}</th>
              <th scope="col" className="th">{t('mr.budgetLine')}</th>
              <th scope="col" className="th text-end">{t('mr.requested')}</th>
              <th scope="col" className="th text-end">{t('mr.issued')}</th>
              <th scope="col" className="th text-end">{t('mr.received')}</th>
              <th scope="col" className="th text-end">{t('mr.purchased')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {mr.lines.map((l) => (
              <tr key={l.id}>
                <td className="td">
                  <span className="font-mono text-xs text-slate-500">{l.item.sku}</span> {pick(l.item, 'name')}
                </td>
                <td className="td text-xs">{l.wbsElement ? `${l.wbsElement.code} · ${pick(l.wbsElement, 'name')}` : '—'}</td>
                <td className="td-num">{n(l.qty)} {l.item.uom}</td>
                <td className="td-num">{n(l.issuedQty)}</td>
                <td className="td-num">{n(l.receivedQty)}</td>
                <td className="td-num">{n(l.purchasedQty)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-slate-700">{t('mr.vouchers')}</h2>
        {mr.issues.length === 0 ? (
          <p className="text-sm text-slate-500">{t('mr.noVouchers')}</p>
        ) : (
          <div className="space-y-3">
            {mr.issues.map((iss) => (
              <div key={iss.id} className="card p-4 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-semibold">{iss.code}</span>
                    <StatusBadge status={iss.status} />
                    <span className="text-xs text-slate-500">
                      {iss.fromLocation.code} → {iss.toLocation.code} · {formatDate(iss.issuedAt, locale)}
                    </span>
                  </div>
                  {iss.status === 'ISSUED' && (
                    <div className="flex gap-2">
                      {engineerHere && can('scm.requisition.write') && (
                        <Btn variant="primary" busy={busy(`rcv-${iss.id}`)} disabled={busy()} onClick={() => post(`rcv-${iss.id}`, `/material-requests/issues/${iss.id}/receive`)}>
                          {t('mr.confirmReceipt')}
                        </Btn>
                      )}
                      <Can perm="scm.procurement.write">
                        <Btn busy={busy(`cxl-${iss.id}`)} disabled={busy()} onClick={() => post(`cxl-${iss.id}`, `/material-requests/issues/${iss.id}/cancel`)}>
                          {t('mr.cancelVoucher')}
                        </Btn>
                      </Can>
                    </div>
                  )}
                </div>
                <ul className="mt-2 space-y-1 text-xs text-slate-600">
                  {iss.lines.map((il) => {
                    const l = lineOf(il.requestLineId);
                    return (
                      <li key={il.requestLineId}>
                        {l ? `${l.item.sku} · ${pick(l.item, 'name')}` : il.requestLineId} — {n(il.qty)} {l?.item.uom}
                        {il.serialUnitIds.length > 0 ? ` (${il.serialUnitIds.length} ${t('mr.units')})` : ''}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      <Modal open={rejectOpen} title={t('mr.reject')} onClose={() => setRejectOpen(false)}>
        <form onSubmit={reject} className="space-y-4">
          <Field label={t('mr.rejectReason')}>
            <textarea name="note" className="input" rows={3} required minLength={3} maxLength={1000} />
          </Field>
          <div className="flex justify-end gap-2">
            <Btn onClick={() => setRejectOpen(false)}>{t('common.cancel')}</Btn>
            <Btn type="submit" variant="primary" busy={busy('reject')} disabled={busy()}>
              {t('mr.reject')}
            </Btn>
          </div>
        </form>
      </Modal>

      <Modal open={issueOpen} title={t('mr.issue')} onClose={() => setIssueOpen(false)}>
        <form onSubmit={issue} className="space-y-4">
          <Field label={t('mr.fromStore')}>
            <select className="input" value={fromId} onChange={(e) => setFromId(e.target.value)} disabled={locations.state !== 'ready'}>
              <option value="">—</option>
              {locations.rows
                .filter((l) => l.locationType !== 'SITE')
                .map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.code} · {pick(l, 'name')}
                  </option>
                ))}
            </select>
          </Field>
          {issueErr && (
            <p role="alert" className="text-xs font-medium text-danger-600">
              {issueErr}
            </p>
          )}
          {stock.length > 0 && (
            <div className="space-y-3">
              {stock.map((s) => {
                const l = lineOf(s.requestLineId);
                if (!l || n(s.left) <= 0) return null;
                return (
                  <div key={s.requestLineId} className="rounded-md border border-slate-200 p-3 text-sm">
                    <p className="font-medium">
                      {l.item.sku} · {pick(l.item, 'name')}
                    </p>
                    <p className="text-xs text-slate-500">
                      {t('mr.left')}: {n(s.left)} · {t('mr.available')}: {n(s.available)}
                    </p>
                    {l.item.isSerialised ? (
                      <select
                        multiple
                        aria-label={t('mr.units')}
                        className="input mt-2 h-28"
                        value={serials[s.requestLineId] ?? []}
                        onChange={(e) =>
                          setSerials((p) => ({
                            ...p,
                            [s.requestLineId]: Array.from(e.target.selectedOptions).map((o) => o.value).slice(0, n(s.left)),
                          }))
                        }
                      >
                        {s.units.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.serialNo}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="number"
                        min={0}
                        max={Math.min(n(s.left), n(s.available))}
                        step="0.001"
                        aria-label={t('proposals.qty')}
                        className="input mt-2 w-32"
                        value={qtys[s.requestLineId] ?? ''}
                        onChange={(e) => setQtys((p) => ({ ...p, [s.requestLineId]: e.target.value }))}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <Field label={`${t('leads.notes')} (${t('common.optional')})`}>
            <textarea name="notes" className="input" rows={2} maxLength={1000} />
          </Field>
          <div className="flex justify-end gap-2">
            <Btn onClick={() => setIssueOpen(false)}>{t('common.cancel')}</Btn>
            <Btn type="submit" variant="primary" busy={busy('issue')} disabled={busy() || !fromId}>
              {t('mr.issue')}
            </Btn>
          </div>
        </form>
      </Modal>
    </div>
  );
}
