'use client';

/**
 * Printable ZATCA-style tax invoice / credit note. The browser's print engine
 * is the PDF renderer (perfect Arabic shaping, zero server dependencies):
 * the print button opens the dialog and "Save as PDF" does the rest.
 * @media print rules in globals.css strip the app chrome.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { translateError } from '@/lib/errors';
import { formatMoney, formatDate } from '@/lib/format';
import { LoadError } from '@/components/ui';
import { Icon } from '@/components/icons';

interface Line {
  id: string;
  descriptionAr: string;
  descriptionEn: string;
  qty: string;
  unitPrice: string;
  lineSubtotal: string;
  vatAmount: string;
}
interface Invoice {
  id: string;
  code: string;
  status: string;
  invoiceType: string;
  issueDate: string;
  currency: string;
  subtotal: string;
  vatAmount: string;
  retentionAmount: string;
  total: string;
  netPayable: string;
  creditReason?: string | null;
  organization?: {
    legalNameAr: string;
    legalNameEn: string;
    vatNumber?: string | null;
    crNumber?: string | null;
    addressAr?: string | null;
    addressEn?: string | null;
    phone?: string | null;
    email?: string | null;
    website?: string | null;
    logoDataUrl?: string | null;
  };
  customer?: { nameAr: string; nameEn: string; vatNumber?: string | null; crNumber?: string | null };
  contract?: { code: string } | null;
  creditedInvoice?: { id: string; code: string } | null;
  lines: Line[];
  eInvoice?: { uuid: string; invoiceHash: string } | null;
  qrDataUrl?: string | null;
}

/** Bilingual label pair — the fiscal document carries both languages. */
function L({ ar, en }: { ar: string; en: string }) {
  return (
    <span>
      {ar} <span className="text-slate-400">/ {en}</span>
    </span>
  );
}

export default function InvoicePrintPage() {
  const { t, locale } = useI18n();
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [inv, setInv] = useState<Invoice | null>(null);
  const [loadErr, setLoadErr] = useState('');

  const load = useCallback(() => {
    setLoadErr('');
    api
      .get<Invoice>(`/finance/invoices/${id}`)
      .then(setInv)
      .catch((e) => setLoadErr(translateError(e, locale)));
  }, [id, locale]);
  useEffect(load, [load]);

  if (loadErr) return <LoadError message={loadErr} onRetry={load} />;
  if (!inv) return <div className="text-slate-400">{t('common.loading')}</div>;

  const isCreditNote = inv.invoiceType === 'CREDIT_NOTE';
  const org = inv.organization;
  const cus = inv.customer;

  return (
    <div>
      {/* Screen-only toolbar */}
      <div className="no-print mb-4 flex items-center justify-between gap-3">
        <p className="text-xs text-slate-500">{t('print.hintScreen')}</p>
        <div className="flex gap-2">
          <button className="btn-primary text-xs" onClick={() => window.print()}>
            <Icon name="printer" className="me-1.5 inline h-4 w-4" />
            {t('print.button')}
          </button>
          <Link href={`/invoices/${inv.id}`} className="btn-ghost text-xs">
            {t('common.back')}
          </Link>
        </div>
      </div>

      {/* The A4 sheet */}
      <div className="print-sheet mx-auto max-w-[820px] rounded-xl border border-slate-200 bg-white p-8 shadow-card lg:p-10" dir="rtl">
        {/* Header */}
        <div className="flex items-start justify-between gap-6 border-b-2 border-slate-800 pb-5">
          <div className="flex items-start gap-3">
            {org?.logoDataUrl && (
              <img src={org.logoDataUrl} alt="" className="h-14 w-14 shrink-0 rounded object-contain" />
            )}
            <div>
              <h1 className="text-lg font-extrabold text-slate-900">{org?.legalNameAr}</h1>
              <p className="text-sm text-slate-500">{org?.legalNameEn}</p>
              <div className="mt-2 space-y-0.5 text-xs text-slate-600">
                {org?.vatNumber && (
                  <p>
                    <L ar={t('print.vatNo')} en="VAT No." />: <span dir="ltr" className="font-mono">{org.vatNumber}</span>
                  </p>
                )}
                {org?.crNumber && (
                  <p>
                    <L ar={t('print.crNo')} en="CR No." />: <span dir="ltr" className="font-mono">{org.crNumber}</span>
                  </p>
                )}
                {(org?.addressAr || org?.addressEn) && (
                  <p>{locale === 'ar' ? org?.addressAr || org?.addressEn : org?.addressEn || org?.addressAr}</p>
                )}
                {(org?.phone || org?.email) && (
                  <p dir="ltr" className="font-mono">
                    {[org?.phone, org?.email].filter(Boolean).join(' · ')}
                  </p>
                )}
              </div>
            </div>
          </div>
          <div className="text-center">
            <p className={`rounded-lg px-4 py-1.5 text-sm font-extrabold ${isCreditNote ? 'bg-rose-50 text-rose-800' : 'bg-slate-100 text-slate-900'}`}>
              {isCreditNote ? (
                <L ar={t('print.creditNote')} en="Credit Note" />
              ) : (
                <L ar={t('print.taxInvoice')} en="Tax Invoice" />
              )}
            </p>
            <p className="mt-2 font-mono text-base font-bold text-slate-900" dir="ltr">{inv.code}</p>
            <p className="mt-0.5 text-xs text-slate-500">
              {t('print.issueDate')}: {formatDate(inv.issueDate, locale)}
            </p>
          </div>
          {inv.qrDataUrl && (
            // Plain <img>: the QR is a data URL — next/image adds nothing here.
            <img src={inv.qrDataUrl} alt="ZATCA QR" width={110} height={110} className="shrink-0 rounded border border-slate-200" />
          )}
        </div>

        {/* Parties */}
        <div className="grid grid-cols-2 gap-6 border-b border-slate-200 py-4 text-sm">
          <div>
            <p className="mb-1 text-xs font-bold text-slate-400">
              <L ar={t('print.seller')} en="Seller" />
            </p>
            <p className="font-semibold text-slate-800">{org?.legalNameAr}</p>
            <p className="text-xs text-slate-500">{org?.legalNameEn}</p>
          </div>
          <div>
            <p className="mb-1 text-xs font-bold text-slate-400">
              <L ar={t('print.buyer')} en="Buyer" />
            </p>
            <p className="font-semibold text-slate-800">{cus?.nameAr}</p>
            <p className="text-xs text-slate-500">{cus?.nameEn}</p>
            {cus?.vatNumber && (
              <p className="mt-1 text-xs text-slate-600">
                {t('print.vatNo')}: <span dir="ltr" className="font-mono">{cus.vatNumber}</span>
              </p>
            )}
          </div>
        </div>

        {/* References */}
        {(inv.contract || inv.creditedInvoice || inv.creditReason) && (
          <div className="flex flex-wrap gap-x-8 gap-y-1 border-b border-slate-200 py-3 text-xs text-slate-600">
            {inv.contract && (
              <span>
                {t('print.contract')}: <span className="font-mono">{inv.contract.code}</span>
              </span>
            )}
            {inv.creditedInvoice && (
              <span>
                {t('cn.against')}: <span className="font-mono">{inv.creditedInvoice.code}</span>
              </span>
            )}
            {inv.creditReason && (
              <span>
                {t('cn.reason')}: {inv.creditReason}
              </span>
            )}
          </div>
        )}

        {/* Lines */}
        <table className="mt-4 min-w-full text-sm">
          <thead>
            <tr className="border-b-2 border-slate-300 text-xs text-slate-500">
              <th className="py-2 text-start font-semibold">
                <L ar={t('inv.description')} en="Description" />
              </th>
              <th className="py-2 text-end font-semibold">
                <L ar={t('inv.qty')} en="Qty" />
              </th>
              <th className="py-2 text-end font-semibold">
                <L ar={t('inv.unitPrice')} en="Unit price" />
              </th>
              <th className="py-2 text-end font-semibold">
                <L ar={t('inv.vat')} en="VAT" />
              </th>
              <th className="py-2 text-end font-semibold">
                <L ar={t('common.total')} en="Total" />
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {inv.lines.map((l) => (
              <tr key={l.id}>
                <td className="py-2.5 pe-3">
                  <p className="text-slate-800">{l.descriptionAr}</p>
                  <p className="text-xs text-slate-400">{l.descriptionEn}</p>
                </td>
                <td className="py-2.5 text-end">{Number(l.qty)}</td>
                <td className="py-2.5 text-end">{formatMoney(l.unitPrice, locale)}</td>
                <td className="py-2.5 text-end">{formatMoney(l.vatAmount, locale)}</td>
                <td className="py-2.5 text-end font-semibold">{formatMoney(l.lineSubtotal, locale)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Totals */}
        <div className="mt-4 flex justify-end">
          <div className="w-72 space-y-1.5 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-500">
                <L ar={t('inv.subtotal')} en="Subtotal" />
              </span>
              <span>{formatMoney(inv.subtotal, locale)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">
                <L ar={t('inv.vat')} en="VAT 15%" />
              </span>
              <span>{formatMoney(inv.vatAmount, locale)}</span>
            </div>
            <div className="flex justify-between border-t-2 border-slate-800 pt-1.5 text-base font-extrabold text-slate-900">
              <span>
                <L ar={t('inv.total')} en="Grand total" />
              </span>
              <span>
                {formatMoney(inv.total, locale)} <span className="text-xs font-normal">{inv.currency}</span>
              </span>
            </div>
            {Number(inv.retentionAmount) > 0 && (
              <>
                <div className="flex justify-between text-slate-500">
                  <span>− {t('inv.retention')}</span>
                  <span>{formatMoney(inv.retentionAmount, locale)}</span>
                </div>
                <div className="flex justify-between border-t border-dashed border-slate-300 pt-1.5 font-bold">
                  <span>{t('inv.netPayable')}</span>
                  <span>{formatMoney(inv.netPayable, locale)}</span>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="mt-8 border-t border-slate-200 pt-4 text-center text-[10px] leading-relaxed text-slate-400">
          <p>{t('print.generatedBy')}</p>
          {inv.eInvoice && (
            <p className="mt-1 font-mono" dir="ltr">
              UUID: {inv.eInvoice.uuid}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
