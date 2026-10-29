'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { useEnums, optionLabel } from '@/lib/useEnums';
import { formatNumber } from '@/lib/format';
import { PageHeader, StatusBadge, Modal, Field, EmptyRow, LoadError, useConfirm, Can, Btn, TableSkeleton } from '@/components/ui';

interface Lead {
  id: string;
  code: string;
  contactName: string;
  companyName?: string;
  source: string;
  status: string;
  estimatedKwp?: string | null;
  siteLocation?: string | null;
  convertedOpportunityId?: string | null;
  rejectionReason?: { nameAr: string; nameEn: string } | null;
}

interface LossReason {
  id: string;
  nameAr: string;
  nameEn: string;
  isActive: boolean;
}

export default function LeadsPage() {
  const { t, locale } = useI18n();
  const enums = useEnums();
  const router = useRouter();
  const PAGE = 25;
  const [leads, setLeads] = useState<Lead[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');
  const [open, setOpen] = useState(false);
  // P3-1: the lead being rejected (its reason is mandatory) and the reasons list.
  const [rejecting, setRejecting] = useState<Lead | null>(null);
  const [reasons, setReasons] = useState<LossReason[]>([]);
  const { act, busy } = useAct();
  const { confirm, confirmNode } = useConfirm();

  const load = useCallback(() => {
    setLoading(true);
    setLoadErr('');
    const qs = new URLSearchParams({ take: String(PAGE), skip: String(page * PAGE) });
    if (search.trim()) qs.set('search', search.trim());
    if (statusFilter) qs.set('status', statusFilter);
    api
      .get<{ rows: Lead[]; total: number }>(`/leads?${qs}`)
      .then((d) => {
        setLeads(d.rows);
        setTotal(d.total);
      })
      .catch((e) => setLoadErr(translateError(e, locale)))
      .finally(() => setLoading(false));
  }, [locale, page, search, statusFilter]);

  useEffect(() => {
    const h = setTimeout(load, search ? 350 : 0);
    return () => clearTimeout(h);
  }, [load, search]);

  // Deep link from global search (?q=...).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('q');
    if (q) setSearch(q);
  }, []);
  // Opened from a dashboard quick action.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('new') === '1') setOpen(true);
  }, []);

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const ok = await act(
      'create',
      () =>
        api.post('/leads', {
          contactName: f.get('contactName'),
          companyName: f.get('companyName') || undefined,
          source: f.get('source'),
          estimatedKwp: f.get('estimatedKwp') ? Number(f.get('estimatedKwp')) : undefined,
          phone: f.get('phone') || undefined,
          email: f.get('email') || undefined,
          address: f.get('address') || undefined,
          siteLocation: f.get('siteLocation') || undefined,
          notes: f.get('notes') || undefined,
        }),
      { success: t('common.created') },
    );
    if (ok) {
      setOpen(false);
      load();
    }
  }

  // P3-1 (ADR-03 §4-1): «تم القبول» converts into an opportunity at once.
  async function accept(l: Lead) {
    if (!(await confirm({ title: t('leads.acceptTitle'), message: t('leads.acceptMsg') }))) return;
    let oppId: string | undefined;
    const ok = await act(`accept:${l.id}`, async () => {
      const res = await api.post<{ opportunity?: { id: string } }>(`/leads/${l.id}/status`, { status: 'ACCEPTED' });
      oppId = res.opportunity?.id;
    });
    if (ok) router.push(oppId ? `/opportunities/${oppId}` : '/opportunities');
  }

  function openReject(l: Lead) {
    setRejecting(l);
    if (reasons.length === 0)
      api
        .get<LossReason[]>('/loss-reasons')
        .then((r) => setReasons(r.filter((x) => x.isActive)))
        .catch(() => setReasons([]));
  }

  async function reject(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!rejecting) return;
    const f = new FormData(e.currentTarget);
    const ok = await act(`reject:${rejecting.id}`, () =>
      api.post(`/leads/${rejecting.id}/status`, {
        status: 'REJECTED',
        rejectionReasonId: f.get('rejectionReasonId'),
        rejectionNotes: f.get('rejectionNotes') || undefined,
      }),
    );
    if (ok) {
      setRejecting(null);
      load();
    }
  }

  async function reopen(l: Lead) {
    if (await act(`reopen:${l.id}`, () => api.post(`/leads/${l.id}/status`, { status: 'NEGOTIATING' }))) load();
  }

  return (
    <div>
      <PageHeader
        title={t('leads.title')}
        action={
          <Can perm="crm.lead.write">
            <Btn variant="primary" icon="plus" onClick={() => setOpen(true)}>
              {t('leads.new')}
            </Btn>
          </Can>
        }
      />

      {loadErr && !loading ? <LoadError message={loadErr} onRetry={load} /> : null}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          className="input max-w-xs"
          aria-label={t('common.search')}
          placeholder={t('common.search') + '…'}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
        />
        <select
          className="input !w-44"
          aria-label={t('common.status')}
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value);
            setPage(0);
          }}
        >
          <option value="">{t('common.status')}: {locale === 'ar' ? 'الكل' : 'All'}</option>
          {enums?.leadStatuses.map((o) => (
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
              <th scope="col" className="th">{t('leads.contactName')}</th>
              <th scope="col" className="th">{t('leads.company')}</th>
              <th scope="col" className="th">{t('leads.source')}</th>
              <th scope="col" className="th">{t('leads.siteLocation')}</th>
              <th scope="col" className="th">{t('leads.kwp')}</th>
              <th scope="col" className="th">{t('common.status')}</th>
              <th scope="col" className="th">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <TableSkeleton cols={8} />
            ) : leads.length === 0 ? (
              <EmptyRow colSpan={8} text={t('leads.emptyHint')} />
            ) : (
              leads.map((l) => (
                <tr key={l.id} className="hover:bg-slate-50">
                  <td className="td font-mono text-xs">{l.code}</td>
                  <td className="td font-medium">{l.contactName}</td>
                  <td className="td">{l.companyName ?? '—'}</td>
                  <td className="td">{optionLabel(enums?.leadSources, l.source, locale)}</td>
                  <td className="td">{l.siteLocation ?? '—'}</td>
                  <td className="td">{l.estimatedKwp ? formatNumber(l.estimatedKwp, locale) : '—'}</td>
                  <td className="td">
                    <StatusBadge status={l.status} />
                    {l.status === 'REJECTED' && l.rejectionReason ? (
                      <div className="mt-1 text-xs text-slate-500">
                        {locale === 'ar' ? l.rejectionReason.nameAr : l.rejectionReason.nameEn}
                      </div>
                    ) : null}
                  </td>
                  <td className="td">
                    {l.status === 'NEGOTIATING' ? (
                      <span className="flex flex-wrap gap-1">
                        {/* Acceptance creates the opportunity too, so the server
                            demands both CRM write permissions. */}
                        <Can perm={['crm.lead.write', 'crm.opportunity.write']}>
                          <Btn
                            variant="success"
                            sm
                            icon="check"
                            busy={busy(`accept:${l.id}`)}
                            disabled={busy()}
                            onClick={() => accept(l)}
                          >
                            {t('leads.accept')}
                          </Btn>
                        </Can>
                        <Can perm="crm.lead.write">
                          <Btn variant="danger" sm icon="x" disabled={busy()} onClick={() => openReject(l)}>
                            {t('leads.reject')}
                          </Btn>
                        </Can>
                      </span>
                    ) : l.status === 'REJECTED' ? (
                      <Can perm="crm.lead.write">
                        <Btn sm icon="undo" busy={busy(`reopen:${l.id}`)} disabled={busy()} onClick={() => reopen(l)}>
                          {t('leads.reopen')}
                        </Btn>
                      </Can>
                    ) : l.convertedOpportunityId ? (
                      <Btn sm onClick={() => router.push(`/opportunities/${l.convertedOpportunityId}`)}>
                        {t('leads.openOpportunity')}
                      </Btn>
                    ) : (
                      <span className="text-xs text-success-700">{t('leads.converted')}</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        {total > PAGE && (
          <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2.5 text-xs text-slate-500">
            <span>
              {page * PAGE + 1}–{Math.min((page + 1) * PAGE, total)} {t('common.of')} {total}
            </span>
            <span className="flex gap-1">
              <Btn sm disabled={page === 0} onClick={() => setPage(page - 1)}>
                {t('common.prev')}
              </Btn>
              <Btn sm disabled={(page + 1) * PAGE >= total} onClick={() => setPage(page + 1)}>
                {t('common.next')}
              </Btn>
            </span>
          </div>
        )}
      </div>

      <Modal open={open} title={t('leads.new')} onClose={() => setOpen(false)}>
        <form onSubmit={create} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t('leads.contactName')}>
            <input name="contactName" className="input" required />
          </Field>
          <Field label={t('leads.company')}>
            <input name="companyName" className="input" />
          </Field>
          <Field label={t('leads.source')}>
            <select name="source" className="input" defaultValue="DIRECT">
              {enums?.leadSources.map((o) => (
                <option key={o.value} value={o.value}>
                  {locale === 'ar' ? o.labelAr : o.labelEn}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('leads.kwp')}>
            <input name="estimatedKwp" type="number" step="0.001" className="input" />
          </Field>
          <Field label={t('leads.phone')}>
            <input name="phone" className="input" />
          </Field>
          <Field label={t('leads.email')}>
            <input name="email" type="email" className="input" />
          </Field>
          <Field label={t('leads.address')}>
            <input name="address" className="input" maxLength={500} />
          </Field>
          <Field label={t('leads.siteLocation')}>
            <input name="siteLocation" className="input" maxLength={500} />
          </Field>
          <div className="sm:col-span-2">
            <Field label={t('leads.notes')}>
              <textarea name="notes" className="input" rows={2} />
            </Field>
          </div>
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Btn onClick={() => setOpen(false)}>{t('common.cancel')}</Btn>
            <Btn type="submit" variant="primary" busy={busy('create')} disabled={busy()}>
              {t('common.create')}
            </Btn>
          </div>
        </form>
      </Modal>
      <Modal open={!!rejecting} title={t('leads.rejectTitle')} onClose={() => setRejecting(null)}>
        <form onSubmit={reject} className="grid grid-cols-1 gap-4">
          <Field label={t('leads.rejectReason')}>
            <select name="rejectionReasonId" className="input" required defaultValue="">
              <option value="" disabled>
                —
              </option>
              {reasons.map((r) => (
                <option key={r.id} value={r.id}>
                  {locale === 'ar' ? r.nameAr : r.nameEn}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('leads.rejectNotes')}>
            <textarea name="rejectionNotes" className="input" rows={3} maxLength={2000} />
          </Field>
          <div className="flex justify-end gap-2">
            <Btn onClick={() => setRejecting(null)}>{t('common.cancel')}</Btn>
            <Btn type="submit" variant="danger" busy={busy(`reject:${rejecting?.id}`)} disabled={busy()}>
              {t('leads.reject')}
            </Btn>
          </div>
        </form>
      </Modal>
      {confirmNode}
    </div>
  );
}
