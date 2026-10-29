'use client';

/**
 * طلبات الشراء — the requisition list.
 *
 * The document §7 starts the purchasing cycle with, and the one the system
 * never had: before it, the first record of a spend was the purchase order, so
 * the request and the commitment were the same piece of paper.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { useLookup } from '@/lib/lookups';
import { formatDate, formatMoney } from '@/lib/format';
import {
  Btn,
  EmptyRow,
  Field,
  LoadError,
  Modal,
  PageHeader,
  StatusBadge,
  TableSkeleton,
} from '@/components/ui';

interface RequisitionRow {
  id: string;
  code: string;
  justification: string;
  status: string;
  estimatedTotal: string | number;
  neededBy: string | null;
  createdAt: string;
  department: { id: string; nameAr: string; nameEn: string } | null;
  project: { id: string; code: string } | null;
  requestedBy: { id: string; nameAr: string; nameEn: string } | null;
  purchaseOrder: { id: string; code: string; status: string } | null;
  _count: { lines: number };
}

interface ItemOption {
  id: string;
  sku: string;
  nameAr: string;
  nameEn: string;
  // null for a user without finance.costs.view — the price is then left blank.
  unitCost: string | number | null;
}

interface DraftLine {
  itemId: string;
  qty: string;
  estimatedUnitPrice: string;
}

export default function RequisitionsPage() {
  const { locale, t } = useI18n();
  const { can } = useAuth();
  const { act, busy } = useAct();
  const ar = locale === 'ar';

  const [rows, setRows] = useState<RequisitionRow[] | null>(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(false);
  // The item list comes with scm.requisition.write itself (ADR-02 §3-3): a
  // requester picks an item without holding the item catalogue screen.
  // Asked for when the dialog opens.
  const itemList = useLookup<ItemOption>('items', { enabled: open });
  const items = itemList.rows;
  const itemsUnavailable = itemList.state === 'unavailable';
  const [justification, setJustification] = useState('');
  const [neededBy, setNeededBy] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([{ itemId: '', qty: '1', estimatedUnitPrice: '' }]);

  const load = useCallback(() => {
    setErr('');
    api
      .get<{ total: number; rows: RequisitionRow[] }>('/requisitions')
      .then((r) => setRows(r.rows))
      .catch((e) => setErr(translateError(e, locale)));
  }, [locale]);
  useEffect(load, [load]);

  const total = lines.reduce(
    (s, l) => s + (Number(l.qty) || 0) * (Number(l.estimatedUnitPrice) || 0),
    0,
  );

  const submit = async () => {
    const payload = {
      justification: justification.trim(),
      neededBy: neededBy || undefined,
      lines: lines
        .filter((l) => l.itemId && Number(l.qty) > 0)
        .map((l) => ({
          itemId: l.itemId,
          qty: Number(l.qty),
          estimatedUnitPrice: l.estimatedUnitPrice ? Number(l.estimatedUnitPrice) : undefined,
        })),
    };
    const ok = await act('create', () => api.post('/requisitions', payload));
    if (ok) {
      setOpen(false);
      setJustification('');
      setNeededBy('');
      setLines([{ itemId: '', qty: '1', estimatedUnitPrice: '' }]);
      load();
    }
  };

  return (
    <div>
      <PageHeader
        title={t('pr.title')}
        subtitle={t('pr.hint')}
        action={
          <div className="flex flex-wrap gap-2">
            {/* P4-2: the project material requests live under this screen. */}
            <Link href="/requisitions/materials" className="btn-ghost">
              {t('mr.title')}
            </Link>
            {can('scm.requisition.write') ? (
              <Btn variant="primary" icon="plus" onClick={() => setOpen(true)}>
                {t('pr.new')}
              </Btn>
            ) : null}
          </div>
        }
      />

      {err && <LoadError message={err} onRetry={load} />}

      {!err && (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3 text-start">{t('pr.col.code')}</th>
                <th className="px-4 py-3 text-start">{t('pr.col.justification')}</th>
                <th className="px-4 py-3 text-start">{t('pr.col.department')}</th>
                <th className="px-4 py-3 text-start">{t('pr.col.estimated')}</th>
                <th className="px-4 py-3 text-start">{t('pr.col.status')}</th>
                <th className="px-4 py-3 text-start">{t('pr.col.neededBy')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows === null && <TableSkeleton cols={6} />}
              {rows?.length === 0 && <EmptyRow colSpan={6} text={t('pr.empty')} />}
              {rows?.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50/60">
                  <td className="px-4 py-3">
                    <Link
                      href={`/requisitions/${r.id}`}
                      className="font-semibold text-brand-700 hover:underline"
                    >
                      {r.code}
                    </Link>
                    {r.purchaseOrder && (
                      <div className="mt-0.5 text-xs text-slate-500">→ {r.purchaseOrder.code}</div>
                    )}
                  </td>
                  <td className="max-w-xs truncate px-4 py-3 text-slate-600" title={r.justification}>
                    {r.justification}
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {r.department ? (ar ? r.department.nameAr : r.department.nameEn) : '—'}
                  </td>
                  <td className="px-4 py-3 tabular-nums text-slate-700">
                    {formatMoney(Number(r.estimatedTotal), locale)}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {r.neededBy ? formatDate(r.neededBy, locale) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title={t('pr.new')}>
        <div className="space-y-4">
          {/* Required, and said so plainly: an approver's first question is
              "why", and a requisition that cannot answer it wastes their time
              and the requester's. */}
          <Field label={t('pr.f.justification')} hint={t('pr.f.justificationHint')}>
            <textarea
              className="input min-h-[4.5rem]"
              value={justification}
              onChange={(e) => setJustification(e.target.value)}
            />
          </Field>

          <Field label={t('pr.f.neededBy')}>
            <input
              type="date"
              className="input"
              value={neededBy}
              onChange={(e) => setNeededBy(e.target.value)}
            />
          </Field>

          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              {t('pr.f.lines')}
            </div>
            {itemsUnavailable && (
              <p className="mb-2 text-xs text-slate-500">{t('lookup.unavailable')}</p>
            )}
            <div className="space-y-2">
              {lines.map((l, i) => (
                <div key={i} className="grid grid-cols-12 gap-2">
                  <select
                    className="input col-span-6"
                    disabled={itemsUnavailable}
                    value={l.itemId}
                    onChange={(e) => {
                      const itemId = e.target.value;
                      const item = items.find((it) => it.id === itemId);
                      setLines((prev) =>
                        prev.map((row, idx) =>
                          idx === i
                            ? {
                                ...row,
                                itemId,
                                // Default to the catalogue price so the line
                                // carries a number the matrix can band on.
                                estimatedUnitPrice:
                                  row.estimatedUnitPrice ||
                                  (item && item.unitCost != null ? String(Number(item.unitCost)) : ''),
                              }
                            : row,
                        ),
                      );
                    }}
                  >
                    <option value="">{t('pr.f.pickItem')}</option>
                    {items.map((it) => (
                      <option key={it.id} value={it.id}>
                        {it.sku} — {ar ? it.nameAr : it.nameEn}
                      </option>
                    ))}
                  </select>
                  <input
                    className="input col-span-2"
                    inputMode="decimal"
                    value={l.qty}
                    onChange={(e) =>
                      setLines((prev) =>
                        prev.map((row, idx) => (idx === i ? { ...row, qty: e.target.value } : row)),
                      )
                    }
                    placeholder={t('pr.f.qty')}
                  />
                  <input
                    className="input col-span-3"
                    inputMode="decimal"
                    value={l.estimatedUnitPrice}
                    onChange={(e) =>
                      setLines((prev) =>
                        prev.map((row, idx) =>
                          idx === i ? { ...row, estimatedUnitPrice: e.target.value } : row,
                        ),
                      )
                    }
                    placeholder={t('pr.f.unitPrice')}
                  />
                  <button
                    type="button"
                    className="btn-ghost btn-sm col-span-1"
                    aria-label={t('common.delete')}
                    onClick={() => setLines((prev) => prev.filter((_, idx) => idx !== i))}
                    disabled={lines.length === 1}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <Btn
              variant="ghost"
              icon="plus"
              sm
              className="mt-2"
              onClick={() =>
                setLines((prev) => [...prev, { itemId: '', qty: '1', estimatedUnitPrice: '' }])
              }
            >
              {t('pr.f.addLine')}
            </Btn>
          </div>

          <div className="flex items-center justify-between rounded-lg bg-slate-50 px-4 py-3 text-sm">
            <span className="text-slate-500">{t('pr.f.estimatedTotal')}</span>
            <span className="font-semibold tabular-nums text-slate-800">
              {formatMoney(total, locale)}
            </span>
          </div>

          <div className="flex justify-end gap-2">
            <Btn variant="ghost" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Btn>
            <Btn
              variant="primary"
              busy={busy('create')}
              disabled={!justification.trim() || !lines.some((l) => l.itemId)}
              onClick={submit}
            >
              {t('common.create')}
            </Btn>
          </div>
        </div>
      </Modal>
    </div>
  );
}
