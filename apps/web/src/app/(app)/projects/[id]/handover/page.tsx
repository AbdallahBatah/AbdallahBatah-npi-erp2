'use client';

/**
 * Package 7 (ADR-07) — «تسليم المشروع» and the acceptance & commissioning
 * certificate (contract annex 2). The engineer fills it in the commissioning
 * stage and submits it; the projects GM and the general manager approve,
 * which closes the project, starts the warranties and makes the last payment due.
 */
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { HANDOVER_CHECKLIST, HANDOVER_READINGS, WARRANTY_KINDS } from '@npi/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { formatDate } from '@/lib/format';
import { PageHeader, StatusBadge, LoadError, Field, Btn, PageSkeleton } from '@/components/ui';
import { ApprovalBanner, type ApprovalRequestView } from '@/components/approvals';
import { AttachmentsCard } from '@/components/attachments';

interface CheckRow { key: string; ok: boolean; note?: string }
interface Reading { label: string; value: string; unit?: string }
interface Handover {
  id: string;
  code: string;
  status: string;
  completionDate: string | null;
  commissionedAt: string | null;
  checklist: CheckRow[];
  readings: Reading[];
  snags: string | null;
  snagsDueDate: string | null;
  clientRepName: string | null;
  warrantyYears: Record<string, number>;
  notes: string | null;
  decisionNote: string | null;
}
interface Data {
  project: { id: string; code: string; nameAr: string; nameEn: string; stage: string };
  handover: Handover | null;
  warranties: Array<{ id: string; kind: string; years: number; startsAt: string; endsAt: string }>;
  pendingApproval: ApprovalRequestView | null;
  readiness: { stageIsCommissioning: boolean; files: number; pendingOverruns: number; openReturns: number };
}

const d10 = (v: string | null | undefined) => (v ? v.slice(0, 10) : '');

export default function HandoverPage() {
  const { id } = useParams<{ id: string }>();
  const { t, locale, pick } = useI18n();
  const { can } = useAuth();
  const { act, busy } = useAct();
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState('');
  const [checks, setChecks] = useState<Record<string, CheckRow>>({});
  const [readings, setReadings] = useState<Record<string, string>>({});
  const [years, setYears] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    api
      .get<Data>(`/projects/${id}/handover`)
      .then((d) => {
        setData(d);
        const h = d.handover;
        setChecks(Object.fromEntries(HANDOVER_CHECKLIST.map((c) => [c.key, h?.checklist.find((r) => r.key === c.key) ?? { key: c.key, ok: true }])));
        setReadings(Object.fromEntries(HANDOVER_READINGS.map((r) => [r.label, h?.readings.find((x) => x.label === r.label)?.value ?? ''])));
        setYears(Object.fromEntries(WARRANTY_KINDS.map((k) => [k.value, String(h?.warrantyYears?.[k.value] ?? k.defaultYears)])));
      })
      .catch((e) => setErr(translateError(e, locale)));
  }, [id, locale]);
  useEffect(load, [load]);

  if (err && !data) return <LoadError message={err} onRetry={load} />;
  if (!data) return <PageSkeleton stats={0} />;
  const h = data.handover;
  const editable = can('projects.project.write') && data.project.stage !== 'CLOSED' && (!h || ['DRAFT', 'REJECTED'].includes(h.status));
  const r = data.readiness;

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const ok = await act('save', () =>
      api.put(`/projects/${id}/handover`, {
        completionDate: String(f.get('completionDate') || '') || undefined,
        commissionedAt: String(f.get('commissionedAt') || '') || undefined,
        clientRepName: String(f.get('clientRepName') || ''),
        snags: String(f.get('snags') || ''),
        snagsDueDate: String(f.get('snagsDueDate') || '') || undefined,
        notes: String(f.get('notes') || ''),
        checklist: Object.values(checks).map((c) => ({ key: c.key, ok: c.ok, note: c.note?.trim() || undefined })),
        readings: HANDOVER_READINGS.filter((x) => readings[x.label]?.trim()).map((x) => ({ label: x.label, value: readings[x.label].trim(), unit: x.unit })),
        warrantyYears: Object.fromEntries(Object.entries(years).map(([k, v]) => [k, Math.max(0, Math.round(Number(v) || 0))])),
      }),
    );
    if (ok) load();
  }

  async function submit() {
    if (await act('submit', () => api.post(`/projects/${id}/handover/submit`))) load();
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${t('hnd.title')} · ${data.project.code}`}
        subtitle={pick(data.project, 'name')}
        backHref={`/projects/${id}`}
        backLabel={data.project.code}
        action={
          <div className="flex flex-wrap items-center gap-2">
            {h && <StatusBadge status={h.status} />}
            {editable && h && (
              <Btn variant="primary" icon="check" busy={busy('submit')} disabled={busy()} onClick={submit}>
                {t('hnd.submit')}
              </Btn>
            )}
          </div>
        }
      />
      {data.pendingApproval && <ApprovalBanner request={data.pendingApproval} />}
      {h?.status === 'REJECTED' && h.decisionNote && (
        <p role="alert" className="rounded-md bg-danger-50 p-3 text-sm text-danger-700">
          {t('hnd.sentBack')}: {h.decisionNote}
        </p>
      )}

      {data.project.stage !== 'CLOSED' && (
        <div className="card grid grid-cols-1 gap-3 p-4 text-sm sm:grid-cols-4">
          <Ready ok={r.stageIsCommissioning} label={t('hnd.ready.stage')} />
          <Ready ok={r.files > 0} label={`${t('hnd.ready.files')} (${r.files})`} />
          <Ready ok={r.pendingOverruns === 0} label={t('hnd.ready.overruns')} />
          <Ready ok={r.openReturns === 0} label={t('hnd.ready.returns')} />
        </div>
      )}

      <form onSubmit={save} className="space-y-6">
        <fieldset disabled={!editable} className="space-y-6">
          <div className="card grid grid-cols-1 gap-4 p-5 sm:grid-cols-3">
            <Field label={t('hnd.completionDate')}>
              <input type="date" name="completionDate" className="input" defaultValue={d10(h?.completionDate)} />
            </Field>
            <Field label={t('hnd.commissionedAt')}>
              <input type="date" name="commissionedAt" className="input" defaultValue={d10(h?.commissionedAt)} />
            </Field>
            <Field label={t('hnd.clientRep')}>
              <input name="clientRepName" className="input" maxLength={120} defaultValue={h?.clientRepName ?? ''} />
            </Field>
          </div>

          <section className="card p-5">
            <h2 className="mb-3 text-sm font-semibold text-slate-700">{t('hnd.checklist')}</h2>
            <div className="space-y-2">
              {HANDOVER_CHECKLIST.map((c, i) => {
                const row = checks[c.key] ?? { key: c.key, ok: true };
                return (
                  <div key={c.key} className="grid grid-cols-1 items-center gap-2 sm:grid-cols-12">
                    <span className="text-sm sm:col-span-5">
                      {i + 1}. {locale === 'ar' ? c.labelAr : c.labelEn}
                    </span>
                    <select
                      aria-label={c.labelEn}
                      className="input sm:col-span-2"
                      value={row.ok ? 'ok' : 'no'}
                      onChange={(e) => setChecks((m) => ({ ...m, [c.key]: { ...row, ok: e.target.value === 'ok' } }))}
                    >
                      <option value="ok">{t('hnd.ok')}</option>
                      <option value="no">{t('hnd.notOk')}</option>
                    </select>
                    <input
                      aria-label={`${c.labelEn} note`}
                      className="input sm:col-span-5"
                      placeholder={t('leads.notes')}
                      value={row.note ?? ''}
                      onChange={(e) => setChecks((m) => ({ ...m, [c.key]: { ...row, note: e.target.value } }))}
                    />
                  </div>
                );
              })}
            </div>
          </section>

          <section className="card p-5">
            <h2 className="mb-3 text-sm font-semibold text-slate-700">{t('hnd.readings')}</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              {HANDOVER_READINGS.map((x) => (
                <Field key={x.label} label={`${x.label} (${x.unit})`}>
                  <input className="input" value={readings[x.label] ?? ''} onChange={(e) => setReadings((m) => ({ ...m, [x.label]: e.target.value }))} />
                </Field>
              ))}
            </div>
          </section>

          <section className="card grid grid-cols-1 gap-4 p-5 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <Field label={t('hnd.snags')}>
                <textarea name="snags" className="input" rows={3} maxLength={2000} defaultValue={h?.snags ?? ''} />
              </Field>
            </div>
            <Field label={t('hnd.snagsDue')}>
              <input type="date" name="snagsDueDate" className="input" defaultValue={d10(h?.snagsDueDate)} />
            </Field>
          </section>

          <section className="card p-5">
            <h2 className="mb-1 text-sm font-semibold text-slate-700">{t('hnd.warranties')}</h2>
            <p className="mb-3 text-xs text-slate-500">{t('hnd.warrantiesHint')}</p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              {WARRANTY_KINDS.map((k) => (
                <Field key={k.value} label={locale === 'ar' ? k.labelAr : k.labelEn}>
                  <input type="number" min={0} max={40} className="input" value={years[k.value] ?? ''} onChange={(e) => setYears((m) => ({ ...m, [k.value]: e.target.value }))} />
                </Field>
              ))}
            </div>
          </section>

          <Field label={`${t('leads.notes')} (${t('common.optional')})`}>
            <textarea name="notes" className="input" rows={2} maxLength={2000} defaultValue={h?.notes ?? ''} />
          </Field>
        </fieldset>
        {editable && (
          <div className="flex justify-end">
            <Btn type="submit" variant="primary" busy={busy('save')} disabled={busy()}>
              {t('common.save')}
            </Btn>
          </div>
        )}
      </form>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-700">{t('hnd.files')}</h2>
        <p className="text-xs text-slate-500">{t('hnd.filesHint')}</p>
        <AttachmentsCard entityType="PROJECT" entityId={id} onChange={load} />
      </section>

      {data.warranties.length > 0 && (
        <section className="card overflow-hidden">
          <h2 className="card-title">{t('hnd.warrantiesStarted')}</h2>
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <tbody className="divide-y divide-slate-100">
              {data.warranties.map((w) => {
                const k = WARRANTY_KINDS.find((x) => x.value === w.kind);
                return (
                  <tr key={w.id}>
                    <td className="td">{k ? (locale === 'ar' ? k.labelAr : k.labelEn) : w.kind}</td>
                    <td className="td-num">{w.years}</td>
                    <td className="td text-xs">
                      {formatDate(w.startsAt, locale)} → {formatDate(w.endsAt, locale)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
      <p className="text-xs text-slate-500">
        <Link href="/projects/warranties" className="text-brand-700 hover:underline">
          {t('wty.title')}
        </Link>
      </p>
    </div>
  );
}

function Ready({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`flex items-center gap-2 ${ok ? 'text-success-700' : 'text-warning-700'}`}>
      <span className={`h-2 w-2 rounded-full ${ok ? 'bg-success-500' : 'bg-warning-500'}`} />
      {label}
    </span>
  );
}
