'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { isOpenStage } from '@npi/shared';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { useEnums } from '@/lib/useEnums';
import { useLookup } from '@/lib/lookups';
import { formatDate, formatMoney } from '@/lib/format';
import { PageHeader, StatusBadge, Modal, Field, EmptyRow, LoadError, Can, Btn, TableSkeleton } from '@/components/ui';
import { OppTypeBadge, daysSince } from '@/components/opportunity-bits';

interface Customer { id: string; code: string; nameAr: string; nameEn: string }
interface Opportunity {
  id: string;
  code: string;
  name: string;
  stage: string;
  opportunityType: string;
  estimatedValue?: string | null;
  expectedCloseDate?: string | null;
  tenderCloseDate?: string | null;
  stageChangedAt?: string | null;
  createdAt: string;
  customer?: Customer;
  lossReason?: { nameAr: string; nameEn: string } | null;
  _count?: { proposals: number };
}

const COLS = 9;

export default function OpportunitiesPage() {
  const { t, locale, pick } = useI18n();
  const enums = useEnums();
  const router = useRouter();
  const [opps, setOpps] = useState<Opportunity[]>([]);
  // The create form's customer list, its own request (ADR-02 §3-3): earned by
  // crm.opportunity.write as well as crm.customer.read, and never able to take
  // the opportunity list down with it.
  const customerList = useLookup<Customer>('customers');
  const customers = customerList.rows;
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');
  const [open, setOpen] = useState(false);
  const [stageFilter, setStageFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  // The create form shows the tender fields only while «مناقصة» is chosen.
  const [newType, setNewType] = useState('DIRECT');
  const [tenderErr, setTenderErr] = useState('');
  const { act, busy } = useAct();

  const load = useCallback(() => {
    setLoading(true);
    setLoadErr('');
    api
      .get<Opportunity[]>('/opportunities')
      .then(setOpps)
      .catch((e) => setLoadErr(translateError(e, locale)))
      .finally(() => setLoading(false));
  }, [locale]);

  useEffect(load, [load]);

  // Opened from a dashboard quick action.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('new') === '1') setOpen(true);
  }, []);

  function openCreate() {
    setNewType('DIRECT');
    setTenderErr('');
    setOpen(true);
  }

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (k: string) => String(f.get(k) ?? '').trim();
    const num = (k: string) => (text(k) ? Number(text(k)) : undefined);
    const tender = newType === 'TENDER';
    if (tender && !text('tenderCloseDate')) {
      // The sentence the server answers with (it enforces the rule as well).
      setTenderErr(translateError(new ApiError(400, 'Tender close date is required'), locale));
      return;
    }
    setTenderErr('');
    const ok = await act(
      'create',
      () =>
        api.post('/opportunities', {
          name: text('name'),
          customerId: text('customerId'),
          opportunityType: newType,
          estimatedKwp: num('estimatedKwp'),
          estimatedValue: num('estimatedValue'),
          expectedCloseDate: text('expectedCloseDate') || undefined,
          ...(tender
            ? {
                tenderReference: text('tenderReference') || undefined,
                tenderCloseDate: text('tenderCloseDate') || undefined,
                bidBondAmount: num('bidBondAmount'),
                bidBondBank: text('bidBondBank') || undefined,
                bidBondExpiry: text('bidBondExpiry') || undefined,
                bidBondReference: text('bidBondReference') || undefined,
              }
            : {}),
        }),
      { success: t('common.created') },
    );
    if (ok) {
      setOpen(false);
      load();
    }
  }

  async function createProposal(oppId: string) {
    let pid: string | null = null;
    const ok = await act(`proposal:${oppId}`, async () => {
      const p = await api.post<{ id: string }>('/proposals', { opportunityId: oppId });
      pid = p.id;
    });
    if (ok && pid) router.push(`/proposals/${pid}`);
  }

  const shown = opps.filter(
    (o) => (!stageFilter || o.stage === stageFilter) && (!typeFilter || o.opportunityType === typeFilter),
  );

  return (
    <div>
      <PageHeader
        title={t('opps.title')}
        action={
          <Can perm="crm.opportunity.write">
            <Btn variant="primary" icon="plus" onClick={openCreate}>
              {t('opps.new')}
            </Btn>
          </Can>
        }
      />

      {loadErr && !loading ? <LoadError message={loadErr} onRetry={load} /> : null}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select
          className="input !w-56"
          aria-label={t('opps.stage')}
          value={stageFilter}
          onChange={(e) => setStageFilter(e.target.value)}
        >
          <option value="">
            {t('opps.stage')}: {t('common.all')}
          </option>
          {enums?.opportunityStages.map((o) => (
            <option key={o.value} value={o.value}>
              {locale === 'ar' ? o.labelAr : o.labelEn}
            </option>
          ))}
        </select>
        <select
          className="input !w-48"
          aria-label={t('opps.type')}
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
        >
          <option value="">
            {t('opps.type')}: {t('common.all')}
          </option>
          {enums?.opportunityTypes?.map((o) => (
            <option key={o.value} value={o.value}>
              {locale === 'ar' ? o.labelAr : o.labelEn}
            </option>
          ))}
        </select>
      </div>
      <div className="card table-sticky">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <th scope="col" className="th">{t('common.code')}</th>
              <th scope="col" className="th">{t('opps.name')}</th>
              <th scope="col" className="th">{t('opps.customer')}</th>
              <th scope="col" className="th">{t('opps.type')}</th>
              <th scope="col" className="th">{t('opps.stage')}</th>
              <th scope="col" className="th">{t('opps.stageAge')}</th>
              <th scope="col" className="th">{t('opps.expectedClose')}</th>
              <th scope="col" className="th">{t('opps.estValue')}</th>
              <th scope="col" className="th">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <TableSkeleton cols={COLS} />
            ) : shown.length === 0 ? (
              <EmptyRow
                colSpan={COLS}
                text={t('opps.emptyHint')}
                actionHref="/customers"
                actionText={t('nav.customers')}
              />
            ) : (
              shown.map((o) => {
                const age = isOpenStage(o.stage) ? daysSince(o.stageChangedAt ?? o.createdAt) : null;
                return (
                  <tr
                    key={o.id}
                    className="cursor-pointer hover:bg-slate-50"
                    onClick={() => router.push(`/opportunities/${o.id}`)}
                  >
                    <td className="td font-mono text-xs">{o.code}</td>
                    <td className="td font-medium">
                      <Link
                        href={`/opportunities/${o.id}`}
                        className="text-brand-700 hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {o.name}
                      </Link>
                    </td>
                    <td className="td">{o.customer ? pick(o.customer, 'name') : '—'}</td>
                    <td className="td">
                      <OppTypeBadge type={o.opportunityType} />
                    </td>
                    <td className="td">
                      <StatusBadge status={o.stage} />
                    </td>
                    <td className="td text-xs tabular-nums">
                      {age === null ? '—' : t('opps.ageDays').replace('{n}', String(age))}
                    </td>
                    <td className="td text-xs">{formatDate(o.expectedCloseDate, locale)}</td>
                    <td className="td">{formatMoney(o.estimatedValue, locale)}</td>
                    <td className="td" onClick={(e) => e.stopPropagation()}>
                      {isOpenStage(o.stage) && (
                        <Can perm="commercial.proposal.write">
                          <Btn
                            variant="solar"
                            sm
                            icon="file-text"
                            busy={busy(`proposal:${o.id}`)}
                            disabled={busy()}
                            onClick={() => createProposal(o.id)}
                          >
                            {t('opps.createProposal')}
                          </Btn>
                        </Can>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <Modal open={open} title={t('opps.new')} onClose={() => setOpen(false)}>
        <form onSubmit={create} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t('opps.name')}>
            <input name="name" className="input" required />
          </Field>
          <Field
            label={t('opps.customer')}
            hint={customerList.state === 'unavailable' ? t('lookup.unavailable') : undefined}
          >
            <select
              name="customerId"
              className="input"
              required
              defaultValue=""
              disabled={customerList.state === 'unavailable'}
            >
              <option value="" disabled>
                —
              </option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} · {pick(c, 'name')}
                </option>
              ))}
            </select>
            {customerList.state === 'ready' && customers.length === 0 && (
              <p className="mt-1 text-xs text-warning-700">
                {locale === 'ar' ? 'لا يوجد عملاء بعد — ' : 'No customers yet — '}
                <a href="/customers" className="underline">
                  {locale === 'ar' ? 'أنشئ عميلاً أولاً' : 'create one first'}
                </a>
              </p>
            )}
          </Field>
          <Field label={t('opps.type')}>
            <select
              name="opportunityType"
              className="input"
              value={newType}
              onChange={(e) => setNewType(e.target.value)}
            >
              {(enums?.opportunityTypes ?? [
                { value: 'DIRECT', labelAr: 'مباشرة', labelEn: 'Direct' },
                { value: 'TENDER', labelAr: 'مناقصة', labelEn: 'Tender' },
              ]).map((o) => (
                <option key={o.value} value={o.value}>
                  {locale === 'ar' ? o.labelAr : o.labelEn}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('opps.expectedClose')}>
            <input name="expectedCloseDate" type="date" className="input" dir="ltr" />
          </Field>
          <Field label={t('leads.kwp')}>
            <input name="estimatedKwp" type="number" step="0.001" className="input" />
          </Field>
          <Field label={t('opps.estValue')}>
            <input name="estimatedValue" type="number" step="0.01" className="input" />
          </Field>

          {newType === 'TENDER' && (
            <fieldset className="grid grid-cols-1 gap-4 rounded-xl border border-solar-200 bg-solar-50/50 p-4 sm:col-span-2 sm:grid-cols-2">
              <legend className="px-2 text-sm font-semibold text-solar-700">{t('opps.tender.title')}</legend>
              <Field label={t('opps.tender.reference')}>
                <input name="tenderReference" className="input" dir="ltr" />
              </Field>
              {/* No `required` on the date: the server is the authority and answers in Arabic (a native bubble would not). */}
              <Field label={t('opps.tender.closeDate')} hint={t('opps.tender.closeRequired')} error={tenderErr}>
                <input name="tenderCloseDate" type="date" className="input" dir="ltr" />
              </Field>
              <Field label={t('opps.bidBond.amount')}>
                <input name="bidBondAmount" type="number" step="0.01" min={0} className="input" dir="ltr" />
              </Field>
              <Field label={t('opps.bidBond.bank')}>
                <input name="bidBondBank" className="input" />
              </Field>
              <Field label={t('opps.bidBond.expiry')}>
                <input name="bidBondExpiry" type="date" className="input" dir="ltr" />
              </Field>
              <Field label={t('opps.bidBond.reference')}>
                <input name="bidBondReference" className="input" dir="ltr" />
              </Field>
            </fieldset>
          )}

          <div className="flex justify-end gap-2 sm:col-span-2">
            <Btn onClick={() => setOpen(false)}>{t('common.cancel')}</Btn>
            <Btn
              type="submit"
              variant="primary"
              busy={busy('create')}
              disabled={busy() || customerList.state === 'unavailable'}
            >
              {t('common.create')}
            </Btn>
          </div>
        </form>
      </Modal>
    </div>
  );
}
