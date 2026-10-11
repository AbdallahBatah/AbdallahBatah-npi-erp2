'use client';

import { FormEvent, ReactNode, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { useEnums, optionLabel } from '@/lib/useEnums';
import { formatDate, formatMoney, formatNumber } from '@/lib/format';
import { AttachmentsCard } from '@/components/attachments';
import { ActivityTimeline, type ActivityRow } from '@/components/activity-timeline';
import { FollowUpTasksPanel, type TaskRow } from '@/components/follow-up-tasks';
import { OppTypeBadge } from '@/components/opportunity-bits';
import {
  Btn,
  EmptyRow,
  Field,
  LoadError,
  Modal,
  PageHeader,
  PageSkeleton,
  StatusBadge,
  Tabs,
  useConfirm,
} from '@/components/ui';

interface Customer {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  customerType: string;
  entityKind: string;
  vatNumber: string | null;
  crNumber: string | null;
  mobile: string | null;
  phone: string | null;
  email: string | null;
  creditTermsDays: number;
  mergedIntoId: string | null;
  mergedInto?: { id: string; code: string; nameAr: string; nameEn: string } | null;
}
interface Contact {
  id: string;
  name: string;
  title: string | null;
  phone: string | null;
  mobile: string | null;
  email: string | null;
  isPrimary: boolean;
  notes: string | null;
}
interface Opportunity {
  id: string;
  code: string;
  name: string;
  stage: string;
  opportunityType: string;
  estimatedValue: string | null;
  currency: string;
  expectedCloseDate: string | null;
  createdAt: string;
}
interface Proposal {
  id: string;
  code: string;
  status: string;
  createdAt: string;
  opportunity: { id: string; code: string; name: string };
}
interface ContractRow {
  id: string;
  code: string;
  contractType: string;
  status: string;
  totalValue: string;
  currency: string;
  startDate: string | null;
}
interface ProjectRow {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  stage: string;
  capacityKwp: string | null;
  contract: { id: string; code: string };
}
interface ClaimRow {
  id: string;
  code: string;
  sequence: number;
  claimedAmount: string;
  status: string;
  createdAt: string;
  agreement: { id: string; code: string; project: { id: string; code: string; nameAr: string; nameEn: string } };
}
interface Overview {
  customer: Customer;
  counts: Record<string, number>;
  contacts: Contact[];
  opportunities?: Opportunity[];
  proposals?: Proposal[];
  contracts?: ContractRow[];
  projects?: ProjectRow[];
  claims?: ClaimRow[];
  /** CRM Step 5: the latest log entries and the OPEN follow-up tasks. */
  activities?: ActivityRow[];
  tasks?: TaskRow[];
}

const LIST_LIMIT = 50;
const NO_ENTRIES: ActivityRow[] = [];
const NO_TASKS: TaskRow[] = [];

export default function CustomerPage() {
  const { t, locale, pick } = useI18n();
  const { can } = useAuth();
  const enums = useEnums();
  const params = useParams<{ id: string }>();
  const id = params.id;
  const { act, busy } = useAct();
  const { confirm, confirmNode } = useConfirm();
  const [data, setData] = useState<Overview | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [tab, setTab] = useState('contacts');
  const [editOpen, setEditOpen] = useState(false);
  const [contactModal, setContactModal] = useState<{ open: boolean; row: Contact | null }>({ open: false, row: null });

  const load = useCallback(() => {
    setLoadErr('');
    api
      .get<Overview>(`/customers/${id}/overview`)
      .then(setData)
      .catch((e) => setLoadErr(translateError(e, locale)));
  }, [id, locale]);
  useEffect(load, [load]);

  // A notification links here with ?tab=tasks — open that tab (read once, on arrival).
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get('tab');
    if (wanted) setTab(wanted);
  }, []);

  if (loadErr) return <LoadError message={loadErr} onRetry={load} />;
  if (!data) return <PageSkeleton />;

  const c = data.customer;
  const merged = !!c.mergedIntoId;
  const writable = !merged && can('crm.customer.write');
  const keyMissing = c.entityKind === 'INDIVIDUAL' ? !c.mobile : !c.crNumber && !c.vatNumber;

  async function saveCustomer(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (k: string) => String(f.get(k) ?? '').trim();
    const ok = await act(
      'saveCustomer',
      () =>
        api.patch(`/customers/${id}`, {
          nameAr: text('nameAr'),
          nameEn: text('nameEn') || text('nameAr'),
          customerType: text('customerType'),
          entityKind: text('entityKind'),
          crNumber: text('crNumber'),
          vatNumber: text('vatNumber'),
          mobile: text('mobile'),
          phone: text('phone'),
          email: text('email') || undefined,
          creditTermsDays: text('creditTermsDays') ? Number(text('creditTermsDays')) : undefined,
        }),
      { success: t('common.done') },
    );
    if (ok) {
      setEditOpen(false);
      load();
    }
  }

  async function saveContact(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (k: string) => String(f.get(k) ?? '').trim();
    const body = {
      name: text('name'),
      title: text('title') || undefined,
      phone: text('phone') || undefined,
      mobile: text('mobile') || undefined,
      email: text('email') || undefined,
      notes: text('notes') || undefined,
      isPrimary: f.get('isPrimary') === 'on',
    };
    const row = contactModal.row;
    const ok = await act(
      'saveContact',
      () => (row ? api.patch(`/customers/${id}/contacts/${row.id}`, body) : api.post(`/customers/${id}/contacts`, body)),
      { success: row ? t('common.done') : t('common.created') },
    );
    if (ok) {
      setContactModal({ open: false, row: null });
      load();
    }
  }

  async function makePrimary(row: Contact) {
    if (await act('primary', () => api.patch(`/customers/${id}/contacts/${row.id}`, { isPrimary: true }))) load();
  }

  async function removeContact(row: Contact) {
    if (!(await confirm({ title: t('cust.contacts.deleteTitle'), message: `${t('cust.contacts.deleteMsg')} (${row.name})`, danger: true })))
      return;
    if (await act('delContact', () => api.del(`/customers/${id}/contacts/${row.id}`))) load();
  }

  const tabs = [
    { key: 'contacts', label: t('cust.tab.contacts'), count: data.counts.contacts },
    { key: 'activities', label: t('cust.tab.activities'), count: data.counts.activities },
    { key: 'tasks', label: t('cust.tab.tasks'), count: data.counts.tasks },
    ...(data.opportunities ? [{ key: 'opportunities', label: t('cust.tab.opportunities'), count: data.counts.opportunities }] : []),
    ...(data.proposals ? [{ key: 'proposals', label: t('cust.tab.proposals'), count: data.counts.proposals }] : []),
    ...(data.contracts ? [{ key: 'contracts', label: t('cust.tab.contracts'), count: data.counts.contracts }] : []),
    ...(data.projects ? [{ key: 'projects', label: t('cust.tab.projects'), count: data.counts.projects }] : []),
    ...(data.claims ? [{ key: 'claims', label: t('cust.tab.claims'), count: data.counts.claims }] : []),
    ...(can('platform.attachment.read') ? [{ key: 'files', label: t('cust.tab.files') }] : []),
  ];
  const activeTab = tabs.some((x) => x.key === tab) ? tab : 'contacts';

  /** A tab's table, with the "latest 50 of N" note when the list was cut. */
  function listTable(count: number | undefined, shown: number, head: string[], body: ReactNode, note?: string) {
    return (
      <div className="card overflow-hidden">
        {note && <p className="border-b border-slate-100 px-4 py-2 text-xs text-slate-500">{note}</p>}
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              {head.map((h) => (
                <th key={h} scope="col" className="th">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {shown === 0 ? <EmptyRow colSpan={head.length} text={t('cust.tab.empty')} /> : body}
          </tbody>
        </table>
        {count !== undefined && count > shown && (
          <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
            {t('cust.tab.limit').replace('{n}', String(LIST_LIMIT)).replace('{total}', String(count))}
          </p>
        )}
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={pick(c, 'name')}
        subtitle={c.code}
        action={
          writable ? (
            <Btn variant="primary" onClick={() => setEditOpen(true)}>
              {t('cust.edit')}
            </Btn>
          ) : undefined
        }
      />

      {merged && c.mergedInto && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning-200 bg-warning-50/60 p-4 text-sm">
          <span className="font-semibold text-warning-900">
            {t('cust.merged.banner').replace('{code}', c.mergedInto.code)}
          </span>
          <Link
            href={`/customers/${c.mergedInto.id}`}
            className="font-semibold text-brand-700 underline underline-offset-4"
          >
            {t('cust.merged.open')} — {c.mergedInto.code} · {pick(c.mergedInto, 'name')}
          </Link>
        </div>
      )}

      {!merged && keyMissing && (
        <output className="block mb-4 rounded-xl border border-warning-200 bg-warning-50/60 p-4 text-sm text-warning-900">
          {t('cust.keyMissing')}
        </output>
      )}

      <div className="card mb-5 grid grid-cols-2 gap-x-6 gap-y-4 p-5 text-sm sm:grid-cols-3 lg:grid-cols-4">
        <Fact label={t('cust.entityKind')}>{optionLabel(enums?.customerEntityKinds, c.entityKind, locale)}</Fact>
        <Fact label={t('common.type')}>{optionLabel(enums?.customerTypes, c.customerType, locale)}</Fact>
        <Fact label={t('cust.cr')} mono>{c.crNumber ?? '—'}</Fact>
        <Fact label={t('cust.vat')} mono>{c.vatNumber ?? '—'}</Fact>
        <Fact label={t('cust.mobile')} mono>{c.mobile ?? '—'}</Fact>
        <Fact label={t('leads.phone')} mono>{c.phone ?? '—'}</Fact>
        <Fact label={t('leads.email')}>{c.email ?? '—'}</Fact>
        <Fact label={t('cust.credit')}>{formatNumber(c.creditTermsDays, locale)}</Fact>
      </div>

      <Tabs tabs={tabs} value={activeTab} onChange={setTab} />

      {activeTab === 'contacts' && (
        <div>
          <div className="mb-3 flex justify-end">
            {writable && (
              <Btn variant="primary" icon="plus" onClick={() => setContactModal({ open: true, row: null })}>
                {t('cust.contacts.new')}
              </Btn>
            )}
          </div>
          {listTable(
            data.counts.contacts,
            data.contacts.length,
            [t('common.name'), t('cust.contacts.title'), t('cust.mobile'), t('leads.phone'), t('leads.email'), ''],
            data.contacts.map((k) => (
              <tr key={k.id} className="hover:bg-slate-50">
                <td className="td font-medium">
                  {k.name}
                  {k.isPrimary && (
                    <span className="badge ms-2 bg-brand-50 text-brand-700">{t('cust.contacts.primary')}</span>
                  )}
                </td>
                <td className="td text-xs">{k.title ?? '—'}</td>
                <td className="td text-xs" dir="ltr">{k.mobile ?? '—'}</td>
                <td className="td text-xs" dir="ltr">{k.phone ?? '—'}</td>
                <td className="td text-xs">{k.email ?? '—'}</td>
                <td className="td">
                  {writable && (
                    <span className="flex justify-end gap-2">
                      {!k.isPrimary && (
                        <Btn sm onClick={() => makePrimary(k)} disabled={busy()}>
                          {t('cust.contacts.makePrimary')}
                        </Btn>
                      )}
                      <Btn sm onClick={() => setContactModal({ open: true, row: k })}>
                        {t('common.edit')}
                      </Btn>
                      <Btn sm variant="danger" onClick={() => removeContact(k)} disabled={busy()}>
                        {t('att.delete')}
                      </Btn>
                    </span>
                  )}
                </td>
              </tr>
            )),
          )}
        </div>
      )}

      {activeTab === 'activities' && (
        <ActivityTimeline
          customerId={id}
          initial={data.activities ?? NO_ENTRIES}
          total={data.counts.activities ?? 0}
          contacts={data.contacts.map((k) => ({ id: k.id, name: k.name }))}
          opportunities={data.opportunities}
          writable={writable}
          onChanged={load}
        />
      )}

      {activeTab === 'tasks' && (
        <FollowUpTasksPanel
          customerId={id}
          openTasks={data.tasks ?? NO_TASKS}
          opportunities={data.opportunities?.map((o) => ({ id: o.id, code: o.code, name: o.name }))}
          writable={writable}
          onChanged={load}
        />
      )}

      {activeTab === 'opportunities' &&
        data.opportunities &&
        listTable(
          data.counts.opportunities,
          data.opportunities.length,
          [t('common.code'), t('common.name'), t('opps.type'), t('common.status'), t('cust.col.value'), t('cust.col.date')],
          data.opportunities.map((o) => (
            <tr key={o.id} className="hover:bg-slate-50">
              <td className="td font-mono text-xs">{o.code}</td>
              <td className="td font-medium">
                <Link href={`/opportunities/${o.id}`} className="text-brand-700 hover:underline">{o.name}</Link>
              </td>
              <td className="td"><OppTypeBadge type={o.opportunityType} /></td>
              <td className="td"><StatusBadge status={o.stage} /></td>
              <td className="td">{o.estimatedValue ? formatMoney(o.estimatedValue, locale, o.currency) : '—'}</td>
              <td className="td text-xs">{formatDate(o.createdAt, locale)}</td>
            </tr>
          )),
        )}

      {activeTab === 'proposals' &&
        data.proposals &&
        listTable(
          data.counts.proposals,
          data.proposals.length,
          [t('common.code'), t('cust.col.opportunity'), t('common.status'), t('cust.col.date')],
          data.proposals.map((p) => (
            <tr key={p.id} className="hover:bg-slate-50">
              <td className="td font-mono text-xs">
                <Link href={`/proposals/${p.id}`} className="text-brand-700 hover:underline">{p.code}</Link>
              </td>
              <td className="td">{p.opportunity.code} · {p.opportunity.name}</td>
              <td className="td"><StatusBadge status={p.status} /></td>
              <td className="td text-xs">{formatDate(p.createdAt, locale)}</td>
            </tr>
          )),
        )}

      {activeTab === 'contracts' &&
        data.contracts &&
        listTable(
          data.counts.contracts,
          data.contracts.length,
          [t('common.code'), t('common.type'), t('common.status'), t('cust.col.value'), t('cust.col.date')],
          data.contracts.map((k) => (
            <tr key={k.id} className="hover:bg-slate-50">
              <td className="td font-mono text-xs">
                <Link href={`/contracts/${k.id}`} className="text-brand-700 hover:underline">{k.code}</Link>
              </td>
              <td className="td">{optionLabel(enums?.contractTypes, k.contractType, locale)}</td>
              <td className="td"><StatusBadge status={k.status} /></td>
              <td className="td">{formatMoney(k.totalValue, locale, k.currency)}</td>
              <td className="td text-xs">{formatDate(k.startDate, locale)}</td>
            </tr>
          )),
        )}

      {activeTab === 'projects' &&
        data.projects &&
        listTable(
          data.counts.projects,
          data.projects.length,
          [t('common.code'), t('common.name'), t('cust.col.contract'), t('common.status')],
          data.projects.map((p) => (
            <tr key={p.id} className="hover:bg-slate-50">
              <td className="td font-mono text-xs">
                <Link href={`/projects/${p.id}`} className="text-brand-700 hover:underline">{p.code}</Link>
              </td>
              <td className="td font-medium">{pick(p, 'name')}</td>
              <td className="td font-mono text-xs">{p.contract.code}</td>
              <td className="td"><StatusBadge status={p.stage} /></td>
            </tr>
          )),
        )}

      {activeTab === 'claims' &&
        data.claims &&
        listTable(
          data.counts.claims,
          data.claims.length,
          [t('common.code'), t('cust.col.project'), t('cust.col.amount'), t('common.status'), t('cust.col.date')],
          data.claims.map((m) => (
            <tr key={m.id} className="hover:bg-slate-50">
              <td className="td font-mono text-xs">{m.code}</td>
              <td className="td">
                <Link href={`/projects/${m.agreement.project.id}`} className="text-brand-700 hover:underline">
                  {m.agreement.project.code} · {pick(m.agreement.project, 'name')}
                </Link>
              </td>
              <td className="td">{formatMoney(m.claimedAmount, locale)}</td>
              <td className="td"><StatusBadge status={m.status} /></td>
              <td className="td text-xs">{formatDate(m.createdAt, locale)}</td>
            </tr>
          )),
          t('cust.claims.hint'),
        )}

      {activeTab === 'files' && <AttachmentsCard entityType="CUSTOMER" entityId={id} />}

      <Modal open={editOpen} title={t('cust.edit')} onClose={() => setEditOpen(false)}>
        <form onSubmit={saveCustomer} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t('cust.nameAr')}>
            <input name="nameAr" className="input" required dir="rtl" defaultValue={c.nameAr} />
          </Field>
          <Field label={t('cust.nameEn')}>
            <input name="nameEn" className="input" dir="ltr" defaultValue={c.nameEn} />
          </Field>
          <Field label={t('cust.entityKind')}>
            <select name="entityKind" className="input" defaultValue={c.entityKind}>
              {enums?.customerEntityKinds.map((o) => (
                <option key={o.value} value={o.value}>
                  {locale === 'ar' ? o.labelAr : o.labelEn}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('common.type')}>
            <select name="customerType" className="input" defaultValue={c.customerType}>
              {enums?.customerTypes.map((o) => (
                <option key={o.value} value={o.value}>
                  {locale === 'ar' ? o.labelAr : o.labelEn}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('cust.cr')}>
            <input name="crNumber" className="input" dir="ltr" defaultValue={c.crNumber ?? ''} />
          </Field>
          <Field label={t('cust.vat')}>
            <input name="vatNumber" className="input" dir="ltr" defaultValue={c.vatNumber ?? ''} />
          </Field>
          <Field label={t('cust.mobile')} hint={t('cust.mobileHint')}>
            <input name="mobile" className="input" dir="ltr" inputMode="tel" defaultValue={c.mobile ?? ''} />
          </Field>
          <Field label={t('leads.phone')}>
            <input name="phone" className="input" dir="ltr" defaultValue={c.phone ?? ''} />
          </Field>
          <Field label={t('leads.email')}>
            <input name="email" type="email" className="input" dir="ltr" defaultValue={c.email ?? ''} />
          </Field>
          <Field label={t('cust.credit')}>
            <input name="creditTermsDays" type="number" min={0} step={1} className="input" dir="ltr" defaultValue={c.creditTermsDays} />
          </Field>
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Btn onClick={() => setEditOpen(false)}>{t('common.cancel')}</Btn>
            <Btn type="submit" variant="primary" busy={busy('saveCustomer')} disabled={busy()}>
              {t('common.save')}
            </Btn>
          </div>
        </form>
      </Modal>

      <Modal
        open={contactModal.open}
        title={contactModal.row ? t('cust.contacts.edit') : t('cust.contacts.new')}
        onClose={() => setContactModal({ open: false, row: null })}
      >
        {/* keyed so reopening for another contact starts from ITS values */}
        <form key={contactModal.row?.id ?? 'new'} onSubmit={saveContact} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t('common.name')}>
            <input name="name" className="input" required defaultValue={contactModal.row?.name ?? ''} />
          </Field>
          <Field label={`${t('cust.contacts.title')} (${t('common.optional')})`}>
            <input name="title" className="input" defaultValue={contactModal.row?.title ?? ''} />
          </Field>
          <Field label={`${t('cust.mobile')} (${t('common.optional')})`}>
            <input name="mobile" className="input" dir="ltr" inputMode="tel" defaultValue={contactModal.row?.mobile ?? ''} />
          </Field>
          <Field label={`${t('leads.phone')} (${t('common.optional')})`}>
            <input name="phone" className="input" dir="ltr" defaultValue={contactModal.row?.phone ?? ''} />
          </Field>
          <Field label={`${t('leads.email')} (${t('common.optional')})`}>
            <input name="email" type="email" className="input" dir="ltr" defaultValue={contactModal.row?.email ?? ''} />
          </Field>
          <Field label={`${t('cust.contacts.notes')} (${t('common.optional')})`}>
            <input name="notes" className="input" defaultValue={contactModal.row?.notes ?? ''} />
          </Field>
          <label className="flex items-center gap-2 text-sm text-slate-700 sm:col-span-2">
            <input type="checkbox" name="isPrimary" defaultChecked={contactModal.row?.isPrimary ?? false} />
            {t('cust.contacts.primary')}
          </label>
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Btn onClick={() => setContactModal({ open: false, row: null })}>{t('common.cancel')}</Btn>
            <Btn type="submit" variant="primary" busy={busy('saveContact')} disabled={busy()}>
              {t('common.save')}
            </Btn>
          </div>
        </form>
      </Modal>
      {confirmNode}
    </div>
  );
}

function Fact({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div>
      <div className="text-xs font-semibold text-slate-500">{label}</div>
      <div className={`mt-0.5 text-slate-900 ${mono ? 'font-mono text-xs' : ''}`}>{children}</div>
    </div>
  );
}
