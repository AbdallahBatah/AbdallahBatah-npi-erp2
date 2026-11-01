'use client';

/**
 * Package 5 (ADR-05) — «التنفيذ»: owner work cycle step 14 on one page.
 * Budget lines with executed / remaining / progress (and budget vs actual for
 * cost viewers), the day's progress, the overrun request that needs the
 * projects GM and the general manager, site photos, and site attendance.
 */
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { formatDate, formatDateTime, formatMoney } from '@/lib/format';
import { PageHeader, StatusBadge, EmptyRow, LoadError, Modal, Field, Btn, PageSkeleton, Tabs } from '@/components/ui';
import { AttachmentsCard } from '@/components/attachments';
import { ApprovalBanner, type ApprovalRequestView } from '@/components/approvals';

interface Line {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  uom: string | null;
  plannedStart: string | null;
  plannedEnd: string | null;
  plannedQty: number | null;
  approvedExtraQty: number;
  capQty: number | null;
  executedQty: number;
  remainingQty: number | null;
  progressPct: number | null;
  budget: number | null;
  committed: number | null;
  actual: number | null;
  variance: number | null;
}
interface Entry {
  id: string;
  workDate: string;
  qty: string;
  notes: string | null;
  createdById: string;
  createdAt: string;
  wbsElement: { code: string; nameAr: string; nameEn: string; uom: string | null };
}
interface Overrun {
  id: string;
  code: string;
  status: string;
  extraQty: string;
  amount: string | null;
  reason: string;
  decisionNote: string | null;
  createdAt: string;
  wbsElement: { code: string; nameAr: string; nameEn: string; uom: string | null };
  pendingApproval: ApprovalRequestView | null;
}
interface Summary {
  project: { id: string; code: string; nameAr: string; nameEn: string; stage: string };
  progressPct: number | null;
  costSummary: { budget: number | null; committed: number | null; actual: number | null; variance: number | null };
  lines: Line[];
  entries: Entry[];
  overruns: Overrun[];
}
interface Attendance {
  id: string;
  workDate: string;
  workerName: string;
  trade: string | null;
  checkInAt: string;
  checkOutAt: string | null;
  notes: string | null;
}

const todayIso = () => new Date().toISOString().slice(0, 10);
const n = (v: number | string | null | undefined) => (v === null || v === undefined ? null : Number(v));
/** Today's date + a HH:MM clock time → ISO, read in the browser's zone. */
const atTime = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00`).toISOString();

export default function ExecutionPage() {
  const { id } = useParams<{ id: string }>();
  const { t, locale, pick } = useI18n();
  const { user, can } = useAuth();
  const { act, busy } = useAct();
  const [s, setS] = useState<Summary | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [tab, setTab] = useState('lines');
  const [progressOpen, setProgressOpen] = useState(false);
  const [workDate, setWorkDate] = useState(todayIso());
  const [qtys, setQtys] = useState<Record<string, string>>({});
  const [overrunFor, setOverrunFor] = useState<Line | null>(null);
  const [attDate, setAttDate] = useState(todayIso());
  const [attendance, setAttendance] = useState<Attendance[]>([]);
  const [attOpen, setAttOpen] = useState(false);
  const showCosts = can('finance.costs.view');
  const writer = can('projects.project.write');

  const load = useCallback(() => {
    setLoadErr('');
    api
      .get<Summary>(`/projects/${id}/execution`)
      .then(setS)
      .catch((e) => setLoadErr(translateError(e, locale)));
  }, [id, locale]);
  useEffect(load, [load]);

  const loadAttendance = useCallback(() => {
    api
      .get<Attendance[]>(`/projects/${id}/attendance?date=${attDate}`)
      .then(setAttendance)
      .catch(() => setAttendance([]));
  }, [id, attDate]);
  useEffect(() => {
    if (tab === 'attendance') loadAttendance();
  }, [tab, loadAttendance]);

  if (loadErr && !s) return <LoadError message={loadErr} onRetry={load} />;
  if (!s) return <PageSkeleton stats={3} />;
  const closed = s.project.stage === 'CLOSED';

  async function recordProgress(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const lines = Object.entries(qtys)
      .filter(([, v]) => Number(v) > 0)
      .map(([wbsElementId, v]) => ({ wbsElementId, qty: Number(v) }));
    if (lines.length === 0) return;
    const ok = await act('progress', () => api.post(`/projects/${id}/progress`, { workDate, lines }));
    if (ok) {
      setProgressOpen(false);
      setQtys({});
      load();
    }
  }

  async function requestOverrun(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!overrunFor) return;
    const f = new FormData(e.currentTarget);
    const ok = await act('overrun', () =>
      api.post(`/projects/${id}/overruns`, {
        wbsElementId: overrunFor.id,
        extraQty: Number(f.get('extraQty')),
        reason: String(f.get('reason') || '').trim(),
      }),
    );
    if (ok) {
      setOverrunFor(null);
      load();
    }
  }

  async function removeEntry(entryId: string) {
    if (await act(`del:${entryId}`, () => api.del(`/projects/progress/${entryId}`))) load();
  }

  async function addAttendance(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const checkIn = String(f.get('checkIn') || '');
    const checkOut = String(f.get('checkOut') || '');
    const ok = await act('att', () =>
      api.post(`/projects/${id}/attendance`, {
        workDate: attDate,
        workerName: String(f.get('workerName') || '').trim(),
        trade: String(f.get('trade') || '').trim() || undefined,
        checkInAt: atTime(attDate, checkIn),
        checkOutAt: checkOut ? atTime(attDate, checkOut) : undefined,
      }),
    );
    if (ok) {
      setAttOpen(false);
      loadAttendance();
    }
  }

  async function checkOut(row: Attendance) {
    const hhmm = new Date().toTimeString().slice(0, 5);
    const ok = await act(`out:${row.id}`, () =>
      api.patch(`/projects/attendance/${row.id}`, { checkOutAt: atTime(row.workDate.slice(0, 10), hhmm) }),
    );
    if (ok) loadAttendance();
  }

  const hours = (a: Attendance) =>
    a.checkOutAt ? Math.round(((new Date(a.checkOutAt).getTime() - new Date(a.checkInAt).getTime()) / 36e5) * 10) / 10 : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${t('exe.title')} · ${s.project.code}`}
        subtitle={pick(s.project, 'name')}
        backHref={`/projects/${id}`}
        backLabel={s.project.code}
        action={
          !closed && writer ? (
            <Btn variant="primary" icon="plus" onClick={() => setProgressOpen(true)}>
              {t('exe.recordDay')}
            </Btn>
          ) : undefined
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <div className="card p-4">
          <p className="text-xs text-slate-500">{t('exe.progress')}</p>
          <p className="mt-1 text-2xl font-bold text-brand-700">{s.progressPct === null ? '—' : `${s.progressPct}%`}</p>
        </div>
        {showCosts && (
          <>
            <div className="card p-4">
              <p className="text-xs text-slate-500">{t('exe.budget')}</p>
              <p className="mt-1 font-medium">{formatMoney(n(s.costSummary.budget) ?? 0, locale)}</p>
            </div>
            <div className="card p-4">
              <p className="text-xs text-slate-500">{t('exe.actualCommitted')}</p>
              <p className="mt-1 font-medium">
                {formatMoney(n(s.costSummary.actual) ?? 0, locale)} + {formatMoney(n(s.costSummary.committed) ?? 0, locale)}
              </p>
            </div>
            <div className="card p-4">
              <p className="text-xs text-slate-500">{t('exe.variance')}</p>
              <p className={`mt-1 font-bold ${(n(s.costSummary.variance) ?? 0) < 0 ? 'text-danger-700' : 'text-success-700'}`}>
                {formatMoney(n(s.costSummary.variance) ?? 0, locale)}
              </p>
            </div>
          </>
        )}
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'lines', label: t('exe.tab.lines') },
          { key: 'log', label: t('exe.tab.log') },
          { key: 'overruns', label: t('exe.tab.overruns'), count: s.overruns.filter((o) => o.status === 'PENDING').length },
          { key: 'photos', label: t('exe.tab.photos') },
          { key: 'attendance', label: t('exe.tab.attendance') },
        ]}
      />

      {tab === 'lines' && (
        <div className="card table-sticky overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th scope="col" className="th">{t('exe.line')}</th>
                <th scope="col" className="th text-end">{t('exe.planned')}</th>
                <th scope="col" className="th text-end">{t('exe.executed')}</th>
                <th scope="col" className="th text-end">{t('exe.remaining')}</th>
                <th scope="col" className="th">{t('exe.progress')}</th>
                {showCosts && <th scope="col" className="th text-end">{t('exe.budget')}</th>}
                {showCosts && <th scope="col" className="th text-end">{t('exe.actual')}</th>}
                {showCosts && <th scope="col" className="th text-end">{t('exe.variance')}</th>}
                <th scope="col" className="th" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {s.lines.length === 0 ? (
                <EmptyRow colSpan={9} text={t('common.none')} />
              ) : (
                s.lines.map((l) => (
                  <tr key={l.id}>
                    <td className="td">
                      <span className="font-mono text-xs text-slate-500">{l.code}</span> {pick(l, 'name')}
                      {l.plannedStart && (
                        <p className="text-xs text-slate-400">
                          {formatDate(l.plannedStart, locale)} → {l.plannedEnd ? formatDate(l.plannedEnd, locale) : '…'}
                        </p>
                      )}
                    </td>
                    <td className="td-num">
                      {l.plannedQty === null ? '—' : `${l.plannedQty} ${l.uom ?? ''}`}
                      {l.approvedExtraQty > 0 && <span className="block text-xs text-warning-700">+{l.approvedExtraQty}</span>}
                    </td>
                    <td className="td-num">{l.executedQty}</td>
                    <td className={`td-num ${l.remainingQty === 0 ? 'text-warning-700' : ''}`}>{l.remainingQty ?? '—'}</td>
                    <td className="td w-40">
                      {l.progressPct === null ? (
                        '—'
                      ) : (
                        <div className="flex items-center gap-2">
                          <div className="h-2 flex-1 rounded-full bg-slate-100">
                            <div className="h-2 rounded-full bg-brand-500" style={{ width: `${l.progressPct}%` }} />
                          </div>
                          <span className="text-xs tabular-nums">{l.progressPct}%</span>
                        </div>
                      )}
                    </td>
                    {showCosts && <td className="td-num">{formatMoney(n(l.budget) ?? 0, locale)}</td>}
                    {showCosts && <td className="td-num">{formatMoney((n(l.actual) ?? 0) + (n(l.committed) ?? 0), locale)}</td>}
                    {showCosts && (
                      <td className={`td-num ${(n(l.variance) ?? 0) < 0 ? 'text-danger-700' : ''}`}>{formatMoney(n(l.variance) ?? 0, locale)}</td>
                    )}
                    <td className="td">
                      {!closed && writer && l.plannedQty !== null && (
                        <Btn sm onClick={() => setOverrunFor(l)}>
                          {t('exe.requestOverrun')}
                        </Btn>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'log' && (
        <div className="card overflow-hidden">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th scope="col" className="th">{t('common.date')}</th>
                <th scope="col" className="th">{t('exe.line')}</th>
                <th scope="col" className="th text-end">{t('exe.qty')}</th>
                <th scope="col" className="th">{t('leads.notes')}</th>
                <th scope="col" className="th" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {s.entries.length === 0 ? (
                <EmptyRow colSpan={5} text={t('exe.noEntries')} />
              ) : (
                s.entries.map((e) => (
                  <tr key={e.id}>
                    <td className="td text-xs">{formatDate(e.workDate, locale)}</td>
                    <td className="td">
                      <span className="font-mono text-xs text-slate-500">{e.wbsElement.code}</span> {pick(e.wbsElement, 'name')}
                    </td>
                    <td className="td-num">
                      {Number(e.qty)} {e.wbsElement.uom ?? ''}
                    </td>
                    <td className="td text-xs text-slate-600">{e.notes ?? ''}</td>
                    <td className="td">
                      {e.createdById === user?.id && Date.now() - new Date(e.createdAt).getTime() < 864e5 && (
                        <Btn sm variant="danger" busy={busy(`del:${e.id}`)} disabled={busy()} onClick={() => removeEntry(e.id)}>
                          {t('exe.remove')}
                        </Btn>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'overruns' && (
        <div className="space-y-3">
          <p className="text-sm text-slate-600">{t('exe.overrunHint')}</p>
          {s.overruns.length === 0 ? (
            <p className="text-sm text-slate-500">{t('common.none')}</p>
          ) : (
            s.overruns.map((o) => (
              <div key={o.id} className="card p-4 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs font-semibold">{o.code}</span>
                  <StatusBadge status={o.status} />
                  <span>
                    {o.wbsElement.code} · {pick(o.wbsElement, 'name')} — +{Number(o.extraQty)} {o.wbsElement.uom ?? ''}
                  </span>
                  {showCosts && o.amount !== null && <span className="text-xs text-slate-500">({formatMoney(o.amount, locale)})</span>}
                  <span className="ms-auto text-xs text-slate-400">{formatDateTime(o.createdAt, locale)}</span>
                </div>
                <p className="mt-2 text-slate-700">{o.reason}</p>
                {o.decisionNote && <p className="mt-1 text-xs text-danger-700">{o.decisionNote}</p>}
                {o.pendingApproval && (
                  <div className="mt-3">
                    <ApprovalBanner request={o.pendingApproval} />
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {tab === 'photos' && (
        <div className="space-y-2">
          <p className="text-sm text-slate-600">{t('exe.photosHint')}</p>
          <AttachmentsCard entityType="PROJECT" entityId={id} />
        </div>
      )}

      {tab === 'attendance' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t('common.date')}>
              <input type="date" className="input" value={attDate} max={todayIso()} onChange={(e) => setAttDate(e.target.value)} />
            </Field>
            {!closed && writer && (
              <Btn variant="primary" icon="plus" onClick={() => setAttOpen(true)}>
                {t('exe.addWorker')}
              </Btn>
            )}
            <span className="ms-auto text-sm text-slate-600">
              {t('exe.onSite')}: {attendance.length} · {t('exe.hours')}:{' '}
              {Math.round(attendance.reduce((sum, a) => sum + (hours(a) ?? 0), 0) * 10) / 10}
            </span>
          </div>
          <div className="card overflow-hidden">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th scope="col" className="th">{t('exe.worker')}</th>
                  <th scope="col" className="th">{t('exe.trade')}</th>
                  <th scope="col" className="th">{t('exe.checkIn')}</th>
                  <th scope="col" className="th">{t('exe.checkOut')}</th>
                  <th scope="col" className="th text-end">{t('exe.hours')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {attendance.length === 0 ? (
                  <EmptyRow colSpan={5} text={t('common.none')} />
                ) : (
                  attendance.map((a) => (
                    <tr key={a.id}>
                      <td className="td">{a.workerName}</td>
                      <td className="td text-xs">{a.trade ?? '—'}</td>
                      <td className="td text-xs">{new Date(a.checkInAt).toTimeString().slice(0, 5)}</td>
                      <td className="td text-xs">
                        {a.checkOutAt ? (
                          new Date(a.checkOutAt).toTimeString().slice(0, 5)
                        ) : writer && !closed ? (
                          <Btn sm busy={busy(`out:${a.id}`)} disabled={busy()} onClick={() => checkOut(a)}>
                            {t('exe.checkOutNow')}
                          </Btn>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="td-num">{hours(a) ?? '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="text-xs text-slate-500">
        <Link href="/requisitions/returns" className="text-brand-700 hover:underline">
          {t('ret.title')}
        </Link>{' '}
        · {t('exe.returnsHint')}
      </p>

      <Modal open={progressOpen} title={t('exe.recordDay')} onClose={() => setProgressOpen(false)}>
        <form onSubmit={recordProgress} className="space-y-4">
          <Field label={t('common.date')}>
            <input type="date" className="input max-w-xs" value={workDate} max={todayIso()} onChange={(e) => setWorkDate(e.target.value)} required />
          </Field>
          <div className="max-h-[50vh] space-y-2 overflow-y-auto">
            {s.lines.map((l) => (
              <div key={l.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0">
                  <span className="font-mono text-xs text-slate-500">{l.code}</span> {pick(l, 'name')}
                  <span className="block text-xs text-slate-400">
                    {t('exe.remaining')}: {l.remainingQty ?? '—'} {l.uom ?? ''}
                  </span>
                </span>
                <input
                  type="number"
                  min={0}
                  step="0.001"
                  max={l.remainingQty ?? undefined}
                  aria-label={`${t('exe.qty')} ${l.code}`}
                  className="input w-28"
                  value={qtys[l.id] ?? ''}
                  onChange={(e) => setQtys((p) => ({ ...p, [l.id]: e.target.value }))}
                />
              </div>
            ))}
          </div>
          <p className="text-xs text-slate-500">{t('exe.capHint')}</p>
          <div className="flex justify-end gap-2">
            <Btn onClick={() => setProgressOpen(false)}>{t('common.cancel')}</Btn>
            <Btn type="submit" variant="primary" busy={busy('progress')} disabled={busy() || !Object.values(qtys).some((v) => Number(v) > 0)}>
              {t('common.save')}
            </Btn>
          </div>
        </form>
      </Modal>

      <Modal open={!!overrunFor} title={t('exe.requestOverrun')} onClose={() => setOverrunFor(null)}>
        {overrunFor && (
          <form onSubmit={requestOverrun} className="space-y-4">
            <p className="text-sm">
              <span className="font-mono text-xs text-slate-500">{overrunFor.code}</span> {pick(overrunFor, 'name')} —{' '}
              {t('exe.planned')}: {overrunFor.capQty} {overrunFor.uom ?? ''}, {t('exe.executed')}: {overrunFor.executedQty}
            </p>
            <Field label={`${t('exe.extraQty')} (${overrunFor.uom ?? ''})`}>
              <input type="number" name="extraQty" min={0.001} step="0.001" className="input w-40" required />
            </Field>
            <Field label={t('exe.reason')}>
              <textarea name="reason" className="input" rows={3} required minLength={5} maxLength={1000} />
            </Field>
            <p className="text-xs text-slate-500">{t('exe.overrunHint')}</p>
            <div className="flex justify-end gap-2">
              <Btn onClick={() => setOverrunFor(null)}>{t('common.cancel')}</Btn>
              <Btn type="submit" variant="primary" busy={busy('overrun')} disabled={busy()}>
                {t('exe.sendForApproval')}
              </Btn>
            </div>
          </form>
        )}
      </Modal>

      <Modal open={attOpen} title={t('exe.addWorker')} onClose={() => setAttOpen(false)}>
        <form onSubmit={addAttendance} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={t('exe.worker')}>
              <input name="workerName" className="input" required minLength={2} maxLength={120} />
            </Field>
            <Field label={`${t('exe.trade')} (${t('common.optional')})`}>
              <input name="trade" className="input" maxLength={80} />
            </Field>
            <Field label={t('exe.checkIn')}>
              <input type="time" name="checkIn" className="input" required defaultValue="07:00" />
            </Field>
            <Field label={`${t('exe.checkOut')} (${t('common.optional')})`}>
              <input type="time" name="checkOut" className="input" />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Btn onClick={() => setAttOpen(false)}>{t('common.cancel')}</Btn>
            <Btn type="submit" variant="primary" busy={busy('att')} disabled={busy()}>
              {t('common.save')}
            </Btn>
          </div>
        </form>
      </Modal>
    </div>
  );
}
