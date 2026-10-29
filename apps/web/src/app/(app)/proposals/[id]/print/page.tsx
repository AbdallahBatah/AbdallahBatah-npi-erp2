'use client';

/**
 * Package 3 · P3-7 (ADR-03 §4-6, owner work cycle step 7) — the printable quote.
 * As with the tax invoice, the browser's print engine is the PDF renderer
 * ("Save as PDF"); the server-side PDF comes with ADR-01's engine in package 2.
 * Selling side only: GET /proposals/:id/print never returns a cost.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { translateError } from '@/lib/errors';
import { formatDate, formatMoney, formatNumber } from '@/lib/format';
import { LoadError, PageSkeleton } from '@/components/ui';
import { Icon } from '@/components/icons';

interface Quote {
  code: string;
  currency: string;
  organization: {
    legalNameAr: string;
    legalNameEn: string;
    vatNumber?: string | null;
    crNumber?: string | null;
    addressAr?: string | null;
    phone?: string | null;
    email?: string | null;
    logoDataUrl?: string | null;
  };
  customer: { nameAr: string; nameEn: string; vatNumber?: string | null; crNumber?: string | null; mobile?: string | null };
  projectName: string;
  siteLocation: string | null;
  revisionNo: number;
  issuedAt: string;
  validUntil: string | null;
  pricingMode: 'PER_LINE' | 'LUMP_SUM';
  capacityKwp: string | null;
  lines: { id: string; nameAr: string; nameEn: string; qty: string; uom: string | null; unitPrice: string | null; lineTotal: string | null }[];
  totals: { net: string; vatRate: number; vat: string; gross: string };
}

export default function QuotePrintPage() {
  const { t, locale } = useI18n();
  const params = useParams<{ id: string }>();
  const id = params.id;
  // Read once from the URL (as the admin page does) rather than through
  // useSearchParams, which would force a Suspense boundary on the route.
  const [revision, setRevision] = useState<string | null | undefined>(undefined);
  useEffect(() => setRevision(new URLSearchParams(window.location.search).get('revision')), []);
  const [q, setQ] = useState<Quote | null>(null);
  const [loadErr, setLoadErr] = useState('');

  const load = useCallback(() => {
    if (revision === undefined) return; // the URL has not been read yet
    setLoadErr('');
    api
      .get<Quote>(`/proposals/${id}/print${revision ? `?revision=${encodeURIComponent(revision)}` : ''}`)
      .then(setQ)
      .catch((e) => setLoadErr(translateError(e, locale)));
  }, [id, revision, locale]);
  useEffect(load, [load]);

  if (loadErr) return <LoadError message={loadErr} onRetry={load} />;
  if (!q) return <PageSkeleton stats={2} />;

  const lump = q.pricingMode === 'LUMP_SUM';
  const org = q.organization;

  return (
    <div>
      <div className="no-print mb-4 flex items-center justify-between gap-3">
        <p className="text-xs text-slate-500">{t('print.hintScreen')}</p>
        <div className="flex gap-2">
          <button className="btn-primary text-xs" onClick={() => window.print()}>
            <Icon name="printer" className="me-1.5 inline h-4 w-4" />
            {t('print.button')}
          </button>
          <Link href={`/proposals/${id}`} className="btn-ghost text-xs">
            {t('common.back')}
          </Link>
        </div>
      </div>

      <div className="print-sheet mx-auto max-w-[820px] rounded-xl border border-slate-200 bg-white p-8 shadow-card lg:p-10" dir="rtl">
        {/* Header */}
        <div className="flex items-start justify-between gap-6 border-b-2 border-slate-800 pb-5">
          <div className="flex items-start gap-3">
            {org.logoDataUrl && <img src={org.logoDataUrl} alt="" className="h-14 w-14 shrink-0 rounded object-contain" />}
            <div>
              <h1 className="text-lg font-extrabold text-slate-900">{org.legalNameAr}</h1>
              <p className="text-sm text-slate-500">{org.legalNameEn}</p>
              <div className="mt-2 space-y-0.5 text-xs text-slate-600">
                {org.crNumber && (
                  <p>
                    {t('print.crNo')}: <span dir="ltr" className="font-mono">{org.crNumber}</span>
                  </p>
                )}
                {org.vatNumber && (
                  <p>
                    {t('print.vatNo')}: <span dir="ltr" className="font-mono">{org.vatNumber}</span>
                  </p>
                )}
                {org.addressAr && <p>{org.addressAr}</p>}
                {(org.phone || org.email) && (
                  <p dir="ltr" className="font-mono">
                    {[org.phone, org.email].filter(Boolean).join(' · ')}
                  </p>
                )}
              </div>
            </div>
          </div>
          <div className="text-center">
            <p className="rounded-lg bg-slate-100 px-4 py-1.5 text-sm font-extrabold text-slate-900">
              {t('quote.title')} <span className="text-slate-500">/ Quotation</span>
            </p>
            <p className="mt-2 font-mono text-base font-bold text-slate-900" dir="ltr">
              {q.code}-R{q.revisionNo}
            </p>
            <p className="mt-0.5 text-xs text-slate-500">
              {t('quote.date')}: {formatDate(q.issuedAt, locale)}
            </p>
            {q.validUntil && (
              <p className="text-xs text-slate-500">
                {t('proposals.validUntil')}: {formatDate(q.validUntil, locale)}
              </p>
            )}
          </div>
        </div>

        {/* Customer and project */}
        <div className="grid grid-cols-2 gap-6 border-b border-slate-200 py-4 text-sm">
          <div>
            <p className="mb-1 text-xs font-bold text-slate-500">{t('quote.to')}</p>
            <p className="font-semibold text-slate-800">{q.customer.nameAr}</p>
            {q.customer.nameEn !== q.customer.nameAr && <p className="text-xs text-slate-500">{q.customer.nameEn}</p>}
            {q.customer.crNumber && (
              <p className="mt-1 text-xs text-slate-600">
                {t('print.crNo')}: <span dir="ltr" className="font-mono">{q.customer.crNumber}</span>
              </p>
            )}
            {q.customer.vatNumber && (
              <p className="text-xs text-slate-600">
                {t('print.vatNo')}: <span dir="ltr" className="font-mono">{q.customer.vatNumber}</span>
              </p>
            )}
          </div>
          <div>
            <p className="mb-1 text-xs font-bold text-slate-500">{t('quote.project')}</p>
            <p className="font-semibold text-slate-800">{q.projectName}</p>
            {q.siteLocation && (
              <p className="text-xs text-slate-600">
                {t('leads.siteLocation')}: {q.siteLocation}
              </p>
            )}
            {q.capacityKwp && (
              <p className="text-xs text-slate-600">
                {t('templates.capacity')}: {formatNumber(q.capacityKwp, locale)}
              </p>
            )}
          </div>
        </div>

        {/* Scope */}
        <p className="mt-4 text-sm font-bold text-slate-800">{lump ? t('quote.scope') : t('proposals.bom')}</p>
        <table className="mt-2 min-w-full text-sm">
          <thead>
            <tr className="border-b-2 border-slate-300 text-xs text-slate-500">
              <th className="w-10 py-2 text-start font-semibold">#</th>
              <th className="py-2 text-start font-semibold">{t('inv.description')}</th>
              <th className="py-2 text-end font-semibold">{t('inv.qty')}</th>
              <th className="py-2 text-start font-semibold">{t('items.uom')}</th>
              {!lump && <th className="py-2 text-end font-semibold">{t('inv.unitPrice')}</th>}
              {!lump && <th className="py-2 text-end font-semibold">{t('common.total')}</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {q.lines.map((l, i) => (
              <tr key={l.id}>
                <td className="py-2.5 text-slate-500">{i + 1}</td>
                <td className="py-2.5 pe-3">
                  <p className="text-slate-800">{l.nameAr}</p>
                  {l.nameEn && <p className="text-xs text-slate-500">{l.nameEn}</p>}
                </td>
                <td className="py-2.5 text-end">{formatNumber(l.qty, locale)}</td>
                <td className="py-2.5">{l.uom ?? '—'}</td>
                {!lump && <td className="py-2.5 text-end">{formatMoney(l.unitPrice ?? 0, locale)}</td>}
                {!lump && <td className="py-2.5 text-end font-semibold">{formatMoney(l.lineTotal ?? 0, locale)}</td>}
              </tr>
            ))}
          </tbody>
        </table>

        {/* Price */}
        <div className="mt-4 flex justify-end">
          <div className="w-80 space-y-1.5 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-500">{lump ? t('quote.lumpSum') : t('inv.subtotal')}</span>
              <span>{formatMoney(q.totals.net, locale)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">
                {t('inv.vat')} {q.totals.vatRate}%
              </span>
              <span>{formatMoney(q.totals.vat, locale)}</span>
            </div>
            <div className="flex justify-between border-t-2 border-slate-800 pt-1.5 text-base font-extrabold text-slate-900">
              <span>{t('inv.total')}</span>
              <span>
                {formatMoney(q.totals.gross, locale)} <span className="text-xs font-normal">{q.currency}</span>
              </span>
            </div>
          </div>
        </div>

        <div className="mt-8 border-t border-slate-200 pt-4 text-xs leading-relaxed text-slate-500">
          <p>{t('quote.note')}</p>
          <p className="mt-1 text-center">{t('print.generatedBy')}</p>
        </div>
      </div>
    </div>
  );
}
