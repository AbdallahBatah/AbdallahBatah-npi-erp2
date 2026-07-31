'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { useValidate } from '@/lib/useValidate';
import { translateError } from '@/lib/errors';
import { useEnums } from '@/lib/useEnums';
import { formatMoney } from '@/lib/format';
import { PageHeader, StatusBadge, Modal, Field, LoadError, useConfirm } from '@/components/ui';

interface Item { id: string; sku: string; nameAr: string; nameEn: string; unitCost: string }
interface Scheme { id: string; code: string; nameAr: string; nameEn: string; marginPct: string }
interface BomLine { id: string; qty: string; unitPrice: string; lineTotal: string; item: Item }
interface Revision {
  id: string;
  revisionNo: number;
  subtotal: string;
  marginAmount: string;
  totalAmount: string;
  status: string;
  isWinning: boolean;
  bomLines: BomLine[];
  designVersion?: { capacityKwp: string; expectedAnnualKwh: string; sourceTool: string } | null;
}
interface Proposal {
  id: string;
  code: string;
  status: string;
  opportunity: { id: string; name: string; customer: { id: string; nameAr: string; nameEn: string } };
  revisions: Revision[];
}

interface DraftLine { itemId: string; qty: number; unitPrice: number }

export default function ProposalDetailPage() {
  const { t, locale, pick } = useI18n();
  const enums = useEnums();
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;

  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [schemes, setSchemes] = useState<Scheme[]>([]);
  const [lines, setLines] = useState<DraftLine[]>([{ itemId: '', qty: 1, unitPrice: 0 }]);
  const [schemeId, setSchemeId] = useState('');
  const [capacityKwp, setCapacityKwp] = useState('');
  const [annualKwh, setAnnualKwh] = useState('');
  const [contractOpen, setContractOpen] = useState(false);
  const [loadErr, setLoadErr] = useState('');
  const { act, busy } = useAct();
  const { confirm, confirmNode } = useConfirm();

  const load = useCallback(() => {
    setLoadErr('');
    api
      .get<Proposal>(`/proposals/${id}`)
      .then(setProposal)
      .catch((e) => setLoadErr(translateError(e, locale)));
  }, [id, locale]);

  useEffect(() => {
    load();
    api.get<Item[]>('/items').then(setItems).catch(() => {});
    api.get<Scheme[]>('/reference/pricing-schemes').then(setSchemes).catch(() => {});
  }, [load]);

  const draftSubtotal = useMemo(
    () => lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0),
    [lines],
  );
  const marginPct = Number(schemes.find((s) => s.id === schemeId)?.marginPct ?? 0);
  const draftTotal = draftSubtotal * (1 + marginPct / 100);

  const winning = proposal?.revisions.find((r) => r.isWinning);

  // The design figures are optional, but if one is given the other is expected
  // and neither may be negative — the server would reject silently otherwise.
  const validation = useValidate(
    { capacityKwp, annualKwh, lines },
    {
      capacityKwp: (v) =>
        Number(v.capacityKwp) < 0
          ? t('valid.negative')
          : v.annualKwh && !v.capacityKwp
            ? t('valid.needBoth')
            : undefined,
      annualKwh: (v) =>
        Number(v.annualKwh) < 0
          ? t('valid.negative')
          : v.capacityKwp && !v.annualKwh
            ? t('valid.needBoth')
            : undefined,
      lines: (v) =>
        v.lines.some((l) => l.itemId && (!l.qty || l.qty <= 0))
          ? t('valid.qtyPositive')
          : v.lines.filter((l) => l.itemId && l.qty > 0).length === 0
            ? t('valid.needLine')
            : undefined,
    },
  );

  function updateLine(i: number, patch: Partial<DraftLine>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }
  function addLine() {
    setLines((prev) => [...prev, { itemId: '', qty: 1, unitPrice: 0 }]);
  }
  function removeLine(i: number) {
    setLines((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function submitRevision(e: FormEvent) {
    e.preventDefault();
    // Reveals every message at once rather than failing on the server.
    if (!validation.validateAll()) return;
    const valid = lines.filter((l) => l.itemId && l.qty > 0);
    const ok = await act(
      'revision',
      () =>
        api.post(`/proposals/${id}/revisions`, {
          pricingSchemeId: schemeId || undefined,
          bomLines: valid.map((l) => ({
            itemId: l.itemId,
            qty: Number(l.qty),
            unitPrice: Number(l.unitPrice),
          })),
          designVersion:
            capacityKwp || annualKwh
              ? {
                  sourceTool: 'manual',
                  capacityKwp: Number(capacityKwp) || 0,
                  expectedAnnualKwh: Number(annualKwh) || 0,
                }
              : undefined,
        }),
      { success: t('common.created') },
    );
    if (ok) {
      setLines([{ itemId: '', qty: 1, unitPrice: 0 }]);
      setCapacityKwp('');
      setAnnualKwh('');
      validation.reset();
      load();
    }
  }

  async function accept(revId: string) {
    if (!(await confirm({ title: t('confirm.acceptRevTitle'), message: t('confirm.acceptRevMsg') })))
      return;
    if (await act(`accept:${revId}`, () => api.post(`/proposals/${id}/revisions/${revId}/accept`, {})))
      load();
  }

  async function createContract(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!winning) return;
    const f = new FormData(e.currentTarget);
    // A milestone counts as filled with EITHER language; mirror the other so
    // Arabic-only entry no longer silently drops milestones.
    const milestones = [1, 2, 3]
      .map((n) => {
        const ar = String(f.get(`m${n}_ar`) || '').trim();
        const en = String(f.get(`m${n}_en`) || '').trim();
        return {
          sequence: n,
          descriptionAr: ar || en,
          descriptionEn: en || ar,
          amount: Number(f.get(`m${n}_amt`) || 0),
          triggerType: 'PROGRESS' as const,
        };
      })
      .filter((m) => m.amount > 0 && m.descriptionEn);
    let cid: string | null = null;
    const ok = await act('contract', async () => {
      const c = await api.post<{ id: string }>('/contracts', {
        proposalRevisionId: winning.id,
        contractType: f.get('contractType'),
        retentionPct: Number(f.get('retentionPct') || 0),
        advancePct: Number(f.get('advancePct') || 0),
        milestones,
      });
      cid = c.id;
    });
    if (ok && cid) router.push(`/contracts/${cid}`);
  }

  if (loadErr) return <LoadError message={loadErr} onRetry={load} />;
  if (!proposal) {
    return <div className="text-slate-400">{t('common.loading')}</div>;
  }

  return (
    <div>
      <PageHeader
        title={`${proposal.code} · ${proposal.opportunity.name}`}
        action={
          <div className="flex items-center gap-2">
            <StatusBadge status={proposal.status} />
            <Link href="/proposals" className="btn-ghost text-xs">
              {t('common.back')}
            </Link>
          </div>
        }
      />

      {/* Existing revisions */}
      <div className="space-y-4">
        {proposal.revisions.map((rev) => (
          <div key={rev.id} className="card p-5">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="font-semibold text-slate-800">
                  {t('proposals.revision')} #{rev.revisionNo}
                </span>
                <StatusBadge status={rev.status} />
                {rev.isWinning && (
                  <span className="badge bg-emerald-100 text-emerald-700">★ {t('proposals.accepted')}</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {!rev.isWinning && proposal.status !== 'ACCEPTED' && (
                  <button
                    className="btn-solar !px-3 !py-1 text-xs"
                    disabled={busy()}
                    onClick={() => accept(rev.id)}
                  >
                    {busy(`accept:${rev.id}`) ? t('common.loading') : t('proposals.accept')}
                  </button>
                )}
              </div>
            </div>

            {rev.designVersion && (
              <p className="mb-3 text-xs text-slate-500">
                {t('proposals.design')}: {Number(rev.designVersion.capacityKwp)} kWp ·{' '}
                {Number(rev.designVersion.expectedAnnualKwh)} kWh/y
              </p>
            )}

            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-xs text-slate-500">
                  <th className="py-2 text-start">{t('proposals.item')}</th>
                  <th className="py-2 text-end">{t('proposals.qty')}</th>
                  <th className="py-2 text-end">{t('proposals.unitPrice')}</th>
                  <th className="py-2 text-end">{t('common.total')}</th>
                </tr>
              </thead>
              <tbody>
                {rev.bomLines.map((bl) => (
                  <tr key={bl.id} className="border-b border-slate-50">
                    <td className="py-2">{bl.item.sku} · {pick(bl.item, 'name')}</td>
                    <td className="py-2 text-end">{Number(bl.qty)}</td>
                    <td className="py-2 text-end">{formatMoney(bl.unitPrice, locale)}</td>
                    <td className="py-2 text-end">{formatMoney(bl.lineTotal, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="mt-3 flex flex-col items-end gap-1 text-sm">
              <span className="text-slate-500">
                {t('proposals.subtotal')}: {formatMoney(rev.subtotal, locale)}
              </span>
              <span className="text-slate-500">
                {t('proposals.margin')}: {formatMoney(rev.marginAmount, locale)}
              </span>
              <span className="text-base font-bold text-slate-900">
                {t('common.total')}: {formatMoney(rev.totalAmount, locale)}
              </span>
            </div>

            {rev.isWinning && (
              <div className="mt-4 border-t border-slate-100 pt-4">
                <button className="btn-primary" onClick={() => setContractOpen(true)}>
                  {t('proposals.createContract')} →
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* New revision builder */}
      {proposal.status !== 'ACCEPTED' && (
        <form onSubmit={submitRevision} className="card mt-6 p-5">
          <h3 className="mb-4 font-semibold text-slate-800">{t('proposals.addRevision')}</h3>

          <div className="mb-4 grid grid-cols-3 gap-4">
            <Field label={t('proposals.pricingScheme')}>
              <select className="input" value={schemeId} onChange={(e) => setSchemeId(e.target.value)}>
                <option value="">{t('proposals.marginPct')}: 0%</option>
                {schemes.map((s) => (
                  <option key={s.id} value={s.id}>
                    {pick(s, 'name')} ({Number(s.marginPct)}%)
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('proposals.capacity')} error={validation.errorOf('capacityKwp')}>
              <input
                type="number"
                step="0.001"
                min={0}
                className="input"
                value={capacityKwp}
                onChange={(e) => setCapacityKwp(e.target.value)}
                onBlur={() => validation.onBlur('capacityKwp')}
              />
            </Field>
            <Field label={t('proposals.annualKwh')} error={validation.errorOf('annualKwh')}>
              <input
                type="number"
                step="0.01"
                min={0}
                className="input"
                value={annualKwh}
                onChange={(e) => setAnnualKwh(e.target.value)}
                onBlur={() => validation.onBlur('annualKwh')}
              />
            </Field>
          </div>

          <label className="label">{t('proposals.bom')}</label>
          {validation.errorOf('lines') && (
            <p role="alert" className="mb-2 text-[11px] font-medium text-danger-600">
              {validation.errorOf('lines')}
            </p>
          )}
          <div className="space-y-2">
            {lines.map((l, i) => (
              <div key={i} className="flex items-center gap-2">
                <select
                  className="input flex-1"
                  value={l.itemId}
                  onChange={(e) => {
                    const it = items.find((x) => x.id === e.target.value);
                    updateLine(i, {
                      itemId: e.target.value,
                      unitPrice: it ? Number(it.unitCost) : l.unitPrice,
                    });
                  }}
                >
                  <option value="">—</option>
                  {items.map((it) => (
                    <option key={it.id} value={it.id}>
                      {it.sku} · {pick(it, 'name')}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  step="0.001"
                  min={0}
                  className={`input w-24 ${l.itemId && (!l.qty || l.qty <= 0) ? '!border-danger-300' : ''}`}
                  placeholder={t('proposals.qty')}
                  value={l.qty}
                  onChange={(e) => updateLine(i, { qty: Number(e.target.value) })}
                  onBlur={() => validation.onBlur('lines')}
                />
                <input
                  type="number"
                  step="0.01"
                  className="input w-28"
                  placeholder={t('proposals.unitPrice')}
                  value={l.unitPrice}
                  onChange={(e) => updateLine(i, { unitPrice: Number(e.target.value) })}
                />
                <span className="w-28 text-end text-sm text-slate-500">
                  {formatMoney((Number(l.qty) || 0) * (Number(l.unitPrice) || 0), locale)}
                </span>
                <button
                  type="button"
                  className="text-slate-300 hover:text-rose-500"
                  onClick={() => removeLine(i)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>

          <button type="button" className="btn-ghost mt-2 text-xs" onClick={addLine}>
            + {t('proposals.addLine')}
          </button>

          <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-4">
            <div className="text-sm text-slate-600">
              {t('proposals.subtotal')}: {formatMoney(draftSubtotal, locale)} ·{' '}
              <span className="font-semibold text-slate-900">
                {t('common.total')}: {formatMoney(draftTotal, locale)}
              </span>
            </div>
            <button type="submit" className="btn-primary" disabled={busy()}>
              {busy('revision') ? t('common.loading') : t('proposals.addRevision')}
            </button>
          </div>
        </form>
      )}

      {/* Create-contract modal */}
      <Modal open={contractOpen} title={t('proposals.createContract')} onClose={() => setContractOpen(false)}>
        <form onSubmit={createContract} className="space-y-4">
          <div className="grid grid-cols-3 gap-4">
            <Field label={t('contracts.type')}>
              <select name="contractType" className="input" defaultValue="EPC">
                {enums?.contractTypes.map((o) => (
                  <option key={o.value} value={o.value}>
                    {locale === 'ar' ? o.labelAr : o.labelEn}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('contracts.retention')}>
              <input name="retentionPct" type="number" step="0.1" className="input" defaultValue="5" />
            </Field>
            <Field label={t('contracts.advance')}>
              <input name="advancePct" type="number" step="0.1" className="input" defaultValue="20" />
            </Field>
          </div>

          <p className="text-xs font-medium text-slate-500">{t('contracts.milestones')}</p>
          {[1, 2, 3].map((n) => (
            <div key={n} className="grid grid-cols-4 gap-2">
              <input name={`m${n}_ar`} className="input" placeholder={`مرحلة ${n} (ع)`} />
              <input name={`m${n}_en`} className="input" placeholder={`Milestone ${n} (en)`} />
              <input
                name={`m${n}_amt`}
                type="number"
                step="0.01"
                className="input col-span-2"
                placeholder={t('contracts.amount')}
              />
            </div>
          ))}

          <p className="text-xs text-slate-400">
            {t('common.value')}: {winning ? formatMoney(winning.totalAmount, locale) : '—'}
          </p>

          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => setContractOpen(false)}>
              {t('common.cancel')}
            </button>
            <button type="submit" className="btn-primary" disabled={busy()}>
              {busy('contract') ? t('common.loading') : t('proposals.createContract')}
            </button>
          </div>
        </form>
      </Modal>
      {confirmNode}
    </div>
  );
}
