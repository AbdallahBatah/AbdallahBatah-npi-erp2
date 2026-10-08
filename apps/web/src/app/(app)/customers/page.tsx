'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { translateError } from '@/lib/errors';
import { useEnums, optionLabel } from '@/lib/useEnums';
import { useToast } from '@/components/toast';
import { PageHeader, Modal, Field, EmptyRow, LoadError, Can, Btn, TableSkeleton } from '@/components/ui';

interface Customer {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  customerType: string;
  entityKind?: string;
  vatNumber?: string | null;
  crNumber?: string | null;
  phone?: string | null;
  mobile?: string | null;
  email?: string | null;
  mergedIntoId?: string | null;
}

interface SimilarHit {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  score: number;
}

interface DuplicateKeyError {
  field: 'crNumber' | 'vatNumber' | 'mobile';
  existing: { id: string; code: string; nameAr: string; nameEn: string };
}

export default function CustomersPage() {
  const { t, locale, pick } = useI18n();
  const { can } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const enums = useEnums();
  const [rows, setRows] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');
  const [search, setSearch] = useState('');
  const [includeMerged, setIncludeMerged] = useState(false);
  const [open, setOpen] = useState(false);

  // create form
  const [kind, setKind] = useState('COMPANY');
  const [nameAr, setNameAr] = useState('');
  const [similar, setSimilar] = useState<SimilarHit[]>([]);
  const [dupe, setDupe] = useState<DuplicateKeyError | null>(null);
  const [keyErr, setKeyErr] = useState('');
  const [saving, setSaving] = useState(false);
  const similarSeq = useRef(0);

  const load = useCallback(
    (q?: string, merged = false) => {
      setLoading(true);
      setLoadErr('');
      const qs = new URLSearchParams();
      if (q) qs.set('search', q);
      if (merged) qs.set('includeMerged', '1');
      const query = qs.toString();
      api
        .get<Customer[]>(`/customers${query ? `?${query}` : ''}`)
        .then(setRows)
        .catch((e) => setLoadErr(translateError(e, locale)))
        .finally(() => setLoading(false));
    },
    [locale],
  );

  // Deep link from global search (?q=...).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('q');
    if (q) setSearch(q);
  }, []);
  // Opened from a dashboard quick action.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('new') === '1') setOpen(true);
  }, []);

  // Debounced server-side search (also runs on first render and when the
  // "show merged" switch flips).
  const firstLoad = useRef(true);
  useEffect(() => {
    const delay = firstLoad.current ? 0 : 350;
    firstLoad.current = false;
    const h = setTimeout(() => load(search.trim() || undefined, includeMerged), delay);
    return () => clearTimeout(h);
  }, [search, includeMerged, load]);

  // Live similarity warning: as the Arabic name is typed, ask the server which
  // existing customers it resembles (debounced like the search above). A stale
  // answer must never overwrite a newer one, hence the sequence number.
  useEffect(() => {
    if (!open) return;
    const name = nameAr.trim();
    if (name.length < 2) {
      setSimilar([]);
      return;
    }
    const seq = ++similarSeq.current;
    const h = setTimeout(() => {
      api
        .get<SimilarHit[]>(`/customers/similar?name=${encodeURIComponent(name)}`)
        .then((hits) => {
          if (seq === similarSeq.current) setSimilar(hits);
        })
        .catch(() => {
          if (seq === similarSeq.current) setSimilar([]);
        });
    }, 350);
    return () => clearTimeout(h);
  }, [nameAr, open]);

  function closeModal() {
    setOpen(false);
    setNameAr('');
    setSimilar([]);
    setDupe(null);
    setKeyErr('');
    setKind('COMPANY');
  }

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const nameEn = String(f.get('nameEn') || '').trim();
    const name = nameAr.trim();
    const cr = String(f.get('crNumber') || '').trim();
    const vat = String(f.get('vatNumber') || '').trim();
    const mobile = String(f.get('mobile') || '').trim();
    setDupe(null);
    setKeyErr('');
    // The mandatory key depends on who the customer is (mirrors the server rule).
    if (kind === 'COMPANY' && !cr && !vat) {
      setKeyErr(t('cust.keyHint.COMPANY'));
      return;
    }
    if (kind === 'INDIVIDUAL' && !mobile) {
      setKeyErr(t('cust.keyHint.INDIVIDUAL'));
      return;
    }
    const credit = String(f.get('creditTermsDays') || '').trim();
    setSaving(true);
    try {
      await api.post('/customers', {
        nameAr: name || nameEn,
        nameEn: nameEn || name,
        entityKind: kind,
        customerType: f.get('customerType'),
        vatNumber: vat || undefined,
        crNumber: cr || undefined,
        mobile: mobile || undefined,
        phone: String(f.get('phone') || '').trim() || undefined,
        email: String(f.get('email') || '').trim() || undefined,
        creditTermsDays: credit ? Number(credit) : undefined,
      });
      toast.success(t('common.created'));
      closeModal();
      load(search.trim() || undefined, includeMerged);
    } catch (err) {
      // A refused duplicate key shows the record that already has it, with a link.
      if (err instanceof ApiError && err.status === 409 && err.body?.code === 'CUSTOMER_DUPLICATE') {
        setDupe({ field: err.body.field, existing: err.body.existing });
      } else {
        toast.error(translateError(err, locale));
      }
    } finally {
      setSaving(false);
    }
  }

  const colCount = 7;

  return (
    <div>
      <PageHeader
        title={t('cust.title')}
        subtitle={t('cust.hint')}
        action={
          <Can perm="crm.customer.write">
            <Btn variant="primary" icon="plus" onClick={() => setOpen(true)}>
              {t('cust.new')}
            </Btn>
          </Can>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-4">
        <input
          className="input max-w-sm"
          aria-label={t('common.search')}
          placeholder={t('common.search') + '…'}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {can('crm.customer.merge') && (
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={includeMerged}
              onChange={(e) => setIncludeMerged(e.target.checked)}
            />
            {t('cust.merged.show')}
          </label>
        )}
      </div>

      {loadErr && !loading ? (
        <LoadError message={loadErr} onRetry={() => load(search.trim() || undefined, includeMerged)} />
      ) : null}
      <div className="card table-sticky">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <th scope="col" className="th">{t('common.code')}</th>
              <th scope="col" className="th">{t('common.name')}</th>
              <th scope="col" className="th">{t('common.type')}</th>
              <th scope="col" className="th">{t('cust.cr')}</th>
              <th scope="col" className="th">{t('cust.vat')}</th>
              <th scope="col" className="th">{t('cust.mobile')}</th>
              <th scope="col" className="th">{t('leads.email')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <TableSkeleton cols={colCount} />
            ) : rows.length === 0 ? (
              <EmptyRow colSpan={colCount} text={t('cust.empty')} />
            ) : (
              rows.map((c) => (
                <tr
                  key={c.id}
                  className={`cursor-pointer hover:bg-slate-50 ${c.mergedIntoId ? 'opacity-60' : ''}`}
                  onClick={() => router.push(`/customers/${c.id}`)}
                >
                  <td className="td font-mono text-xs">
                    <Link href={`/customers/${c.id}`} onClick={(e) => e.stopPropagation()}>
                      {c.code}
                    </Link>
                  </td>
                  <td className="td font-medium">
                    <Link
                      href={`/customers/${c.id}`}
                      className="hover:text-brand-700"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {pick(c, 'name')}
                    </Link>
                    {c.mergedIntoId && (
                      <span className="badge ms-2 bg-slate-100 text-slate-600">{t('cust.merged.badge')}</span>
                    )}
                  </td>
                  <td className="td">
                    {optionLabel(enums?.customerEntityKinds, c.entityKind ?? 'COMPANY', locale)}
                    <span className="text-xs text-slate-500">
                      {' · '}
                      {optionLabel(enums?.customerTypes, c.customerType, locale)}
                    </span>
                  </td>
                  <td className="td font-mono text-xs">{c.crNumber ?? '—'}</td>
                  <td className="td font-mono text-xs">{c.vatNumber ?? '—'}</td>
                  <td className="td text-xs" dir="ltr">{c.mobile ?? c.phone ?? '—'}</td>
                  <td className="td text-xs">{c.email ?? '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Modal open={open} title={t('cust.new')} onClose={closeModal} dirty={nameAr.trim().length > 0}>
        <form onSubmit={create} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t('cust.entityKind')}>
            <select
              name="entityKind"
              className="input"
              value={kind}
              onChange={(e) => {
                setKind(e.target.value);
                setKeyErr('');
              }}
            >
              {enums?.customerEntityKinds.map((o) => (
                <option key={o.value} value={o.value}>
                  {locale === 'ar' ? o.labelAr : o.labelEn}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('common.type')}>
            <select name="customerType" className="input" defaultValue="CI">
              {enums?.customerTypes.map((o) => (
                <option key={o.value} value={o.value}>
                  {locale === 'ar' ? o.labelAr : o.labelEn}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('cust.nameAr')}>
            <input
              name="nameAr"
              className="input"
              required
              dir="rtl"
              value={nameAr}
              onChange={(e) => setNameAr(e.target.value)}
            />
          </Field>
          <Field label={`${t('cust.nameEn')} (${t('common.optional')})`}>
            <input name="nameEn" className="input" dir="ltr" />
          </Field>

          {similar.length > 0 && (
            <div
              role="status"
              className="rounded-xl border border-warning-200 bg-warning-50/60 p-4 sm:col-span-2"
            >
              <p className="text-sm font-bold text-warning-900">{t('cust.similar.title')}</p>
              <p className="mt-1 text-xs text-slate-600">{t('cust.similar.hint')}</p>
              <ul className="mt-3 divide-y divide-warning-200/60">
                {similar.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <span>
                      <span className="font-mono text-xs text-slate-500">{s.code}</span>{' '}
                      <span className="font-medium text-slate-800">{pick(s, 'name')}</span>{' '}
                      <span className="text-xs text-slate-500">
                        {t('cust.similar.score')} {Math.round(s.score * 100)}%
                      </span>
                    </span>
                    <Link
                      href={`/customers/${s.id}`}
                      className="shrink-0 text-xs font-semibold text-brand-700 underline underline-offset-4"
                    >
                      {t('cust.similar.open')}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <Field
            label={`${t('cust.cr')}${kind === 'COMPANY' ? '' : ` (${t('common.optional')})`}`}
            hint={kind === 'COMPANY' ? t('cust.keyHint.COMPANY') : undefined}
          >
            <input name="crNumber" className="input" dir="ltr" />
          </Field>
          <Field label={`${t('cust.vat')}${kind === 'COMPANY' ? '' : ` (${t('common.optional')})`}`}>
            <input name="vatNumber" className="input" dir="ltr" />
          </Field>
          <Field
            label={`${t('cust.mobile')}${kind === 'INDIVIDUAL' ? '' : ` (${t('common.optional')})`}`}
            hint={kind === 'INDIVIDUAL' ? t('cust.keyHint.INDIVIDUAL') : t('cust.mobileHint')}
          >
            <input name="mobile" className="input" dir="ltr" inputMode="tel" />
          </Field>
          <Field label={`${t('leads.phone')} (${t('common.optional')})`}>
            <input name="phone" className="input" dir="ltr" />
          </Field>
          <Field label={`${t('leads.email')} (${t('common.optional')})`}>
            <input name="email" type="email" className="input" dir="ltr" />
          </Field>
          <Field label={`${t('cust.credit')} (${t('common.optional')})`}>
            <input name="creditTermsDays" type="number" min={0} step={1} className="input" dir="ltr" />
          </Field>

          {keyErr && (
            <p role="alert" className="text-sm font-medium text-danger-600 sm:col-span-2">
              {keyErr}
            </p>
          )}
          {dupe && (
            <div role="alert" className="rounded-xl border border-danger-200 bg-danger-50/50 p-4 text-sm sm:col-span-2">
              <p className="font-semibold text-danger-700">
                {t('cust.dup.msg')
                  .replace('{field}', t(`cust.dup.field.${dupe.field}`))
                  .replace('{code}', dupe.existing.code)
                  .replace('{name}', pick(dupe.existing, 'name'))}
              </p>
              <Link
                href={`/customers/${dupe.existing.id}`}
                className="mt-2 inline-block text-xs font-semibold text-brand-700 underline underline-offset-4"
              >
                {t('cust.dup.open')}
              </Link>
            </div>
          )}

          <div className="flex justify-end gap-2 sm:col-span-2">
            <Btn onClick={closeModal}>{t('common.cancel')}</Btn>
            <Btn type="submit" variant={similar.length > 0 ? 'solar' : 'primary'} busy={saving} disabled={saving}>
              {similar.length > 0 ? t('cust.similar.createAnyway') : t('common.create')}
            </Btn>
          </div>
        </form>
      </Modal>
    </div>
  );
}
