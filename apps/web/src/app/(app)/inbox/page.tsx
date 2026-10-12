'use client';

/**
 * صندوق المهام الموحّد — the unified task box (§8, phase 4).
 *
 * Brought forward from phase 4 because phase 1 already produces two kinds of
 * task — a signature the matrix wants, and a document the engine has parked on
 * your role — and a user with two inboxes has none.
 *
 * Rows are ordered oldest-first and show their age, because the failure a task
 * box exists to prevent is not "I could not find it" but "nobody noticed this
 * had been sitting there for nine days".
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { translateError } from '@/lib/errors';
import { formatDateTime, formatMoney } from '@/lib/format';
import { Btn, EmptyRow, LoadError, PageHeader, TableSkeleton } from '@/components/ui';
import { Icon } from '@/components/icons';

interface InboxTask {
  source: 'APPROVAL' | 'WORKFLOW' | 'FOLLOWUP';
  id: string;
  documentType: string;
  documentId: string;
  documentCode: string;
  titleAr: string;
  titleEn: string;
  stateAr: string;
  stateEn: string;
  amount: number | null;
  waitingSince: string;
  ageHours: number;
  overdue: boolean;
  actionable: boolean;
  blockedReason?: string;
  linkPath: string | null;
}

interface Monitor {
  openByState: Array<{ documentType: string; state: string; count: number }>;
  escalatedSteps: number;
  averageApprovalHours: number | null;
  sampleSize: number;
  failedEvents: number;
}

/** Hours read as hours for a day, then as days — "73h" tells nobody anything. */
function age(hours: number, ar: boolean): string {
  if (hours < 24) return ar ? `${Math.round(hours)} ساعة` : `${Math.round(hours)}h`;
  const days = Math.round(hours / 24);
  return ar ? `${days} يوم` : `${days}d`;
}

export default function InboxPage() {
  const { locale, t } = useI18n();
  const { can } = useAuth();
  const ar = locale === 'ar';
  const canMonitor = can('admin.workflow.manage');

  const [tasks, setTasks] = useState<InboxTask[] | null>(null);
  const [monitor, setMonitor] = useState<Monitor | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    setErr('');
    api
      .get<InboxTask[]>('/inbox/tasks')
      .then(setTasks)
      .catch((e) => setErr(translateError(e, locale)));
    if (canMonitor) {
      api
        .get<Monitor>('/inbox/monitor')
        .then(setMonitor)
        // The monitor is a secondary panel: its failure must not blank the
        // task list, which is the thing people came here for.
        .catch(() => setMonitor(null));
    }
  }, [locale, canMonitor]);
  useEffect(load, [load]);

  return (
    <div>
      <PageHeader
        title={t('inbox.title')}
        subtitle={t('inbox.hint')}
        action={
          <Btn variant="ghost" icon="refresh" onClick={load}>
            {t('common.refresh')}
          </Btn>
        }
      />

      {canMonitor && monitor && (
        <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label={t('inbox.stat.open')}
            value={String(monitor.openByState.reduce((s, r) => s + r.count, 0))}
            tone="slate"
          />
          <Stat
            label={t('inbox.stat.escalated')}
            value={String(monitor.escalatedSteps)}
            tone={monitor.escalatedSteps > 0 ? 'warning' : 'slate'}
          />
          <Stat
            label={t('inbox.stat.avgApproval')}
            value={
              monitor.averageApprovalHours === null
                ? '—'
                : age(monitor.averageApprovalHours, ar)
            }
            hint={
              monitor.sampleSize
                ? t('inbox.stat.sample').replace('{n}', String(monitor.sampleSize))
                : undefined
            }
            tone="slate"
          />
          {/* A failed event is a consequence that silently did not happen —
              a journal not posted, a commitment not booked. It belongs on the
              executive panel, not only in a log file. */}
          <Stat
            label={t('inbox.stat.failedEvents')}
            value={String(monitor.failedEvents)}
            tone={monitor.failedEvents > 0 ? 'danger' : 'slate'}
          />
        </div>
      )}

      {err && <LoadError message={err} onRetry={load} />}

      {!err && (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-start text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3 text-start">{t('inbox.col.task')}</th>
                <th className="px-4 py-3 text-start">{t('inbox.col.state')}</th>
                <th className="px-4 py-3 text-start">{t('inbox.col.amount')}</th>
                <th className="px-4 py-3 text-start">{t('inbox.col.waiting')}</th>
                <th className="px-4 py-3 text-end">{t('inbox.col.action')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {tasks === null && <TableSkeleton cols={5} />}
              {tasks?.length === 0 && <EmptyRow colSpan={5} text={t('inbox.empty')} />}
              {tasks?.map((task) => (
                <tr key={`${task.source}:${task.id}`} className="hover:bg-slate-50/60">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 font-medium text-slate-800">
                      <Icon
                        name={task.source === 'APPROVAL' ? 'stamp' : task.source === 'FOLLOWUP' ? 'square-check' : 'file-text'}
                        className="h-4 w-4 text-slate-400"
                      />
                      {ar ? task.titleAr : task.titleEn}
                    </div>
                    {!task.actionable && (
                      <div className="mt-1 text-xs text-slate-500">
                        {task.blockedReason === 'RAISED_BY_YOU'
                          ? t('inbox.blocked.raisedByYou')
                          : task.blockedReason === 'NO_PERMISSION'
                            ? t('inbox.blocked.noPermission')
                            : t('inbox.blocked.alreadySigned')}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-600">{ar ? task.stateAr : task.stateEn}</td>
                  <td className="px-4 py-3 tabular-nums text-slate-600">
                    {task.amount === null ? '—' : formatMoney(task.amount, locale)}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={
                        task.overdue
                          ? 'rounded-md bg-warning-50 px-2 py-0.5 text-xs font-semibold text-warning-900'
                          : 'text-xs text-slate-500'
                      }
                      title={formatDateTime(task.waitingSince, locale)}
                    >
                      {age(task.ageHours, ar)}
                      {task.overdue ? ` · ${t('inbox.overdue')}` : ''}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-end">
                    {task.linkPath ? (
                      <Link
                        href={task.linkPath}
                        className="text-sm font-medium text-brand-700 hover:underline"
                      >
                        {t('inbox.open')}
                      </Link>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone: 'slate' | 'warning' | 'danger';
}) {
  const ring =
    tone === 'danger'
      ? 'border-danger-200 bg-danger-50/50'
      : tone === 'warning'
        ? 'border-warning-200 bg-warning-50/50'
        : 'border-slate-200 bg-white';
  return (
    <div className={`rounded-xl border p-4 ${ring}`}>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-800">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}
